import * as THREE from "three";
import { CAM_DIST, STAGE_H, STAGE_W, toWorld } from "./stage";
import type { Palette } from "./palette";
import { BOAT_ANCHOR, sampleBoat } from "../wave";
import {
  BOAT_SCALE,
  awning,
  awningMouth,
  contact,
  foam,
  foamTail,
  glow,
  gunwaleLitBottom,
  gunwaleLitTop,
  hullGunwale,
  hullKeel,
  lamp,
  lampCenter,
  oarBlade,
  oarShaft,
  pole,
  shimmer,
  type Pt,
} from "../boatShape";

/**
 * 湖面小舟（WebGL 版）。
 *
 * 轮廓与移动端 SVG 船共用 boatShape.ts 里那套点：SVG 组 scale(1.6)，
 * 这里乘同一个 BOAT_SCALE 换成舞台单位，两端不会再各画一套。
 * 1440 下船身约 77 × 16px，装饰都做到 1.4 单位（约 2px）以上，再细就是噪点。
 *
 * 运动完全由 wave.ts 的 sampleBoat 驱动（与移动端 SVG 船共用同一个采样函数）：
 * 船头/船尾高度差 → 俯仰 ±3.5°，近舷/远舷高度差 → 横摇 ±2.5°，另有 ±12 单位 / 40s 的横向漂移。
 *
 * z = 90：排在水面、水纹、山体倒影、花瓣之前，船不会被它们穿模；
 * 船底有一块压暗的接触带（soft 层里的椭圆），不做镜面倒影。
 *
 * 只有两个 mesh（solid / soft）→ 两次 draw call。所有装饰都并进 solid 的三角形里，
 * 灯芯、光晕、暖影的绘制顺序在几何里固定，不参与每帧的透明排序，不会出现逐帧翻转。
 */
const Z = 90;
const SOFT_Z = 89;

const solidVertexShader = /* glsl */ `
  attribute vec4 aColor;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const solidFragmentShader = /* glsl */ `
  varying vec4 vColor;
  void main() {
    gl_FragColor = vColor;
    #include <colorspace_fragment>
  }
`;

const softVertexShader = /* glsl */ `
  attribute vec4 aColor;
  attribute float aFalloff;
  attribute vec2 aUv;
  varying vec4 vColor;
  varying float vFalloff;
  varying vec2 vUv;
  void main() {
    vColor = aColor;
    vFalloff = aFalloff;
    vUv = aUv;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const softFragmentShader = /* glsl */ `
  varying vec4 vColor;
  varying float vFalloff;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float fall = mix(1.0, pow(max(0.0, 1.0 - r), 2.0), vFalloff);
    float a = vColor.a * fall;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor.rgb, a);
    #include <colorspace_fragment>
  }
`;

/** 局部形状 → 舞台坐标偏移（同一 z 下 k 相同，可以直接减原点） */
function localize(stageX: number, stageY: number): [number, number] {
  const o = toWorld(BOAT_ANCHOR.x, BOAT_ANCHOR.y, Z);
  const w = toWorld(stageX, stageY, Z);
  return [w.x - o.x, w.y - o.y];
}

/** 形状数据是 SVG 组内坐标，乘 BOAT_SCALE 才是舞台单位 */
function stagePoint([x, y]: Pt): [number, number] {
  return [x * BOAT_SCALE, y * BOAT_SCALE];
}

function addTriangle(
  positions: number[],
  colors: number[],
  a: [number, number],
  b: [number, number],
  c: [number, number],
  color: THREE.Color,
  alpha: number,
) {
  for (const p of [a, b, c]) {
    positions.push(p[0], p[1], 0);
    colors.push(color.r, color.g, color.b, alpha);
  }
}

function addPoly(
  positions: number[],
  colors: number[],
  poly: Pt[],
  color: THREE.Color,
  alpha: number,
) {
  const pts = poly.map((p) => {
    const [x, y] = stagePoint(p);
    return localize(BOAT_ANCHOR.x + x, BOAT_ANCHOR.y + y);
  });
  for (let i = 1; i < pts.length - 1; i += 1) {
    addTriangle(positions, colors, pts[0], pts[i], pts[i + 1], color, alpha);
  }
}

/** 两条等长折线之间铺三角带：船身、舷沿高光都是这种带状面，扇式三角化会在月牙里叠出双份透明度 */
function addBand(
  positions: number[],
  colors: number[],
  outer: Pt[],
  inner: Pt[],
  color: THREE.Color,
  alpha: number,
) {
  const toStage = (p: Pt) => {
    const [x, y] = stagePoint(p);
    return localize(BOAT_ANCHOR.x + x, BOAT_ANCHOR.y + y);
  };
  for (let i = 0; i < outer.length - 1; i += 1) {
    const o0 = toStage(outer[i]);
    const o1 = toStage(outer[i + 1]);
    const i0 = toStage(inner[i]);
    const i1 = toStage(inner[i + 1]);
    addTriangle(positions, colors, o0, o1, i0, color, alpha);
    addTriangle(positions, colors, o1, i1, i0, color, alpha);
  }
}

function buildSolid(palette: Palette): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  // 绘制顺序即叠色顺序：橹 → 篷 → 篷口 → 船身 → 舷沿 → 杆 → 灯 → 白沫 → 暖影。
  // 橹先画，杆根被船身盖住；篷先画，底边被船身压出一道更深的交界。
  addPoly(positions, colors, oarShaft, palette.ink, 0.5);
  addPoly(positions, colors, oarBlade, palette.ink, 0.55);
  addPoly(positions, colors, awning, palette.ink, 0.5);
  addPoly(positions, colors, awningMouth, palette.ink, 0.78);
  addBand(positions, colors, hullKeel, hullGunwale, palette.ink, 0.62);
  // 舷沿高光：墨色船身上缘一条 1.3 单位的浅色带，1440 下约 1.9px
  addBand(positions, colors, gunwaleLitTop, gunwaleLitBottom, palette.ripple, 0.5);
  addPoly(positions, colors, pole, palette.ink, 0.5);
  addPoly(positions, colors, lamp, palette.lampHot, 0.95);
  // 船头破水白沫：两段长短不一的浅色短线，第二段更淡
  addPoly(positions, colors, foam, palette.ripple, 0.6);
  addPoly(positions, colors, foamTail, palette.ripple, 0.42);
  // 水面暖影：灯正下方三段窄碎影，不铺成一条连续色块
  for (const s of shimmer) {
    addPoly(
      positions,
      colors,
      [
        [s.x, s.y],
        [s.x, s.y + s.h],
        [s.x + s.w, s.y + s.h],
        [s.x + s.w, s.y],
      ],
      palette.lamp,
      s.alpha,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 4));
  return geometry;
}

