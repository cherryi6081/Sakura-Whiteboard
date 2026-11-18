/** 架构：分层架构 / 微服务拓扑 */
import { Pen, type Skeleton } from "../draw";
import type { Palette } from "../spec";

/** 分层架构：四层 + 横切能力 */
export function layered(p: Palette): Skeleton[] {
  const d = new Pen("sakura.arch.layered", p);
  const layers = [
    ["接入层", "Gateway · 静态资源"],
    ["应用层", "订单 · 支付 · 用户"],
    ["领域层", "聚合 · 领域服务"],
    ["基础设施层", "DB · MQ · 缓存"],
  ];

  const ids = layers.map(([name, sub], i) =>
    d.box(20, 20 + i * 64, 320, 48, {
      fill: i === 1 ? "accent" : "head",
      text: `${name}　${sub}`,
      size: 12,
      align: "left",
    }),
  );

  for (let i = 0; i < 3; i += 1) {
    const y = 20 + i * 64;
    d.arrow([[180, y + 48], [180, y + 64]], { start: ids[i], end: ids[i + 1] });
  }

  d.box(360, 20, 120, 240, {
    dash: true,
    sw: 1,
    stroke: "faint",
    text: "横切能力",
    size: 11,
    valign: "top",
    color: "muted",
  });
  d.box(376, 56, 88, 40, { text: "配置", size: 12 });
  d.box(376, 104, 88, 40, { text: "日志", size: 12 });
  d.box(376, 152, 88, 40, { text: "监控", size: 12 });
  d.box(376, 200, 88, 40, { text: "链路追踪", size: 11 });

  return d.els;
}

/** 微服务拓扑：客户端 → 网关 → 三个服务 → 消息总线 / 订单库 */
export function micro(p: Palette): Skeleton[] {
  const d = new Pen("sakura.arch.micro", p);

  const client = d.box(16, 66, 86, 46, { round: true, text: "客户端", size: 12 });
  const gateway = d.box(140, 66, 110, 48, { fill: "accent", text: "API 网关", size: 12 });
  d.arrow([[102, 89], [140, 89]], { start: client, end: gateway });

  const services = [
    { name: "订单服务", x: 20 },
    { name: "库存服务", x: 150 },
    { name: "支付服务", x: 280 },
  ];
  const bus = d.box(20, 268, 370, 26, { fill: "wash", text: "消息总线 / 事件流", size: 10.5, font: "code" });
  const svcIds = services.map((svc) => {
    const id = d.box(svc.x, 176, 110, 56, { fill: "head", text: svc.name, size: 12 });
    d.arrow([[195, 114], [svc.x + 55, 176]], { start: gateway, end: id });
    d.arrow([[svc.x + 55, 232], [svc.x + 55, 268]], { start: id, end: bus });
    return id;
  });

  // 圆柱体：柱身 + 上下椭圆 + 名称
  const dbBody = d.box(410, 159, 76, 78, { fill: "head" });
  d.ellipse(410, 150, 76, 18, { fill: "head" });
  d.ellipse(410, 228, 76, 18, { fill: "head" });
  d.text(448, 260, "订单库", { size: 10.5, color: "muted" });

  d.arrow([[390, 204], [410, 204]], { start: svcIds[2], end: dbBody });

  return d.els;
}
