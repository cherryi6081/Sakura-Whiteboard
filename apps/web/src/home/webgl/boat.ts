import * as THREE from "three";
import { CAM_DIST, STAGE_H, STAGE_W, toWorld } from "./stage";
import type { Palette } from "./palette";
import { BOAT_ANCHOR, sampleBoat } from "../wave";

/**
 * 湖面小舟（WebGL 版）。
 *
 * 与 SVG 版同一组形状参数，只是把 1:1 的形状按船长 86 / 船宽 18 / 桅篷 34 舞台单位重画：
 * 船身 72 宽（−36…36），船头船尾各翘起 8 单位；1440 下约 77 × 16 px，
 * 相对 1232 的山脚宽度约 7%，读成「湖上有一条船」，不是玩具。
 *
 * 运动完全由 wave.ts 的 sampleBoat 驱动（与移动端 SVG 船共用同一个采样函数）：
 * 船头/船尾高度差 → 俯仰 ±3.5°，近舷/远舷高度差 → 横摇 ±2.5°，另有 ±12 单位 / 40s 的横向漂移。
 *
 * z = 90：排在水面、水纹、山体倒影、花瓣之前，船不会被它们穿模；
 * 船底有一块压暗的接触带（soft 层里的椭圆），不做镜面倒影。
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

type Poly = Array<[number, number]>;

/** 真正的舞台坐标 → 以锚点为原点的世界偏移（同一 z 下 k 相同，所以可以直接减原点） */
function localize(stageX: number, stageY: number): [number, number] {
  const o = toWorld(BOAT_ANCHOR.x, BOAT_ANCHOR.y, Z);
  const w = toWorld(stageX, stageY, Z);
  return [w.x - o.x, w.y - o.y];
}

function addPoly(
  positions: number[],
  colors: number[],
  poly: Poly,
  color: THREE.Color,
  alpha: number,
) {
  const pts = poly.map(([x, y]) => localize(BOAT_ANCHOR.x + x, BOAT_ANCHOR.y + y));
  for (let i = 1; i < pts.length - 1; i += 1) {
    for (const p of [pts[0], pts[i], pts[i + 1]]) {
      positions.push(p[0], p[1], 0);
      colors.push(color.r, color.g, color.b, alpha);
    }
  }
}

function buildSolid(palette: Palette): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  // 船身：上沿平直、下沿微弧，两端收到船头船尾
  addPoly(
    positions,
    colors,
    [
      [-36, 0],
      [-30, 6],
      [0, 7.2],
      [30, 6],
      [36, 0],
      [30, 2.6],
      [0, 3.1],
      [-30, 2.6],
    ],
    palette.ink,
    0.62,
  );
  // 船头 / 船尾翘起
  addPoly(positions, colors, [[-36, 0], [-44, -7], [-33, -1.2]], palette.ink, 0.62);
  addPoly(positions, colors, [[36, 0], [44, -7], [33, -1.2]], palette.ink, 0.62);
  // 船篷
  addPoly(positions, colors, [[-12, 0], [-10, -12], [2, -14], [17, 0]], palette.ink, 0.5);
  // 挂灯的短杆
  addPoly(positions, colors, [[25, 0], [26.4, -15], [28, -15], [26.6, 0]], palette.ink, 0.5);
  // 渔火
  addPoly(
    positions,
    colors,
    [[24.4, -15.5], [24.4, -11.3], [28.6, -11.3], [28.6, -15.5]],
    palette.lampHot,
    0.95,
  );
  // 水面暖色碎影：三段由宽到窄
  addPoly(positions, colors, [[12, 12], [12, 14], [31, 14], [31, 12]], palette.lamp, 0.4);
  addPoly(positions, colors, [[15, 20], [15, 21.7], [28, 21.7], [28, 20]], palette.lamp, 0.28);
  addPoly(positions, colors, [[11, 28], [11, 29.4], [20, 29.4], [20, 28]], palette.lamp, 0.18);

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
  // 船底接触带：贴着水线的窄椭圆，压低一点明度，让船「压」在水上
  addSoftQuad(positions, colors, uvs, falloffs, 0, 7.5, 30, 3.6, palette.ink, 0.16, 0.55);
  // 渔火光晕
  addSoftQuad(positions, colors, uvs, falloffs, 26.5, -15.5, 40, 40, palette.lamp, 0.26, 1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setAttribute("aUv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aFalloff", new THREE.Float32BufferAttribute(falloffs, 1));
  // 两个 quad 各自两个三角形（顶点顺序与 corners 的 push 顺序一致）
  geometry.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
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
