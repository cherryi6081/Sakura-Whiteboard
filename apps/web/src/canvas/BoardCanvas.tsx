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
   * 基线同步保证 `onChange` 不会把远端改动当成新 op 再发回去；
   * 另外 `updateScene` 可能触发一次内部规范化，因此吞掉紧随其后的那一帧 onChange，
   * 只把它当作新的基线（避免把远端回放"回声"成 op）。
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
  /** 远端回放触发的下一帧 onChange 只同步基线，不产出 op */
  const suppressDeriveRef = useRef(0);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handle: BoardCanvasHandle = {
    getElements: () => apiRef.current?.getSceneElements() ?? [],
    applyRemoteElements: (elements) => {
      suppressDeriveRef.current += 1;
      if (suppressTimerRef.current !== null) clearTimeout(suppressTimerRef.current);
      // 兜底：极端情况下 updateScene 没有触发 onChange，别把后续用户改动一起吞掉
      suppressTimerRef.current = setTimeout(() => {
        suppressTimerRef.current = null;
        suppressDeriveRef.current = 0;
      }, 200);
      deriverRef.current.reset(elements as any);
      apiRef.current?.updateScene({
        elements: elements as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
  };

  /**
   * 注意：**不要**把缓存元素塞进 `initialData`。
   * Excalidraw 对 `initialData` 会走 restore 路径（会升级元素版本），
   * 导致首次 onChange 与缓存里的 element 版本不一致，被派生层当成"用户改动"回传，
   * 多端之间形成 op 回声循环。这里先挂空画布，API 就绪后再用 updateScene 无损灌入。
   */
  useEffect(
    () => () => {
      if (suppressTimerRef.current !== null) clearTimeout(suppressTimerRef.current);
    },
    [],
  );

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
        // Excalidraw 刚挂载时还会初始化场景；下一拍再把缓存/快照灌入，
        // 否则 updateScene 会被后续初始化覆盖（表现为刷新后画布空白，直到补拉回来）。
        setTimeout(() => {
          if (apiRef.current !== api) return;
          handle.applyRemoteElements(initialElements);
          onApiReady?.(api, handle);
        }, 0);
      }}
      initialData={{}}
      viewModeEnabled={viewModeEnabled ?? false}
      onChange={(elements) => {
        if (suppressDeriveRef.current > 0) {
          // 这一帧来自远端回放/初始灌入：只把实际场景当作新基线
          suppressDeriveRef.current -= 1;
          if (suppressTimerRef.current !== null) {
            clearTimeout(suppressTimerRef.current);
            suppressTimerRef.current = null;
          }
          deriverRef.current.reset(elements as any);
          return;
        }
        const ops = deriverRef.current.derive(elements as any);
        batcherRef.current.push(ops);
      }}
    />
  );
}
