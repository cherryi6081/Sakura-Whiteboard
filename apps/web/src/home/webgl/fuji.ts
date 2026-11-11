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

/**
 * 环向分段数。32 时雪齿宽约 26 舞台单位（1440 下 23px），正面只数得出 5 个齿，
 * 倒影里被水纹和半透明一压就只剩 2–3 个轮廓起伏，和 SVG 版那排密齿对不上。
 * 64 把齿宽收到约 13 单位（12px），与 SVG 雪线 12–24 单位的齿距同量级；
 * 齿深仍由下沿的 t 抖动决定（0.57–0.74），深宽比落在 SVG 的区间里，
 * 而不是靠把齿拉得更尖。岩体与雪盖共用同一组角向采样，接触线不会因为两边
 * 采样密度不同而露出缝或溢出。顶点量正好翻一倍（768 → 1536 三角），不是十倍。
 */
const SEG = 64;
const PEAK_Y = 208;
const HEIGHT = WATERLINE - PEAK_Y;
const AXIS_X = 786;
const BASE_HALF = 606;
const TOP_HALF = 13;
const Z_RATIO = 0.13;

/**
 * 湖面倒影：与 SVG 版（FujiScene 的 REFLECT_MIRROR）同一套几何参数。
 *
 * - 纯镜像，压缩比 1：y' = 2·WATERLINE − y，dx = 0。
 *   山体水线以上高 358，倒影尖端落到 566 + 358 = 924，比 900 的舞台底多出 24 单位，
 *   被画面底干净裁掉 —— 这是纯镜像的必然结果，不为它缩放或抬高水线。
 * - 只有一段：纯镜像下三段之间不再有压缩差和横向错位，只剩不透明度台阶，
 *   留着必然在段边界留下可见接缝；合并成一段后，自下而上的衰减交给
 *   着色器里连续的 fade 曲线（与 SVG 的 #wb-ref-fade 同一档）。
 * - 不透明度 0.9 与 SVG 版一致，倒影才是“同一座山的镜像”而不是一层灰影。
 */
const REFLECT_COMPRESS = 1;
const REFLECT_DEPTH = HEIGHT * REFLECT_COMPRESS;
const REFLECT_OPACITY = 0.9;

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
 *
 * `shadeAt` 按该面的方位角余弦（右坡 = +1、山脊 = 0、左坡 = −1）预乘一档明度，
 * 与 SVG 版右侧那块固定的 `--fuji-shadow` 同源。为什么必须烘焙而不是靠灯光，见 facingShade。
 */
function buildCone(
  rings: RingDef[],
  colorAt: (t: number, seed: number) => THREE.Color,
  shadeAt?: (cosA: number) => number,
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
      if (shadeAt) {
        const shade = shadeAt(Math.cos(((j + 0.5) / SEG) * Math.PI * 2));
        color.setRGB(
          Math.min(1, color.r * shade),
          Math.min(1, color.g * shade),
          Math.min(1, color.b * shade),
        );
      }
      pushTriangle(out, l0, u0, l1, color);
      pushTriangle(out, u0, u1, l1, color);
    }
  }
  return out;
}

/**
 * 舞台坐标 → 世界坐标。
 *
 * `reflect` 是湖面倒影专用：绕水线镜像后按 compress 纵向压缩。**不压平 z**——
 * 山体是闭合锥面，朝向相机那一半的 z 恒为正，本来就排在不透明水面（z = −2）之前；
 * 压平反而会让背面与正面落到同一深度、被透明混合两次，整片倒影发灰。
 *
 * 镜像会翻转三角形绕序，因此这里把每个三角形的第 2、3 个顶点一起交换
 * （位置 / 颜色 / 法线三组属性同步交换），正面仍然朝外，背面照常被剔除。
 *
 * `normalSource` 用来复用山体本身的法线：镜像后再自己算，法线会跟着翻，
 * 受光面就跑到另一侧；沿用山体法线，倒影的受光面 / 背光面才与山体同侧同档。
 */
