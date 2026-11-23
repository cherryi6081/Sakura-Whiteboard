/**
 * 把 skeleton 目录（整图模板 + 元件）打包成 Excalidraw 库条目。
 *
 * 关键约束：
 * - 条目 id 与元素 versionNonce 必须稳定，`mergeLibraryItems` 用「元素数 + 逐个 id/versionNonce」判重；
 * - 改模板/元件内容必须升 `TEMPLATE_VERSION`，否则 merge 认为条目已存在而不更新；
 * - `created` 固定，避免每次启动时间戳变化导致排序抖动。
 */
import { convertToExcalidrawElements, mergeLibraryItems } from "@excalidraw/excalidraw";
import { CATALOG, type CatalogEntry } from "./catalog";
import { PALETTE, type Theme } from "./spec";

export type LibraryItems = Parameters<typeof mergeLibraryItems>[0];
export type LibraryItem = LibraryItems[number];

/** 模板/元件内容版本：内容变更时 +1，配合 pruneStale 清理旧副本 */
export const TEMPLATE_VERSION = 4;

/** 自播种条目的 id 前缀，用于区分用户自建条目 */
export const SEED_PREFIX = "sakura.";

const versionTag = (theme: Theme) => `@${TEMPLATE_VERSION}-${theme}`;

/** 带版本与主题的完整 library item id */
export const seedItemId = (entry: CatalogEntry, theme: Theme = "light") =>
  `${entry.id}${versionTag(theme)}`;

/** FNV-1a：把 id 变成稳定的 32 位正整数（替代 randomInteger） */
function stableHash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2_000_000_000;
}

/** skeleton → 原生元素，并把随机 seed / versionNonce 归一化成确定性值 */
export function buildCatalogEntry(entry: CatalogEntry, theme: Theme) {
  const elements = convertToExcalidrawElements(entry.build(PALETTE[theme]), {
    regenerateIds: false,
  });
  return elements.map((el) => ({
    ...el,
    seed: stableHash(`${el.id}:seed`),
    versionNonce: stableHash(`${el.id}:nonce`),
  }));
}

export function makeLibraryItems(theme: Theme = "light"): LibraryItem[] {
  return CATALOG.map((entry) => ({
    id: seedItemId(entry, theme),
    status: "published" as const,
    created: 0,
    elements: buildCatalogEntry(entry, theme),
  }));
}

/** 只保留当前版本（任意主题）的种子条目；用户自建条目一律保留 */
export function pruneStale(items: LibraryItems): LibraryItems {
  const current = `@${TEMPLATE_VERSION}-`;
  return items.filter(
    (item) => !item.id.startsWith(SEED_PREFIX) || item.id.includes(current),
  );
}

/** 版本升级时补齐当前版本条目（旧版存过一次的板子会把删掉的模板再回填一次） */
export function withDefaults(items: LibraryItems, theme: Theme = "light"): LibraryItems {
  return mergeLibraryItems(pruneStale(items), makeLibraryItems(theme));
}
