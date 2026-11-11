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
  update(time: number): void;
  dispose(): void;
};

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

  return {
    mesh,
    update(time: number) {
      uniforms.uTime.value = time;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
