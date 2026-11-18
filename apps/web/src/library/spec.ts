/**
 * 素材库模板的视觉规格（唯一真源）。
 * 数值与 `design/library-templates/style-sheet.html` 的 `THEMES` / 参数区一一对应，
 * 改这里等于改样式图，反之亦然。
 */

export type Theme = "light" | "dark";

export type Palette = {
  /** 主文字与主描边 */
  ink: string;
  /** 次要文字 / 次要描边 */
  muted: string;
  /** 辅助文字 / 网格线 */
  faint: string;
  /** 品牌强调色（描边） */
  accent: string;
  /** 填充：标题区 */
  head: string;
  /** 填充：浅色洗底 / 泳道 */
  wash: string;
  /** 填充：强调底（样式图里的 fillAccent） */
  terminal: string;
  /** 画布底色：仅用于空心箭头的内部填充 */
  bg: string;
};

export const PALETTE: Record<Theme, Palette> = {
  light: {
    ink: "#3a2e33",
    muted: "#6b5a61",
    faint: "#9a8a90",
    accent: "#a85c7c",
    head: "#fcf6f9",
    wash: "#f4eef1",
    terminal: "#f4e3e9",
    bg: "#ffffff",
  },
  dark: {
    ink: "#eef2fb",
    muted: "#bfc9de",
    faint: "#8d9ab4",
    accent: "#d39ab1",
    head: "#232d45",
    wash: "#1c2438",
    terminal: "#2a3552",
    bg: "#121212",
  },
};

/** Excalidraw FontFamilyValues：2 = Helvetica，3 = Cascadia（等宽） */
export const FONT = { normal: 2, code: 3 } as const;

/** 线宽映射：网格/生命线 1，常规 2，BPMN 结束事件 4 */
export const STROKE = { hair: 1, base: 2, bold: 4 } as const;
