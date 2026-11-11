import * as THREE from "three";
import { STAGE_H, WATERLINE, toWorld } from "./stage";
import type { Palette } from "./palette";

/**
 * 低多边形富士山。
 *
 * 造型仍按 SVG 的山脊剖面推导：半宽随高度按 (1 − t)^1.08 收拢，山脚 606、峰顶 13，
 * 峰顶留一小块平台。横截面压扁到宽度的 13%（z 向深度），既保留真实体积与法线，
 * 又不会在透视下把山脚撑宽。顶点 x/y 在进入世界坐标前做了透视反补偿
 * （见 stage.ts 的 toWorld），因此静止时整座山的投影与 SVG 山体严丝合缝。
 *
 * 每个三角面单独一组顶点、整面同色 —— 这是版画感的来源：
 * 面与面之间有明确的色阶断点，而不是平滑渐变。
 */

const SEG = 32;
const PEAK_Y = 208;
const HEIGHT = WATERLINE - PEAK_Y;
const AXIS_X = 786;
const BASE_HALF = 606;
const TOP_HALF = 13;
const Z_RATIO = 0.13;

function halfWidth(t: number): number {
  // 指数 1.3：山腰收得比直线更紧，侧面才有富士山那种内凹的轮廓；
  // 1.0 会得到一座笔直的火山三角，和 SVG 山形对不上。
  return TOP_HALF + (BASE_HALF - TOP_HALF) * Math.pow(1 - t, 1.3);
}

/** 稳定伪随机：同一帧内多次调用结果一致，刷新页面山脉形状不变 */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

type StageMesh = { positions: number[]; colors: number[] };
type RingDef = { t: number | ((j: number) => number); radiusScale: number; radiusOffset: number };

type StageVertex = { x: number; y: number; z: number; t: number };

function ringVertex(ring: RingDef, j: number): StageVertex {
  const a = (j / SEG) * Math.PI * 2;
  const t = typeof ring.t === "function" ? ring.t(j) : ring.t;
  // 三条低频起伏 + 一点随机，做出山脊上不均匀的棱
  const wobble =
    1 +
    0.028 * Math.sin(a * 3 + t * 11) +
    0.018 * Math.sin(a * 7 - t * 5.3) +
    0.014 * (hash(j * 12.9898 + t * 78.233) - 0.5);
  const r = halfWidth(t) * wobble * ring.radiusScale + ring.radiusOffset;
  // 山脚与峰顶都不抖动，保证水线与山顶平台干净
  const jitter = t <= 0.002 || t >= 0.998 ? 0 : (hash(j * 4.71 + t * 33.7) - 0.5) * 6;
  return {
    x: AXIS_X + r * Math.cos(a),
    y: WATERLINE - HEIGHT * t + jitter,
    z: r * Z_RATIO * Math.sin(a),
    t,
  };
}

function pushTriangle(out: StageMesh, a: StageVertex, b: StageVertex, c: StageVertex, color: THREE.Color) {
  out.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < 3; i += 1) out.colors.push(color.r, color.g, color.b);
}

/**
 * 由一圈圈截面拼出锥体（非索引、每面独立颜色）。
 * 三角形绕序保证法线朝外：先 (下 j, 上 j, 下 j+1)，再 (上 j, 上 j+1, 下 j+1)。
 */
function buildCone(
  rings: RingDef[],
  colorAt: (t: number, seed: number) => THREE.Color,
): StageMesh {
  const out: StageMesh = { positions: [], colors: [] };
  for (let i = 0; i < rings.length - 1; i += 1) {
    for (let j = 0; j < SEG; j += 1) {
      const l0 = ringVertex(rings[i], j);
      const l1 = ringVertex(rings[i], j + 1);
      const u0 = ringVertex(rings[i + 1], j);
      const u1 = ringVertex(rings[i + 1], j + 1);
      const t = (l0.t + l1.t + u0.t + u1.t) / 4;
      const color = colorAt(t, i * 97 + j * 7.3);
      pushTriangle(out, l0, u0, l1, color);
      pushTriangle(out, u0, u1, l1, color);
    }
  }
  return out;
}