/** 椭圆 quad：中心、半径、颜色、径向衰减 */
function addSoftQuad(
  positions: number[],
  colors: number[],
  uvs: number[],
  falloffs: number[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: THREE.Color,
  alpha: number,
  falloff: number,
) {
  const corners: Array<[number, number, number, number]> = [
    [cx - rx, cy - ry, 0, 0],
    [cx - rx, cy + ry, 0, 1],
    [cx + rx, cy - ry, 1, 0],
    [cx + rx, cy + ry, 1, 1],
  ];
  for (const [sx, sy, u, v] of corners) {
    const p = localize(BOAT_ANCHOR.x + sx, BOAT_ANCHOR.y + sy);
    positions.push(p[0], p[1], 0);
    colors.push(color.r, color.g, color.b, alpha);
    uvs.push(u, v);
    falloffs.push(falloff);
  }
}

function buildSoft(palette: Palette): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const falloffs: number[] = [];

  addSoftQuad(
    positions,
    colors,
    uvs,
    falloffs,
    contact.x * BOAT_SCALE,
    contact.y * BOAT_SCALE,
    contact.rx * BOAT_SCALE,
    contact.ry * BOAT_SCALE,
    palette.ink,
    contact.alpha,
    contact.falloff,
  );
  const [lx, ly] = stagePoint(lampCenter);
  // 大晕只贴到 18 单位（约 26px），alpha 0.15；再大就会在水纹上铺成一块淡黄色斑
  addSoftQuad(
    positions,
    colors,
    uvs,
    falloffs,
    lx,
    ly,
    glow.outer * BOAT_SCALE,
    glow.outer * BOAT_SCALE,
    palette.lamp,
    glow.outerAlpha,
    1,
  );
  // 小晕用灯芯色，把「实心灯芯 → 湖面」的落差拆成两段
  addSoftQuad(
    positions,
    colors,
    uvs,
    falloffs,
    lx,
    ly,
    glow.inner * BOAT_SCALE,
    glow.inner * BOAT_SCALE,
    palette.lampHot,
    glow.innerAlpha,
    1,
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setAttribute("aUv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aFalloff", new THREE.Float32BufferAttribute(falloffs, 1));
  // 三个 quad 各自两个三角形（顶点顺序与 corners 的 push 顺序一致）
  geometry.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7, 8, 9, 10, 10, 9, 11]);
  return geometry;
}

export type BoatBuild = {
  group: THREE.Group;
  update(time: number): void;
  dispose(): void;
};

export function createBoat(palette: Palette): BoatBuild {
  const group = new THREE.Group();

  const solidGeometry = buildSolid(palette);
  const solidMaterial = new THREE.ShaderMaterial({
    vertexShader: solidVertexShader,
    fragmentShader: solidFragmentShader,
    transparent: true,
    depthWrite: false,
    // 平面片：舞台 y 翻成世界 y 后三角形绕序会反，双面渲染省得逐个校正
    side: THREE.DoubleSide,
  });
  const solid = new THREE.Mesh(solidGeometry, solidMaterial);

  const softGeometry = buildSoft(palette);
  const softMaterial = new THREE.ShaderMaterial({
    vertexShader: softVertexShader,
    fragmentShader: softFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const soft = new THREE.Mesh(softGeometry, softMaterial);
  soft.position.z = SOFT_Z - Z;

  group.add(soft, solid);

  const k = (CAM_DIST - Z) / CAM_DIST;

  const build: BoatBuild = {
    group,
    update(time: number) {
      const pose = sampleBoat(time);
      const x = BOAT_ANCHOR.x + pose.drift;
      const y = BOAT_ANCHOR.y + pose.dy;
      group.position.set((x - STAGE_W / 2) * k, (STAGE_H / 2 - y) * k, Z);
      // 俯仰在屏幕平面内（绕 z），横摇绕船身长轴（绕 x）
      group.rotation.set(pose.roll * 0.8, 0, pose.pitch);
    },
    dispose() {
      solidGeometry.dispose();
      solidMaterial.dispose();
      softGeometry.dispose();
      softMaterial.dispose();
    },
  };

  build.update(0);
  return build;
}
