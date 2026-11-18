import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

/**
 * 图片资产的存储驱动（v1.1）。接口保持窄（put/get/delete），两种实现：
 * - `local`：本地磁盘（默认，开发/单机部署）；
 * - `s3`：S3 兼容对象存储（AWS S3 / MinIO / R2 / OSS 的 S3 模式），签名与传输交给官方 SDK。
 *
 * 桶不对外暴露：读取仍走 `/api/assets/:id`、`/api/avatars/:file`、`/api/boards/:id/thumbnail`
 * 服务端代理，画布里存的地址保持稳定、不带有效期。key 布局与本地磁盘一致，
 * 以后要直接挂 CDN 时只需在桶前加一层，不需要改业务代码。
 *
 * 失败语义：所有底层 IO 错误统一包成 `StorageError`，路由层映射为 `503 STORAGE_UNAVAILABLE`，
 * 不让磁盘/对象存储故障被兜成 500。
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
 * 存储 key 只允许三种固定形状，杜绝路径穿越：
 * - 白板图片：`<12 位 boardId>/<64 位 hex sha256>`
 * - 白板缩略图：`<12 位 boardId>/thumbnail`（每板固定一个 key，覆盖式写入）
 * - 用户头像：`avatars/<uuid>.<ext>`（文件名由服务端随机生成，不含用户输入）
 */
const BOARD_ASSET_KEY = /^[A-Za-z0-9_-]{12}\/[a-f0-9]{64}$/;
const BOARD_THUMBNAIL_KEY = /^[A-Za-z0-9_-]{12}\/thumbnail$/;
const AVATAR_KEY = /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/;

export function isValidStorageKey(key: string): boolean {
  return BOARD_ASSET_KEY.test(key) || BOARD_THUMBNAIL_KEY.test(key) || AVATAR_KEY.test(key);
}

/**
 * 服务端包根目录（`apps/server`）。相对 `STORAGE_ROOT` 一律以它为基准，
 * 而不是进程 cwd：API 由 `npm run dev`、迁移脚本、直接从仓库根启动进程时
 * 都能落到同一个目录，避免历史上出现根 `.storage` 与 `apps/server/.storage` 两套文件。
 */
const serverPackageRoot = fileURLToPath(new URL('../../', import.meta.url));

export const storageRootDir = () => resolve(serverPackageRoot, config.STORAGE_ROOT);

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

/**
 * 懒建 S3 客户端：迁移脚本可能在 `STORAGE_DRIVER=local` 时把对象写入 s3，
 * 所以不能只在“当前生效驱动是 s3”时才初始化。配置不全时给出明确报错。
 */
let s3Client: S3Client | null = null;

function s3(): S3Client {
  if (s3Client) return s3Client;
  if (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
    throw new StorageError('S3 未配置：需要 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY');
  }
  s3Client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
}

export const s3Storage: StorageDriver = {
  async put(key, bytes) {
    if (!isValidStorageKey(key)) throw new StorageError(`invalid storage key: ${key}`);
    try {
      await s3().send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: bytes }));
    } catch (err) {
      throw new StorageError('storage put failed', err);
    }
  },

  async read(key) {
    if (!isValidStorageKey(key)) throw new StorageError(`invalid storage key: ${key}`);
    try {
      const result = await s3().send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
      if (!result.Body) throw new StorageError('storage read failed: empty body');
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof StorageError) throw err;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (err as { name?: string }).name;
      if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return null;
      throw new StorageError('storage read failed', err);
    }
  },

  async delete(key) {
    if (!isValidStorageKey(key)) throw new StorageError(`invalid storage key: ${key}`);
    try {
      // DeleteObject 对不存在的对象也返回成功，天然幂等
      await s3().send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    } catch (err) {
      throw new StorageError('storage delete failed', err);
    }
  },
};

export const storage: StorageDriver = config.STORAGE_DRIVER === 's3' ? s3Storage : localDiskStorage;

/** 迁移脚本按名字取驱动，不受“当前生效驱动”影响。 */
export const storageDrivers = { local: localDiskStorage, s3: s3Storage } as const;
export type StorageDriverName = keyof typeof storageDrivers;
