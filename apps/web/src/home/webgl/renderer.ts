import * as THREE from "three";
import { PERIOD_SUN, readPalette, type SunState } from "./palette";
import { createMountain } from "./fuji";
import { createWater } from "./water";
import { createMist } from "./mist";
import { createPetals } from "./petals";
import { createCraneLayer, type CraneLayer } from "./crane";
import { layoutCamera } from "./stage";
import type { Period } from "../usePeriod";
import type { SkyClock } from "../skyClock";

/**
 * WebGL 场景装配与生命周期。
 *
 * 只做三件事：把天空留给 CSS（canvas 透明）、把 3D 元素按舞台对齐、
 * 让鼠标与时辰驱动相机和光。所有暂停/恢复、DPR、尺寸变化都在这里收口，
 * React 组件只负责“什么时候挂载”。
 */

const MAX_YAW = THREE.MathUtils.degToRad(2);
const MAX_PITCH = THREE.MathUtils.degToRad(0.45);

export type SceneHandle = {
  setPeriod(period: Period): void;
  dispose(): void;
};

type MountOptions = {
  period: Period;
  /** 第一帧真正画完之后再回调：用来淡入 canvas、隐藏 SVG 层，避免闪一下 */
  onFirstFrame?: () => void;
  /**
   * 丹顶鹤专用透明 canvas（z-index 2，压在山体/小舟之上、枝条之下）。
   * 鹤必须压住小舟与雁群，而主 canvas 在最底层做不到，所以单独一块；
   * 这里把它并进同一条渲染循环：同一个 camera、同一个 rAF、同一份 currentSun。
   */
  craneCanvas?: HTMLCanvasElement;
  /**
   * 天空/湖面/雾共用的那盏钟。它和下面的 currentSun 用同一个阻尼常数，
   * 且在本 tick 里先推进、再写 uniform，所以四路输出（天空渐变、湖面、雾、山/鹤的光）
   * 永远停在同一帧，不会出现「山已经变完、天空还在旧色」。
   */
  skyClock?: SkyClock;
};

function cloneSun(source: SunState): SunState {
  return {
    color: source.color.clone(),
    intensity: source.intensity,
    sky: source.sky.clone(),
    ground: source.ground.clone(),
    hemiIntensity: source.hemiIntensity,
    dir: source.dir.clone(),
  };
}

function applySun(
  state: SunState,
  sun: THREE.DirectionalLight,
  hemi: THREE.HemisphereLight,
): void {
  sun.color.copy(state.color);
  sun.intensity = state.intensity;
  sun.position.copy(state.dir).multiplyScalar(900);
  hemi.color.copy(state.sky);
  hemi.groundColor.copy(state.ground);
  hemi.intensity = state.hemiIntensity;
}

