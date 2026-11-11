import * as THREE from "three";
import type { Palette } from "./palette";
import { PETAL_BOX_ASPECT, PETAL_OUTLINE } from "../floatingPetals";

/**
 * 花瓣粒子：一次 draw call 上万片。
 *
 * 位置不在 CPU 上算 —— 每片只带一组固定参数（起点、深度、大小、速度、落程、摆幅），
 * 飘落进度由 fract 时间 + 种子在顶点着色器里推进，所以 12000 片也只是一次
 * InstancedBufferGeometry 提交，主线程每帧只更新一个 uTime。
 *
 * 层次感来自三件事：
 * 1. 深度分层 —— 三成花瓣落在山体之后（z 为负，会被山与雾自然遮挡），
 *    越远尺寸越小、越淡、越偏浅色，视差也越弱；
 * 2. 运动去同步 —— 每片有自己的落程、摆幅、摆频、自转方向与侧翻相位，
 *    避免整片花雨像一块布一起移动；
 * 3. 侧翻 —— 绕自身短轴来回翻，边缘时刻只剩一条线，中景花瓣的翻面最明显。
 *
 * 形状：四边形只是"画布"，真正的樱花瓣轮廓来自 floatingPetals.ts 的 PETAL_OUTLINE
 * （与移动端 SVG 的 clip-path 同一份 32 点：基部收窄、中段最宽、末端 V 缺刻），
 * 启动时烘成一张 96×96 的有向距离图，片元只做一次纹理采样 + fwidth 的 1px 过渡。
 * 这样不管花瓣多大、翻到多斜，边缘都是干净的抗锯齿；每个实例仍然只有一个四边形，
 * 整帧 draw call 不变，片元成本与旧的纯色填充几乎相同。
 */

const COUNT = 12000;
/** 花瓣深度分层范围：负值落在山体之后，正值压在近景 */
const Z_FAR = -240;
const Z_NEAR = 240;
/** 四边形画布与距离图覆盖的形状空间半径：比轮廓大 12%，给边缘抗锯齿留一圈余量 */
const QUAD_HALF = 1.12;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uCamDist;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  attribute vec4 aSeed;    // (相位, 色偏, 自转方向, 侧翻相位)
  attribute vec4 aParam;   // (起点 x, 深度 z, 尺寸, 下落速度)
  attribute vec4 aMotion;  // (起点 y, 落程, 摆幅, 摆频)
  varying vec2 vLocal;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float t = fract(uTime * aParam.w + aSeed.x);

    // 起点在舞台坐标里，按深度做透视反补偿（与 toWorld 同一套算法）
    float k = (uCamDist - aParam.y) / uCamDist;

    // 落程逐片不同：起点与跨度都随机，画面上不会出现同步刷新的整排花瓣
    float yStage = aMotion.x + t * aMotion.y;

    // 主摆 + 一层高频小幅颤动，整体风向仍向左
    float sway = sin(uTime * aMotion.w + aSeed.x * 6.283 + t * 5.0)
               + 0.35 * sin(uTime * aMotion.w * 2.7 + aSeed.z * 4.1);
    float xStage = aParam.x + sway * aMotion.z - t * (60.0 + aSeed.z * 150.0);

    vec3 center = vec3((xStage - 800.0) * k, (450.0 - yStage) * k, aParam.y);

    // 自转方向一半一半，速度按种子拉开
    float dir = aSeed.z < 0.5 ? -1.0 : 1.0;
    float angle = aSeed.w * 6.283 + uTime * dir * (0.18 + aSeed.y * 0.75);

    // 侧翻：绕自身短轴来回翻，翻到边缘时几乎只剩一条线
    float flip = 0.15 + 0.85 * abs(sin(uTime * (0.5 + aSeed.y * 0.9) + aSeed.w * 9.0));

    // 轮廓坐标归一化在 [-1,1]²：0.5 让“尺寸”等于花瓣宽度，纵向按盒子比例拉到 1.33
    vLocal = position.xy;
    vec2 local = vec2(position.x, position.y * ${PETAL_BOX_ASPECT.toFixed(2)}) * aParam.z * 0.5 * k;
    local.x *= flip;

    vec3 pos = center + vec3(
      local.x * cos(angle) - local.y * sin(angle),
      local.x * sin(angle) + local.y * cos(angle),
      0.0
    );

    // 深度分层：远景用浅粉而不是纯白（纯白在深色天空上会变成雪），近景更饱和
    float near = smoothstep(${Z_FAR.toFixed(1)}, ${Z_NEAR.toFixed(1)}, aParam.y);
    vec3 farColor = mix(uColorB, uColorA, 0.72 + aSeed.y * 0.2);
    vec3 nearColor = mix(uColorA, uColorB, 0.35 + aSeed.y * 0.6);
    vColor = mix(farColor, nearColor, near);

    // 淡入淡出的窗口也逐片错开
    float fade = smoothstep(0.0, 0.08 + aSeed.x * 0.06, t)
               * smoothstep(1.0, 0.78 + aSeed.z * 0.08, t);
    vAlpha = fade * (0.14 + near * 0.42) * (0.55 + aSeed.x * 0.45);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMask;

  varying vec2 vLocal;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // 距离图里 0.5 是轮廓线：大于 0.5 在外、小于 0.5 在内。
    // 图覆盖的形状空间是 ±QUAD_HALF，所以先把局部坐标折算成图的 [0,1]
    float d = texture2D(uMask, vLocal * ${(0.5 / QUAD_HALF).toFixed(4)} + 0.5).r * 2.0 - 1.0;
    // fwidth 把形状单位换算成屏幕像素，边缘过渡恒定约 1px，远近大小都不出锯齿
    float aa = max(fwidth(d), 0.004);
    float cover = 1.0 - smoothstep(-aa, aa, d);
    if (cover < 0.004) discard;
    gl_FragColor = vec4(vColor, vAlpha * cover);
    #include <colorspace_fragment>
  }
