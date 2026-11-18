import type { Skeleton } from "../draw";
import type { Palette } from "../spec";
import { layered, micro } from "./architecture";
import { gantt, kanban, wbs } from "./management";
import { cicd } from "./ops";
import { bpmn } from "./process";
import { er, flow, sequence, state, uml, usecase } from "./software";

export type TemplateCat = "se" | "arch" | "pm" | "flowx" | "ops";
export type TemplatePrio = "P0" | "P1" | "P2";

export type Template = {
  /** 条目 id 里的 slug：`sakura.<cat>.<slug>@<ver>-<theme>` */
  slug: string;
  cat: TemplateCat;
  prio: TemplatePrio;
  name: string;
  build: (p: Palette) => Skeleton[];
};

/**
 * 首批只含 P0（13 条）。数组顺序 = 素材库侧栏顺序：
 * 软件工程 → 架构 → 项目管理 → 流程与体验 → 工程运维。
 * 侧栏没有分组/名称 UI，顺序是唯一的分组手段。
 */
export const TEMPLATES: Template[] = [
  { slug: "uml", cat: "se", prio: "P0", name: "UML 类图", build: uml },
  { slug: "seq", cat: "se", prio: "P0", name: "时序图", build: sequence },
  { slug: "flow", cat: "se", prio: "P0", name: "流程图", build: flow },
  { slug: "usecase", cat: "se", prio: "P0", name: "用例图", build: usecase },
  { slug: "state", cat: "se", prio: "P0", name: "状态机图", build: state },
  { slug: "er", cat: "se", prio: "P0", name: "ER 图", build: er },
  { slug: "layered", cat: "arch", prio: "P0", name: "分层架构", build: layered },
  { slug: "micro", cat: "arch", prio: "P0", name: "微服务拓扑", build: micro },
  { slug: "gantt", cat: "pm", prio: "P0", name: "甘特图", build: gantt },
  { slug: "wbs", cat: "pm", prio: "P0", name: "WBS 分解", build: wbs },
  { slug: "kanban", cat: "pm", prio: "P0", name: "看板泳道", build: kanban },
  { slug: "bpmn", cat: "flowx", prio: "P0", name: "BPMN 简化", build: bpmn },
  { slug: "cicd", cat: "ops", prio: "P0", name: "CI/CD 流水线", build: cicd },
];