/** 舞台坐标 → 世界坐标；mirror 用于湖面倒影，flattenZ 把倒影压成一张贴水面的薄片 */
function toGeometry(
  mesh: StageMesh,
  options: { zShift?: number; mirror?: boolean; flattenZ?: number } = {},
): THREE.BufferGeometry {
  const { zShift = 0, mirror = false, flattenZ } = options;
  const positions = new Float32Array(mesh.positions.length);

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mirror ? WATERLINE * 2 - mesh.positions[i + 1] : mesh.positions[i + 1];
    const z = (flattenZ ?? mesh.positions[i + 2]) + zShift;
    toWorld(x, y, z).toArray(positions, i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(mesh.colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 卡通着色的三阶色带：暗部 / 中间调 / 受光，Nearest 取样保证是硬阶而不是渐变 */
function toonGradient(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([104, 168, 220, 255]), 4, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function rockColor(palette: Palette, t: number, seed: number): THREE.Color {
  const color = palette.rock.clone();
  color.lerp(palette.rockDeep, Math.min(0.7, (1 - t) * 0.75));
  if (t < 0.08) color.lerp(palette.rockFoot, (0.08 - t) * 4.5);
  const shade = 0.93 + hash(seed) * 0.1;
  color.setRGB(
    Math.min(1, color.r * shade),
    Math.min(1, color.g * shade),
    Math.min(1, color.b * shade),
  );
  return color;
}

function snowColor(palette: Palette, seed: number): THREE.Color {
  const color = palette.snow.clone().lerp(palette.snowShade, 0.1);
  const shade = 0.965 + hash(seed * 1.7) * 0.05;
  color.setRGB(
    Math.min(1, color.r * shade),
    Math.min(1, color.g * shade),
    Math.min(1, color.b * shade),
  );
  return color;
}

/** 远岸山脊：更淡更灰的一层色块，压在湖面与主山之间 */
function buildRidge(palette: Palette): StageMesh {
  const N = 56;
  const out: StageMesh = { positions: [], colors: [] };
  const top: Array<[number, number]> = [];
  for (let i = 0; i <= N; i += 1) {
    const x = -1200 + (i / N) * 4000;
    const y = WATERLINE - (34 + 26 * Math.sin(i * 0.42) + 14 * Math.sin(i * 0.17 + 1.7));
    top.push([x, y]);
  }
  const color = palette.rockDeep.clone().multiplyScalar(0.98);
  for (let i = 0; i < N; i += 1) {
    const [x0, y0] = top[i];
    const [x1, y1] = top[i + 1];
    const a: StageVertex = { x: x0, y: y0, z: 0, t: 0 };
    const b: StageVertex = { x: x1, y: y1, z: 0, t: 0 };
    const c: StageVertex = { x: x1, y: WATERLINE + 20, z: 0, t: 0 };
    const d: StageVertex = { x: x0, y: WATERLINE + 20, z: 0, t: 0 };
    pushTriangle(out, a, c, b, color);
    pushTriangle(out, a, d, c, color);
  }
  return out;
}

export type MountainBuild = {
  group: THREE.Group;
  reflection: THREE.Group;
  /** 倒影波纹与渐隐需要每帧推进时间 */
  update(time: number): void;
  dispose(): void;
};

export function createMountain(palette: Palette): MountainBuild {
  const group = new THREE.Group();
  const gradient = toonGradient();

  const rockMesh = buildCone(
    [
      { t: 0, radiusScale: 1, radiusOffset: 0 },
      { t: 0.14, radiusScale: 1, radiusOffset: 0 },
      { t: 0.28, radiusScale: 1, radiusOffset: 0 },
      { t: 0.42, radiusScale: 1, radiusOffset: 0 },
      { t: 0.56, radiusScale: 1, radiusOffset: 0 },
      { t: 0.7, radiusScale: 1, radiusOffset: 0 },
      { t: 0.82, radiusScale: 1, radiusOffset: 0 },
      { t: 0.92, radiusScale: 1, radiusOffset: 0 },
      { t: 1, radiusScale: 1, radiusOffset: 0 },
    ],
    (t, seed) => rockColor(palette, t, seed),
  );

  // 雪盖是独立网格：下沿按角度逐齿抖动（0.57–0.75），再整体外扩一点点压在岩面上
  const snowRings: RingDef[] = [
    { t: (j) => 0.57 + 0.17 * hash((j % SEG) * 9.13 + 2.7), radiusScale: 1.004, radiusOffset: 1.1 },
    { t: 0.8, radiusScale: 1.004, radiusOffset: 1.1 },
    { t: 0.88, radiusScale: 1.004, radiusOffset: 1.1 },
    { t: 0.95, radiusScale: 1.004, radiusOffset: 1.1 },
    { t: 1, radiusScale: 1.004, radiusOffset: 1.1 },
  ];

  const snowMesh = buildCone(snowRings, (_t, seed) => snowColor(palette, seed));

  const rockGeometry = toGeometry(rockMesh);
  const snowGeometry = toGeometry(snowMesh);

  // 几何是非索引的、每个三角面独立顶点，computeVertexNormals 出来就是面法线，
  // 因此不需要 flatShading，卡通台阶本身就落在每个面上
  const rockMaterial = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    gradientMap: gradient,
  });
  const snowMaterial = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    gradientMap: gradient,
  });

  group.add(new THREE.Mesh(rockGeometry, rockMaterial));
  group.add(new THREE.Mesh(snowGeometry, snowMaterial));

  // ---- 远岸山脊 ----
  const ridgeGeometry = toGeometry(buildRidge(palette), { zShift: -300 });
  const ridgeMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const ridgeMesh = new THREE.Mesh(ridgeGeometry, ridgeMaterial);
  ridgeMesh.renderOrder = 0;
  group.add(ridgeMesh);

  // ---- 湖面倒影：镜像 + 压平 + 横向波纹、越往下越淡 ----
  const reflection = new THREE.Group();
  const reflectionUniforms = { uTime: { value: 0 }, uWater: { value: STAGE_H / 2 - WATERLINE } };

  const makeReflectionMaterial = (opacity: number) => {
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = reflectionUniforms.uTime;
      shader.uniforms.uWater = reflectionUniforms.uWater;
      shader.vertexShader =
        "uniform float uTime;\nuniform float uWater;\nvarying float vDepth;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float dip = max(0.0, uWater - transformed.y);
          transformed.x += sin(transformed.y * 0.16 + uTime * 1.7 + transformed.z * 0.05) * (0.7 + dip * 0.012);
          vDepth = clamp(dip / 220.0, 0.0, 1.0);`,
        );
      shader.fragmentShader =
        "uniform float uTime;\nvarying float vDepth;\n" +
        shader.fragmentShader.replace(
          "#include <colorspace_fragment>",
          `gl_FragColor.a *= (1.0 - smoothstep(0.02, 1.0, vDepth)) * (0.72 + 0.28 * sin(vDepth * 62.0 - uTime * 1.4));
          #include <colorspace_fragment>`,
        );
    };
    return material;
  };

  const rockReflection = new THREE.Mesh(
    toGeometry(rockMesh, { mirror: true, flattenZ: 1.5 }),
    makeReflectionMaterial(0.18),
  );
  const snowReflection = new THREE.Mesh(
    toGeometry(snowMesh, { mirror: true, flattenZ: 1.5 }),
    makeReflectionMaterial(0.26),
  );
  reflection.add(rockReflection, snowReflection);

  return {
    group,
    reflection,
    update(time: number) {
      reflectionUniforms.uTime.value = time;
    },
    dispose() {
      gradient.dispose();
      rockGeometry.dispose();
      snowGeometry.dispose();
      ridgeGeometry.dispose();
      rockReflection.geometry.dispose();
      snowReflection.geometry.dispose();
      rockMaterial.dispose();
      snowMaterial.dispose();
      ridgeMaterial.dispose();
      rockReflection.material.dispose();
      snowReflection.material.dispose();
    },
  };
}
