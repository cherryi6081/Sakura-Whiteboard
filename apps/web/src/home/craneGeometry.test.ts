import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRANE_FLAP_SECONDS,
  CRANE_FLIGHT,
  CRANE_FLIGHT_SECONDS,
  CRANE_FAR_PRIMARIES,
  CRANE_FAR_LEG,
  CRANE_FAR_TOES,
  CRANE_LAYERS,
  CRANE_LEG,
  CRANE_PRIMARIES,
  CRANE_SECONDARIES,
  CRANE_SHOULDER,
  CRANE_TAIL,
  CRANE_TOES,
  CRANE_TRAIL_DELAY_SECONDS,
  CRANE_VIEWBOX,
  craneFlightEnvelope,
  featherPath,
  type Point,
} from "./craneGeometry";

const CSS = readFileSync(fileURLToPath(new URL("../styles/pages.css", import.meta.url)), "utf8");

/** 取出某条 @keyframes 的整段内容（关键帧里没有嵌套花括号） */
function keyframesBlock(name: string): string {
  const start = CSS.indexOf(`@keyframes ${name} {`);
  expect(start, `缺少 @keyframes ${name}`).toBeGreaterThan(-1);
  const end = CSS.indexOf("\n}", start);
  return CSS.slice(start, end === -1 ? CSS.length : end);
}

function lengths(feathers: readonly { base: Point; tip: Point }[]) {
  return feathers.map((feather) => Math.hypot(feather.tip.x - feather.base.x, feather.tip.y - feather.base.y));
}

describe("丹顶鹤图层顺序", () => {
  it("自下而上依次是 腿 → 远翼 → 尾羽 → 颈 → 躯干 → 近翼 → 头颈细节", () => {
    expect(CRANE_LAYERS.map((layer) => layer.id)).toEqual([
      "leg",
      "farWing",
      "tail",
      "neck",
      "body",
      "nearWing",
      "head",
    ]);
  });

  it("z-index 严格递增，近翼在躯干之上、远翼在躯干之下", () => {
    const z = CRANE_LAYERS.map((layer) => layer.z);
    expect(z).toEqual([...z].sort((a, b) => a - b));
    expect(new Set(z).size).toBe(z.length);

    const byId = new Map(CRANE_LAYERS.map((layer) => [layer.id, layer.z]));
    expect(byId.get("nearWing")!).toBeGreaterThan(byId.get("body")!);
    expect(byId.get("farWing")!).toBeLessThan(byId.get("body")!);
  });
});

