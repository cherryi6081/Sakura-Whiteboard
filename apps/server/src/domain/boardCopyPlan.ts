import { BOARD_TITLE_MAX } from './boardTitle.js';

/**
 * 复制白板的纯函数部分（不碰数据库/存储，便于单测）。
 *
 * 元素的图片引用口径与 `jobs/assetGc.ts` 一致：`data.fileId` 优先，
 * `data.customData.assetId` 兜底；两处都要在复制时重映射。
 */

export type ElementData = Record<string, unknown>;

const asRecord = (value: unknown): ElementData | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ElementData) : null;

/** 元素引用的资产 id：`fileId` 优先，`customData.assetId` 兜底。 */
export function assetIdOf(data: ElementData): string | null {
  const fileId = data.fileId;
  if (typeof fileId === 'string' && fileId) return fileId;
  const assetId = asRecord(data.customData)?.assetId;
  return typeof assetId === 'string' && assetId ? assetId : null;
}

/** 收集元素里引用的全部资产 id（去重，保持出现顺序）。 */
export function collectReferencedAssetIds(elements: readonly { data: ElementData }[]): string[] {
  const ids: string[] = [];
  for (const element of elements) {
    const id = assetIdOf(element.data);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 把元素里的资产引用改写成新 id。
 * 返回 `null` 表示引用的资产没有被复制（缺失），调用方应跳过该元素。
 */
export function remapElementData(data: ElementData, mapping: ReadonlyMap<string, string>): ElementData | null {
  const oldId = assetIdOf(data);
  if (!oldId) return data;
  const newId = mapping.get(oldId);
  if (!newId) return null;

  const next: ElementData = { ...data };
  if (next.fileId === oldId) next.fileId = newId;
  const customData = asRecord(next.customData);
  if (customData && customData.assetId === oldId) {
    next.customData = { ...customData, assetId: newId };
  }
  return next;
}

/** 默认副本名：`原名 的副本`，按标题上限截断（列表允许重名）。 */
export function defaultCopyTitle(sourceTitle: string): string {
  const suffix = ' 的副本';
  const base = sourceTitle.trim() || '未命名白板';
  return `${base.slice(0, BOARD_TITLE_MAX - suffix.length).trimEnd()}${suffix}`;
}
