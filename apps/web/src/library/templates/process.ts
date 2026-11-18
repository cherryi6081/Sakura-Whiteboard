/** 流程与体验：BPMN 简化（其余模板为 P1/P2，不进首批） */
import { Pen, type Skeleton } from "../draw";
import type { Palette } from "../spec";

/** BPMN 简化：开始/结束事件 + 排他网关 + 两条分支 */
export function bpmn(p: Palette): Skeleton[] {
  const d = new Pen("sakura.flowx.bpmn", p);

  const start = d.ellipse(16, 88, 32, 32, { sw: 1 });
  const submit = d.box(70, 78, 110, 52, { round: true, fill: "head", text: "提交订单", size: 12 });
  const gateway = d.diamond(206, 76, 64, 64);
  d.line([[222, 92], [254, 124]], { sw: 1.5 });
  d.line([[254, 92], [222, 124]], { sw: 1.5 });

  const online = d.box(300, 20, 130, 50, { round: true, fill: "head", text: "在线支付", size: 12 });
  const cod = d.box(300, 150, 130, 50, { round: true, fill: "head", text: "货到付款", size: 12 });
  const end = d.ellipse(452, 88, 32, 32, { sw: 4 });

  d.arrow([[48, 104], [70, 104]], { start, end: submit });
  d.arrow([[180, 104], [206, 104]], { start: submit, end: gateway });
  d.arrow([[238, 76], [269, 62], [300, 45]], { start: gateway, end: online });
  d.text(258, 46, "是", { size: 11, color: "muted" });
  d.arrow([[430, 45], [468, 88]], { start: online, end });
  d.arrow([[238, 140], [269, 154], [300, 175]], { start: gateway, end: cod });
  d.text(258, 166, "否", { size: 11, color: "muted" });
  d.arrow([[430, 175], [468, 120]], { start: cod, end });

  return d.els;
}
