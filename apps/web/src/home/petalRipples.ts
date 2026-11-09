/**
 * 花瓣入水涟漪的落点与时刻计算。
 *
 * 为什么需要这一层：花瓣的纵向终点固定是 92%，水线位置却随视口宽高比变化
 * （16:9 约 66.6%、超宽屏约 62.9%、4:3 约 72.2%、手机约 90.4%）。所以
 * “花瓣第几秒落到水面、落点横坐标是多少”必须在**初始化 / 尺寸变化时**按
 * 已知参数算一次，而不是每帧去量。
 *
 * 计算方式：花瓣的位移关键帧是公开的（见 pages.css 的 wb-petal-path-*），
 * 每段的缓动也是固定的 ease-in / ease-in-out。这里用三次贝塞尔反解：
 * 先由水线求出纵向进度，再反解出该进度对应的时间比例，最后用同一段缓动
 * 求出该时刻的横向位移比例。整个过程纯函数、可单测，不碰 DOM。
 *
 * 拿到 `at`（入水时刻在花瓣周期内的比例）之后，渲染层用同一周期、同一延迟
 * 起一条只在 `at` 附近张开的涟漪动画，两者永远同相，不会随运行时长漂移。
 */

type Bezier = readonly [number, number, number, number];

/** CSS 的 ease-in / ease-in-out（与 pages.css 里关键帧上写的缓动一一对应） */
const EASE_IN: Bezier = [0.42, 0, 1, 1];
const EASE_IN_OUT: Bezier = [0.42, 0, 0.58, 1];

/** 一条轨迹上的一个关键帧：时间比例、纵向进度、横向位移比例、该段缓动 */
type TrackKey = {
  t: number;
  down: number;
  side: number;
  ease: Bezier;
};

/**
 * 四条花瓣轨迹的关键帧表，逐项对齐 pages.css：
 * a 0/34/68/100 → 0/0.26/0.6/1；b 0/32/66/100 → 0/0.28/0.63/1；
 * c 0/36/70/100 → 0/0.26/0.59/1；d 0/37/71/100 → 0/0.27/0.59/1。
 * side 是横向位移占 `--p-sway` 的比例（c 中段会摆到 -0.71，属于回摆）。
 */
const TRACKS: Record<PetalPath, readonly TrackKey[]> = {
  a: [
    { t: 0, down: 0, side: 0, ease: EASE_IN },
    { t: 0.34, down: 0.26, side: 0.38, ease: EASE_IN_OUT },
    { t: 0.68, down: 0.6, side: 0.66, ease: EASE_IN },
    { t: 1, down: 1, side: 1, ease: EASE_IN },
  ],
  b: [
    { t: 0, down: 0, side: 0, ease: EASE_IN },
    { t: 0.32, down: 0.28, side: 0.39, ease: EASE_IN_OUT },
    { t: 0.66, down: 0.63, side: 0.7, ease: EASE_IN },
    { t: 1, down: 1, side: 1, ease: EASE_IN },
  ],
  c: [
    { t: 0, down: 0, side: 0, ease: EASE_IN },
    { t: 0.36, down: 0.26, side: 1, ease: EASE_IN_OUT },
    { t: 0.7, down: 0.59, side: -0.71, ease: EASE_IN },
    { t: 1, down: 1, side: 0.86, ease: EASE_IN },
  ],
  d: [
    { t: 0, down: 0, side: 0, ease: EASE_IN },
    { t: 0.37, down: 0.27, side: 0.67, ease: EASE_IN_OUT },
    { t: 0.71, down: 0.59, side: 0.25, ease: EASE_IN },
    { t: 1, down: 1, side: 1, ease: EASE_IN },
  ],
};

export type PetalPath = "a" | "b" | "c" | "d";

function bezierAxis(p1: number, p2: number, u: number): number {
  const v = 1 - u;
  return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u;
}

/** 已知“输出进度”，反解贝塞尔曲线上的时间比例（x 轴） */
function timeForProgress(bezier: Bezier, progress: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (bezierAxis(bezier[1], bezier[3], mid) < progress) lo = mid;
    else hi = mid;
  }
  return bezierAxis(bezier[0], bezier[2], (lo + hi) / 2);
}

/** 已知“时间比例”，求缓动后的输出进度 */
function progressForTime(bezier: Bezier, time: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (bezierAxis(bezier[0], bezier[2], mid) < time) lo = mid;
    else hi = mid;
  }
  return bezierAxis(bezier[1], bezier[3], (lo + hi) / 2);
}

