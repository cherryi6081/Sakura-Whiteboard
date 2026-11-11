/**
 * 首页丹顶鹤的 WebGL 图层（独立透明 canvas）。
 *
 * 为什么是第二块 canvas：小舟与雁群留在 SVG（z-index 1），主 canvas 在 z-index 0，
 * 把鹤画进主 canvas 就必然钻到小舟后面。鹤只需要「压在小舟之上、枝条与落瓣之下」，
 * 所以单独一块**透明** canvas 落在 z-index 2 即可，不用改任何现有 z-index，
 * 也不用把已经退回 SVG 的小舟再搬回 canvas。
 *
 * 挂载（第二步接线）：
 *   <canvas className="wb-scene__crane-canvas" aria-hidden />
 *   .wb-scene__crane-canvas {
 *     position: absolute; inset: 0; z-index: 2;
 *     display: block; width: 100%; height: 100%; pointer-events: none;
 *   }
 *   z-index 2 > 山体/小舟/雁群(1)，与枝条/涟漪/浮瓣同为 2 但它们在 DOM 之后 → 压住鹤，
 *   落瓣(3)最上。层级关系与现在 CSS 版鹤完全一致，点击穿透靠 pointer-events: none。
 *
 * 与主 canvas 的同步：
 *   - 共用**同一个 camera 实例**、同一个 rAF（由主 renderer 的 tick 调用 render），
 *     所以鼠标视差、相机视口、DPR 变化、时辰缓动都在同一帧、同一条曲线上；
 *   - 颜色不另起一套：每帧从主 renderer 已经阻尼好的 currentSun 推导（见 applyTone），
 *     四个时辰切换时鹤与山体同帧同缓动变色；
 *   - 落点与 CSS 版严格一致：航路百分比按 vw/vh 还原（与 translate3d 同源），
 *     再经与 layoutCamera 相同的 meet 缩放换算进舞台坐标。
 *
 * 合成参数（避免暗边/发灰）：
 *   alpha: true、premultipliedAlpha: true、clearAlpha 0、antialias: true；
 *   材质用**预乘混合**（ONE / ONE_MINUS_SRC_ALPHA），片元输出 vec4(c * a, a)。
 *   这样 MSAA 解析后的边缘（RGB 已乘覆盖率、A 为覆盖率）与浏览器按预乘合成完全一致，
 *   亚像素墨线不会出现黑边或灰雾。
 */
import * as THREE from "three";
import type { Palette, SunState } from "./palette";
import { buildCraneGeometry, CRANE_LOCAL_HEIGHT, CRANE_ROLE } from "./craneMesh";
import {
  CRANE_FLAP,
  CRANE_FLAP_SECONDS,
  CRANE_FLIGHT,
  CRANE_FLIGHT_SECONDS,
  CRANE_TRAIL_DELAY_SECONDS,
} from "../craneGeometry";
import { CAM_DIST, readStageLayout, STAGE_H, STAGE_W } from "./stage";

const DEG2RAD = Math.PI / 180;

/** 每根轴上的 5 个通道预先烘成 Float32Array：update 里只有标量插值，没有任何对象分配 */
const FRAME_COUNT = CRANE_FLIGHT.length;
const FRAME_AT = new Float32Array(FRAME_COUNT);
const FRAME_X = new Float32Array(FRAME_COUNT);
const FRAME_Y = new Float32Array(FRAME_COUNT);
const FRAME_ROT = new Float32Array(FRAME_COUNT);
const FRAME_OPACITY = new Float32Array(FRAME_COUNT);

for (let i = 0; i < FRAME_COUNT; i += 1) {
  const frame = CRANE_FLIGHT[i];
  FRAME_AT[i] = (frame.at / 100) * CRANE_FLIGHT_SECONDS;
  FRAME_X[i] = frame.x;
  FRAME_Y[i] = frame.y;
  FRAME_ROT[i] = frame.rot;
  FRAME_OPACITY[i] = frame.opacity;
}

/** 后鹤比前鹤晚 3s：等价于 CSS 的 animation-delay: -22s */
const TRAIL_PHASE = CRANE_FLIGHT_SECONDS - CRANE_TRAIL_DELAY_SECONDS;
/** 后鹤振翅同样滞后 0.31s */
const TRAIL_WING_PHASE = 0.31;

/** 洞察点：后鹤的 z 比前鹤远，视差略小；两者都在花瓣与雾的下层 canvas 之上 */
const LEAD_Z = 210;
const TRAIL_Z = 60;

