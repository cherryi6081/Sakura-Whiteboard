import type { ElementOp } from '@whiteboard/shared';
import {
  CACHE_DB_NAME,
  CACHE_DB_VERSION,
  CACHE_STORES,
  CACHE_TTL_MS,
  ELEMENT_KEY_PATH,
  isCacheExpired,
} from './cachePolicy';

/**
 * M2-C5：自建 IndexedDB 缓存（**不用 localStorage**）。
 *
 * - `elements`：主键 `[boardId, elementId]` 复合键，按 `boardId` 索引；保存 Excalidraw 元素原文，
 *   刷新后可直接作为 `initialData` 渲染，不必先等网络。
 * - `outbox`：待发 op 队列（持久化 outbox），主键自增 `queueId`，`byBoard` + `byOpId` 索引；
 *   重连后按 queueId 顺序补发，服务端再按 `opId` 幂等去重。
 * - `meta`：每块板的同步水位 `seq` 与 `lastAccessAt`，TTL 清理用。
 *
 * 已知边界：元素 store 采用"整板覆盖写"（先按 boardId 删除再写当前场景），
 * 没有做逐元素增量；对当前量级（单板几百元素）足够，M3 再按需优化。
 */

type StoredElement = {
  boardId: string;
  elementId: string;
  element: Record<string, unknown>;
  updatedAt: number;
};

type StoredQueueItem = {
  queueId?: number;
  boardId: string;
  opId: string;
  op: ElementOp;
  createdAt: number;
};

export type StoredMeta = {
  boardId: string;
  seq: number;
  updatedAt: number;
  lastAccessAt: number;
};

export type CachedScene = {
  elements: Record<string, unknown>[];
  seq: number;
  lastAccessAt: number;
};

export type QueuedOp = {
  queueId: number;
  opId: string;
  op: ElementOp;
  createdAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openCacheDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORES.elements)) {
        const store = db.createObjectStore(CACHE_STORES.elements, { keyPath: [...ELEMENT_KEY_PATH] });
        store.createIndex('byBoard', 'boardId');
      }
      if (!db.objectStoreNames.contains(CACHE_STORES.outbox)) {
        const store = db.createObjectStore(CACHE_STORES.outbox, { keyPath: 'queueId', autoIncrement: true });
        store.createIndex('byBoard', 'boardId');
        store.createIndex('byOpId', 'opId', { unique: true });
      }
      if (!db.objectStoreNames.contains(CACHE_STORES.meta)) {
        db.createObjectStore(CACHE_STORES.meta, { keyPath: 'boardId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open wb-cache failed'));
  });
  return dbPromise;
}

function requestOf<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('idb transaction aborted'));
  });
}

const now = () => Date.now();

/** 读取缓存场景；没有缓存返回 null。 */
export async function readCachedScene(boardId: string): Promise<CachedScene | null> {
  const db = await openCacheDb();
  const tx = db.transaction([CACHE_STORES.elements, CACHE_STORES.meta], 'readonly');
  const metaReq = tx.objectStore(CACHE_STORES.meta).get(boardId) as IDBRequest<StoredMeta | undefined>;
  const elementsReq = tx
    .objectStore(CACHE_STORES.elements)
    .index('byBoard')
    .getAll(boardId) as IDBRequest<StoredElement[]>;
  const [meta, records] = await Promise.all([requestOf(metaReq), requestOf(elementsReq)]);
  await done(tx);

  if (!meta && records.length === 0) return null;
  return {
    elements: records.filter((r) => !(r.element as { isDeleted?: boolean }).isDeleted).map((r) => r.element),
    seq: meta?.seq ?? 0,
    lastAccessAt: meta?.lastAccessAt ?? 0,
  };
}

