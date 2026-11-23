/**
 * 工程模板的「元件」：从 13 条整图模板里拆出来的可复用零件。
 *
 * 约束：
 * - 元件是独立的 library item（`sakura.<cat>.<slug>@<ver>-light`），可反复插入多次；
 * - 默认不成组，只有「多个图元拼成一个物件」的（人形、圆柱、双圈、网关、里程碑、阶段块、三段类框、实体表、ER 关系线、分支线）才用 `Pen.unit()`；
 * - 坐标以 (0,0) 为左上角，尺寸与所属模板保持一致，插入后视觉可直接拼回整图。
 */
import { Pen, type Skeleton } from "./draw";
import type { Palette } from "./spec";
import type { TemplateCat } from "./templates";

export type Component = {
  slug: string;
  cat: TemplateCat;
  name: string;
  build: (p: Palette) => Skeleton[];
};

export const COMPONENTS: Component[] = [
  /* ---------------- 软件工程 ---------------- */
  {
    slug: "el-class3",
    cat: "se",
    name: "三段类框",
    build: (p) => {
      const d = new Pen("sakura.se.el-class3", p);
      d.unit(() => {
        d.box(0, 0, 232, 40, { fill: "head", text: "ClassName", size: 17 });
        d.box(0, 40, 232, 72, { text: "- id: UUID\n- total: Money", size: 13, font: "code", align: "left", valign: "top" });
        d.box(0, 112, 232, 64, { text: "+ pay(): void\n+ cancel(): void", size: 13, font: "code", align: "left", valign: "top" });
      });
      return d.els;
    },
  },
  {
    slug: "el-class1",
    cat: "se",
    name: "单段类框",
    build: (p) => {
      const d = new Pen("sakura.se.el-class1", p);
      d.box(0, 0, 232, 40, { fill: "head", text: "ClassName", size: 14 });
      return d.els;
    },
  },
  {
    slug: "el-actor",
    cat: "se",
    name: "参与者",
    build: (p) => {
      const d = new Pen("sakura.se.el-actor", p);
      d.unit(() => {
        d.ellipse(20, 0, 20, 20);
        d.line([[30, 20], [30, 44]]);
        d.line([[15, 28], [45, 28]]);
        d.line([[30, 44], [17, 66]]);
        d.line([[30, 44], [43, 66]]);
        d.text(30, 82, "Actor", { size: 12, color: "ink" });
      });
      return d.els;
    },
  },
  {
    slug: "el-lifeline",
    cat: "se",
    name: "生命线",
    build: (p) => {
      const d = new Pen("sakura.se.el-lifeline", p);
      d.line([[0, 0], [0, 320]], { dash: true, sw: 1, stroke: "muted" });
      return d.els;
    },
  },
  {
    slug: "el-activation",
    cat: "se",
    name: "激活条",
    build: (p) => {
      const d = new Pen("sakura.se.el-activation", p);
      d.box(0, 0, 12, 220, { fill: "wash" });
      return d.els;
    },
  },
  {
    slug: "el-msg-sync",
    cat: "se",
    name: "同步消息",
    build: (p) => {
      const d = new Pen("sakura.se.el-msg-sync", p);
      d.arrow([[0, 0], [160, 0]], { head: "triangle" });
      return d.els;
    },
  },
  {
    slug: "el-msg-return",
    cat: "se",
    name: "返回消息",
    build: (p) => {
      const d = new Pen("sakura.se.el-msg-return", p);
      d.arrow([[0, 0], [160, 0]], { dash: true, head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-usecase",
    cat: "se",
    name: "用例椭圆",
    build: (p) => {
      const d = new Pen("sakura.se.el-usecase", p);
      d.ellipse(0, 0, 180, 52, { text: "用例", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-boundary",
    cat: "se",
    name: "系统边界",
    build: (p) => {
      const d = new Pen("sakura.se.el-boundary", p);
      d.box(0, 0, 260, 200, { stroke: "faint", sw: 1, text: "系统边界", size: 12, valign: "top", color: "muted" });
      return d.els;
    },
  },
  {
    slug: "el-decision",
    cat: "se",
    name: "判定菱形",
    build: (p) => {
      const d = new Pen("sakura.se.el-decision", p);
      d.diamond(0, 0, 140, 80, { text: "条件？", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-activity",
    cat: "se",
    name: "起止节点",
    build: (p) => {
      const d = new Pen("sakura.se.el-activity", p);
      d.box(0, 0, 140, 48, { round: true, fill: "accent", stroke: "accent", text: "步骤", size: 13 });
      return d.els;
    },
  },
  {
    slug: "el-initial",
    cat: "se",
    name: "初态",
    build: (p) => {
      const d = new Pen("sakura.se.el-initial", p);
      d.ellipse(0, 0, 18, 18, { fill: "ink", stroke: "ink" });
      return d.els;
    },
  },
  {
    slug: "el-final",
    cat: "se",
    name: "终态",
    build: (p) => {
      const d = new Pen("sakura.se.el-final", p);
      d.unit(() => {
        d.ellipse(0, 0, 26, 26);
        d.ellipse(8, 8, 10, 10, { fill: "ink", stroke: "ink" });
      });
      return d.els;
    },
  },
  {
    slug: "el-entity",
    cat: "se",
    name: "实体表",
    build: (p) => {
      const d = new Pen("sakura.se.el-entity", p);
      d.unit(() => {
        d.box(0, 0, 160, 34, { fill: "head", text: "Entity", size: 12.5 });
        d.box(0, 34, 160, 72, { text: "pk id\nname\nemail", size: 11, font: "code", align: "left", valign: "top" });
      });
      return d.els;
    },
  },
  {
    slug: "el-er-rel",
    cat: "se",
    name: "ER 关系线 1:N",
    build: (p) => {
      const d = new Pen("sakura.se.el-er-rel", p);
      const rel = { stroke: "muted" as const, sw: 2 };
      d.unit(() => {
        d.line([[0, 18], [150, 18]], rel);
        d.line([[10, 10], [10, 26]], rel);
        d.line([[150, 18], [162, 10]], rel);
        d.line([[150, 18], [162, 18]], rel);
        d.line([[150, 18], [162, 26]], rel);
        d.text(8, 6, "1", { size: 11, font: "code", color: "muted", align: "left" });
        d.text(140, 6, "N", { size: 11, font: "code", color: "muted", align: "right" });
      });
      return d.els;
    },
  },

  /* ---------------- 系统架构 ---------------- */
  {
    slug: "el-layer",
    cat: "arch",
    name: "分层条",
    build: (p) => {
      const d = new Pen("sakura.arch.el-layer", p);
      d.box(0, 0, 280, 48, { fill: "head", text: "应用层　订单 · 支付 · 用户", size: 12, align: "left" });
      return d.els;
    },
  },
  {
    slug: "el-crosscut",
    cat: "arch",
    name: "横切能力框",
    build: (p) => {
      const d = new Pen("sakura.arch.el-crosscut", p);
      d.box(0, 0, 120, 200, { dash: true, sw: 1, stroke: "faint", text: "横切能力", size: 11, valign: "top", color: "muted" });
      return d.els;
    },
  },
  {
    slug: "el-client",
    cat: "arch",
    name: "客户端卡片",
    build: (p) => {
      const d = new Pen("sakura.arch.el-client", p);
      d.box(0, 0, 110, 48, { round: true, text: "客户端", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-gateway",
    cat: "arch",
    name: "API 网关",
    build: (p) => {
      const d = new Pen("sakura.arch.el-gateway", p);
      d.box(0, 0, 120, 48, { fill: "accent", text: "API 网关", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-service",
    cat: "arch",
    name: "服务卡片",
    build: (p) => {
      const d = new Pen("sakura.arch.el-service", p);
      d.box(0, 0, 110, 56, { fill: "head", text: "服务", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-bus",
    cat: "arch",
    name: "消息总线",
    build: (p) => {
      const d = new Pen("sakura.arch.el-bus", p);
      d.box(0, 0, 320, 26, { fill: "wash", text: "消息总线 / 事件流", size: 10.5, font: "code" });
      return d.els;
    },
  },
  {
    slug: "el-cylinder",
    cat: "arch",
    name: "数据库圆柱",
    build: (p) => {
      const d = new Pen("sakura.arch.el-cylinder", p);
      d.unit(() => {
        d.box(0, 9, 96, 78, { fill: "head" });
        d.ellipse(0, 0, 96, 18, { fill: "head" });
        d.ellipse(0, 78, 96, 18, { fill: "head" });
        d.text(48, 110, "数据库", { size: 10.5, color: "muted" });
      });
      return d.els;
    },
  },

  /* ---------------- 流程与体验 ---------------- */
  {
    slug: "el-bpmn-start",
    cat: "flowx",
    name: "开始事件",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-start", p);
      d.ellipse(0, 0, 32, 32, { sw: 1 });
      return d.els;
    },
  },
  {
    slug: "el-bpmn-end",
    cat: "flowx",
    name: "结束事件",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-end", p);
      d.ellipse(0, 0, 32, 32, { sw: 4 });
      return d.els;
    },
  },
  {
    slug: "el-bpmn-task",
    cat: "flowx",
    name: "任务框",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-task", p);
      d.box(0, 0, 130, 52, { round: true, fill: "head", text: "任务", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-bpmn-gateway",
    cat: "flowx",
    name: "排他网关",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-gateway", p);
      d.unit(() => {
        d.diamond(0, 0, 64, 64);
        d.line([[16, 16], [48, 48]], { sw: 1.5 });
        d.line([[48, 16], [16, 48]], { sw: 1.5 });
      });
      return d.els;
    },
  },
  {
    slug: "el-bpmn-label",
    cat: "flowx",
    name: "条件标签",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-label", p);
      d.text(0, 8, "是", { size: 11, color: "muted", align: "left" });
      return d.els;
    },
  },
  {
    slug: "el-bpmn-arrow",
    cat: "flowx",
    name: "连线箭头",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-arrow", p);
      d.arrow([[0, 0], [160, 0]], { head: "arrow" });
      return d.els;
    },
  },

  /* ---------------- 项目管理 ---------------- */
  {
    slug: "el-pm-taskrow",
    cat: "pm",
    name: "任务行",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-taskrow", p);
      d.box(0, 0, 110, 42, { text: "任务", size: 11.5, align: "left" });
      return d.els;
    },
  },
  {
    slug: "el-pm-bar",
    cat: "pm",
    name: "甘特条",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-bar", p);
      d.box(0, 0, 120, 18, { fill: "wash", stroke: "muted", sw: 1 });
      return d.els;
    },
  },
  {
    slug: "el-pm-bar-key",
    cat: "pm",
    name: "关键任务条",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-bar-key", p);
      d.box(0, 0, 120, 18, { fill: "accent", stroke: "muted", sw: 1 });
      return d.els;
    },
  },
  {
    slug: "el-pm-month",
    cat: "pm",
    name: "月份表头",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-month", p);
      d.box(0, 0, 97.5, 30, { fill: "wash", text: "M1", size: 10.5, font: "code" });
      return d.els;
    },
  },
  {
    slug: "el-pm-grid",
    cat: "pm",
    name: "时间网格线",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-grid", p);
      d.line([[0, 0], [0, 240]], { dash: true, sw: 1, stroke: "faint" });
      return d.els;
    },
  },
  {
    slug: "el-pm-milestone",
    cat: "pm",
    name: "里程碑",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-milestone", p);
      d.unit(() => {
        d.diamond(0, 0, 18, 18, { fill: "accent", stroke: "accent" });
        d.text(24, 9, "里程碑", { size: 10, color: "muted", align: "left" });
      });
      return d.els;
    },
  },
  {
    slug: "el-pm-wbs",
    cat: "pm",
    name: "WBS 节点",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-wbs", p);
      d.box(0, 0, 140, 40, { fill: "head", text: "模块", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-pm-colhead",
    cat: "pm",
    name: "看板列头",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-colhead", p);
      d.box(0, 0, 120, 30, { fill: "wash", text: "待办", size: 11 });
      return d.els;
    },
  },
  {
    slug: "el-pm-card",
    cat: "pm",
    name: "看板卡片",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-card", p);
      d.box(0, 0, 100, 44, { round: true, text: "卡片", size: 11 });
      return d.els;
    },
  },
  {
    slug: "el-pm-swimlane",
    cat: "pm",
    name: "泳道条",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-swimlane", p);
      d.box(0, 0, 390, 24, { fill: "wash", text: "泳道", size: 10.5, align: "left", color: "muted" });
      return d.els;
    },
  },

  /* ---------------- 工程运维 ---------------- */
  {
    slug: "el-ops-stage",
    cat: "ops",
    name: "阶段块",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-stage", p);
      d.unit(() => {
        d.box(0, 0, 86, 72, { round: true, fill: "head", text: "阶段\n说明", size: 11 });
        d.ellipse(72, 8, 8, 8, { fill: "accent", stroke: "accent" });
      });
      return d.els;
    },
  },
  {
    slug: "el-ops-arrow",
    cat: "ops",
    name: "流水线箭头",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-arrow", p);
      d.arrow([[0, 0], [100, 0]], { head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-ops-branch",
    cat: "ops",
    name: "分支连接线",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-branch", p);
      d.unit(() => {
        d.line([[30, 0], [30, 24]], { sw: 1 });
        d.line([[0, 24], [60, 24]], { sw: 1 });
        d.line([[0, 24], [0, 44]], { sw: 1 });
        d.line([[60, 24], [60, 44]], { sw: 1 });
      });
      return d.els;
    },
  },
  {
    slug: "el-ops-test",
    cat: "ops",
    name: "测试框",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-test", p);
      d.box(0, 0, 70, 34, { text: "测试", size: 10 });
      return d.els;
    },
  },
  {
    slug: "el-ops-note",
    cat: "ops",
    name: "说明文字",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-note", p);
      d.text(0, 8, "每个阶段产出可复现制品", { size: 10, color: "muted", align: "left" });
      return d.els;
    },
  },

  /* ======================================================================
   * 关系线：UML 类图
   *
   * 只用 Excalidraw 原生箭头形态，不拿文字冒充：实线/虚线区分语义，
   * 空心三角（泛化/实现）、实心三角、实心/空心菱形（组合/聚合）、开口箭头（关联/依赖）。
   * ==================================================================== */
  {
    slug: "el-uml-assoc",
    cat: "se",
    name: "关联线",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-assoc", p);
      d.line([[0, 0], [160, 0]]);
      return d.els;
    },
  },
  {
    slug: "el-uml-directed",
    cat: "se",
    name: "有向关联",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-directed", p);
      d.arrow([[0, 0], [160, 0]], { head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-uml-generalization",
    cat: "se",
    name: "泛化（空心三角）",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-generalization", p);
      d.arrow([[0, 0], [160, 0]], { head: "triangle_outline" });
      return d.els;
    },
  },
  {
    slug: "el-uml-realization",
    cat: "se",
    name: "实现（虚线空心三角）",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-realization", p);
      d.arrow([[0, 0], [160, 0]], { dash: true, head: "triangle_outline" });
      return d.els;
    },
  },
  {
    slug: "el-uml-dependency",
    cat: "se",
    name: "依赖（虚线开口箭头）",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-dependency", p);
      d.arrow([[0, 0], [160, 0]], { dash: true, head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-uml-composition",
    cat: "se",
    name: "组合（实心菱形）",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-composition", p);
      d.arrow([[0, 0], [160, 0]], { startHead: "diamond" });
      return d.els;
    },
  },
  {
    slug: "el-uml-aggregation",
    cat: "se",
    name: "聚合（空心菱形）",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-aggregation", p);
      d.arrow([[0, 0], [160, 0]], { startHead: "diamond_outline" });
      return d.els;
    },
  },
  {
    slug: "el-uml-multiplicity",
    cat: "se",
    name: "多重性标注",
    build: (p) => {
      const d = new Pen("sakura.se.el-uml-multiplicity", p);
      d.unit(() => {
        d.text(4, 8, "1", { size: 11, font: "code", color: "muted", align: "left" });
        d.text(156, 8, "0..*", { size: 11, font: "code", color: "muted", align: "right" });
      });
      return d.els;
    },
  },

  /* ---------------- 关系线：用例图 ---------------- */
  {
    slug: "el-uc-assoc",
    cat: "se",
    name: "用例关联",
    build: (p) => {
      const d = new Pen("sakura.se.el-uc-assoc", p);
      d.line([[0, 0], [150, 0]]);
      return d.els;
    },
  },
  {
    slug: "el-uc-include",
    cat: "se",
    name: "包含关系 «include»",
    build: (p) => {
      const d = new Pen("sakura.se.el-uc-include", p);
      d.unit(() => {
        d.arrow([[0, 15], [150, 15]], { dash: true, head: "arrow" });
        d.text(75, 4, "«include»", { size: 9.5, color: "muted" });
      });
      return d.els;
    },
  },
  {
    slug: "el-uc-extend",
    cat: "se",
    name: "扩展关系 «extend»",
    build: (p) => {
      const d = new Pen("sakura.se.el-uc-extend", p);
      d.unit(() => {
        d.arrow([[0, 15], [150, 15]], { dash: true, head: "arrow" });
        d.text(75, 4, "«extend»", { size: 9.5, color: "muted" });
      });
      return d.els;
    },
  },

  /* ---------------- 时序图：消息与片段 ---------------- */
  {
    slug: "el-seq-async",
    cat: "se",
    name: "异步消息",
    build: (p) => {
      const d = new Pen("sakura.se.el-seq-async", p);
      d.arrow([[0, 0], [160, 0]], { head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-seq-self",
    cat: "se",
    name: "自消息",
    build: (p) => {
      const d = new Pen("sakura.se.el-seq-self", p);
      d.arrow([[0, 0], [80, 0], [80, 44], [10, 44]], { head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-seq-fragment",
    cat: "se",
    name: "片段框",
    build: (p) => {
      const d = new Pen("sakura.se.el-seq-fragment", p);
      d.unit(() => {
        d.box(0, 0, 220, 150, { stroke: "faint", sw: 1 });
        d.box(0, 0, 52, 22, { fill: "wash", stroke: "faint", sw: 1, text: "alt", size: 10, font: "code" });
      });
      return d.els;
    },
  },

  /* ---------------- 状态机图 ---------------- */
  {
    slug: "el-state-box",
    cat: "se",
    name: "状态框",
    build: (p) => {
      const d = new Pen("sakura.se.el-state-box", p);
      d.box(0, 0, 150, 50, { round: true, fill: "head", text: "状态", size: 12 });
      return d.els;
    },
  },
  {
    slug: "el-state-composite",
    cat: "se",
    name: "复合状态",
    build: (p) => {
      const d = new Pen("sakura.se.el-state-composite", p);
      d.unit(() => {
        d.box(0, 0, 240, 160, { round: true });
        d.box(0, 0, 240, 32, { fill: "wash", text: "复合状态", size: 11 });
      });
      return d.els;
    },
  },
  {
    slug: "el-state-transition",
    cat: "se",
    name: "状态转移",
    build: (p) => {
      const d = new Pen("sakura.se.el-state-transition", p);
      d.unit(() => {
        d.arrow([[0, 18], [150, 18]], { head: "arrow" });
        d.text(75, 6, "事件[条件]", { size: 9.5, color: "muted" });
      });
      return d.els;
    },
  },

  /* ---------------- ER 图：基数与自关联 ---------------- */
  {
    slug: "el-er-1to1",
    cat: "se",
    name: "ER 关系 1:1",
    build: (p) => {
      const d = new Pen("sakura.se.el-er-1to1", p);
      d.arrow([[0, 16], [150, 16]], { stroke: "muted", sw: 2, startHead: "crowfoot_one", head: "crowfoot_one" });
      return d.els;
    },
  },
  {
    slug: "el-er-mton",
    cat: "se",
    name: "ER 关系 N:M（鸦爪）",
    build: (p) => {
      const d = new Pen("sakura.se.el-er-mton", p);
      d.arrow([[0, 16], [150, 16]], { stroke: "muted", sw: 2, startHead: "crowfoot_one", head: "crowfoot_many" });
      return d.els;
    },
  },
  {
    slug: "el-er-self",
    cat: "se",
    name: "ER 自关联",
    build: (p) => {
      const d = new Pen("sakura.se.el-er-self", p);
      d.arrow([[150, 24], [150, -34], [64, -34], [64, 24]], {
        stroke: "muted", sw: 2, startHead: "crowfoot_one", head: "crowfoot_many",
      });
      return d.els;
    },
  },
  {
    slug: "el-er-attr",
    cat: "se",
    name: "属性椭圆",
    build: (p) => {
      const d = new Pen("sakura.se.el-er-attr", p);
      d.ellipse(0, 0, 120, 36, { text: "属性", size: 10.5 });
      return d.els;
    },
  },

  /* ---------------- 流程图：节点形状 ---------------- */
  {
    slug: "el-flow-io",
    cat: "se",
    name: "输入输出",
    build: (p) => {
      const d = new Pen("sakura.se.el-flow-io", p);
      d.unit(() => {
        d.poly([[0, 0], [170, 0], [150, 48], [20, 48]]);
        d.text(85, 24, "输入 / 输出", { size: 11 });
      });
      return d.els;
    },
  },
  {
    slug: "el-flow-sub",
    cat: "se",
    name: "子流程框",
    build: (p) => {
      const d = new Pen("sakura.se.el-flow-sub", p);
      d.unit(() => {
        d.box(0, 0, 150, 54);
        d.line([[14, 0], [14, 54]], { sw: 1 });
        d.line([[136, 0], [136, 54]], { sw: 1 });
        d.text(75, 27, "子流程", { size: 11 });
      });
      return d.els;
    },
  },
  {
    slug: "el-flow-doc",
    cat: "se",
    name: "文档",
    build: (p) => {
      const d = new Pen("sakura.se.el-flow-doc", p);
      d.unit(() => {
        d.poly([[0, 0], [150, 0], [150, 40], [112, 50], [75, 40], [38, 50], [0, 40]]);
        d.text(75, 22, "文档", { size: 11 });
      });
      return d.els;
    },
  },
  {
    slug: "el-flow-connector",
    cat: "se",
    name: "连接点",
    build: (p) => {
      const d = new Pen("sakura.se.el-flow-connector", p);
      d.ellipse(0, 0, 32, 32, { text: "A", size: 10, font: "code" });
      return d.els;
    },
  },

  /* ---------------- 系统架构：调用 / 依赖 / 数据流 ---------------- */
  {
    slug: "el-arch-call",
    cat: "arch",
    name: "调用箭头",
    build: (p) => {
      const d = new Pen("sakura.arch.el-arch-call", p);
      d.arrow([[0, 0], [130, 0]], { head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-arch-dependency",
    cat: "arch",
    name: "依赖线",
    build: (p) => {
      const d = new Pen("sakura.arch.el-arch-dependency", p);
      d.arrow([[0, 0], [130, 0]], { dash: true, head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-arch-dataflow",
    cat: "arch",
    name: "数据流箭头",
    build: (p) => {
      const d = new Pen("sakura.arch.el-arch-dataflow", p);
      d.arrow([[0, 0], [130, 0]], { head: "triangle" });
      return d.els;
    },
  },
  {
    slug: "el-arch-external",
    cat: "arch",
    name: "外部系统",
    build: (p) => {
      const d = new Pen("sakura.arch.el-arch-external", p);
      d.box(0, 0, 150, 56, { dash: true, sw: 1, stroke: "faint", text: "外部系统", size: 11, color: "muted" });
      return d.els;
    },
  },

  /* ---------------- BPMN：网关 / 消息 / 子流程 ---------------- */
  {
    slug: "el-bpmn-parallel",
    cat: "flowx",
    name: "并行网关",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-parallel", p);
      d.unit(() => {
        d.diamond(0, 0, 64, 64);
        d.line([[32, 16], [32, 48]], { sw: 1.5 });
        d.line([[16, 32], [48, 32]], { sw: 1.5 });
      });
      return d.els;
    },
  },
  {
    slug: "el-bpmn-message",
    cat: "flowx",
    name: "消息流",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-message", p);
      d.arrow([[0, 0], [160, 0]], { dash: true, startHead: "circle_outline", head: "arrow" });
      return d.els;
    },
  },
  {
    slug: "el-bpmn-sub",
    cat: "flowx",
    name: "BPMN 子流程",
    build: (p) => {
      const d = new Pen("sakura.flowx.el-bpmn-sub", p);
      d.unit(() => {
        d.box(0, 0, 130, 52, { round: true, fill: "head" });
        d.text(65, 22, "子流程", { size: 11 });
        d.line([[59, 44], [71, 44]], { sw: 1.5 });
        d.line([[65, 38], [65, 50]], { sw: 1.5 });
      });
      return d.els;
    },
  },

  /* ---------------- 项目管理：依赖 / 摘要 / WBS / 阻塞 ---------------- */
  {
    slug: "el-pm-dependency",
    cat: "pm",
    name: "任务依赖",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-dependency", p);
      d.arrow([[0, 0], [26, 0], [26, 40], [108, 40]], { head: "arrow", sw: 1.5 });
      return d.els;
    },
  },
  {
    slug: "el-pm-summary",
    cat: "pm",
    name: "摘要条",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-summary", p);
      d.unit(() => {
        d.box(0, 0, 160, 10, { fill: "ink", stroke: "ink" });
        d.line([[0, 0], [0, 12]], { sw: 1.5 });
        d.line([[160, 0], [160, 12]], { sw: 1.5 });
      });
      return d.els;
    },
  },
  {
    slug: "el-pm-wbs-link",
    cat: "pm",
    name: "WBS 连接线",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-wbs-link", p);
      d.line([[0, 0], [0, 26], [70, 26], [70, 52]], { sw: 1 });
      return d.els;
    },
  },
  {
    slug: "el-pm-wbs-leaf",
    cat: "pm",
    name: "WBS 叶子节点",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-wbs-leaf", p);
      d.box(0, 0, 120, 34, { text: "子任务", size: 11 });
      return d.els;
    },
  },
  {
    slug: "el-pm-blocker",
    cat: "pm",
    name: "阻塞标记",
    build: (p) => {
      const d = new Pen("sakura.pm.el-pm-blocker", p);
      d.box(0, 0, 74, 26, { dash: true, sw: 1.5, stroke: "accent", text: "阻塞", size: 10, color: "muted" });
      return d.els;
    },
  },

  /* ---------------- 工程运维：制品 / 环境 / 回滚 ---------------- */
  {
    slug: "el-ops-artifact",
    cat: "ops",
    name: "制品块",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-artifact", p);
      d.unit(() => {
        d.box(0, 0, 96, 64, { fill: "head" });
        d.text(48, 24, "制品", { size: 11 });
        d.text(48, 42, "image:tag", { size: 9, font: "code", color: "muted" });
      });
      return d.els;
    },
  },
  {
    slug: "el-ops-env",
    cat: "ops",
    name: "部署环境",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-env", p);
      d.box(0, 0, 130, 48, { dash: true, sw: 1, text: "生产环境", size: 11, color: "muted" });
      return d.els;
    },
  },
  {
    slug: "el-ops-rollback",
    cat: "ops",
    name: "回滚箭头",
    build: (p) => {
      const d = new Pen("sakura.ops.el-ops-rollback", p);
      d.unit(() => {
        d.arrow([[0, 16], [130, 16]], { dash: true, head: "arrow" });
        d.text(65, 4, "回滚", { size: 9.5, color: "muted" });
      });
      return d.els;
    },
  },
];
