import { useEffect, useRef } from "react";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { ElementOp } from "@whiteboard/shared";
import { createOpBatcher, createOpDeriver } from "../collab/deriveOps";

export type BoardCanvasHandle = {
  getElements: () => readonly any[];
  /**
   * 远端回放：先把派生基线重置成这份元素，再 `updateScene(NEVER)`。
   * 基线同步保证 `onChange` 不会把远端改动当成新 op 再发回去。
   */
  applyRemoteElements: (elements: readonly any[]) => void;
};

type Props = {
  initialElements: readonly any[];
  viewModeEnabled?: boolean;
  onApiReady?: (api: ExcalidrawImperativeAPI, handle: BoardCanvasHandle) => void;
  /** 一批合并后的元素级 op */
  onOps?: (ops: ElementOp[]) => void;
};

/**
 * 渲染与派生解耦：本组件只负责把 `onChange` 的全量数组交给 `deriveOps`，
 * 再由 50ms 静默 flush（或 pointerup 立即 flush）交出批量 op。
 */
export function BoardCanvas({ initialElements, viewModeEnabled, onApiReady, onOps }: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const deriverRef = useRef(createOpDeriver());
  const onOpsRef = useRef(onOps);
  onOpsRef.current = onOps;
  const batcherRef = useRef(
    createOpBatcher({
      onFlush: (ops) => onOpsRef.current?.(ops),
    }),
  );

  const handle: BoardCanvasHandle = {
    getElements: () => apiRef.current?.getSceneElements() ?? [],
    applyRemoteElements: (elements) => {
      deriverRef.current.reset(elements as any);
      apiRef.current?.updateScene({
        elements: elements as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
  };

  useEffect(() => {
    deriverRef.current.reset(initialElements as any);
  }, [initialElements]);

  useEffect(() => {
    const flush = () => batcherRef.current.flushNow();
    window.addEventListener("pointerup", flush);
    window.addEventListener("pointercancel", flush);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("pointerup", flush);
      window.removeEventListener("pointercancel", flush);
      window.removeEventListener("blur", flush);
      batcherRef.current.dispose();
    };
  }, []);

  return (
    <Excalidraw
      excalidrawAPI={(api) => {
        apiRef.current = api;
        onApiReady?.(api, handle);
      }}
      initialData={{ elements: initialElements as any }}
      viewModeEnabled={viewModeEnabled ?? false}
      onChange={(elements) => {
        const ops = deriverRef.current.derive(elements as any);
        batcherRef.current.push(ops);
      }}
    />
  );
}
