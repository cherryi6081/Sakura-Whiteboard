/**
 * 存储 key 的形状约束与分类。独立成纯函数模块，便于一致性校验在不加载
 * 存储驱动/环境配置的情况下做归类与单测。
 *
 * 只允许三种固定形状，杜绝路径穿越：
 * - 白板图片：`<12 位 boardId>/<64 位 hex sha256>`
 * - 白板缩略图：`<12 位 boardId>/thumbnail`（每板固定一个 key，覆盖式写入）
 * - 用户头像：`avatars/<uuid>.<ext>`（文件名由服务端随机生成，不含用户输入）
 */

export type StorageKeyKind = 'asset' | 'thumbnail' | 'avatar';

const BOARD_ASSET_KEY = /^[A-Za-z0-9_-]{12}\/[a-f0-9]{64}$/;
const BOARD_THUMBNAIL_KEY = /^[A-Za-z0-9_-]{12}\/thumbnail$/;
const AVATAR_KEY = /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/;

export function classifyStorageKey(key: string): StorageKeyKind | null {
  if (BOARD_ASSET_KEY.test(key)) return 'asset';
  if (BOARD_THUMBNAIL_KEY.test(key)) return 'thumbnail';
  if (AVATAR_KEY.test(key)) return 'avatar';
  return null;
}

export function isValidStorageKey(key: string): boolean {
  return classifyStorageKey(key) !== null;
}
