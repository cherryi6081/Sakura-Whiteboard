/** 软件工程：UML 类图 / 时序图 / 流程图 / 用例图 / 状态机图 / ER 图 */
import { Pen, type Skeleton } from "../draw";
import type { Palette } from "../spec";

/** 类图：三段共边矩形 + 5 类关系（继承 / 实现 / 组合 / 聚合 / 关联） */
export function uml(p: Palette): Skeleton[] {
  const d = new Pen("sakura.se.uml", p);
  const BW = 232;

  d.unit(() => {
    d.box(0, 0, BW, 40, { fill: "head", text: "Order", size: 17 });
    d.box(0, 40, BW, 72, { text: "- id: UUID\n- total: Money", size: 13, font: "code", align: "left", valign: "top" });
    d.box(0, 112, BW, 64, { text: "+ pay(): void\n+ cancel(): void", size: 13, font: "code", align: "left", valign: "top" });
  });

  d.text(0, 206, "多重性标注", { size: 11, color: "faint", align: "left" });
  d.text(0, 228, "1", { size: 12, font: "code", color: "muted", align: "left" });
  d.text(34, 228, "0..*", { size: 12, font: "code", color: "muted", align: "left" });
  d.text(104, 228, "1..n", { size: 12, font: "code", color: "muted", align: "left" });

  const X = 268;
  const BWR = 86;
  const GAP = 64;
  const ROWH = 68;
  const rows = [
    { name: "继承", head: "triangle_outline" as const },
    { name: "实现", dash: true, head: "triangle_outline" as const },
    { name: "组合", startHead: "diamond" as const },
    { name: "聚合", startHead: "diamond_outline" as const },
    { name: "关联", head: "arrow" as const },
  ];

  rows.forEach((row, i) => {
    const y = i * ROWH;
    const a = d.box(X, y, BWR, 36, { text: "A", size: 13, font: "code" });
    const b = d.box(X + BWR + GAP, y, BWR, 36, { text: "B", size: 13, font: "code" });
    d.arrow(
      [
        [X + BWR, y + 18],
        [X + BWR + GAP, y + 18],
      ],
      { head: row.head, startHead: row.startHead, dash: row.dash, start: a, end: b },
    );
    d.text(X + BWR + GAP / 2, y + 56, row.name, { size: 11, color: "muted" });
    if (i === 4) {
      d.text(X + BWR + 6, y + 5, "1", { size: 11, font: "code", color: "muted", align: "left" });
      d.text(X + BWR + GAP - 6, y + 5, "0..*", { size: 11, font: "code", color: "muted", align: "right" });
    }
  });

  return d.els;
}

/** 时序图：参与者 + 虚线生命线 + 激活条 + 同步/异步/返回箭头 */
export function sequence(p: Palette): Skeleton[] {
  const d = new Pen("sakura.se.seq", p);
  const parts = [
    { text: "顾客", x: 32 },
    { text: "订单服务", x: 202 },
    { text: "支付网关", x: 372 },
  ];
  parts.forEach((part) => d.box(part.x, 0, 116, 44, { fill: "head", text: part.text, size: 14 }));

  [90, 260, 430].forEach((x) => d.line([[x, 44], [x, 404]], { dash: true, sw: 1, stroke: "muted" }));

  d.box(254, 92, 12, 220, { fill: "wash" });
  d.box(424, 180, 12, 88, { fill: "wash" });

  d.arrow([[90, 84], [254, 84]], { head: "triangle" });
  d.text(172, 72, "1 提交订单", { size: 12 });
  d.arrow([[266, 120], [304, 120], [304, 156], [266, 156]], { head: "arrow" });
  d.text(352, 138, "2 校验库存", { size: 12 });
  d.arrow([[266, 184], [424, 184]], { head: "arrow" });
  d.text(345, 172, "3 支付请求", { size: 12 });
  d.arrow([[424, 252], [266, 252]], { dash: true, head: "arrow" });
  d.text(345, 240, "4 支付结果", { size: 12, color: "muted" });
  d.arrow([[254, 300], [90, 300]], { dash: true, head: "arrow" });
  d.text(172, 288, "5 下单成功", { size: 12, color: "muted" });

  return d.els;
}

