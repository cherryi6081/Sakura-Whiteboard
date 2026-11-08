import { useRef } from "react";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { ElementOp } from "@whiteboard/shared";
import { createOpBatcher, createOpDeriver } from "../collab/deriveOps";
import { probeStorage } from "./probe";

type Stats = {
  onChangeCalls: number;
  rawOps: number;
  rawOpsPerCall: number[];
  dedupFlushes: number;
  dedupOps: number;
  dedupOpsPerFlush: ElementOp[][];
  lastOps: ElementOp[];
};

function createStats(): Stats {
  return {
    onChangeCalls: 0,
    rawOps: 0,
    rawOpsPerCall: [],
    dedupFlushes: 0,
    dedupOps: 0,
    dedupOpsPerFlush: [],
    lastOps: [],
  };
}

declare global {
  interface Window {
    __spike: {
      getReport: () => unknown;
      reset: () => void;
      applyRemote: (elements: unknown[], mode: "never" | "immediately") => number;
      sceneIds: () => string[];
      sceneFull: () => unknown[];
      probeStorage: () => Promise<unknown>;
      hasCaptureUpdateAction: boolean;
      version: string;
    };
  }
}

export function SpikeApp() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const statsRef = useRef<Stats>(createStats());
  const deriverRef = useRef(createOpDeriver());
  const batcherRef = useRef(
    createOpBatcher({
      onFlush: (batch) => {
        const s = statsRef.current;
        s.dedupFlushes += 1;
        s.dedupOps += batch.length;
        s.dedupOpsPerFlush.push(batch);
      },
    }),
  );

  const onChange = (elements: readonly any[]) => {
    const s = statsRef.current;
    s.onChangeCalls += 1;
    const ops = deriverRef.current.derive(elements);
    s.rawOps += ops.length;
    s.rawOpsPerCall.push(ops.length);
    s.lastOps = ops;
    batcherRef.current.push(ops);
  };

  const sceneFull = () => {
    const api = apiRef.current;
    if (!api) return [];
    return api.getSceneElementsIncludingDeleted().map((el) => JSON.parse(JSON.stringify(el)));
  };

  window.__spike = {
    getReport: () => ({
      stats: statsRef.current,
      elementCount: apiRef.current?.getSceneElements().length ?? -1,
      ids: apiRef.current?.getSceneElements().map((e) => e.id) ?? [],
    }),
    reset: () => {
      statsRef.current = createStats();
      const api = apiRef.current;
      deriverRef.current.reset(api ? api.getSceneElementsIncludingDeleted() : []);
      batcherRef.current.dispose();
    },
    applyRemote: (elements: unknown[], mode: "never" | "immediately") => {
      const api = apiRef.current;
      if (!api) return -1;
      api.updateScene({
        elements: elements as any,
        captureUpdate:
          mode === "never" ? CaptureUpdateAction.NEVER : CaptureUpdateAction.IMMEDIATELY,
      });
      return elements.length;
    },
    sceneIds: () => apiRef.current?.getSceneElements().map((e) => e.id) ?? [],
    sceneFull,
    probeStorage,
    hasCaptureUpdateAction: typeof CaptureUpdateAction?.NEVER === "string",
    version: "0.18.1",
  };

  const boardId = new URLSearchParams(window.location.search).get("board") ?? "default";

  return (
    <div style={{ height: "100vh" }}>
      <Excalidraw
        name={`spike-${boardId}`}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          (window as any).__spikeApiReady = true;
        }}
        initialData={{ elements: [], scrollToContent: false }}
        onChange={onChange}
      />
    </div>
  );
}
