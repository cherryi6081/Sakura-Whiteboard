/**
 * 本机"最近打开"记录（开发文档 §6.4：游客最近打开**只本地**，不进服务端）。
 *
 * **按身份隔离**：游客一份（`wb:recentBoards:guest`），每个登录用户一份
 * （`wb:recentBoards:user:<userId>`）。退出登录后读游客那份，绝不会读到上一个账号的条目；
 * 登录后也不会把游客/别人的记录当成自己的。
 * 历史版本只有一个全局 key `wb:recentBoards`，无法判断归属，首次加载直接丢弃重建。
 *
 * 只存 boardId、标题、打开时间与置顶标记，不存任何白板内容；同一 boardId 只保留一条并前移。
 * 存储不可用（隐私模式 / 配额满）时静默降级为空列表，不能让页面白屏。
 */

import { BOARDS_CAPACITY, sortBoards } from "./boardList";

const LEGACY_KEY = "wb:recentBoards";
const KEY_PREFIX = "wb:recentBoards";
/** 与列表容量一致：游客本机也最多 12 条（服务端满额时同样会淘汰一块） */
const MAX = BOARDS_CAPACITY;

/** 记录归属：游客，或某个登录用户 */
export type RecentOwner = { kind: "guest" } | { kind: "user"; id: string };

export const GUEST_OWNER: RecentOwner = { kind: "guest" };

export function userOwner(userId: string): RecentOwner {
  return { kind: "user", id: userId };
}

export function ownerKey(owner: RecentOwner): string {
  return owner.kind === "guest" ? `${KEY_PREFIX}:guest` : `${KEY_PREFIX}:user:${owner.id}`;
}

/** 缩略图缓存用的身份标识（不含存储 key 前缀）：`guest` / `user:<id>` */
export function ownerTag(owner: RecentOwner): string {
  return owner.kind === "guest" ? "guest" : `user:${owner.id}`;
}

/**
 * 当前标签页的身份缓存：列表页/编辑页拿到 `/api/auth/me` 后写入，
 * 让 `titleOf`、`recordRecentBoard` 这类同步调用不必到处传 owner。
 */
let activeOwner: RecentOwner = GUEST_OWNER;

export function setActiveOwner(owner: RecentOwner): void {
  activeOwner = owner;
}

export function activeOwnerOf(): RecentOwner {
  return activeOwner;
}

/** 旧全局 key 的归属无法区分，直接删掉，避免把上一个账号的条目带给游客。 */
function dropLegacyKey(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 存储不可用：本来也没有可清理的数据 */
  }
}

if (typeof localStorage !== "undefined") dropLegacyKey();

export type RecentBoard = { id: string; title: string; lastEditedAt: string; pinned?: boolean };

function readRaw(owner: RecentOwner = activeOwner): RecentBoard[] {
  try {
    const text = localStorage.getItem(ownerKey(owner));
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

function write(owner: RecentOwner, list: RecentBoard[]): void {
  try {
    localStorage.setItem(ownerKey(owner), JSON.stringify(trimToCapacity(list)));
  } catch {
    /* 存储不可用时只影响本机列表，不阻断使用 */
  }
}

/** 超出 12 条时按写入顺序截断，但置顶项不丢：用它们挤掉末尾的非置顶项。 */
function trimToCapacity(list: RecentBoard[]): RecentBoard[] {
  if (list.length <= MAX) return list;
  const kept = list.slice(0, MAX);
  for (const pinned of list.slice(MAX).filter((item) => item.pinned)) {
    let victim = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (!kept[i]?.pinned) {
        victim = i;
        break;
      }
    }
    if (victim < 0) break;
    kept[victim] = pinned;
  }
  return kept;
}

export function listRecentBoards(owner: RecentOwner = activeOwner): RecentBoard[] {
  return sortBoards(readRaw(owner));
}

export function titleOf(boardId: string, owner: RecentOwner = activeOwner): string | null {
  return readRaw(owner).find((item) => item.id === boardId)?.title ?? null;
}

export function recordRecentBoard(input: { id: string; title: string }, owner: RecentOwner = activeOwner): void {
  const raw = readRaw(owner);
  const previous = raw.find((item) => item.id === input.id);
  const rest = raw.filter((item) => item.id !== input.id);
  // 重新打开不能把置顶状态丢掉
  write(owner, [
    {
      id: input.id,
      title: input.title,
      lastEditedAt: new Date().toISOString(),
      pinned: previous?.pinned === true,
    },
    ...rest,
  ]);
}

export function removeRecentBoard(boardId: string, owner: RecentOwner = activeOwner): void {
  write(owner, readRaw(owner).filter((item) => item.id !== boardId));
}

/** 改名：本机标题只存本机，不同步的话刷新会回退到旧名。 */
export function renameRecentBoard(boardId: string, title: string, owner: RecentOwner = activeOwner): void {
  const raw = readRaw(owner);
  if (!raw.some((item) => item.id === boardId)) return;
  write(owner, raw.map((item) => (item.id === boardId ? { ...item, title } : item)));
}

/** 游客板的置顶只落在本机：与「游客最近打开只本地」的既有约定保持一致。 */
export function setRecentPinned(boardId: string, pinned: boolean, owner: RecentOwner = activeOwner): RecentBoard[] {
  const next = readRaw(owner).map((item) => (item.id === boardId ? { ...item, pinned } : item));
  write(owner, next);
  return sortBoards(next);
}

/**
 * 临时板转入账号后，把游客那份本机记录搬到账号下。
 *
 * - 只搬 `boardIds` 里列出的条目（服务端真正转过去的那批），其余游客记录原样保留；
 * - 账号那份已有的同 id 条目以账号为准，不重复插入；新条目按游客侧原顺序追加，
 *   读取时仍由 `sortBoards` 按置顶 + 时间排序，顺序不会乱；
 * - 两边都走 `write`，各自最多 12 条，置顶项不会被截断丢掉。
 */
export function migrateRecentBoards(
  from: RecentOwner,
  to: RecentOwner,
  boardIds?: readonly string[],
): number {
  if (from.kind === "guest" && to.kind === "guest") return 0;
  if (from.kind === "user" && to.kind === "user" && from.id === to.id) return 0;
  const fromRaw = readRaw(from);
  const moving = boardIds ? fromRaw.filter((item) => boardIds.includes(item.id)) : fromRaw;
  if (moving.length === 0) return 0;

  const toRaw = readRaw(to);
  const existing = new Set(toRaw.map((item) => item.id));
  write(to, [...toRaw, ...moving.filter((item) => !existing.has(item.id))]);
  const movingIds = new Set(moving.map((item) => item.id));
  write(from, fromRaw.filter((item) => !movingIds.has(item.id)));
  return moving.length;
}
