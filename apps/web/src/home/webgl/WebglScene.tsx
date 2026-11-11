import { useEffect, useRef } from "react";
import type { Period } from "../usePeriod";
import type { SceneHandle } from "./renderer";

/**
 * 桌面端 3D 场景的挂载点。
 *
 * 渲染模式在**首次渲染前**同步判定（见 decideRenderMode），由父组件一次性写进
 * `data-render`，所以首屏第一帧就是 WebGL 模式，不会再出现“先 SVG、再跳一下切 WebGL”。
 *
 * 降级条件（任一成立就完全不加载 three，首帧直接出 SVG）：
 *   - 视口小于 1024px（平板/手机）；
 *   - 系统开启“减少动态效果”；
 *   - 浏览器开了省流模式；
 *   - 没有 WebGL2。
 * 这些条件都在挂载前判定，不存在“先渲染 SVG 占位再尝试 WebGL”的路径。
 * 只有运行时出错（动态 import 失败、context 创建失败、视口缩到 1024 以下）才回退 SVG。
 *
 * three 用动态 import 单独打包，移动端用户不会为它付首屏字节。
 */

const MIN_WIDTH = 1024;

export function canUseWebgl(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;

  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return false;

  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2");
  if (!gl) return false;
  // 探测用的 context 立刻释放，别占用浏览器有限的 context 配额
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

/** 同步判定首屏渲染模式：在首次 render 里调用，保证第一帧就落定 */
export function decideRenderMode(): "svg" | "webgl" {
  if (typeof window === "undefined") return "svg";
  if (!window.matchMedia(`(min-width: ${MIN_WIDTH}px)`).matches) return "svg";
  return canUseWebgl() ? "webgl" : "svg";
}

type Props = {
  period: Period;
  /** 首屏判定结果：webgl 时立即挂载，svg 时完全不碰 three */
  mode: "svg" | "webgl";
  /** 运行时失败或视口跌破断点时通知父组件回退 */
  onModeChange?: (mode: "svg") => void;
  /** 首个 WebGL 帧画完：父组件据此把静态湖色衬底交接给 WebGL 水面 */
  onFirstFrame?: () => void;
};

export function WebglScene({ period, mode, onModeChange, onFirstFrame }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const craneCanvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<SceneHandle | null>(null);
  const periodRef = useRef(period);

  periodRef.current = period;

  // 运行中跌破 1024px：卸载 three，回退 SVG（首屏判定不受影响）
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${MIN_WIDTH}px)`);
    const sync = () => {
      if (!query.matches) onModeChange?.("svg");
    };
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (mode !== "webgl") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    import("./renderer")
      .then(({ mountScene }) => {
        if (cancelled) return;
        handleRef.current = mountScene(canvas, {
          period: periodRef.current,
          onFirstFrame,
          craneCanvas: craneCanvasRef.current ?? undefined,
        });
      })
      .catch(() => {
        // 动态 import 或 context 创建失败：回退 SVG，不影响页面
        if (!cancelled) onModeChange?.("svg");
      });

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [mode]);

  // 时辰切换只推给已有场景，不重建（重建会闪一下）
  useEffect(() => {
    handleRef.current?.setPeriod(period);
  }, [period]);

  if (mode !== "webgl") return null;
  return (
    <>
      <canvas ref={canvasRef} className="wb-scene__canvas" aria-hidden />
      {/* 丹顶鹤单独一块透明 canvas：主 canvas 在 z-index 0，压不住 z-index 1 的小舟与雁群；
          这块拿 z-index 2，DOM 排在枝条（同为 2、在后）之前，于是压住山体/小舟/雁群、
          又钻到枝条与落瓣之下。只画鹤，透明清屏，与主场景共用同一个相机与同一个 rAF */}
      <canvas ref={craneCanvasRef} className="wb-scene__crane-canvas" aria-hidden />
    </>
  );
}