const LEAD_ALPHA = 1;
const TRAIL_ALPHA = 0.88;
/** 腿：并拢后拖，±2°，滞后 0.17 个振翅周期（只做一组，不拆远近腿） */
const LEG_SWING_DEG = 2;
const LEG_LAG_PHASE = 0.17;

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 aNormal;
  attribute float aSide;
  attribute float aWidth;
  attribute float aRole;
  attribute float aAlpha;

  uniform float uCssPxPerLocal;

  varying float vRole;
  varying float vAlpha;

  void main() {
    float stroke = step(0.5, abs(aSide));
    // 墨线按屏幕像素保底 1px：局部线宽不足 1px 时把几何撑到 1px、同时按比例降 alpha，
    // 既不会因为亚像素覆盖丢样本而闪烁，也保住 SVG 里那种「淡墨」而不是实心黑边。
    float minLocal = 1.0 / uCssPxPerLocal;
    float width = max(aWidth, minLocal);
    vec2 offset = aNormal * (aSide * width * 0.5) * stroke;
    float subPixel = min(1.0, aWidth * uCssPxPerLocal);

    vAlpha = aAlpha * mix(1.0, subPixel, stroke);
    vRole = aRole;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy + offset, position.z, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uWhite;
  uniform vec3 uShade;
  uniform vec3 uEdge;
  uniform vec3 uInk;
  uniform vec3 uCrown;
  uniform vec3 uBeak;
  uniform vec3 uLeg;
  uniform vec3 uEye;
  uniform vec3 uShaft;
  uniform vec3 uFarFace;
  uniform vec3 uNearFace;
  uniform float uAlpha;
  uniform float uInkAlpha;

  varying float vRole;
  varying float vAlpha;

  void main() {
    vec3 color;
    float alpha = vAlpha * uAlpha;

    if (vRole < 0.5) color = uWhite;
    else if (vRole < 1.5) color = uShade;
    else if (vRole < 2.5) color = uEdge;
    else if (vRole < 3.5) { color = uInk; alpha *= uInkAlpha; }
    else if (vRole < 4.5) color = uCrown;
    else if (vRole < 5.5) color = uBeak;
    else if (vRole < 6.5) color = uLeg;
    else if (vRole < 7.5) color = uEye;
    else if (vRole < 8.5) color = uShaft;
    else if (vRole < 9.5) color = uFarFace;
    else color = uNearFace;

    if (alpha < 0.004) discard;
    // 预乘输出：与 premultipliedAlpha: true 的合成方式严格一致
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

type RoleColors = THREE.Color[];

function srgbToken(name: string, fallback: string): THREE.Color {
  const color = new THREE.Color(fallback);
  if (typeof window !== "undefined") {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (raw) {
      try {
        color.set(raw);
      } catch {
        /* 保持 fallback */
      }
    }
  }
  return color.convertLinearToSRGB();
}

function roleBaseColors(): RoleColors {
  const white = srgbToken("--crane-white", "#fbfcfe");
  const shade = srgbToken("--crane-shade", "#d7e2ec");
  const colors: RoleColors = [
    white.clone(),
    shade.clone(),
    srgbToken("--crane-edge", "#7e96ab"),
    srgbToken("--crane-ink", "#1b2026"),
    srgbToken("--crane-crown", "#c23a2c"),
    srgbToken("--crane-beak", "#2a2f34"),
    srgbToken("--crane-leg", "#333a40"),
    srgbToken("--crane-eye", "#14181c"),
    srgbToken("--crane-shaft", "#a9bccd"),
    // 远翼面：白 55% + 冷灰 45%；近翼面：白 60% + 冷灰 40%（与 CSS color-mix 同值）
    white.clone().lerp(shade, 0.45),
    white.clone().lerp(shade, 0.4),
  ];
  return colors;
}

const ROLE_UNIFORM_KEYS = [
  "uWhite",
  "uShade",
  "uEdge",
  "uInk",
  "uCrown",
  "uBeak",
  "uLeg",
  "uEye",
  "uShaft",
  "uFarFace",
  "uNearFace",
] as const;

function luminance(color: THREE.Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function smoothstepInverse(value: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (from - value) / (from - to)));
  return t * t * (3 - 2 * t);
}

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

type CraneRig = {
  root: THREE.Group;
  bob: THREE.Group;
  legs: THREE.Mesh;
  farWing: THREE.Mesh;
  nearWing: THREE.Mesh;
  material: THREE.ShaderMaterial;
  colors: RoleColors;
  cursor: number;
  phase: number;
  wingPhase: number;
  alphaScale: number;
  haze: number;
  z: number;
  hCss: number;
  unit: number;
};

type Layout = {
  scale: number;
  left: number;
  top: number;
};

/**
 * 与主 canvas 同一个上限：鹤克制在 8 个 draw call、几何很小，真正占显存的是
 * 这块全屏透明缓冲，DPR 必须和主 canvas 一致才不会让鹤比山体糊一档。
 * 想省显存只改这一个数（1.5 可省约四成缓冲，肉眼几乎看不出）。
 */
const MAX_PIXEL_RATIO = 2;

export type CraneLayer = {
  update(time: number, sun: SunState): void;
  render(camera: THREE.Camera): void;
  resize(width: number, height: number, viewportWidth: number, viewportHeight: number): void;
  readonly stats: { drawCalls: number; triangles: number };
  dispose(): void;
};

export function createCraneLayer(canvas: HTMLCanvasElement, palette: Palette): CraneLayer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    powerPreference: "high-performance",
    depth: false,
    stencil: false,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  const geometry = buildCraneGeometry();
  const baseColors = roleBaseColors();

  const sunSrgb = new THREE.Color();
  const skySrgb = new THREE.Color();
  const mistSrgb = new THREE.Color();
  const tint = new THREE.Color();
  const tintSoft = new THREE.Color();
  const paper = srgbToken("--paper", "#ffffff");

  const backdrop = palette.rockDeep.clone().convertLinearToSRGB().multiplyScalar(0.75);
  const backdropLuminance = luminance(backdrop);

  const makeMaterial = (): THREE.ShaderMaterial => {
    const colors = baseColors.map((c) => c.clone());
    const uniforms: Record<string, THREE.IUniform> = {
      uAlpha: { value: 1 },
      uInkAlpha: { value: 1 },
      uCssPxPerLocal: { value: 0.637 },
    };
    ROLE_UNIFORM_KEYS.forEach((key, index) => {
      uniforms[key] = { value: colors[index] };
    });
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      // 预乘 alpha 混合：输出已经是 color * alpha，因此源因子取 ONE
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
  };

  const makeRig = (options: {
    phase: number;
    wingPhase: number;
    alphaScale: number;
    haze: number;
    z: number;
    order: number;
  }): CraneRig => {
    const material = makeMaterial();
    const colors = ROLE_UNIFORM_KEYS.map((key) => material.uniforms[key].value as THREE.Color);

    const root = new THREE.Group();
    const flip = new THREE.Group();
    const bob = new THREE.Group();
    flip.scale.x = -1;

    const legs = new THREE.Mesh(geometry.groups.legs, material);
    legs.position.set(geometry.pivots.hip.x, geometry.pivots.hip.y, 0);
    legs.renderOrder = options.order;

    const farWing = new THREE.Mesh(geometry.groups.farWing, material);
    farWing.position.set(geometry.pivots.shoulder.x, geometry.pivots.shoulder.y, 0);
    farWing.renderOrder = options.order + 0.25;

    const body = new THREE.Mesh(geometry.groups.body, material);
    body.renderOrder = options.order + 0.5;

    const nearWing = new THREE.Mesh(geometry.groups.nearWing, material);
    nearWing.position.set(geometry.pivots.shoulder.x, geometry.pivots.shoulder.y, 0);
    nearWing.renderOrder = options.order + 0.75;

    bob.add(legs, farWing, body, nearWing);
    flip.add(bob);
    root.add(flip);
    scene.add(root);

    return {
      root,
      bob,
      legs,
      farWing,
      nearWing,
      material,
      colors,
      cursor: 0,
      phase: options.phase,
      wingPhase: options.wingPhase,
      alphaScale: options.alphaScale,
      haze: options.haze,
      z: options.z,
      hCss: 82.8,
      unit: 1,
    };
  };

  const lead = makeRig({
    phase: 0,
    wingPhase: 0,
    alphaScale: LEAD_ALPHA,
    haze: 0,
    z: LEAD_Z,
    order: 2,
  });
  const trail = makeRig({
    phase: TRAIL_PHASE,
    wingPhase: TRAIL_WING_PHASE,
    alphaScale: TRAIL_ALPHA,
    haze: 0.16,
    z: TRAIL_Z,
    order: 1,
  });
  const rigs: CraneRig[] = [trail, lead];

  const layout: Layout = { scale: 1, left: 0, top: 0 };
  let viewportW = 0;
  let viewportH = 0;

  const applyTone = (rig: CraneRig, night: number, haze: number): void => {
    const colors = rig.colors;
    tint.copy(baseColors[0]).lerp(sunSrgb, 0.16);
    tintSoft.copy(baseColors[0]).lerp(sunSrgb, 0.1);

    // 白羽：**不能乘 tint**。tint 本身是由同一个白羽色向阳光色 lerp 出来的，
    // 两个接近 1 的通道相乘只会把白压暗（#fbfcfe → #f7f8fa，L 0.973 → 0.938），
    // 而 SVG 分支的白羽是实打实的 #fbfcfe —— 鹤一搬到 WebGL 就整体变深一档。
    // 改成向阳光色 lerp 同样的 0.16，色偏还在、明度不再被乘掉；夜里也不再额外压 10%，
    // 夜色交给与 SVG 同一层的 CSS 叠色，两个分支才对得上。
    colors[CRANE_ROLE.white]
      .copy(baseColors[CRANE_ROLE.white])
      .lerp(sunSrgb, 0.16)
      .lerp(skySrgb, 0.04 + 0.05 * night);
    colors[CRANE_ROLE.shade]
      .copy(baseColors[CRANE_ROLE.shade])
      .lerp(skySrgb, 0.16)
      .multiplyScalar(1 - 0.07 * night);
    colors[CRANE_ROLE.edge].copy(baseColors[CRANE_ROLE.edge]).lerp(skySrgb, 0.1 + 0.08 * night);
    colors[CRANE_ROLE.ink].copy(baseColors[CRANE_ROLE.ink]).lerp(skySrgb, 0.04 + 0.24 * night);
    colors[CRANE_ROLE.crown]
      .copy(baseColors[CRANE_ROLE.crown])
      .multiply(tintSoft)
      .multiplyScalar(1 - 0.1 * night);
    colors[CRANE_ROLE.beak].copy(baseColors[CRANE_ROLE.beak]).lerp(skySrgb, 0.02 + 0.24 * night);
    colors[CRANE_ROLE.leg].copy(baseColors[CRANE_ROLE.leg]).lerp(skySrgb, 0.02 + 0.24 * night);
    colors[CRANE_ROLE.eye].copy(baseColors[CRANE_ROLE.eye]).lerp(skySrgb, 0.05 + 0.15 * night);
    colors[CRANE_ROLE.shaft].copy(baseColors[CRANE_ROLE.shaft]).lerp(skySrgb, 0.08 + 0.18 * night);
    colors[CRANE_ROLE.farFace]
      .copy(baseColors[CRANE_ROLE.farFace])
      .multiply(tint)
      .lerp(skySrgb, 0.1)
      .multiplyScalar(1 - 0.08 * night);
    colors[CRANE_ROLE.nearFace]
      .copy(baseColors[CRANE_ROLE.nearFace])
      .multiply(tint)
      .lerp(skySrgb, 0.1)
      .multiplyScalar(1 - 0.08 * night);

    // 墨线与深色山体（背光面）的对比保底：差距不足 0.16 时向纸色提亮，最多 30%。
    // 墨羽压在暗部时读成冷石墨而不是一个黑洞；不会把整只鹤提亮。
    const gap = backdropLuminance - luminance(colors[CRANE_ROLE.ink]);
    if (gap < 0.16) {
      colors[CRANE_ROLE.ink].lerp(paper, Math.min(0.3, (0.16 - gap) * 1.6));
    }

    // 空气透视：后鹤整体向雾色靠、明度抬一档；前鹤 haze = 0
    if (haze > 0) {
      for (const color of colors) color.lerp(mistSrgb, haze);
    }
  };

  const updateRig = (rig: CraneRig, time: number): void => {
    const t = wrap(time + rig.phase, CRANE_FLIGHT_SECONDS);

    if (t < FRAME_AT[rig.cursor]) rig.cursor = 0;
    while (rig.cursor < FRAME_COUNT - 1 && t >= FRAME_AT[rig.cursor + 1]) {
      rig.cursor += 1;
    }

    const i = rig.cursor;
    const j = Math.min(i + 1, FRAME_COUNT - 1);
    const span = FRAME_AT[j] - FRAME_AT[i];
    const f = span > 0 ? Math.min(1, Math.max(0, (t - FRAME_AT[i]) / span)) : 0;

    const x = FRAME_X[i] + (FRAME_X[j] - FRAME_X[i]) * f;
    const y = FRAME_Y[i] + (FRAME_Y[j] - FRAME_Y[i]) * f;
    const rot = FRAME_ROT[i] + (FRAME_ROT[j] - FRAME_ROT[i]) * f;
    const opacity = FRAME_OPACITY[i] + (FRAME_OPACITY[j] - FRAME_OPACITY[i]) * f;

    const cxPx = (x / 100) * viewportW;
    const cyPx = (y / 100) * viewportH;
    const sx = (cxPx - layout.left) / layout.scale;
    const sy = (cyPx - layout.top) / layout.scale;
    const k = (CAM_DIST - rig.z) / CAM_DIST;

    rig.root.position.set((sx - STAGE_W / 2) * k, (STAGE_H / 2 - sy) * k, rig.z);
    rig.root.scale.set(rig.unit * k, -rig.unit * k, 1);
    // 舞台 y 向下、世界 y 向上：屏幕顺时针 rot 对应 rotation.z = -rot
    rig.root.rotation.z = -rot * DEG2RAD;

    const flapPhase = wrap((time + rig.wingPhase) / CRANE_FLAP_SECONDS, 1);
    const ease = 0.5 - 0.5 * Math.cos(flapPhase * Math.PI * 2);
    const nearAngle = CRANE_FLAP.near.from + (CRANE_FLAP.near.to - CRANE_FLAP.near.from) * ease;
    const farAngle = CRANE_FLAP.far.from + (CRANE_FLAP.far.to - CRANE_FLAP.far.from) * ease;

    rig.nearWing.rotation.z = nearAngle * DEG2RAD;
    rig.farWing.rotation.z = farAngle * DEG2RAD;
    // 与 CSS 的 wb-crane-bob 同相：相位 0 / 1 归位，半周期（振翅下压）抬到 -2% 鹤高
    rig.bob.position.y = -geometry.bobOffset * ease;

    const legPhase = wrap((time + rig.wingPhase) / CRANE_FLAP_SECONDS - LEG_LAG_PHASE, 1);
    rig.legs.rotation.z = Math.sin(legPhase * Math.PI * 2) * LEG_SWING_DEG * DEG2RAD;

    rig.material.uniforms.uAlpha.value = opacity * rig.alphaScale;
  };

  return {
    update(time: number, sun: SunState): void {
      sunSrgb.copy(sun.color).convertLinearToSRGB();
      skySrgb.copy(sun.sky).convertLinearToSRGB();
      mistSrgb.copy(palette.mist).convertLinearToSRGB();
      const night = smoothstepInverse(sun.intensity, 2.5, 1.2);

      for (const rig of rigs) {
        updateRig(rig, time);
        // 后鹤的空气透视强度随夜色略增（雾更厚），前鹤保持 0
        const haze = rig.haze > 0 ? rig.haze + 0.06 * night : 0;
        applyTone(rig, night, haze);
        rig.material.uniforms.uInkAlpha.value = rig.haze > 0 ? 0.85 : 1;
      }
    },

    render(camera: THREE.Camera): void {
      renderer.render(scene, camera);
    },

    resize(width: number, height: number, vw: number, vh: number): void {
      if (width <= 0 || height <= 0) return;
      viewportW = vw;
      viewportH = vh;

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
      renderer.setSize(width, height, false);

      // 与主 canvas 同一份舞台换算（stage.ts）：落点、缩放、视差补偿不会两边各算一套
      const stage = readStageLayout(width, height);
      layout.scale = stage.scale;
      layout.left = stage.left;
      layout.top = stage.top;

      // 与 CSS 的 --crane-h / --crane-h-trail 同一公式（clamp(min, 9.2vh / 7.6vh, max)）
      const leadH = Math.min(132, Math.max(76, 0.092 * vh));
      const trailH = Math.min(108, Math.max(62, 0.076 * vh));

      for (const rig of rigs) {
        rig.hCss = rig === lead ? leadH : trailH;
        rig.unit = rig.hCss / CRANE_LOCAL_HEIGHT / layout.scale;
        // CSS px / 局部单位：墨线保底 1px 与亚像素 alpha 都靠它
        rig.material.uniforms.uCssPxPerLocal.value = Math.max(
          0.01,
          rig.hCss / CRANE_LOCAL_HEIGHT,
        );
      }
    },

    get stats() {
      return {
        drawCalls: rigs.length * 4,
        triangles: geometry.stats.triangles * rigs.length,
      };
    },

    dispose(): void {
      geometry.groups.legs.dispose();
      geometry.groups.farWing.dispose();
      geometry.groups.body.dispose();
      geometry.groups.nearWing.dispose();
      for (const rig of rigs) rig.material.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
