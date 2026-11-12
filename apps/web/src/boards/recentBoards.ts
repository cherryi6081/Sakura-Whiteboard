/**
 * 游客/本机的"最近打开"记录（开发文档 §6.4：游客最近打开**只本地**，不进服务端）。
 *
 * 只存 boardId、标题、打开时间与置顶标记，不存任何白板内容；同一 boardId 只保留一条并前移。
 * 存储不可用（隐私模式 / 配额满）时静默降级为空列表，不能让页面白屏。
 */

import { sortBoards } from "./boardList";

const KEY = "wb:recentBoards";
const MAX = 20;

export type RecentBoard = { id: string; title: string; lastEditedAt: string; pinned?: boolean };

function readRaw(): RecentBoard[] {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentBoard =>
          typeof item === "object" && item !== null && typeof (item as RecentBoard).id === "string",
      )
      .map((item) => ({ ...item, pinned: item.pinned === true }));
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
  return sortBoards(readRaw());
}

export function titleOf(boardId: string): string | null {
  return readRaw().find((item) => item.id === boardId)?.title ?? null;
}

export function recordRecentBoard(input: { id: string; title: string }): void {
  const raw = readRaw();
  const previous = raw.find((item) => item.id === input.id);
  const rest = raw.filter((item) => item.id !== input.id);
  // 重新打开不能把置顶状态丢掉
  write([
    {
      id: input.id,
      title: input.title,
      lastEditedAt: new Date().toISOString(),
      pinned: previous?.pinned === true,
    },
    ...rest,
  ]);
}

export function removeRecentBoard(boardId: string): void {
  write(readRaw().filter((item) => item.id !== boardId));
}

/** 游客板的置顶只落在本机：与「游客最近打开只本地」的既有约定保持一致。 */
export function setRecentPinned(boardId: string, pinned: boolean): RecentBoard[] {
  const next = readRaw().map((item) => (item.id === boardId ? { ...item, pinned } : item));
  write(next);
  return sortBoards(next);
}