describe("丹顶鹤外形比例", () => {
  it("viewBox 是 240×130，宽高比与 CSS 的 1.8462 一致", () => {
    expect(CRANE_VIEWBOX).toEqual({ width: 240, height: 130 });
    expect(+(CRANE_VIEWBOX.width / CRANE_VIEWBOX.height).toFixed(4)).toBe(1.8462);
  });

  it("近翼 5 根初级飞羽长度递增、端点彼此错开", () => {
    expect(CRANE_PRIMARIES).toHaveLength(5);
    const ls = lengths(CRANE_PRIMARIES);
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
    const tips = CRANE_PRIMARIES.map((feather) => `${feather.tip.x},${feather.tip.y}`);
    expect(new Set(tips).size).toBe(5);
  });

  it("次级飞羽 3 根、远翼飞羽 4 根、尾羽 3 片，且都从根部向尖端收窄", () => {
    expect(CRANE_SECONDARIES).toHaveLength(3);
    expect(CRANE_FAR_PRIMARIES).toHaveLength(4);
    expect(CRANE_TAIL).toHaveLength(3);
    for (const feather of [...CRANE_PRIMARIES, ...CRANE_SECONDARIES, ...CRANE_FAR_PRIMARIES, ...CRANE_TAIL]) {
      expect(feather.width).toBeGreaterThan(0);
      // 羽片一端是宽度 width 的根部，另一端是单点，所以一定是楔形
      expect(featherPath(feather.base, feather.tip, feather.width, feather.bow)).toMatch(/^M-?[\d.]+ -?[\d.]+ Q.*Z$/);
    }
  });

  it("飞羽路径起点在羽根处偏移半个羽宽，终点就是羽尖", () => {
    const d = featherPath({ x: 0, y: 0 }, { x: 0, y: 10 }, 4, 0);
    expect(d).toBe("M-2 0 Q0 5 0 10 Q0 5 2 0 Z");
  });

  it("两翼旋转原点与造型里的肩点一致", () => {
    const wing = CSS.slice(CSS.indexOf(".wb-crane__wing {"));
    const origin = wing.slice(0, wing.indexOf("}"));
    expect(origin).toContain("transform-box: view-box");
    expect(origin).toContain(`transform-origin: ${CRANE_SHOULDER.x}px ${CRANE_SHOULDER.y}px`);
  });

  it("同组相邻羽片彼此重叠（羽尖间距小于较窄一片的羽宽），不留断缝", () => {
    // 次级飞羽整根压在翼面之内、不参与外缘轮廓，不适用这条约束
    for (const group of [CRANE_PRIMARIES, CRANE_FAR_PRIMARIES, CRANE_TAIL]) {
      for (let i = 1; i < group.length; i++) {
        const gap = Math.hypot(
          group[i].tip.x - group[i - 1].tip.x,
          group[i].tip.y - group[i - 1].tip.y,
        );
        expect(gap).toBeLessThan(Math.min(group[i].width, group[i - 1].width));
      }
    }
  });

  it("有两条腿：远侧腿更短、更靠内、抬得更高", () => {
    const nearLen = Math.hypot(CRANE_LEG[2].x - CRANE_LEG[0].x, CRANE_LEG[2].y - CRANE_LEG[0].y);
    const farLen = Math.hypot(CRANE_FAR_LEG[2].x - CRANE_FAR_LEG[0].x, CRANE_FAR_LEG[2].y - CRANE_FAR_LEG[0].y);
    expect(CRANE_LEG).toHaveLength(3);
    expect(CRANE_FAR_LEG).toHaveLength(3);
    expect(farLen).toBeLessThan(nearLen);
    expect(CRANE_FAR_LEG[2].x).toBeGreaterThan(CRANE_LEG[2].x);
    expect(CRANE_FAR_LEG[2].y).toBeLessThan(CRANE_LEG[2].y);
    expect(CRANE_TOES).toHaveLength(3);
    expect(CRANE_FAR_TOES).toHaveLength(3);
  });
});

