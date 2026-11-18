import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { pool } from '../infra/db.js';
import { storage, StorageError } from '../infra/storage.js';
import {
  collectReferencedAssetIds,
  defaultCopyTitle,
  remapElementData,
  type ElementData,
} from './boardCopyPlan.js';

/**
 * 复制白板内容到调用者自己的空间（或指定的团队空间）。
 *
 * 只复制「内容」：元素当前态 + 被元素引用的图片资产。
 * **不复制**权限、分享链接、成员、回收站/归档状态、缩略图、op 日志——
 * 新板从 `last_seq = 0`、空分享配置开始，归调用者所有。
 *
 * 图片元素里的 `fileId`（= `assets.id`）必须重映射：
 * - 资产字节按新板 key `${newBoardId}/${sha256}` 复制一份；
 * - 新资产行 `board_id` 指向新板、`uploader_id` 是调用者；
 * - 元素 `data.fileId` 与 `data.customData.assetId` 一起改写成新 id。
 * 源资产缺失（被 GC / 文件丢失）时跳过对应元素，避免新板出现永久破图。
 *
 * 纯函数（引用收集 / 重映射 / 默认标题）在 `boardCopyPlan.ts`，可脱离数据库单测。
 */

export type SourceElement = {
  element_id: string;
  type: string;
  version: number;
  version_nonce: number;
  zindex_key: string;
  data: ElementData;
};

type SourceAsset = {
  id: string;
  mime: string;
  size_bytes: number;
  width: number;
  height: number;
  sha256: string;
  storage_key: string;
};


export type CopyBoardResult = {
  boardId: string;
  title: string;
  spaceId: string;
  elementCount: number;
  assetCount: number;
  /** 因源资产缺失而跳过的元素数 */
  skippedElements: number;
};

export async function copyBoardContents(params: {
  sourceBoardId: string;
  sourceTitle: string;
  userId: string;
  spaceId: string;
  title?: string;
}): Promise<CopyBoardResult> {
  const { sourceBoardId, sourceTitle, userId, spaceId } = params;
  const title = params.title?.trim() || defaultCopyTitle(sourceTitle);
  const newBoardId = nanoid(12);

  const { rows: sourceElements } = await pool.query<SourceElement>(
    `select element_id, type, version, version_nonce, zindex_key, data
       from elements
      where board_id = $1 and is_deleted = false
      order by zindex_key asc, element_id asc`,
    [sourceBoardId],
  );

  const referenced = collectReferencedAssetIds(sourceElements);
  const { rows: assets } = referenced.length
    ? await pool.query<SourceAsset>(
        `select id, mime, size_bytes, width, height, sha256, storage_key
           from assets
          where board_id = $1 and status = 'active' and id = any($2::uuid[])`,
        [sourceBoardId, referenced],
      )
    : { rows: [] as SourceAsset[] };

  const mapping = new Map<string, string>();
  const copiedAssets: Array<SourceAsset & { id: string; storage_key: string }> = [];
  const writtenKeys: string[] = [];

  try {
    for (const asset of assets) {
      const bytes = await storage.read(asset.storage_key);
      if (!bytes) continue;
      const newAssetId = randomUUID();
      const newKey = `${newBoardId}/${asset.sha256}`;
      await storage.put(newKey, bytes);
      writtenKeys.push(newKey);
      mapping.set(asset.id, newAssetId);
      copiedAssets.push({ ...asset, id: newAssetId, storage_key: newKey });
    }

    const elements: SourceElement[] = [];
    let skippedElements = 0;
    for (const element of sourceElements) {
      const data = remapElementData(element.data, mapping);
      if (!data) {
        skippedElements += 1;
        continue;
      }
      elements.push({ ...element, data });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into boards (id, title, owner_id, owner_guest_id, share_mode, space_id)
         values ($1, $2, $3, null, 'private', $4)`,
        [newBoardId, title, userId, spaceId],
      );

      if (copiedAssets.length > 0) {
        await client.query(
          `insert into assets (id, board_id, uploader_id, uploader_guest_id, mime, size_bytes, width, height, storage_key, sha256)
           select u.id, $1, $2, null, u.mime, u.size_bytes, u.width, u.height, u.storage_key, u.sha256
             from unnest($3::uuid[], $4::text[], $5::int[], $6::int[], $7::int[], $8::text[], $9::text[])
               as u(id, mime, size_bytes, width, height, storage_key, sha256)`,
          [
            newBoardId,
            userId,
            copiedAssets.map((asset) => asset.id),
            copiedAssets.map((asset) => asset.mime),
            copiedAssets.map((asset) => asset.size_bytes),
            copiedAssets.map((asset) => asset.width),
            copiedAssets.map((asset) => asset.height),
            copiedAssets.map((asset) => asset.storage_key),
            copiedAssets.map((asset) => asset.sha256),
          ],
        );
      }

      if (elements.length > 0) {
        await client.query(
          `insert into elements (board_id, element_id, type, version, version_nonce, zindex_key, is_deleted, data, updated_by, updated_at)
           select $1, u.element_id, u.type, u.version, u.version_nonce, u.zindex_key, false, u.data::jsonb, $2, now()
             from unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::text[], $8::text[])
               as u(element_id, type, version, version_nonce, zindex_key, data)`,
          [
            newBoardId,
            userId,
            elements.map((element) => element.element_id),
            elements.map((element) => element.type),
            elements.map((element) => element.version),
            elements.map((element) => element.version_nonce),
            elements.map((element) => element.zindex_key),
            elements.map((element) => JSON.stringify(element.data)),
          ],
        );
      }

      await client.query('commit');

      return {
        boardId: newBoardId,
        title,
        spaceId,
        elementCount: elements.length,
        assetCount: copiedAssets.length,
        skippedElements,
      };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    // 数据库失败时回收已经写入的对象，避免留下无人引用的孤儿文件
    await Promise.all(writtenKeys.map((key) => storage.delete(key).catch(() => undefined)));
    if (err instanceof StorageError) throw err;
    throw err;
  }
}
