import * as THREE from "three";
import { toWorld } from "./stage";
import type { Palette } from "./palette";

/**
 * 雾带：三片横置的薄云，替掉 SVG 里那几个椭圆云。
 * 片元里用两层噪声叠出像和纸渗墨一样的不规则边缘，竖向两头渐隐，
 * 所以不需要贴图，也不会有明显的矩形边界。
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;

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

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i += 1) {
      value += amplitude * noise(p);
      p *= 2.03;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 p = vec2(vUv.x * 3.4 + uTime * 0.012 + uSeed * 2.7, vUv.y * 1.7 + uSeed * 4.1);
    float n = fbm(p);
    float band = smoothstep(0.0, 0.36, vUv.y) * smoothstep(1.0, 0.62, vUv.y);
    float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
    float alpha = band * edge * (0.3 + 0.8 * n) * uOpacity;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`;

type BandSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  seed: number;
  opacity: number;
};

const BANDS: BandSpec[] = [
  { x: 420, y: 176, width: 1500, height: 92, z: 130, seed: 0.13, opacity: 0.36 },
  { x: 1210, y: 216, width: 1700, height: 104, z: 118, seed: 0.47, opacity: 0.32 },
  { x: 800, y: 344, width: 2300, height: 86, z: 152, seed: 0.79, opacity: 0.26 },
];

export type MistBuild = {
  group: THREE.Group;
  update(time: number): void;
  dispose(): void;
};

function buildPlane(spec: BandSpec): THREE.BufferGeometry {
  const { x, y, width, height, z } = spec;
  const left = x - width / 2;
  const right = x + width / 2;
  const top = y - height / 2;
  const bottom = y + height / 2;

  const corners: Array<[number, number, number, number]> = [
    // [stageX, stageY, u, v]
    [left, bottom, 0, 0],
    [right, bottom, 1, 0],
    [left, top, 0, 1],
    [right, top, 1, 1],
  ];

  const positions: number[] = [];
  const uvs: number[] = [];
  for (const [sx, sy, u, v] of corners) {
    const p = toWorld(sx, sy, z);
    positions.push(p.x, p.y, p.z);
    uvs.push(u, v);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  return geometry;
}

export function createMist(palette: Palette): MistBuild {
  const group = new THREE.Group();
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  const timeUniform = { value: 0 };
  const materials: THREE.ShaderMaterial[] = [];

  for (const spec of BANDS) {
    const geometry = buildPlane(spec);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: timeUniform,
        uSeed: { value: spec.seed },
        uOpacity: { value: spec.opacity },
        uColor: { value: palette.mist },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    // 透明物排序：雾在倒影之上、花瓣之下
    mesh.renderOrder = 1;
    group.add(mesh);
    materials.push(material);
    disposables.push(geometry, material);
  }

  return {
    group,
    update(time: number) {
      timeUniform.value = time;
    },
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}
