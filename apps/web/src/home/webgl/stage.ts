import * as THREE from "three";

/** 与 SVG 场景完全同一套虚拟舞台：viewBox 0 0 1600 900 */
export const STAGE_W = 1600;
export const STAGE_H = 900;
/** 水线（SVG y）：山脚、湖面、倒影都从这一条线开始 */
export const WATERLINE = 566;
/** 相机到 z=0 平面的距离；所有透视补偿都以它为准 */
export const CAM_DIST = 1000;

/**
 * 舞台坐标 → 世界坐标。
 *
 * x/y 先按透视缩放做反补偿：(1000 − z) / 1000。这样无论顶点在哪个深度，
 * 静止时都精确投影回它在 SVG 里的像素位置 —— 山脊、水线与 SVG 前景
 * （樱花枝、小舟）严格对齐；相机一转，不同深度的位移差才成为视差。
 */
export function toWorld(x: number, y: number, z: number): THREE.Vector3 {
  const k = (CAM_DIST - z) / CAM_DIST;
  return new THREE.Vector3((x - STAGE_W / 2) * k, (STAGE_H / 2 - y) * k, z);
}

/** 把舞台 y（0 在上、900 在下）换算成世界 y（向上为正） */
export function stageY(y: number): number {
  return STAGE_H / 2 - y;
}

export type StageLayout = {
  /** 1 舞台单位 = 多少 CSS px */
  scale: number;
  /** 舞台左上角在画布内的 CSS px 偏移 */
  left: number;
  top: number;
  stageW: number;
  stageH: number;
};

/**
 * 让正交舞台在任意视口里沿用 CSS 的 meet 规则：
 *   stageH = min(vh, vw * 9 / 16)，stageW = stageH * 16 / 9，
 * 舞台底边贴视口底（对应 preserveAspectRatio="xMidYMax meet"）。
 * 视口更宽时上下留白为零、左右露出湖面延展；更窄时左右撑满、上方露出天空。
 *
 * 鹤用的第二块 canvas 与主 canvas 尺寸、位置完全相同，也必须用同一份换算，
 * 否则鹤的落点会和 SVG 版差几个像素 —— 所以这里导出成纯数据，两边共用。
 */
export function readStageLayout(width: number, height: number): StageLayout {
  const stageH = Math.min(height, (width * 9) / 16);
  const stageW = (stageH * 16) / 9;
  return {
    stageH,
    stageW,
    scale: stageH / STAGE_H,
    left: (width - stageW) / 2,
    top: height - stageH,
  };
}

/** 相机取景：与 readStageLayout 同一份舞台，只是进一步换算成 fov / 观察中心 */
export function layoutCamera(camera: THREE.PerspectiveCamera, width: number, height: number): void {
  if (width <= 0 || height <= 0) return;

  const { scale, left, top } = readStageLayout(width, height);
  const visibleH = height / scale;
  const visibleW = width / scale;

  // 视口中心换算成舞台坐标 = 相机在 z=0 平面上的观察中心
  const cx = (width / 2 - left) / scale;
  const cy = (height / 2 - top) / scale;

  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(visibleH / 2 / CAM_DIST));
  camera.aspect = visibleW / visibleH;
  camera.position.set(cx - STAGE_W / 2, STAGE_H / 2 - cy, CAM_DIST);
  camera.rotation.set(0, 0, 0);
  camera.updateProjectionMatrix();
}
