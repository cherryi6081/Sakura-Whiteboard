/**
 * 模板骨架的绘制 DSL。
 *
 * 产物是 `convertToExcalidrawElements` 的输入（skeleton），不是 Excalidraw 元素本体：
 * 文本会由 convert 绑定到容器上，箭头会按 start/end 建立绑定并重算 focus/gap。
 * 因此每个模板插入画板后都是原生元素（可单独选中、改字、改色、解组）。
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { FONT, STROKE, type Palette } from "./spec";

export type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];

export type Pt = [number, number];

type ColorKey = "ink" | "muted" | "faint" | "accent";
type FillKey = "head" | "wash" | "accent" | "ink";
type FontKey = keyof typeof FONT;
type Align = "left" | "center" | "right";

export type ShapeOpts = {
  fill?: FillKey;
  stroke?: ColorKey;
  dash?: boolean;
  round?: boolean;
  sw?: number;
  text?: string;
  size?: number;
  font?: FontKey;
  color?: ColorKey;
  align?: Align;
  valign?: "top" | "middle";
};

export type TextOpts = {
  size?: number;
  font?: FontKey;
  color?: ColorKey;
  /** 传 center/right 时，cx 分别是中心/右边界；默认 left（cx 为左边界） */
  align?: Align;
};

export type LineOpts = {
  stroke?: ColorKey;
  dash?: boolean;
  sw?: number;
};

export type ArrowHead = "arrow" | "triangle" | "triangle_outline" | "diamond" | "diamond_outline";

export type ArrowOpts = LineOpts & {
  head?: ArrowHead;
  startHead?: ArrowHead;
  /** 起点绑定的容器 id */
  start?: string;
  /** 终点绑定的容器 id */
  end?: string;
};

/** 一行文字的估算宽度：中文按 1em，西文按 0.56em，等宽按 0.6em */
function measureLine(line: string, size: number, font: FontKey): number {
  if (font === "code") return [...line].length * size * 0.6;
  return [...line].reduce((w, ch) => {
    const cjk = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch);
    return w + size * (cjk ? 1 : 0.56);
  }, 0);
}

export class Pen {
  readonly els: Skeleton[] = [];
  private seq = 0;
  private readonly group: string;

  constructor(
    readonly prefix: string,
    private readonly p: Palette,
  ) {
    // 一个模板一个组：插入后整组被选中，Ctrl+Shift+G 可解组
    this.group = `${prefix}.g`;
  }

  private next(): string {
    this.seq += 1;
    return `${this.prefix}.${this.seq}`;
  }

  private base(): Record<string, unknown> {
    return { roughness: 1, groupIds: [this.group] };
  }

  private fill(key?: FillKey): string {
    if (!key) return "transparent";
    return this.p[key === "accent" ? "terminal" : key];
  }


  box(x: number, y: number, w: number, h: number, o: ShapeOpts = {}): string {
    const id = this.next();
    const el: Record<string, unknown> = {
      ...this.base(),
      id,
      type: "rectangle",
      x,
      y,
      width: w,
      height: h,
      strokeColor: this.p[o.stroke ?? "ink"],
      backgroundColor: this.fill(o.fill),
      fillStyle: "solid",
      strokeWidth: o.sw ?? STROKE.base,
      strokeStyle: o.dash ? "dashed" : "solid",
      roundness: o.round ? { type: 3 } : null,
    };
    if (o.text !== undefined) {
      el.label = {
        text: o.text,
        fontSize: o.size ?? 13,
        fontFamily: FONT[o.font ?? "normal"],
        strokeColor: this.p[o.color ?? "ink"],
        textAlign: o.align ?? "center",
        verticalAlign: o.valign ?? "middle",
      };
    }
    this.els.push(el as unknown as Skeleton);
    return id;
  }

  diamond(x: number, y: number, w: number, h: number, o: ShapeOpts = {}): string {
    return this.shape("diamond", x, y, w, h, o);
  }

  ellipse(x: number, y: number, w: number, h: number, o: ShapeOpts = {}): string {
    return this.shape("ellipse", x, y, w, h, o);
  }