/** 整板覆盖写：先删该板既有元素，再写当前场景（含墓碑的元素会被跳过）。 */
export async function writeCachedScene(
  boardId: string,
  elements: readonly Record<string, unknown>[],
  seq: number,
): Promise<void> {
  const db = await openCacheDb();
  const stamp = now();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CACHE_STORES.elements, CACHE_STORES.meta], 'readwrite');
    const elementStore = tx.objectStore(CACHE_STORES.elements);
    const metaStore = tx.objectStore(CACHE_STORES.meta);

    const keysReq = elementStore.index('byBoard').getAllKeys(boardId);
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) elementStore.delete(key);
      for (const element of elements) {
        const elementId = typeof element.id === 'string' ? element.id : '';
        if (!elementId || element.isDeleted === true) continue;
        elementStore.put({ boardId, elementId, element, updatedAt: stamp } satisfies StoredElement);
      }
      const metaReq = metaStore.get(boardId) as IDBRequest<StoredMeta | undefined>;
      metaReq.onsuccess = () => {
        const previous: StoredMeta | undefined = metaReq.result;
        metaStore.put({
          boardId,
          seq: Math.max(seq, previous?.seq ?? 0),
          updatedAt: stamp,
          lastAccessAt: stamp,
        } satisfies StoredMeta);
      };
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('write scene failed'));
    tx.onabort = () => reject(tx.error ?? new Error('write scene aborted'));
  });
}

/** 只更新 `lastAccessAt`（刷新时让缓存不计入过期）。 */
export async function touchCache(boardId: string): Promise<void> {
  const db = await openCacheDb();
  const tx = db.transaction(CACHE_STORES.meta, 'readwrite');
  const store = tx.objectStore(CACHE_STORES.meta);
  const req = store.get(boardId) as IDBRequest<StoredMeta | undefined>;
  req.onsuccess = () => {
    const previous = req.result;
    store.put({
      boardId,
      seq: previous?.seq ?? 0,
      updatedAt: previous?.updatedAt ?? now(),
      lastAccessAt: now(),
    } satisfies StoredMeta);
  };
  await done(tx);
}

export async function getCachedSeq(boardId: string): Promise<number | null> {
  const db = await openCacheDb();
  const tx = db.transaction(CACHE_STORES.meta, 'readonly');
  const meta = await requestOf(tx.objectStore(CACHE_STORES.meta).get(boardId) as IDBRequest<StoredMeta | undefined>);
  await done(tx);
  return meta ? meta.seq : null;
}

/** 待发 op 入队；`opId` 已有记录时跳过（同一 op 不会因刷新重复排队）。 */
export async function enqueueOps(boardId: string, ops: readonly ElementOp[]): Promise<void> {
  if (ops.length === 0) return;
  const db = await openCacheDb();
  const tx = db.transaction(CACHE_STORES.outbox, 'readwrite');
  const store = tx.objectStore(CACHE_STORES.outbox);
  const byOpId = store.index('byOpId');
  const stamp = now();

  for (const op of ops) {
    const existsReq = byOpId.getKey(op.opId);
    existsReq.onsuccess = () => {
      if (existsReq.result !== undefined) return;
      store.add({ boardId, opId: op.opId, op, createdAt: stamp } satisfies StoredQueueItem);
    };
  }
  await done(tx);
}

export async function listQueuedOps(boardId: string): Promise<QueuedOp[]> {
  const db = await openCacheDb();
  const tx = db.transaction(CACHE_STORES.outbox, 'readonly');
  const rows = await requestOf(
    tx.objectStore(CACHE_STORES.outbox).index('byBoard').getAll(boardId) as IDBRequest<StoredQueueItem[]>,
  );
  await done(tx);
  return rows
    .map((row) => ({ queueId: Number(row.queueId ?? 0), opId: row.opId, op: row.op, createdAt: row.createdAt }))
    .sort((a, b) => a.queueId - b.queueId);
}

export async function removeQueuedOps(opIds: readonly string[]): Promise<void> {
  if (opIds.length === 0) return;
  const db = await openCacheDb();
  const tx = db.transaction(CACHE_STORES.outbox, 'readwrite');
  const store = tx.objectStore(CACHE_STORES.outbox);
  const byOpId = store.index('byOpId');
  for (const opId of opIds) {
    const keyReq = byOpId.getKey(opId);
    keyReq.onsuccess = () => {
      if (keyReq.result !== undefined) store.delete(keyReq.result);
    };
  }
  await done(tx);
}