`;

/**
 * 把轮廓烘成有向距离图：每像素存 0.5 + d/2（d 是到轮廓的距离，形状单位，内部为负）。
 * 覆盖 ±QUAD_HALF 的整块画布，轮廓四周因此各留 6 个纹素，缺口尖角不会被采样边界糊掉；
 * 96×96 在 12px 的花瓣上相当于 8 倍超采样。
 */
function buildPetalMask(size = 96): THREE.DataTexture {
  const data = new Uint8Array(size * size);
  const n = PETAL_OUTLINE.length;
  for (let gy = 0; gy < size; gy += 1) {
    const py = QUAD_HALF - ((gy + 0.5) / size) * 2 * QUAD_HALF;
    for (let gx = 0; gx < size; gx += 1) {
      const px = ((gx + 0.5) / size) * 2 * QUAD_HALF - QUAD_HALF;
      let best = Infinity;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
        const [xi, yi] = PETAL_OUTLINE[i];
        const [xj, yj] = PETAL_OUTLINE[j];
        const ex = xj - xi;
        const ey = yj - yi;
        const wx = px - xi;
        const wy = py - yi;
        const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
        const dx = wx - ex * t;
        const dy = wy - ey * t;
        best = Math.min(best, dx * dx + dy * dy);
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      const d = Math.sqrt(best) * (inside ? -1 : 1);
      data[gy * size + gx] = Math.round(Math.min(1, Math.max(0, 0.5 + d * 0.5)) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export type PetalsBuild = {
  mesh: THREE.Mesh;
  update(time: number): void;
  dispose(): void;
};

export function createPetals(palette: Palette): PetalsBuild {
  // 四边形只是承托距离图的画布：与距离图同样覆盖 ±QUAD_HALF，轮廓外留一圈抗锯齿余量
  const shape = new Float32Array([
    -QUAD_HALF, -QUAD_HALF, 0,
    QUAD_HALF, -QUAD_HALF, 0,
    QUAD_HALF, QUAD_HALF, 0,
    -QUAD_HALF, QUAD_HALF, 0,
  ]);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(shape, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = COUNT;

  const seeds = new Float32Array(COUNT * 4);
  const params = new Float32Array(COUNT * 4);
  const motion = new Float32Array(COUNT * 4);

  for (let i = 0; i < COUNT; i += 1) {
    // 六成从右侧枝头一带飘出，四成铺满全幅
    const fromBranch = Math.random() < 0.62;
    const x = fromBranch ? 700 + Math.random() * 880 : -300 + Math.random() * 1900;

    // 三成落在山体之后，七成在近景
    const behind = Math.random() < 0.3;
    const z = behind ? Z_FAR + Math.random() * (0 - Z_FAR) : 0 + Math.random() * Z_NEAR;
    const near = (z - Z_FAR) / (Z_NEAR - Z_FAR);

    // 尺寸与深度绑定：远处小而淡，只有近处几片能看清形状
    const size = (1.0 + Math.pow(Math.random(), 3) * 7.5) * (0.55 + near * 0.95);
    // 近处落得更快，配合视差形成前后错落
    const speed = (0.03 + Math.random() * 0.04) * (0.6 + near * 0.7);

    seeds[i * 4] = Math.random();
    seeds[i * 4 + 1] = Math.random();
    seeds[i * 4 + 2] = Math.random();
    seeds[i * 4 + 3] = Math.random();

    params[i * 4] = x;
    params[i * 4 + 1] = z;
    params[i * 4 + 2] = size;
    params[i * 4 + 3] = speed;

    // 起点 −220…340、落程 380…760：每片的区间都不同，
    // 越靠上覆盖的花瓣越少，不会在顶部堆出一条“雪带”
    motion[i * 4] = -220 + Math.random() * 560;
    motion[i * 4 + 1] = 380 + Math.random() * 380;
    motion[i * 4 + 2] = 18 + Math.random() * 62;
    motion[i * 4 + 3] = 0.35 + Math.random() * 0.85;
  }

  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.setAttribute("aParam", new THREE.InstancedBufferAttribute(params, 4));
  geometry.setAttribute("aMotion", new THREE.InstancedBufferAttribute(motion, 4));

  const mask = buildPetalMask();

  const uniforms = {
    uTime: { value: 0 },
    uCamDist: { value: 1000 },
    uColorA: { value: palette.petalLight },
    uColorB: { value: palette.petalDeep },
    uMask: { value: mask },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // 花瓣永远压在雾与倒影之上，不会被雾洗淡
  mesh.renderOrder = 3;

  return {
    mesh,
    update(time: number) {
      uniforms.uTime.value = time;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mask.dispose();
    },
  };
}