/** 纵向落到 down（0–1）时，处在整个周期的哪个时间比例 */
export function timeAtDown(path: PetalPath, down: number): number {
  if (down <= 0) return 0;
  if (down >= 1) return 1;
  const keys = TRACKS[path];
  for (let i = 0; i < keys.length - 1; i++) {
    const head = keys[i];
    const tail = keys[i + 1];
    if (down > tail.down) continue;
    const local = (down - head.down) / (tail.down - head.down);
    return head.t + timeForProgress(head.ease, local) * (tail.t - head.t);
  }
  return 1;
}

/** 给定时间比例，求横向位移占 `--p-sway` 的比例 */
export function sideAtTime(path: PetalPath, time: number): number {
  const keys = TRACKS[path];
  for (let i = 0; i < keys.length - 1; i++) {
    const head = keys[i];
    const tail = keys[i + 1];
    if (time > tail.t) continue;
    const local = (time - head.t) / (tail.t - head.t);
    return head.side + progressForTime(head.ease, local) * (tail.side - head.side);
  }
  return keys[keys.length - 1].side;
}

// ---------------------------------------------------------------------------
// 涟漪参数
// ---------------------------------------------------------------------------

/** 外圈 / 内圈 / 入水闪光一次张开的时长（秒），三段都落在 1.2–1.8s（闪光更短） */
export const OUTER_SPLASH_SECONDS = 1.7;
export const INNER_SPLASH_SECONDS = 1.45;
/** 内圈比外圈晚 0.32s 起，形成前后两圈而不是同相重影 */
export const INNER_SPLASH_DELAY = 0.32;
/** 入水瞬间的一次极短亮面：0.5s 内张开并消失，用来把「入水」这一下点出来 */
export const FLASH_SPLASH_SECONDS = 0.5;
/**
 * 峰值透明度。上一版外圈 0.32 叠 1px 描边，实测与水面只差 9 个色阶（见自检记录），
 * 属于「实现上根本看不见」而不是「轻微」。现在外圈 0.50、内圈 0.34、闪光 0.62，
 * 配合 2px 描边与近白高光色，峰值实测差 30 个色阶以上，同时总量仍是两圈淡纹 + 一次短闪。
 */
export const OUTER_PEAK_OPACITY = 0.5;
export const INNER_PEAK_OPACITY = 0.34;
export const FLASH_PEAK_OPACITY = 0.62;
/** 同时存在的涟漪上限：桌面 8、移动端 6（每片只是 3 个 transform/opacity 圆环，开销很小） */
export const MAX_CONCURRENT_DESKTOP = 8;
export const MAX_CONCURRENT_MOBILE = 6;
/**
 * 「同时存在」按肉眼还能分辨的那一段算：外圈 1.7s 里只有约 1.2s 高于 30% 峰值，
 * 尾巴已经淡到看不见，不该占额度。并发上限按这个窗口统计。
 */
export const CONCURRENCY_WINDOW = 1.2;
/** 相邻落点的最小横向间距（px，换算成 vw 后传给 planRipples）：避免同一时刻两圈叠在一起 */
export const MIN_RIPPLE_X_GAP_PX = 12;
/** 移动端屏幕窄，落到同一横坐标的花瓣本来就多，间距收得更小才能保证任意 4s 内都有涟漪 */
export const MIN_RIPPLE_X_GAP_PX_MOBILE = 4;
/** 任意时间窗内至少要能看到一次涟漪的间隔上限（秒） */
export const MAX_RIPPLE_GAP_SECONDS = 4;

export type RippleInput = {
  /** 稳定的下标，对应渲染层的占位元素 */
  key: number;
  /** 以下字段与花瓣的几何参数同名同义 */
  left: number;
  top: number;
  dur: number;
  delay: number;
  size: number;
  path: PetalPath;
  sway: number;
  fall: number;
};

/**
 * 花瓣中心落到水线时，处在周期的哪个比例。
 * 推落入水时刻、花瓣淡出窗口都用这一条公式，保证两者永远同相。
 */
export function waterTime(input: RippleInput, waterlinePct: number, vh: number): number {
  // 花瓣元素的 top 是上边缘，落到水面时看的是中心：减去半个高度
  const halfHeightPct = ((input.size * 0.94) / 2 / vh) * 100;
  return timeAtDown(input.path, (waterlinePct - input.top - halfHeightPct) / input.fall);
}

/**
 * 花瓣的淡出窗口（周期比例）：穿水线时仍是满不透明度，之后 2% 个周期收完。
 * 这样花瓣一定是看得见地落到水面、再消失，涟漪不会“凭空出现”。
 */
