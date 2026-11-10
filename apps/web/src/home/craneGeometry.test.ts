import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRANE_FLAP_SECONDS,
  CRANE_FLIGHT,
  CRANE_FLIGHT_SECONDS,
  CRANE_FAR_PRIMARIES,
  CRANE_LAYERS,
  CRANE_PRIMARIES,
  CRANE_SECONDARIES,
  CRANE_SHOULDER,
  CRANE_TAIL,
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

  it("次级飞羽 3 根、远翼飞羽 3 根、尾羽 3 片，且都从根部向尖端收窄", () => {
    expect(CRANE_SECONDARIES).toHaveLength(3);
    expect(CRANE_FAR_PRIMARIES).toHaveLength(3);
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

  it("可见段（0–58%）一路向左上，不回摆", () => {
    const visible = CRANE_FLIGHT.filter((frame) => frame.at <= 58);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i].x).toBeLessThan(visible[i - 1].x);
      expect(visible[i].y).toBeLessThan(visible[i - 1].y);
    }
  });

  it("最低点 84vh、最高点 -20vh：与页脚、视口上缘的关系只在预期范围内", () => {
    expect(craneFlightEnvelope()).toEqual({ minX: -10, maxX: 112, minY: -20, maxY: 84 });
  });

  it("pages.css 里的 wb-crane-flight 与 CRANE_FLIGHT 数值一一对应", () => {
    const block = keyframesBlock("wb-crane-flight");
    const frames = Array.from(
      block.matchAll(
        /(\d+)%\s*\{\s*transform:\s*translate3d\((-?[\d.]+)vw,\s*(-?[\d.]+)vh,\s*0\)\s*rotate\((-?[\d.]+)deg\)/g,
      ),
    ).map((match) => ({ at: +match[1], x: +match[2], y: +match[3], rot: +match[4] }));
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
