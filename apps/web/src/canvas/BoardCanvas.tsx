import { useEffect, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { ElementOp } from "@whiteboard/shared";
import { createOpBatcher, createOpDeriver } from "../collab/deriveOps";

type Props = {
  initialElements: readonly any[];
  onApiReady?: (api: ExcalidrawImperativeAPI) => void;
  /** 一批合并后的元素级 op；C2 只在此打点，C3 接入网络 */
  onOps?: (ops: ElementOp[]) => void;
};

/**
 * 渲染与派生解耦：本组件只负责把 `onChange` 的全量数组交给 `deriveOps`，
 * 再由 50ms 静默 flush（或 pointerup 立即 flush）交出批量 op。
 */
export function BoardCanvas({ initialElements, onApiReady, onOps }: Props) {
  const deriverRef = useRef(createOpDeriver());
  const onOpsRef = useRef(onOps);
  onOpsRef.current = onOps;
  const batcherRef = useRef(
    createOpBatcher({
      onFlush: (ops) => onOpsRef.current?.(ops),
    }),
  );

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
      excalidrawAPI={(api) => onApiReady?.(api)}
      initialData={{ elements: initialElements as any }}
      onChange={(elements) => {
        const ops = deriverRef.current.derive(elements as any);
        batcherRef.current.push(ops);
      }}
    />
  );
}
