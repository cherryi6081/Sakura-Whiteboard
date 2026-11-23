/**
 * 工程模板 → 元件 的人工归属表（唯一真源）。
 *
 * 为什么人工维护、不做自动推导：
 * 整图模板与元件是两套独立的 library item（内容、版本、条目 id 都不同），
 * 元件不反向引用模板。按图元指纹（坐标 / 尺寸 / 文本）反查会把「长得像」
 * 误判成「属于」，模板改样式或加图元时归属还会漂移；人工表可评审、可单测，
 * 改模板时同步改这里即可（漏写会在 map.test.ts 里报出来）。
 *
 * 共享元件（判定菱形同时属于流程图与 BPMN、参与者同时属于用例图与时序图）
 * 在各自模板的二级视图里都会出现：去重只发生在单张模板内部，不做全局去重。
 */
import { COMPONENTS } from "./components";
import { TEMPLATES } from "./templates";

/** 模板 slug → 该模板用到的元件 slug（数组顺序 = 二级视图的展示顺序） */
export const TEMPLATE_COMPONENTS: Record<string, readonly string[]> = {
  uml: [
    "el-class3", "el-class1",
    "el-uml-assoc", "el-uml-directed", "el-uml-generalization", "el-uml-realization",
    "el-uml-dependency", "el-uml-composition", "el-uml-aggregation", "el-uml-multiplicity",
    "el-er-rel",
  ],
  seq: [
    "el-actor", "el-lifeline", "el-activation",
    "el-msg-sync", "el-msg-return", "el-seq-async", "el-seq-self", "el-seq-fragment",
  ],
  flow: [
    "el-activity", "el-decision", "el-initial", "el-final",
    "el-flow-io", "el-flow-sub", "el-flow-doc", "el-flow-connector", "el-bpmn-arrow",
  ],
  usecase: [
    "el-actor", "el-usecase", "el-boundary",
    "el-uc-assoc", "el-uc-include", "el-uc-extend", "el-uml-generalization",
  ],
  state: [
    "el-initial", "el-final", "el-activity",
    "el-state-box", "el-state-composite", "el-state-transition",
  ],
  er: [
    "el-entity", "el-er-rel", "el-er-1to1", "el-er-mton", "el-er-self", "el-er-attr",
  ],
  layered: [
    "el-layer", "el-crosscut", "el-client", "el-cylinder",
    "el-arch-call", "el-arch-dependency", "el-arch-dataflow", "el-arch-external",
  ],
  micro: [
    "el-client", "el-gateway", "el-service", "el-bus", "el-cylinder",
    "el-arch-call", "el-arch-dependency", "el-arch-dataflow", "el-arch-external",
  ],
  bpmn: [
    "el-bpmn-start", "el-bpmn-end", "el-bpmn-task", "el-bpmn-gateway", "el-bpmn-label",
    "el-bpmn-arrow", "el-decision", "el-bpmn-parallel", "el-bpmn-message", "el-bpmn-sub",
  ],
  gantt: [
    "el-pm-taskrow", "el-pm-bar", "el-pm-bar-key", "el-pm-month", "el-pm-grid",
    "el-pm-milestone", "el-pm-dependency", "el-pm-summary",
  ],
  wbs: ["el-pm-wbs", "el-pm-wbs-link", "el-pm-wbs-leaf"],
  kanban: ["el-pm-colhead", "el-pm-card", "el-pm-swimlane", "el-pm-blocker"],
  cicd: [
    "el-ops-stage", "el-ops-arrow", "el-ops-branch", "el-ops-test", "el-ops-note",
    "el-ops-artifact", "el-ops-env", "el-ops-rollback",
  ],
};

export function componentSlugsOfTemplate(templateSlug: string): readonly string[] {
  return TEMPLATE_COMPONENTS[templateSlug] ?? [];
}

/** 元件 slug → 出现在哪些模板（搜索命中和二级标题用模板中文名） */
export function templateNamesOfComponent(componentSlug: string): string[] {
  return TEMPLATES.filter((template) =>
    componentSlugsOfTemplate(template.slug).includes(componentSlug),
  ).map((template) => template.name);
}

/** 单测入口：列出映射表里所有对不上目录的项（空数组 = 表完整） */
export function validateTemplateMap(): string[] {
  const problems: string[] = [];
  const templateSlugs = new Set(TEMPLATES.map((template) => template.slug));
  const componentSlugs = new Set(COMPONENTS.map((component) => component.slug));

  for (const slug of Object.keys(TEMPLATE_COMPONENTS)) {
    if (!templateSlugs.has(slug)) problems.push(`未知模板 slug：${slug}`);
  }
  for (const template of TEMPLATES) {
    if (!TEMPLATE_COMPONENTS[template.slug]) {
      problems.push(`模板缺归属表：${template.slug}（${template.name}）`);
    }
  }
  for (const [templateSlug, components] of Object.entries(TEMPLATE_COMPONENTS)) {
    for (const componentSlug of components) {
      if (!componentSlugs.has(componentSlug)) {
        problems.push(`${templateSlug} 引用了不存在的元件：${componentSlug}`);
      }
    }
    if (new Set(components).size !== components.length) {
      problems.push(`${templateSlug} 的元件有重复项`);
    }
  }
  return problems;
}