export function petalFade(at: number) {
  // 不把 start 提前到入水之前：花瓣到水线那一刻必须还是满不透明度，
  // 手机上入水点在周期 98% 之后，窗口也就只剩最后 1%–2%
  const start = Math.max(0.03, Math.min(at, 0.995));
  const end = Math.min(1, Math.max(start + 0.005, at + 0.02));
  return { start, end };
}

export type RipplePlan = {
  key: number;
  /** 落点横坐标（视口宽度百分比，数值上等于 vw） */
  x: number;
  /** 入水时刻在花瓣周期内的比例 */
  at: number;
  /** 花瓣周期（秒），涟漪动画用同一周期才能长期同相 */
  cycle: number;
  /** 花瓣的负延迟（秒），涟漪沿用同一个延迟 */
  delay: number;
  /** 原花瓣尺寸，仅用于挑选优先级与输出核对 */
  size: number;
};

export type PlanOptions = {
  /** 水线在视口高度中的百分比 */
  waterlinePct: number;
  /** 视口高度（px）：花瓣 top 是元素上边缘，算落地时刻要用中心 */
  vh: number;
  /** 允许出现涟漪的横向范围（视口宽度百分比） */
  minX: number;
  maxX: number;
  /** 横向最小间距（vw） */
  xGap: number;
  /** 同时存在的涟漪上限 */
  cap: number;
  /** 并发统计的时间窗口（秒） */
  horizon: number;
};

/** 一片涟漪在 horizon 内出现的时刻（秒），已把负 delay 折算成正相位 */
function splashStarts(plan: RipplePlan, horizon: number): number[] {
  const phase = (((plan.delay + plan.at * plan.cycle) % plan.cycle) + plan.cycle) % plan.cycle;
  const starts: number[] = [];
  for (let t = phase; t < horizon; t += plan.cycle) starts.push(t);
  return starts;
}

/**
 * horizon 内最长的一段「一片涟漪都看不见」的时间（秒）。
 * 把每片涟漪的所有出现时段摊平后扫一遍，前导空档也算。
 */