function toGeometry(
  mesh: StageMesh,
  options: {
    zShift?: number;
    reflect?: { compress: number };
    normalSource?: THREE.BufferGeometry;
  } = {},
): THREE.BufferGeometry {
  const { zShift = 0, reflect, normalSource } = options;
  const positions = new Float32Array(mesh.positions.length);

  for (let i = 0; i < mesh.positions.length; i += 3) {
    let x = mesh.positions[i];
    let y = mesh.positions[i + 1];
    if (reflect) {
      y = WATERLINE + (WATERLINE - y) * reflect.compress;
      // x 的横向错位由着色器按分段加，几何本身保持 0，三段可以共用同一份顶点
    }
    const z = mesh.positions[i + 2] + zShift;
    toWorld(x, y, z).toArray(positions, i);
  }

  const colors = new THREE.Float32BufferAttribute(mesh.colors, 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", colors);
  if (normalSource) {
    const source = normalSource.getAttribute("normal");
    geometry.setAttribute("normal", source.clone());
  } else {
    geometry.computeVertexNormals();
  }

  // 换绕序时必须三个逐顶点属性一起换，否则颜色 / 法线会错位到相邻顶点上
  if (reflect) {
    for (const name of ["position", "color", "normal"]) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      for (let i = 0; i < array.length; i += 9) {
        for (let k = 0; k < 3; k += 1) {
          const tmp = array[i + 3 + k];
          array[i + 3 + k] = array[i + 6 + k];
          array[i + 6 + k] = tmp;
        }
      }
      attribute.needsUpdate = true;
    }
  }

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

/**
 * 背光坡的烘焙明度。
 *
 * 为什么不靠灯光：Z_RATIO = 0.13 把锥体在 z 向压得很扁，朝向相机的那半边
 * 法线几乎全都指向镜头（水平分量 |nx| 平均只有 0.17，最大 0.78），
 * 两坡的 N·L 差得很少（day 0.81 vs 0.65、dusk 0.50 vs 0.75），再被 4 阶 toon
 * 量化后，day 下 96% 的面、dusk 下 100% 的面落在同一阶 —— 所以左右坡渲染同色
 * （1440 实测都是 0.746）。想把背光坡压到下一阶，主光必须压到近乎水平，
 * 受光面会跟着一起掉档，违反「受光面明度不能变」。
 *
 * 因此按坡向在顶点色里预乘一档明度，和 SVG 版右侧那块固定的 --fuji-shadow 同源：
 * 山脊（cosA = 0）不压，往右山脚平滑压到 1 − BACKFACE_SHADE。用 smoothstep 而不是
 * 阈值，坡面上不会出现新的色阶硬边，山脊线也不会断层。倒影复用同一份顶点色，
 * 因此镜像里的背光面自动跟着变暗，两坡差值不需要另算。
 */
const BACKFACE_SHADE = 0.25;

function facingShade(cosA: number): number {
  const u = Math.min(1, Math.max(0, (cosA - 0.05) / 0.8));
  return 1 - BACKFACE_SHADE * u * u * (3 - 2 * u);
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
    facingShade,
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

  // ---- 湖面倒影：绕水线纯镜像（compress = 1、dx = 0），单段 ----
  // 材质与山体共用同一张 gradientMap、同一组灯光和同一套顶点色（法线也沿用山体的），
  // 所以倒影的受光岩面、背光面、雪顶、雪影与山体是同一档明度，而不是一块同色淡影。
  const reflection = new THREE.Group();
  const reflectionUniforms = { uTime: { value: 0 }, uWater: { value: STAGE_H / 2 - WATERLINE } };

  const rockReflectionGeometry = toGeometry(rockMesh, {
    reflect: { compress: REFLECT_COMPRESS },
    normalSource: rockGeometry,
  });
  const snowReflectionGeometry = toGeometry(snowMesh, {
    reflect: { compress: REFLECT_COMPRESS },
    normalSource: snowGeometry,
  });

  const reflectionMeshes: THREE.Mesh[] = [];

  const makeReflectionMaterial = () => {
    const material = new THREE.MeshToonMaterial({
      color: 0xffffff,
      vertexColors: true,
      gradientMap: gradient,
      transparent: true,
      depthWrite: false,
    });
    const uniforms = {
      uTime: reflectionUniforms.uTime,
      uWater: reflectionUniforms.uWater,
      uOpacity: { value: REFLECT_OPACITY },
      uDepth: { value: REFLECT_DEPTH },
    };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader =
        "uniform float uTime;\nuniform float uWater;\nvarying float vRefDepth;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float refDepth = max(0.0, uWater - transformed.y);
          // 水面波动只给横向位移。SEG 提到 64 后雪齿宽约 13 舞台单位（1440 下 12px），
          // 原来 0.55 + 0.008 × 深度（最深 3.4 单位 ≈ 3px）会剪掉齿尖宽度的四分之一，
          // 齿口被揉圆。收到 0.28 + 0.0035 × 深度（最深 1.5 单位 ≈ 1.4px），
          // 水面照样有横向错动，但不再吃掉齿形；波形沿 y 的相位不变，动作频率没改。
          transformed.x += sin(transformed.y * 0.16 + uTime * 1.7 + transformed.z * 0.05) * (0.28 + refDepth * 0.0035);
          vRefDepth = refDepth;`,
        );
      shader.fragmentShader =
        "uniform float uTime;\nuniform float uOpacity;\nuniform float uDepth;\nvarying float vRefDepth;\n" +
        shader.fragmentShader.replace(
          "#include <colorspace_fragment>",
          `float d = clamp(vRefDepth / uDepth, 0.0, 1.0);
          // 前 60% 基本不衰减（镜面清晰），之后只淡到 0.82，最底部 4% 再收干净：
          // 雪顶倒影落在 d≈0.63–1.0，衰减过狠会把整块高光雪面抹成灰。
          // 单段连续曲线，没有段边界，也就不会出现横向接缝
          float fade = 1.0 - 0.18 * smoothstep(0.6, 1.0, d);
          float tipFade = 1.0 - smoothstep(0.96, 1.0, d);
          // 轻微的水面明暗呼吸，只影响明度、不参与轮廓
          float shimmer = 0.92 + 0.08 * sin(vRefDepth * 0.24 - uTime * 1.4);
          gl_FragColor.a *= uOpacity * fade * tipFade * shimmer;
          #include <colorspace_fragment>`,
        );
    };
    return material;
  };

  reflectionMeshes.push(
    new THREE.Mesh(rockReflectionGeometry, makeReflectionMaterial()),
    new THREE.Mesh(snowReflectionGeometry, makeReflectionMaterial()),
  );
  reflection.add(...reflectionMeshes);

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
      rockReflectionGeometry.dispose();
      snowReflectionGeometry.dispose();
      rockMaterial.dispose();
      snowMaterial.dispose();
      ridgeMaterial.dispose();
      reflectionMeshes.forEach((mesh) => (mesh.material as THREE.Material).dispose());
    },
  };
}
