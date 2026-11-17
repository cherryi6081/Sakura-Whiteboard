import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';

/**
 * 图片资产的存储驱动（v1.1）。本次实现为**本地磁盘**驱动，接口保持窄（put/get/delete），
 * 生产替换成 S3 兼容对象存储时只需再实现一个 `StorageDriver`（差异见开发文档 §4.6 附录）。
 *
 * 失败语义：所有底层 IO 错误统一包成 `StorageError`，路由层映射为 `503 STORAGE_UNAVAILABLE`，
 * 不让磁盘故障被兜成 500。
 */

export class StorageError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export type StorageDriver = {
  put: (key: string, bytes: Buffer) => Promise<void>;
  /** 对象不存在返回 `null`；其它 IO 失败抛 `StorageError`。 */
  read: (key: string) => Promise<Buffer | null>;
  delete: (key: string) => Promise<void>;
};

/**
 * 存储 key 只允许两种形状，杜绝路径穿越：
 * - 白板图片：`<12 位 boardId>/<64 位 hex sha256>`
 * - 用户头像：`avatars/<uuid>.<ext>`（文件名由服务端随机生成，不含用户输入）
 */
const BOARD_ASSET_KEY = /^[A-Za-z0-9_-]{12}\/[a-f0-9]{64}$/;
const AVATAR_KEY = /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/;

export function isValidStorageKey(key: string): boolean {
  return BOARD_ASSET_KEY.test(key) || AVATAR_KEY.test(key);
}

export const storageRootDir = () => resolve(config.STORAGE_ROOT);

const objectPath = (key: string): string => {
  if (!isValidStorageKey(key)) throw new StorageError(`invalid storage key: ${key}`);
  return join(storageRootDir(), key);
};

export const localDiskStorage: StorageDriver = {
  async put(key, bytes) {
    const path = objectPath(key);
    // 先写临时文件再 rename：并发重复上传（同 sha256 同路径）不会读到半截文件
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new StorageError('storage put failed', err);
    }
  },

  async read(key) {
    try {
      return await readFile(objectPath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StorageError('storage read failed', err);
    }
  },

  async delete(key) {
    try {
      await rm(objectPath(key), { force: true });
    } catch (err) {
      throw new StorageError('storage delete failed', err);
    }
  },
};

export const storage: StorageDriver = localDiskStorage;