export async function clearQueuedOps(boardId: string): Promise<void> {
  const db = await openCacheDb();
  const tx = db.transaction(CACHE_STORES.outbox, 'readwrite');
  const store = tx.objectStore(CACHE_STORES.outbox);
  const keysReq = store.index('byBoard').getAllKeys(boardId);
  keysReq.onsuccess = () => {
    for (const key of keysReq.result) store.delete(key);
  };
  await done(tx);
}

/** 板被删除（服务端 404）或缓存过期时调用：元素、队列、水位一起清。 */
export async function clearBoardCache(boardId: string): Promise<void> {
  const db = await openCacheDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CACHE_STORES.elements, CACHE_STORES.outbox, CACHE_STORES.meta], 'readwrite');
    const elementStore = tx.objectStore(CACHE_STORES.elements);
    const outbox = tx.objectStore(CACHE_STORES.outbox);

    const elementKeys = elementStore.index('byBoard').getAllKeys(boardId);
    elementKeys.onsuccess = () => {
      for (const key of elementKeys.result) elementStore.delete(key);
    };
    const outboxKeys = outbox.index('byBoard').getAllKeys(boardId);
    outboxKeys.onsuccess = () => {
      for (const key of outboxKeys.result) outbox.delete(key);
    };
    tx.objectStore(CACHE_STORES.meta).delete(boardId);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('clear board cache failed'));
    tx.onabort = () => reject(tx.error ?? new Error('clear board cache aborted'));
  });
}

/**
 * 启动时清理：删除 7 天未访问的板（元素 + 队列 + meta）。
 * 返回被清理的 boardId，便于日志/验收。
 */
export async function purgeExpiredCache(
  options: { now?: number; ttlMs?: number } = {},
): Promise<string[]> {
  const stamp = options.now ?? now();
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const db = await openCacheDb();
  const tx = db.transaction(CACHE_STORES.meta, 'readonly');
  const metas = await requestOf(tx.objectStore(CACHE_STORES.meta).getAll() as IDBRequest<StoredMeta[]>);
  await done(tx);

  const expired = metas
    .filter((meta) => isCacheExpired(meta.lastAccessAt, stamp, ttlMs))
    .map((meta) => meta.boardId);
  for (const boardId of expired) await clearBoardCache(boardId);
  return expired;
}

/** 验收/调试用：暴露库结构、复合键、队列与 localStorage 情况（不用于业务逻辑）。 */
export async function cacheDebugInfo(boardId: string) {
  const db = await openCacheDb();
  const stores = Array.from(db.objectStoreNames).map((name) => {
    const tx = db.transaction(name, "readonly");
    const store = tx.objectStore(name);
    return {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames),
    };
  });

  const tx = db.transaction([CACHE_STORES.elements, CACHE_STORES.outbox, CACHE_STORES.meta], "readonly");
  const elementKeys = await requestOf(
    tx.objectStore(CACHE_STORES.elements).index("byBoard").getAllKeys(boardId) as IDBRequest<IDBValidKey[]>,
  );
  const meta = await requestOf(
    tx.objectStore(CACHE_STORES.meta).get(boardId) as IDBRequest<StoredMeta | undefined>,
  );
  const queued = await requestOf(
    tx.objectStore(CACHE_STORES.outbox).index("byBoard").getAll(boardId) as IDBRequest<StoredQueueItem[]>,
  );
  await done(tx);

  let localStorageKeys: string[] = [];
  try {
    localStorageKeys = Object.keys(localStorage);
  } catch {
    localStorageKeys = ["<unavailable>"];
  }

  return {
    dbName: CACHE_DB_NAME,
    dbVersion: CACHE_DB_VERSION,
    stores,
    elementKeys: elementKeys.map((key) => (Array.isArray(key) ? key : [key])),
    meta: meta ?? null,
    queuedOps: queued.length,
    localStorageKeys,
    indexedDbNames: typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((d) => d.name) : [],
  };
}
