/**
 * 方案 A：同色光标的标签文案。
 *
 * 颜色本身是固定分配的（见服务端 `cursorPalette.ts`），这里**只决定标签文案**：
 * - 同一块板内按 `color` 分组；
 * - 组内按连接的加入时间（`joinedAt`）升序稳定排序，时间相同用 `connectionId` 兜底；
 * - 组内第 1 条只显示昵称，第 2 条起显示「昵称 · 2」「昵称 · 3」……
 *
 * 排序与人数无关的固定规则，不会因为输入数组顺序变化而抖动；某人离开后，
 * 同色组里后来的连接会自然前移、序号跟着收敛（颜色始终不变）。
 */
export type LabeledCursor = {
  connectionId: string;
  color: string;
  displayName: string;
  joinedAt: number;
};

export function buildCursorLabels(cursors: readonly LabeledCursor[]): Map<string, string> {
  const byColor = new Map<string, LabeledCursor[]>();
  for (const cursor of cursors) {
    const list = byColor.get(cursor.color);
    if (list) list.push(cursor);
    else byColor.set(cursor.color, [cursor]);
  }

  const labels = new Map<string, string>();
  for (const list of byColor.values()) {
    const ordered = [...list].sort(
      (a, b) => a.joinedAt - b.joinedAt || a.connectionId.localeCompare(b.connectionId),
    );
    ordered.forEach((cursor, index) => {
      const name = cursor.displayName || "协作者";
      labels.set(cursor.connectionId, index === 0 ? name : `${name} · ${index + 1}`);
    });
  }
  return labels;
}