export function longestGapSeconds(plans: ReadonlyArray<RipplePlan>, horizon: number): number {
  const intervals: Array<[number, number]> = [];
  for (const plan of plans) {
    for (const start of splashStarts(plan, horizon)) intervals.push([start, start + OUTER_SPLASH_SECONDS]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let gap = 0;
  let end = 0;
  for (const [start, stop] of intervals) {
    if (start > end) gap = Math.max(gap, start - end);
    if (stop > end) end = stop;
  }
  return gap;
}

/**
 * 按并发上限裁剪。
 *
 * 不是「谁小砍谁」：那样会把正好填在空档里的一片砍掉、反而留下几片挤在同一秒的。
 * 这里逐个试删，选「删掉之后最长空档最小」的那一片——直接对着 4s 目标优化。
 */
function trimRipples(candidates: RipplePlan[], cap: number, horizon: number): RipplePlan[] {
  const kept = [...candidates];
  while (kept.length > 0 && countConcurrent(kept, horizon, CONCURRENCY_WINDOW) > cap) {
    let bestIndex = 0;
    let bestGap = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const rest = [...kept.slice(0, i), ...kept.slice(i + 1)];
      const gap = longestGapSeconds(rest, horizon);
      if (
        gap < bestGap - 1e-9 ||
        (Math.abs(gap - bestGap) <= 1e-9 && kept[i].size < kept[bestIndex].size)
      ) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    kept.splice(bestIndex, 1);
  }
  return kept;
}

/**
 * 选出要做涟漪的花瓣，并给出每片的落点与时刻。
 *
 * 两步走：
 * 1) 按尺寸从大到小挑，落点间距不足 xGap 的跳过——保证同一片水域不同时挤两圈；
 * 2) 按并发上限 + 最长空档裁剪，4s 空档是硬目标。
 */
/** 判断两片涟漪是否在时间上真正重叠只看 300s，已经覆盖十几个周期，足够代表长期行为 */
const OVERLAP_HORIZON = 300;

export function planRipples(inputs: ReadonlyArray<RippleInput>, options: PlanOptions): RipplePlan[] {
  const { waterlinePct, vh, minX, maxX, xGap, cap, horizon } = options;

  const candidates: RipplePlan[] = inputs
    .map((input) => {
      const at = waterTime(input, waterlinePct, vh);
      const x = input.left + input.sway * sideAtTime(input.path, at);
      return { key: input.key, x, at, cycle: input.dur, delay: input.delay, size: input.size };
    })
    // 入水点必须真的落在周期内部；横向必须落在山体倒影所在的水域
    .filter((plan) => plan.at > 0.001 && plan.at < 0.999 && plan.x >= minX && plan.x <= maxX);

  candidates.sort((a, b) => b.size - a.size || a.x - b.x);

  // 每片涟漪在 300s 内的落水时刻，用来判断两片会不会「同一时刻、同一片水域」
  const pulses = new Map<number, number[]>(
    candidates.map((plan) => [plan.key, splashStarts(plan, OVERLAP_HORIZON)]),
  );
  const collide = (a: RipplePlan, b: RipplePlan) => {
    const first = pulses.get(a.key) ?? [];
    const second = pulses.get(b.key) ?? [];
    for (const x of first) {
      for (const y of second) {
        if (Math.abs(x - y) < OUTER_SPLASH_SECONDS) return true;
      }
    }
    return false;
  };

  // 横向间距只约束「同时张开」的两片：同一处水域先后入水是自然的重复涟漪，
  // 只要不同时叠在一起，就不算「叠成一坨」。这样能留下更多花瓣，把空档压下去
  const chosen: RipplePlan[] = [];
  for (const candidate of candidates) {
    const blocked = chosen.some(
      (plan) => Math.abs(plan.x - candidate.x) < xGap && collide(plan, candidate),
    );
    if (blocked) continue;
    chosen.push(candidate);
  }

  return trimRipples(chosen, cap, horizon).sort((a, b) => a.x - b.x);
}


/**
 * 统计一段时间内同时存在的涟漪峰值。
 * 每片涟漪在自己的花瓣周期里重复出现，起止时刻按 `delay + at * cycle + k * cycle` 展开。
 */
export function countConcurrent(
  plans: ReadonlyArray<RipplePlan>,
  horizon: number,
  window = OUTER_SPLASH_SECONDS,
): number {
  const events: Array<{ t: number; delta: number }> = [];
  for (const plan of plans) {
    const first = plan.delay + plan.at * plan.cycle;
    const phase = ((first % plan.cycle) + plan.cycle) % plan.cycle;
    for (let t = phase; t < horizon; t += plan.cycle) {
      const start = Math.max(0, t);
      const end = Math.min(horizon, t + window);
      if (end <= start) continue;
      events.push({ t: start, delta: 1 });
      events.push({ t: end, delta: -1 });
    }
  }
  // 同一时刻先结算结束再结算开始，首尾相接不算重叠
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

export type RippleKeyframe = {
  offset: number;
  opacity: number;
  transform: string;
};

/**
 * 生成一圈涟漪在**整个花瓣周期**里的关键帧：只有 `at` 之后的一小段张开并淡出，
 * 其余时间完全透明。`at + span` 超过 1 时自然回绕到下一周期开头，
 * offset 0 与 offset 1 的取值相同，循环处不会跳变。
 */
export function splashFrames(
  at: number,
  cycle: number,
  splashSeconds: number,
  peak: number,
  startScale = 0.12,
): RippleKeyframe[] {
  const span = Math.min(0.85, Math.max(0.02, splashSeconds / cycle));
  const phaseOf = (offset: number) => {
    const raw = (offset - at) % 1;
    return raw < 0 ? raw + 1 : raw;
  };
  const FADE_IN = 0.18;
  const valueOf = (offset: number) => {
    const phase = phaseOf(offset);
    if (phase > span) return { opacity: 0, scale: startScale };
    const u = phase / span;
    // 前 18% 淡入，其余线性淡出；扩散先快后慢，像水面被压出的一圈
    const envelope = u < FADE_IN ? u / FADE_IN : (1 - u) / (1 - FADE_IN);
    return {
      opacity: +Math.max(0, Math.min(peak, peak * envelope)).toFixed(4),
      scale: startScale + (1 - startScale) * Math.pow(u, 0.65),
    };
  };

  const offsets = new Set<number>([0, 1]);
  // 采样点强制包含淡入终点（u = 0.18），否则峰值会被采样网格漏掉、实际只到 0.9 × peak
  for (const u of [0, FADE_IN, 0.3, 0.42, 0.54, 0.66, 0.78, 0.9, 1]) {
    const raw = at + span * u;
    offsets.add(+((((raw % 1) + 1) % 1).toFixed(6)));
  }

  return [...offsets].sort((a, b) => a - b).map((offset) => {
    const value = valueOf(offset);
    return { offset, opacity: value.opacity, transform: `scale(${+value.scale.toFixed(3)})` };
  });
}