/** 流程图：圆角终态 + 直角处理 + 菱形判断 + 平行四边形输入输出 */
export function flow(p: Palette): Skeleton[] {
  const d = new Pen("sakura.se.flow", p);

  const start = d.box(180, 0, 120, 44, { round: true, fill: "accent", stroke: "accent", text: "开始", size: 15 });
  const submit = d.box(156, 76, 168, 56, { text: "提交订单", size: 15 });
  const judge = d.diamond(156, 164, 168, 92, { text: "库存充足？", size: 14 });
  const lock = d.box(156, 300, 168, 56, { text: "锁定库存", size: 15 });
  const outbound = d.poly([[164, 392], [332, 392], [316, 448], [148, 448]]);
  const end = d.box(180, 476, 120, 44, { round: true, fill: "accent", stroke: "accent", text: "结束", size: 15 });
  const restock = d.box(366, 182, 142, 56, { text: "通知补货", size: 14 });

  d.arrow([[240, 44], [240, 76]], { start, end: submit });
  d.arrow([[240, 132], [240, 164]], { start: submit, end: judge });
  d.arrow([[240, 256], [240, 300]], { start: judge, end: lock });
  d.text(250, 278, "是", { size: 11, color: "muted", align: "left" });
  d.arrow([[240, 356], [240, 392]], { start: lock });
  d.text(240, 420, "生成出库单", { size: 14 });
  d.arrow([[240, 448], [240, 476]], { end });
  d.arrow([[324, 210], [366, 210]], { start: judge, end: restock });
  d.text(334, 196, "否", { size: 11, color: "muted", align: "left" });
  d.arrow([[437, 238], [437, 498], [302, 498]], { start: restock, end });

  return d.els;
}

/** 参与者：椭圆头 + 躯干 + 双臂 + 双腿 + 名称（6 个元素） */
function actor(d: Pen, x: number, y: number, name: string) {
  d.unit(() => {
    d.ellipse(x - 10, y, 20, 20);
    d.line([[x, y + 20], [x, y + 44]]);
    d.line([[x - 15, y + 28], [x + 15, y + 28]]);
    d.line([[x, y + 44], [x - 13, y + 66]]);
    d.line([[x, y + 44], [x + 13, y + 66]]);
    d.text(x, y + 82, name, { size: 12, color: "ink" });
  });
}

/** 用例图：系统边界 + 参与者 + 用例椭圆 + include */
export function usecase(p: Palette): Skeleton[] {
  const d = new Pen("sakura.se.usecase", p);

  d.box(140, 20, 240, 280, {
    stroke: "faint",
    sw: 1,
    text: "订单系统",
    size: 12,
    valign: "top",
    color: "muted",
  });
  actor(d, 46, 74, "顾客");
  actor(d, 432, 196, "支付网关");

  d.ellipse(180, 60, 160, 50, { text: "浏览商品", size: 12 });
  const submit = d.ellipse(180, 140, 160, 50, { text: "提交订单", size: 12 });
  const pay = d.ellipse(180, 220, 160, 50, { text: "在线支付", size: 12 });

  d.line([[61, 98], [180, 85]]);
  d.line([[61, 98], [180, 165]]);
  d.line([[61, 98], [180, 245]]);
  d.line([[417, 220], [340, 245]]);

  d.arrow([[260, 190], [260, 220]], { dash: true, head: "arrow", start: submit, end: pay });
  d.text(304, 205, "«include»", { size: 11, color: "muted" });

  return d.els;
}

