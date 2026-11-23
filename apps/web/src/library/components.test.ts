import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { COMPONENTS } from "./components";
import { TEMPLATE_COMPONENTS } from "./map";
import { PALETTE } from "./spec";

type Skeleton = Record<string, unknown>;
const entries = new Map(CATALOG.map((entry) => [entry.slug, entry]));

function elementsOf(slug: string): Skeleton[] {
  const entry = entries.get(slug);
  if (!entry) throw new Error(`missing catalog entry ${slug}`);
  return entry.build(PALETTE.light) as unknown as Skeleton[];
}

describe("元件库补全", () => {
  it("每个元件都能构建出元素，且没有任何元件是空条目", () => {
    const empty = COMPONENTS.filter((component) => elementsOf(component.slug).length === 0);
    expect(empty).toEqual([]);
  });

  it("关系线用原生箭头形态区分线型与端点，不靠文字", () => {
    const shape = (slug: string) => {
      const el = elementsOf(slug)[0];
      return {
        type: el.type,
        start: el.startArrowhead ?? null,
        end: el.endArrowhead ?? null,
        dash: el.strokeStyle ?? null,
      };
    };
    expect(shape("el-uml-assoc")).toMatchObject({ type: "line", start: null, end: null });
    expect(shape("el-uml-directed")).toMatchObject({ type: "arrow", end: "arrow" });
    expect(shape("el-uml-generalization")).toMatchObject({ end: "triangle_outline", dash: "solid" });
    expect(shape("el-uml-realization")).toMatchObject({ end: "triangle_outline", dash: "dashed" });
    expect(shape("el-uml-dependency")).toMatchObject({ end: "arrow", dash: "dashed" });
    expect(shape("el-uml-composition")).toMatchObject({ start: "diamond" });
    expect(shape("el-uml-aggregation")).toMatchObject({ start: "diamond_outline" });
    expect(shape("el-er-mton")).toMatchObject({ start: "crowfoot_one", end: "crowfoot_many" });
    expect(shape("el-seq-async")).toMatchObject({ end: "arrow" });
    expect(shape("el-msg-return")).toMatchObject({ dash: "dashed" });
  });

  it("跨图种共用的关系元件在各模板下都出现", () => {
    const templatesOf = (slug: string) =>
      Object.entries(TEMPLATE_COMPONENTS)
        .filter(([, slugs]) => slugs.includes(slug))
        .map(([template]) => template);
    expect(templatesOf("el-uml-generalization")).toEqual(expect.arrayContaining(["uml", "usecase"]));
    expect(templatesOf("el-arch-call")).toEqual(expect.arrayContaining(["layered", "micro"]));
    expect(templatesOf("el-er-rel")).toEqual(expect.arrayContaining(["uml", "er"]));
  });

  it("复合元件成组插入，绑定文本保留", () => {
    const fragment = elementsOf("el-seq-fragment");
    const groupIds = new Set(fragment.flatMap((el) => (el.groupIds as string[]) ?? []));
    expect(fragment.length).toBeGreaterThan(1);
    expect([...groupIds].some(Boolean)).toBe(true);

    const [stateBox] = elementsOf("el-state-box");
    expect(stateBox.type).toBe("rectangle");
    expect((stateBox.label as { text?: string } | undefined)?.text).toBe("状态");
  });

  it("目录里的元件条目与归属表一一对应", () => {
    const known = new Set(COMPONENTS.map((component) => component.slug));
    const dangling = Object.values(TEMPLATE_COMPONENTS).flat().filter((slug) => !known.has(slug));
    expect(dangling).toEqual([]);
  });
});