  private shape(type: "diamond" | "ellipse", x: number, y: number, w: number, h: number, o: ShapeOpts): string {
    const id = this.next();
    const el: Record<string, unknown> = {
      ...this.base(),
      id,
      type,
      x,
      y,
      width: w,
      height: h,
      strokeColor: this.p[o.stroke ?? "ink"],
      backgroundColor: this.fill(o.fill),
      fillStyle: "solid",
      strokeWidth: o.sw ?? STROKE.base,
      strokeStyle: o.dash ? "dashed" : "solid",
      roundness: null,
    };
    if (o.text !== undefined) {
      el.label = {
        text: o.text,
        fontSize: o.size ?? 13,
        fontFamily: FONT[o.font ?? "normal"],
        strokeColor: this.p[o.color ?? "ink"],
        textAlign: o.align ?? "center",
        verticalAlign: o.valign ?? "middle",
      };
    }
    this.els.push(el as unknown as Skeleton);
    return id;
  }

  /** 折线：坐标先归一化到 bbox（line 元素不会自动重算 width/height） */
  line(points: Pt[], o: LineOpts = {}): string {
    return this.polyline(points, false, o);
  }

  /** 闭合多边形（平行四边形、3D 顶/侧面）：用闭合 line + 实心底模拟 */
  poly(points: Pt[], o: LineOpts & { fill?: FillKey } = {}): string {
    return this.polyline([...points, points[0]], true, o);
  }

  private polyline(points: Pt[], closed: boolean, o: LineOpts & { fill?: FillKey }): string {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const id = this.next();
    this.els.push({
      ...this.base(),
      id,
      type: "line",
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
      points: points.map(([x, y]) => [x - minX, y - minY]),
      strokeColor: this.p[o.stroke ?? "ink"],
      backgroundColor: closed ? this.fill(o.fill) : "transparent",
      fillStyle: "solid",
      strokeWidth: o.sw ?? STROKE.base,
      strokeStyle: o.dash ? "dashed" : "solid",
      roundness: null,
    } as unknown as Skeleton);
    return id;
  }

  arrow(points: Pt[], o: ArrowOpts = {}): string {
    const [x0, y0] = points[0];
    const id = this.next();
    const outline = [o.head, o.startHead].some((h) => h?.endsWith("_outline"));
    this.els.push({
      ...this.base(),
      id,
      type: "arrow",
      x: x0,
      y: y0,
      points: points.map(([x, y]) => [x - x0, y - y0]),
      strokeColor: this.p[o.stroke ?? "ink"],
      // 空心箭头需要用画布底色填充，否则线会从箭头内部穿过
      backgroundColor: outline ? this.p.bg : "transparent",
      fillStyle: "solid",
      strokeWidth: o.sw ?? STROKE.base,
      strokeStyle: o.dash ? "dashed" : "solid",
      endArrowhead: o.head ?? null,
      startArrowhead: o.startHead ?? null,
      ...(o.start ? { start: { id: o.start } } : {}),
      ...(o.end ? { end: { id: o.end } } : {}),
    } as unknown as Skeleton);
    return id;
  }

  /** 独立文本：cx/cy 是文本块中心（与样式图 `tx` / `al` 的语义一致） */
  text(cx: number, cy: number, str: string, o: TextOpts = {}): string {
    const size = o.size ?? 12;
    const font = o.font ?? "normal";
    const lines = str.split("\n");
    const lh = Math.round(size * 1.25);
    const width = Math.max(...lines.map((line) => measureLine(line, size, font)));
    const align: Align = o.align ?? "center";
    const x = align === "center" ? cx - width / 2 : align === "right" ? cx - width : cx;
    const y = cy - (lines.length * lh) / 2;
    const id = this.next();
    this.els.push({
      ...this.base(),
      id,
      type: "text",
      x,
      y,
      width,
      height: lines.length * lh,
      text: str,
      fontSize: size,
      fontFamily: FONT[font],
      lineHeight: 1.25,
      textAlign: align,
      verticalAlign: "top",
      strokeColor: this.p[o.color ?? "ink"],
    } as unknown as Skeleton);
    return id;
  }
}
