/** 项目管理：甘特图 / WBS 分解 / 看板泳道 */
import { Pen, type Skeleton } from "../draw";
import type { Palette } from "../spec";

/** 甘特图：任务列 + 月份表头 + 网格 + 任务条 + 上线里程碑 */
export function gantt(p: Palette): Skeleton[] {
  const d = new Pen("sakura.pm.gantt", p);
  const LX = 110;
  const CW = 97.5;
  const RH = 42;
  const TOP = 30;
  const bottom = TOP + 5 * RH;

  d.box(0, 0, LX, TOP, { fill: "wash", text: "任务", size: 11 });
  ["M1", "M2", "M3", "M4"].forEach((month, i) => {
    d.box(LX + i * CW, 0, CW, TOP, { fill: "wash", text: month, size: 10.5, font: "code" });
    d.line([[LX + i * CW, 0], [LX + i * CW, bottom]], { dash: true, sw: 1, stroke: "faint" });
  });
  d.line([[500, 0], [500, bottom]], { dash: true, sw: 1, stroke: "faint" });

  const tasks = [
    { name: "需求调研", x: 112, w: 96 },
    { name: "概要设计", x: 205, w: 100 },
    { name: "开发实现", x: 300, w: 150 },
    { name: "系统测试", x: 438, w: 62 },
  ];
  tasks.forEach((task, i) => {
    const y = TOP + i * RH;
    d.box(0, y, LX, RH, { text: task.name, size: 11.5, align: "left" });
    d.box(task.x, y + 12, task.w, 18, {
      fill: i === 2 ? "accent" : "wash",
      stroke: "muted",
      sw: 1,
    });
  });

  const lastY = TOP + 4 * RH;
  d.box(0, lastY, LX, RH, { text: "上线发布", size: 11.5, align: "left" });
  d.unit(() => {
    d.diamond(466, lastY + 12, 18, 18, { fill: "accent", stroke: "accent" });
    d.text(490, lastY + 21, "上线", { size: 10, color: "muted", align: "left" });
  });

  return d.els;
}

/** WBS 分解：根 → 三个中心 → 每个中心两个叶子 */
export function wbs(p: Palette): Skeleton[] {
  const d = new Pen("sakura.pm.wbs", p);

  d.box(190, 0, 140, 40, { fill: "accent", text: "电商平台", size: 12.5 });
  const lv2 = [
    { name: "商品中心", x: 20 },
    { name: "交易中心", x: 190 },
    { name: "用户中心", x: 360 },
  ];
  const leaves = [
    ["目录", "库存"],
    ["下单", "支付"],
    ["登录", "权限"],
  ];

  d.line([[260, 40], [260, 62]], { sw: 1 });
  d.line([[90, 62], [430, 62]], { sw: 1 });

  lv2.forEach((node, i) => {
    d.box(node.x, 84, 140, 40, { fill: "head", text: node.name, size: 12 });
    d.line([[node.x + 70, 62], [node.x + 70, 84]], { sw: 1 });
    d.line([[node.x + 70, 124], [node.x + 70, 148]], { sw: 1 });
    leaves[i].forEach((leaf, j) => {
      const center = node.x + j * 74 + 33;
      d.box(node.x + j * 74, 172, 66, 34, { text: leaf, size: 10.5 });
      d.line([[node.x + 70, 148], [center, 148]], { sw: 1 });
      d.line([[center, 148], [center, 172]], { sw: 1 });
    });
  });

  return d.els;
}

/** 看板泳道：三列 + 两条泳道 + 卡片 */
export function kanban(p: Palette): Skeleton[] {
  const d = new Pen("sakura.pm.kanban", p);
  const cols = ["待办", "进行中", "已完成"];

  cols.forEach((col, i) => {
    d.box(i * 130, 0, 120, 30, { fill: "wash", text: col, size: 11 });
    if (i > 0) d.line([[i * 130, 0], [i * 130, 340]], { dash: true, sw: 1, stroke: "faint" });
  });

  d.box(0, 30, 390, 24, { fill: "wash", text: "团队 A", size: 10.5, align: "left", color: "muted" });
  d.box(0, 184, 390, 24, { fill: "wash", text: "团队 B", size: 10.5, align: "left", color: "muted" });

  const cards = [
    { name: "需求梳理", x: 10, y: 64 },
    { name: "接口联调", x: 140, y: 64 },
    { name: "登录页", x: 270, y: 64 },
    { name: "支付回调", x: 10, y: 218 },
    { name: "埋点接入", x: 140, y: 218 },
  ];
  cards.forEach((card) => d.box(card.x, card.y, 100, 44, { round: true, text: card.name, size: 11 }));

  return d.els;
}
