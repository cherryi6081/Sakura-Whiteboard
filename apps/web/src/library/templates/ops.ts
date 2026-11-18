/** 工程运维：CI/CD 流水线（网络拓扑为 P1，不进首批） */
import { Pen, type Skeleton } from "../draw";
import type { Palette } from "../spec";

/** CI/CD 流水线：五个阶段 + 测试分支 */
export function cicd(p: Palette): Skeleton[] {
  const d = new Pen("sakura.ops.cicd", p);
  const stages = [
    ["提交", "git push"],
    ["构建", "build"],
    ["测试", "test"],
    ["打包", "image"],
    ["部署", "deploy"],
  ];

  const ids = stages.map(([name, sub], i) => {
    const x = 20 + i * 100;
    const id = d.box(x, 70, 86, 72, { round: true, fill: "head", text: `${name}\n${sub}`, size: 11 });
    d.ellipse(x + 72, 78, 8, 8, { fill: "accent", stroke: "accent" });
    return id;
  });
  for (let i = 0; i < 4; i += 1) {
    d.arrow([[20 + i * 100 + 86, 106], [20 + (i + 1) * 100, 106]], { start: ids[i], end: ids[i + 1] });
  }

  d.line([[265, 142], [265, 166]], { sw: 1 });
  d.line([[230, 166], [300, 166]], { sw: 1 });
  d.line([[230, 166], [230, 186]], { sw: 1 });
  d.line([[300, 166], [300, 186]], { sw: 1 });
  d.box(195, 186, 70, 34, { text: "单元测试", size: 10 });
  d.box(265, 186, 70, 34, { text: "集成测试", size: 10 });
  d.text(20, 250, "每个阶段产出可复现制品；失败即阻断后续阶段", { size: 10, color: "muted", align: "left" });

  return d.els;
}