describe("丹顶鹤飞行关键帧", () => {
  it("首尾帧位置与角度完全一致，循环处不跳帧", () => {
    const first = CRANE_FLIGHT[0];
    const last = CRANE_FLIGHT[CRANE_FLIGHT.length - 1];
    expect(last).toEqual({ ...first, at: 100 });
  });

  it("时间点递增，总时长在 30–50s，振翅周期在 0.7–1.1s", () => {
    expect(CRANE_FLIGHT[0].at).toBe(0);
    for (let i = 1; i < CRANE_FLIGHT.length; i++) {
      expect(CRANE_FLIGHT[i].at).toBeGreaterThan(CRANE_FLIGHT[i - 1].at);
    }
    expect(CRANE_FLIGHT_SECONDS).toBeGreaterThanOrEqual(30);
    expect(CRANE_FLIGHT_SECONDS).toBeLessThanOrEqual(50);
    expect(CRANE_FLAP_SECONDS).toBeGreaterThanOrEqual(0.7);
    expect(CRANE_FLAP_SECONDS).toBeLessThanOrEqual(1.1);
  });

  it("俯仰角始终落在 5–15° 内", () => {
    for (const frame of CRANE_FLIGHT) {
      expect(frame.rot).toBeGreaterThanOrEqual(5);
      expect(frame.rot).toBeLessThanOrEqual(15);
    }
  });

  it("可见段（0–80%）一路向左上，不回摆", () => {
    const visible = CRANE_FLIGHT.filter((frame) => frame.at <= 80);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i].x).toBeLessThan(visible[i - 1].x);
      expect(visible[i].y).toBeLessThan(visible[i - 1].y);
    }
  });

  it("入画前与出画后透明度归零，折返段完全不可见", () => {
    // 0–2% 藏在右下角外侧、全透明；2% 之后才淡入
    expect(CRANE_FLIGHT[0].opacity).toBe(0);
    expect(CRANE_FLIGHT[1].opacity).toBe(0);
    const visible = CRANE_FLIGHT.filter((frame) => frame.at >= 4 && frame.at < 80);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((frame) => frame.opacity === 1)).toBe(true);
    const hidden = CRANE_FLIGHT.filter((frame) => frame.at >= 80);
    expect(hidden.every((frame) => frame.opacity === 0)).toBe(true);
  });

  it("两只鹤起飞间隔 1.5–3s，且后一只错开振翅相位", () => {
    expect(CRANE_TRAIL_DELAY_SECONDS).toBeGreaterThanOrEqual(1.5);
    expect(CRANE_TRAIL_DELAY_SECONDS).toBeLessThanOrEqual(3);
    const trail = CSS.slice(CSS.indexOf(".wb-scene__crane--trail {"));
    expect(trail.slice(0, trail.indexOf("}"))).toContain(
      `animation-delay: -${CRANE_FLIGHT_SECONDS - CRANE_TRAIL_DELAY_SECONDS}s`,
    );
    expect(CSS).toContain(".wb-scene__crane--trail .wb-crane__wing");
  });

  it("最低点 88vh、最高点 8vh：与页脚、视口上缘的关系只在预期范围内", () => {
    expect(craneFlightEnvelope()).toEqual({ minX: -24, maxX: 108, minY: 8, maxY: 88 });
  });

  it("pages.css 里的 wb-crane-flight 与 CRANE_FLIGHT 数值一一对应", () => {
    const block = keyframesBlock("wb-crane-flight");
    const frames = Array.from(block.matchAll(/(\d+)%\s*\{([^}]*)\}/g)).map((match) => {
      const transform = match[2].match(
        /translate3d\((-?[\d.]+)vw,\s*(-?[\d.]+)vh,\s*0\)\s*rotate\((-?[\d.]+)deg\)/,
      );
      const opacity = match[2].match(/opacity:\s*([\d.]+)/);
      expect(transform, `缺少 transform: ${match[0]}`).not.toBeNull();
      expect(opacity, `缺少 opacity: ${match[0]}`).not.toBeNull();
      return {
        at: +match[1],
        x: +transform![1],
        y: +transform![2],
        rot: +transform![3],
        opacity: +opacity![1],
      };
    });
    expect(frames).toEqual(CRANE_FLIGHT.map((frame) => ({ ...frame })));
  });

  it("pages.css 的振翅时长与幅度与 CRANE_FLAP_SECONDS 一致", () => {
    const wing = CSS.slice(CSS.indexOf(".wb-crane__wing {"));
    expect(wing.slice(0, wing.indexOf("}"))).toContain(`animation-duration: ${CRANE_FLAP_SECONDS}s`);
    expect(CSS).toContain("@keyframes wb-crane-flap-near");
    expect(CSS).toContain("@keyframes wb-crane-flap-far");
  });
});

describe("丹顶鹤运动与降级约束", () => {
  it("外层只动 transform，不出现 filter / will-change: all", () => {
    const start = CSS.indexOf(".wb-scene__crane {");
    const block = CSS.slice(start, CSS.indexOf("\n}", start));
    expect(block).toContain("will-change: transform");
    expect(block).not.toContain("filter");
    expect(block).not.toContain("will-change: all");
  });

  it("reduce 下飞行与振翅全部停掉，但鹤仍然可见（不 display:none）", () => {
    const reduce = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toContain(".wb-scene__crane,");
    expect(reduce).toContain("animation: none");
    expect(reduce).not.toMatch(/\.wb-scene__crane[^{]*\{[^}]*display:\s*none/);
  });
});
