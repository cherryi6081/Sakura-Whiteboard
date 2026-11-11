import * as THREE from "three";
import { PERIOD_SUN, readPalette, type SunState } from "./palette";
import { createMountain } from "./fuji";
import { createWater } from "./water";
import { createMist } from "./mist";
import { createPetals } from "./petals";
import { layoutCamera } from "./stage";
import type { Period } from "../usePeriod";

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
  scene.add(water.mesh, mountain.reflection, mountain.group, mist.group, petals.mesh);

  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.9);
  const ambient = new THREE.AmbientLight(0xffffff, 0.08);
  scene.add(sun, hemi, ambient);

  let currentSun = cloneSun(PERIOD_SUN[options.period]);
  let targetSun = cloneSun(PERIOD_SUN[options.period]);
  applySun(currentSun, sun, hemi);

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
    currentSun.color.lerp(targetSun.color, lightDamping);
    currentSun.sky.lerp(targetSun.sky, lightDamping);
    currentSun.ground.lerp(targetSun.ground, lightDamping);
    currentSun.dir.lerp(targetSun.dir, lightDamping).normalize();
    currentSun.intensity += (targetSun.intensity - currentSun.intensity) * lightDamping;
    currentSun.hemiIntensity +=
      (targetSun.hemiIntensity - currentSun.hemiIntensity) * lightDamping;
    applySun(currentSun, sun, hemi);

    renderer.render(scene, camera);

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
      ambient.dispose();
      sun.dispose();
      hemi.dispose();
      renderer.dispose();
      // 释放 context：来回跨越 1024px 断点时不会把 WebGL context 攒满
      renderer.forceContextLoss();
    },
  };
}