export function mountScene(canvas: HTMLCanvasElement, options: MountOptions): SceneHandle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearAlpha(0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 20, 4000);
  camera.rotation.order = "YXZ";

  const palette = readPalette();
  const water = createWater(palette);
  const mountain = createMountain(palette);
  const mist = createMist(palette);
  const petals = createPetals(palette);
  scene.add(water.mesh, water.lines, mountain.reflection, mountain.group, mist.group, petals.mesh);

  // 第二块 canvas 只画鹤：独立 WebGL 上下文、透明清屏、与主场景共用 camera 和 currentSun
  const crane: CraneLayer | null = options.craneCanvas
    ? createCraneLayer(options.craneCanvas, palette)
    : null;

  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.9);
  const ambient = new THREE.AmbientLight(0xffffff, 0.08);
  scene.add(sun, hemi, ambient);

  let currentSun = cloneSun(PERIOD_SUN[options.period]);
  let targetSun = cloneSun(PERIOD_SUN[options.period]);
  applySun(currentSun, sun, hemi);

  // 天空/湖面/雾：从同一盏钟取色，转成线性空间的 THREE.Color 再喂 uniform
  const skyClock = options.skyClock;
  const skyLake = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
  const skyHorizon = new THREE.Color();
  const skyMist = new THREE.Color();
  let skyRevision = -1;

  const toLinear = (target: THREE.Color, rgb: readonly number[]) => {
    target.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  };

  const syncSky = () => {
    if (!skyClock || skyClock.state.revision === skyRevision) return;
    skyRevision = skyClock.state.revision;
    for (let i = 0; i < skyLake.length; i += 1) toLinear(skyLake[i], skyClock.state.lake[i]);
    toLinear(skyHorizon, skyClock.state.sky[skyClock.state.sky.length - 1]);
    toLinear(skyMist, skyClock.state.mist);
    water.setColors(skyLake, skyHorizon);
    mist.setColor(skyMist);
    mountain.setHaze(skyMist);
  };
  syncSky();

  const pointer = { x: 0, y: 0 };
  let yaw = 0;
  let pitch = 0;

  const onPointerMove = (event: PointerEvent) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
  };
  const onPointerReset = () => {
    pointer.x = 0;
    pointer.y = 0;
  };

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("mouseleave", onPointerReset);

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    layoutCamera(camera, width, height);
    // 鹤 canvas 与主 canvas 同框同尺寸：尺寸/DPR 一起更新，落点用同一份舞台换算
    crane?.resize(width, height, window.innerWidth, window.innerHeight);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  let firstFrame = false;

  const tick = () => {
    const delta = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    // 阻尼跟随：鼠标停下后仍缓慢靠位，不会和指针硬绑定
    const damping = 1 - Math.exp(-delta * 3.2);
    yaw += (pointer.x * MAX_YAW - yaw) * damping;
    pitch += (-pointer.y * MAX_PITCH - pitch) * damping;
    // 静止时也留一点点呼吸，画面不会“死”住
    camera.rotation.set(
      pitch + Math.cos(time * 0.13) * 0.0014,
      yaw + Math.sin(time * 0.17) * 0.0026,
      0,
    );

    water.update(time);
    mountain.update(time);
    mist.update(time);
    petals.update(time);

    const lightDamping = 1 - Math.exp(-delta * 1.4);
    // 同一帧、同一常数：天空/湖面/雾先跟进，再让光跟进，四路一起落在同一个进度上
    skyClock?.tick(delta);
    syncSky();
    currentSun.color.lerp(targetSun.color, lightDamping);
    currentSun.sky.lerp(targetSun.sky, lightDamping);
    currentSun.ground.lerp(targetSun.ground, lightDamping);
    currentSun.dir.lerp(targetSun.dir, lightDamping).normalize();
    currentSun.intensity += (targetSun.intensity - currentSun.intensity) * lightDamping;
    currentSun.hemiIntensity +=
      (targetSun.hemiIntensity - currentSun.hemiIntensity) * lightDamping;
    applySun(currentSun, sun, hemi);

    renderer.render(scene, camera);

    // 鹤在主画面之后画：camera 的世界矩阵刚被上面这次 render 更新过，
    // 两块 canvas 天然共用同一个视口与同一帧的鼠标视差；currentSun 也已经阻尼到本帧，
    // 所以四个时辰切换时鹤与山体是同帧、同曲线变色（不另起一套光）
    if (crane) {
      crane.update(time, currentSun);
      crane.render(camera);
    }

    if (!firstFrame) {
      firstFrame = true;
      options.onFirstFrame?.();
    }
  };

  renderer.setAnimationLoop(tick);

  const onVisibility = () => {
    if (document.hidden) {
      renderer.setAnimationLoop(null);
    } else {
      // 丢掉切走期间累积的 delta，避免回来第一帧跳一大步
      clock.getDelta();
      renderer.setAnimationLoop(tick);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    setPeriod(period: Period) {
      targetSun = cloneSun(PERIOD_SUN[period]);
      skyClock?.setPeriod(period);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("mouseleave", onPointerReset);
      document.removeEventListener("visibilitychange", onVisibility);
      water.dispose();
      mountain.dispose();
      mist.dispose();
      petals.dispose();
      crane?.dispose();
      ambient.dispose();
      sun.dispose();
      hemi.dispose();
      renderer.dispose();
      // 释放 context：来回跨越 1024px 断点时不会把 WebGL context 攒满
      renderer.forceContextLoss();
    },
  };
}
