/**
 * 协作光标色板。
 *
 * 共 20 色 = 原有 6 色（原样保留在最前面）+ 新增 14 色。新增色沿用同一套低饱和
 * 「灰调」审美：饱和度 34–40%、明度 43–59%，与旧色（饱和度 20–30%）同档，
 * 不引入荧光色；明度在相邻色相之间交错，避免同色相堆叠。
 *
 * 选色校验口径（由 cursorPalette.test.ts 固化）：
 * - 两两 CIE76 ΔE ≥ 15：旧色自身最接近的一对 #5C9E7C / #5CA8A0 是 15.4，
 *   新增色与任何已有色的距离都不低于这个下限，不会出现「近似色扎堆」；
 * - 与白底对比度 ≥ 2.75（旧色最低 #5CA8A0 = 2.78），与夜间主题底色 #131a2b
 *   对比度 ≥ 3.1，保证 9px 圆点 + 白描边在浅色/夜间画布上都看得清。
 *
 * 稳定性：颜色只由身份串的字符和取模决定，与在线列表、加入顺序无关；
 * 同一用户每次进板都是同一个颜色，不会因为别人加入/离开而抖动。
 */
export const CURSOR_COLORS = [
  // 原有 6 色（保持不变）
  '#A85C7C',
  '#7C8AA8',
  '#5C9E7C',
  '#A88B5C',
  '#8A5CA8',
  '#5CA8A0',
  // 新增 14 色（按色相从红到紫排列）
  '#AC4D4F',
  '#BA7378',
  '#BB8772',
  '#9A5942',
  '#A49A51',
  '#819D4D',
  '#5AAB49',
  '#519CB3',
  '#4B6D9B',
  '#6E76B9',
  '#6262BC',
  '#9948A8',
  '#AB498E',
  '#BE6FBE',
] as const;

/**
 * 固定分配：`CHARSUM(seed) % 20`。seed 依次取 `userId` / `guestId` / `clientId`。
 * 扩色后模数从 6 变成 20，老用户在本次上线时会一次性重映射，之后永久固定。
 */
export function cursorColorOf(seed: string): string {
  const index = [...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % CURSOR_COLORS.length;
  return CURSOR_COLORS[index] ?? CURSOR_COLORS[0];
}
