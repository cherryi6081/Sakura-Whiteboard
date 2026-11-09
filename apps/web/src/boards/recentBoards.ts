/**
 * 游客/本机的"最近打开"记录（开发文档 §6.4：游客最近打开**只本地**，不进服务端）。
 *
 * 只存 boardId、标题与打开时间，不存任何白板内容；同一 boardId 只保留一条并前移。
 * 存储不可用（隐私模式 / 配额满）时静默降级为空列表，不能让页面白屏。
 */

const KEY = "wb:recentBoards";
const MAX = 20;

export type RecentBoard = { id: string; title: string; lastEditedAt: string };

function readRaw(): RecentBoard[] {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentBoard =>
        typeof item === "object" && item !== null && typeof (item as RecentBoard).id === "string",
    );
  } catch {
    return [];
  }
}

function write(list: RecentBoard[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 存储不可用时只影响本机列表，不阻断使用 */
  }
}

export function listRecentBoards(): RecentBoard[] {
  return readRaw().sort((a, b) => (b.lastEditedAt > a.lastEditedAt ? 1 : -1));
}

export function titleOf(boardId: string): string | null {
  return readRaw().find((item) => item.id === boardId)?.title ?? null;
}

export function recordRecentBoard(input: { id: string; title: string }): void {
  const rest = readRaw().filter((item) => item.id !== input.id);
  write([{ id: input.id, title: input.title, lastEditedAt: new Date().toISOString() }, ...rest]);
}

export function removeRecentBoard(boardId: string): void {
  write(readRaw().filter((item) => item.id !== boardId));
}
