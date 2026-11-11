import * as THREE from "three";
import { STAGE_H, STAGE_W, WATERLINE, toWorld } from "./stage";
import type { Palette } from "./palette";

/**
 * 湖面：一整块平面 + 世界坐标水纹着色。
 *
 * 透视在顶点里已经按 toWorld 反补偿过，静止时水线精确压在 SVG 的 y=566 上；
 * 片元用 vDepth（0 在水平线、1 在舞台底）驱动四档湖色、波纹频率与映天强度，
 * 于是远处纹路密、近处纹路疏，像被透视压过。
 */

// 湖面只铺到舞台底：水面高度 334 = 900 − 566，正好是 SVG 湖面 rect 的比例。
// 早先把平面往下拉长过，结果是屏幕底部只走到整块平面的 3%，四档湖色根本用不上。
const SPAN = STAGE_H - WATERLINE;
const TOP = WATERLINE;

const vertexShader = /* glsl */ `
  attribute float aStageY;
  varying float vDepth;
  varying vec3 vWorld;

  void main() {
    vDepth = clamp((aStageY - ${TOP.toFixed(1)}) / ${SPAN.toFixed(1)}, 0.0, 1.0);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uTop;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uBottom;
  uniform vec3 uSky;
  uniform vec3 uRipple;
  varying float vDepth;
  varying vec3 vWorld;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    float d = vDepth;

    // 四档湖色：0 / 28 / 66 / 100%
    vec3 color = mix(uTop, uMid, smoothstep(0.0, 0.28, d));
    color = mix(color, uDeep, smoothstep(0.28, 0.66, d));
    color = mix(color, uBottom, smoothstep(0.66, 1.0, d));

    // 越靠水线越映天
    color = mix(uSky, color, 0.3 + 0.7 * smoothstep(0.0, 0.22, d));

    // 横向水纹：远处密、近处疏
    float freq = mix(0.42, 0.19, pow(d, 0.7));
    float drift = noise(vec2(vWorld.x * 0.006, vWorld.y * 0.05 + uTime * 0.07));
    float wave = sin(vWorld.y * freq + uTime * (0.5 + d * 0.3) + drift * 6.0 + vWorld.x * 0.0007);
    float fine = sin(vWorld.y * freq * 2.7 - uTime * 0.85 + vWorld.x * 0.0016);
    float lines = smoothstep(0.9, 0.995, wave * 0.72 + fine * 0.28);
    color = mix(
      color,
      uRipple,
      lines * 0.32 * smoothstep(0.02, 0.24, d) * (1.0 - smoothstep(0.72, 1.0, d))
    );

    // 水线亮线
    color = mix(color, vec3(1.0), exp(-d * 130.0) * 0.34);

    // 抖动，压掉大色块上的色带
    color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

export type WaterBuild = {
  mesh: THREE.Mesh;
  /** 静态水纹：12 条 2.4 单位高的圆角横条（与 SVG 的 .wb-scene__lake-line 同一组坐标） */
  lines: THREE.Mesh;
  update(time: number): void;
  dispose(): void;
};

/**
 * 静态水纹：[舞台 x, 舞台 y, 宽度, 不透明度]，与 FujiScene 的 RIPPLES 逐项一致。
 * 高度固定 2.4、两端圆角半径 1.2（等于半高，端头是半圆），颜色取 palette.ripple
 * （= --paper 与 --lake-horizon 的 26% 混合，和 CSS 的 --lake-ripple 同源）。
 *
 * 画在水面（z = −2）之前、倒影（z ≈ 0）之后：倒影不透明度 0.9，水纹被压住 9 成，
 * 只会在轮廓之外的水面上露出来，不会横穿脊线或融雪齿 —— 与 SVG 的叠放次序一致。
 */
const LAKE_LINES: Array<[number, number, number, number]> = [
  [40, 594, 110, 0.5],
  [1444, 604, 112, 0.42],
  [236, 620, 86, 0.34],
  [1268, 636, 94, 0.3],
  [92, 668, 132, 0.28],
  [1382, 694, 118, 0.26],
  [520, 712, 96, 0.22],
  [980, 732, 108, 0.24],
  [1150, 790, 102, 0.3],
  [292, 856, 148, 0.26],
  [686, 874, 126, 0.22],
  [1116, 842, 138, 0.24],
];
const LINE_H = 2.4;
const LINE_Z = -1.6;

const lineVertexShader = /* glsl */ `
  attribute vec2 aSize;
  attribute vec2 aLocal;
  attribute float aAlpha;
  varying vec2 vSize;
  varying vec2 vLocal;
  varying float vAlpha;

  void main() {
    vSize = aSize;
    // 相对条中心的舞台单位偏移（透视反补偿的 k≈1.0016，这里直接用舞台偏移做 SDF 足够准）
    vLocal = aLocal;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const lineFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vSize;
  varying vec2 vLocal;
  varying float vAlpha;

  void main() {
    // 端头是半径 = 半高的半圆，用胶囊 SDF 裁出圆角横条
    float r = vSize.y * 0.5;
    vec2 p = vec2(abs(vLocal.x) - (vSize.x * 0.5 - r), 0.0);
    float d = length(max(p, 0.0)) - r;
    float a = (1.0 - smoothstep(-0.35, 0.35, d)) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`;

function buildLineGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const sizes: number[] = [];
  const locals: number[] = [];
  const alphas: number[] = [];
  const index: number[] = [];
  let base = 0;

  for (const [x, y, width, opacity] of LAKE_LINES) {
    const cx = x + width / 2;
    const cy = y + LINE_H / 2;
    const hw = width / 2;
    const hh = LINE_H / 2;
    for (const [dx, dy] of [
      [-hw, -hh],
      [-hw, hh],
      [hw, -hh],
      [hw, hh],
    ]) {
      const v = toWorld(cx + dx, cy + dy, LINE_Z);
      positions.push(v.x, v.y, v.z);
      sizes.push(width, LINE_H);
      locals.push(dx, dy);
      alphas.push(opacity);
    }
    index.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    base += 4;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 2));
  geometry.setAttribute("aLocal", new THREE.Float32BufferAttribute(locals, 2));
  geometry.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alphas, 1));
  geometry.setIndex(index);
  return geometry;
}

function buildGeometry(): THREE.BufferGeometry {
  const x0 = -1400;
  const x1 = STAGE_W + 1400;
  const y0 = TOP;
  const y1 = TOP + SPAN;
  const z = -2;

  // 左上 / 左下 / 右上 / 右下
  const corners: Array<[number, number]> = [
    [x0, y0],
    [x0, y1],
    [x1, y0],
    [x1, y1],
  ];
  const positions: number[] = [];
  for (const [x, y] of corners) {
    const v = toWorld(x, y, z);
    positions.push(v.x, v.y, v.z);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute(
    "aStageY",
    new THREE.Float32BufferAttribute([y0, y1, y0, y1], 1),
  );
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  return geometry;
}

export function createWater(palette: Palette): WaterBuild {
  const uniforms = {
    uTime: { value: 0 },
    uTop: { value: palette.lake[0] },
    uMid: { value: palette.lake[1] },
    uDeep: { value: palette.lake[2] },
    uBottom: { value: palette.lake[3] },
    uSky: { value: palette.horizon },
    uRipple: { value: palette.ripple },
  };

  const geometry = buildGeometry();
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  // 静态水纹：12 条合并成一份几何，1 个 draw call、96 个顶点
  const lineGeometry = buildLineGeometry();
  const lineMaterial = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: palette.ripple } },
    vertexShader: lineVertexShader,
    fragmentShader: lineFragmentShader,
    transparent: true,
    depthWrite: false,
  });
  const lines = new THREE.Mesh(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  // 不设 renderOrder：12 条 z = −1.6，倒影在 z ≈ 0，透明队列按深度从远到近排，
  // 水纹自然后于水面、先于倒影，与 SVG 的「水纹在倒影下面」一致

  return {
    mesh,
    lines,
    update(time: number) {
      uniforms.uTime.value = time;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
    },
  };
}
