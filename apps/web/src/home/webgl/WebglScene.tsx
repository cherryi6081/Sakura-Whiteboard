import { useEffect, useRef } from "react";
import type { Period } from "../usePeriod";
import type { SceneHandle } from "./renderer";
import type { SkyClock } from "../skyClock";

/**
 * 桌面端 3D 场景的挂载点。
 *
 * 渲染模式在**首次渲染前**同步判定（见 decideRenderMode），由父组件一次性写进
 * `data-render`，所以首屏第一帧就是 WebGL 模式，不会再出现“先 SVG、再跳一下切 WebGL”。
 *
 * 降级条件（任一成立就完全不加载 three，首帧直接出 SVG）：
 *   - 触摸主设备（hover: none + pointer: coarse），或物理像素宽度小于 1024；
 *   - 系统开启“减少动态效果”；
 *   - 浏览器开了省流模式；
 *   - 没有 WebGL2。
 * 宽度取物理像素（innerWidth × devicePixelRatio），页面缩放不会改变它。
 * 这些条件都在挂载前判定，不存在“先渲染 SVG 占位再尝试 WebGL”的路径。
 * 只有运行时出错（动态 import 失败、context 创建失败、物理宽度真的跌破断点）才回退 SVG。
 *
 * three 用动态 import 单独打包，移动端用户不会为它付首屏字节。
 */

const MIN_WIDTH = 1024;

/**
 * 判定用的宽度必须是**物理像素**，不能用 CSS 像素。
 *
 * 页面缩放（Ctrl +/−、Ctrl+滚轮、浏览器菜单里的缩放）只改两个量：CSS 视口变小、
 * devicePixelRatio 按同一比例变大，物理像素宽度不变（1440 的窗口在 150% 下是
 * innerWidth 960 / dpr 1.5）。用 `(min-width: 1024px)` 判定时，1440 的窗口缩到
 * 150% 就只剩 960 CSS px，判定当场翻成 false，于是 canvas 被卸载、场景退回静态 SVG，
 * 而且这条路径是单向的——再缩回 100% 也不会重新挂载。用 innerWidth × dpr 判定，
 * 任何缩放档位下都是同一个数，缩放不再影响渲染模式。
 */
function physicalWidth(): number {
  return Math.round(window.innerWidth * (window.devicePixelRatio || 1));
}

/**
 * 真手机/平板：没有悬停能力、主指针是粗指针。触屏笔记本同时有细指针与悬停，
 * 不会被误判。只把「确定是触摸主设备」的情况降级，识别不出指针能力的旧浏览器
 * 仍然按桌面处理，避免把 WebGL 误关掉。
 */
function isCoarseOnlyPointer(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

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
  if (isCoarseOnlyPointer()) return "svg";
  if (physicalWidth() < MIN_WIDTH) return "svg";
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
  /**
   * 天空/湖面/雾的钟，由父组件在 `.wb-home__scene` 上创建后传进来。
   * 没拿到之前不挂载 three：时钟写的是同一棵子树上的 CSS 变量，必须先有它。
   */
  skyClock: SkyClock | null;
};

export function WebglScene({ period, mode, onModeChange, onFirstFrame, skyClock }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const craneCanvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<SceneHandle | null>(null);
  const periodRef = useRef(period);

  periodRef.current = period;

  // 运行中真的缩到断点以下（或指针变成触摸主设备）：卸载 three，回退 SVG。
  // 判定同样只看物理像素宽度，所以页面缩放（Ctrl +/−）不会触发；
  // 延迟 150ms 再判，避开缩放/拖拽窗口过程中 dpr 与 innerWidth 短暂不同步的中间帧。
  useEffect(() => {
    if (mode !== "webgl") return;
    let timer = 0;
    const sync = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (isCoarseOnlyPointer() || physicalWidth() < MIN_WIDTH) onModeChange?.("svg");
      }, 150);
    };
    window.addEventListener("resize", sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", sync);
    };
  }, [mode, onModeChange]);

  useEffect(() => {
    if (mode !== "webgl" || !skyClock) return;
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
          skyClock,
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
  }, [mode, skyClock]);

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
