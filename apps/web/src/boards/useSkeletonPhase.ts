import { useEffect, useRef, useState } from "react";

/**
 * 骨架屏的延迟显示 + 最短展示 + 交叉淡出（列表页与回收站共用）。
 *
 * - 数据 200ms 内到达就完全不出现骨架（首屏只看到内容淡入）；
 * - 真的慢时才显示骨架；一旦显示就至少停留 360ms，再淡出 180ms，
 *   避免「骨架闪一下就换真实内容」的抖动。
 */

export const SKELETON_DELAY_MS = 200;
export const SKELETON_EXIT_MS = 180;
/** 骨架一旦出现，至少显示这么久再退场，避免「刚出现就消失」的闪烁 */
export const SKELETON_MIN_SHOW_MS = 360;

export type SkeletonPhase = "idle" | "waiting" | "shown" | "exiting";

/** waiting 是「已排队但还没到 200ms」的静默阶段，不渲染任何灰块 */
export function skeletonVisible(phase: SkeletonPhase): boolean {
  return phase === "shown" || phase === "exiting";
}

export function useSkeletonPhase(
  active: boolean,
  delayMs = SKELETON_DELAY_MS,
  exitMs = SKELETON_EXIT_MS,
): SkeletonPhase {
  const [phase, setPhase] = useState<SkeletonPhase>("idle");
  const shownAtRef = useRef(0);

  useEffect(() => {
    if (active) {
      setPhase((current) => (current === "idle" ? "waiting" : current === "exiting" ? "shown" : current));
      return undefined;
    }
    if (phase === "waiting") {
      setPhase("idle");
      return undefined;
    }
    if (phase === "shown") {
      const remain = Math.max(0, shownAtRef.current + SKELETON_MIN_SHOW_MS - performance.now());
      const timer = window.setTimeout(() => setPhase("exiting"), remain);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [active, phase]);

  useEffect(() => {
    if (phase === "waiting") {
      const timer = window.setTimeout(() => {
        shownAtRef.current = performance.now();
        setPhase("shown");
      }, delayMs);
      return () => window.clearTimeout(timer);
    }
    if (phase === "exiting") {
      const timer = window.setTimeout(() => setPhase("idle"), exitMs);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [phase, delayMs, exitMs]);

  return phase;
}
