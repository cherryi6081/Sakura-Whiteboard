import { describe, expect, it } from "vitest";
import { TEMPLATES } from "./templates";
import { COMPONENTS } from "./components";
import { TEMPLATE_COMPONENTS, componentSlugsOfTemplate, templateNamesOfComponent, validateTemplateMap } from "./map";

describe("工程模板 → 元件 归属表", () => {
  it("映射表与目录完全对齐（模板、元件 slug 都存在且无重复）", () => {
    expect(validateTemplateMap()).toEqual([]);
  });

  it("13 张模板都有二级元件，且至少含一个元件", () => {
    expect(TEMPLATES).toHaveLength(13);
    for (const template of TEMPLATES) {
      expect(componentSlugsOfTemplate(template.slug).length).toBeGreaterThan(0);
    }
  });

  it("共享元件在多个模板下都出现（判定菱形 / 参与者为例）", () => {
    const decision = TEMPLATES.filter((t) => componentSlugsOfTemplate(t.slug).includes("el-decision"));
    const actor = TEMPLATES.filter((t) => componentSlugsOfTemplate(t.slug).includes("el-actor"));
    expect(decision.map((t) => t.slug).sort()).toEqual(["bpmn", "flow"]);
    expect(actor.map((t) => t.slug).sort()).toEqual(["seq", "usecase"]);
  });

  it("反向查询返回模板中文名", () => {
    expect(templateNamesOfComponent("el-decision").sort()).toEqual(["BPMN 简化", "流程图"].sort());
  });

  it("每个元件都被至少一张模板引用（没有孤立的二级条目）", () => {
    const used = new Set(Object.values(TEMPLATE_COMPONENTS).flat());
    const orphans = COMPONENTS.filter((component) => !used.has(component.slug)).map((c) => c.slug);
    expect(orphans).toEqual([]);
  });

  it("关系线补全：类图 / 用例 / ER / 时序的关键语义都在二级视图里", () => {
    expect(componentSlugsOfTemplate("uml")).toEqual(
      expect.arrayContaining([
        "el-uml-assoc", "el-uml-directed", "el-uml-generalization", "el-uml-realization",
        "el-uml-dependency", "el-uml-composition", "el-uml-aggregation", "el-uml-multiplicity",
      ]),
    );
    expect(componentSlugsOfTemplate("usecase")).toEqual(
      expect.arrayContaining(["el-uc-assoc", "el-uc-include", "el-uc-extend", "el-uml-generalization"]),
    );
    expect(componentSlugsOfTemplate("er")).toEqual(
      expect.arrayContaining(["el-er-rel", "el-er-1to1", "el-er-mton", "el-er-self", "el-er-attr"]),
    );
    expect(componentSlugsOfTemplate("seq")).toEqual(
      expect.arrayContaining(["el-lifeline", "el-activation", "el-seq-async", "el-seq-self", "el-seq-fragment"]),
    );
  });
});