/** 状态机图：初态 / 终态 + 圆角状态 + 迁移 */
export function state(p: Palette): Skeleton[] {
  const d = new Pen("sakura.se.state", p);

  const init = d.ellipse(28, 36, 18, 18, { fill: "ink", stroke: "ink" });
  const unpaid = d.box(66, 22, 124, 46, { round: true, fill: "head", text: "待支付", size: 13 });
  const paid = d.box(302, 22, 124, 46, { round: true, fill: "head", text: "已支付", size: 13 });
  const shipped = d.box(302, 150, 124, 46, { round: true, fill: "head", text: "已发货", size: 13 });
  const cancelled = d.box(66, 150, 124, 46, { round: true, fill: "wash", text: "已取消", size: 13 });

  const finalOuter = d.unit(() => {
    const outer = d.ellipse(322, 272, 26, 26);
    d.ellipse(330, 280, 10, 10, { fill: "ink", stroke: "ink" });
    return outer;
  });

  d.arrow([[46, 45], [66, 45]], { start: init, end: unpaid });
  d.arrow([[190, 45], [302, 45]], { start: unpaid, end: paid });
  d.text(236, 31, "支付成功", { size: 11, color: "muted" });
  d.arrow([[128, 68], [128, 150]], { start: unpaid, end: cancelled });
  d.text(138, 109, "取消", { size: 11, color: "muted", align: "left" });
  d.arrow([[364, 68], [364, 150]], { start: paid, end: shipped });
  d.text(374, 109, "发货", { size: 11, color: "muted", align: "left" });
  d.arrow([[364, 196], [335, 272]], { start: shipped, end: finalOuter });
  d.text(362, 234, "签收", { size: 11, color: "muted" });

  return d.els;
}

/** 实体：表头 + 字段两段（字段是 Code 字体、左上对齐） */
function entity(d: Pen, x: number, y: number, w: number, name: string, fields: string[]) {
  d.unit(() => {
    d.box(x, y, w, 34, { fill: "head", text: name, size: 12.5 });
    d.box(x, y + 34, w, fields.length * 20 + 12, {
      text: fields.join("\n"),
      size: 11,
      font: "code",
      align: "left",
      valign: "top",
    });
  });
}

/** ER 图：0.18.1 没有鸦爪箭头，用三条 line 叠在关系线端点 */
export function er(p: Palette): Skeleton[] {
  const d = new Pen("sakura.se.er", p);
  const rel = { stroke: "muted" as const, sw: 2 };

  entity(d, 16, 24, 150, "Customer", ["pk id", "name", "email"]);
  entity(d, 330, 24, 154, "Order", ["pk id", "fk customer", "total", "status"]);
  entity(d, 16, 226, 150, "Product", ["pk id", "title", "price"]);
  entity(d, 330, 226, 154, "OrderItem", ["pk id", "fk order", "qty"]);

  // Customer 1 — N Order
  d.unit(() => {
    d.line([[166, 70], [330, 70]], rel);
    d.line([[176, 62], [176, 78]], rel);
    d.line([[330, 70], [342, 62]], rel);
    d.line([[330, 70], [342, 70]], rel);
    d.line([[330, 70], [342, 78]], rel);
    d.text(174, 56, "1", { size: 11, font: "code", color: "muted", align: "left" });
    d.text(318, 56, "N", { size: 11, font: "code", color: "muted", align: "right" });
  });

  // Order 1 — N OrderItem
  d.unit(() => {
    d.line([[407, 152], [407, 226]], rel);
    d.line([[399, 162], [415, 162]], rel);
    d.line([[407, 226], [399, 238]], rel);
    d.line([[407, 226], [407, 238]], rel);
    d.line([[407, 226], [415, 238]], rel);
    d.text(415, 186, "N", { size: 11, font: "code", color: "muted", align: "left" });
  });

  // Product 1 — N OrderItem
  d.unit(() => {
    d.line([[166, 272], [330, 272]], rel);
    d.line([[176, 264], [176, 280]], rel);
    d.line([[330, 272], [342, 264]], rel);
    d.line([[330, 272], [342, 272]], rel);
    d.line([[330, 272], [342, 280]], rel);
    d.text(174, 258, "1", { size: 11, font: "code", color: "muted", align: "left" });
    d.text(318, 258, "N", { size: 11, font: "code", color: "muted", align: "right" });
  });

  return d.els;
}
