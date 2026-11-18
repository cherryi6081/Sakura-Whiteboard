import '../load-env.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pool } from '../infra/db.js';
import { config } from '../config.js';
import { storageDrivers, type StorageDriverName } from '../infra/storage.js';
import {
  avatarKeyOfUrl,
  buildStorageAudit,
  type ReferencedObject,
  type StorageAuditReport,
} from '../domain/storageAudit.js';

/**
 * 跨存储一致性校验（只读报告，不删除、不修复任何对象）。
 *
 * 对账三类 key（与 `domain/storageKeys.ts` 的形状一致）：
 * - `asset`：`assets.storage_key`（`purged_at is null`，包含 status='deleted' 但尚未物理清理的行）；
 * - `thumbnail`：`boards.thumbnail_url is not null` → `<boardId>/thumbnail`；
 * - `avatar`：`users.avatar_url` 以 `/api/avatars/` 开头 → `avatars/<uuid>.<ext>`；外链头像跳过。
 *
 * 报告区分：
 * - **库里有引用但对象缺失**（`missingObjects`）→ 线上读图会 404/503，需要从备份恢复或修库；
 * - **对象存在但没人引用**（`orphanObjects`）→ 硬删白板/覆盖上传失败/迁移残留，确认后再人工清理；
 * - 附带 `sizeMismatch`（资产行大小 ≠ 对象大小）作为告警。
 *
 * 用法：
 *   npm run storage:audit -w @whiteboard/server -- [--driver=local|s3|all] [--sample=50] [--out=report.json]
 * 默认只审计当前 `STORAGE_DRIVER`；`--driver=all` 时本地与 S3 各出一份。
 * 有差异时退出码仍为 0（这是巡检报告），只有存储不可达/查询失败才非 0。
 */

export type StorageAuditOptions = {
  drivers?: StorageDriverName[];
  sampleLimit?: number;
};

export type StorageAuditDriverResult = StorageAuditReport | { driver: string; error: string };

export type StorageAuditRun = {
  generatedAt: string;
  /** 无法反解/可疑但未中断对账的引用（只列前 20 条） */
  warnings: string[];
  referencedTotal: number;
  drivers: Record<string, StorageAuditDriverResult>;
};

type CollectedReferences = { referenced: ReferencedObject[]; warnings: string[] };

async function collectReferencedObjects(): Promise<CollectedReferences> {
  const warnings: string[] = [];
  const referenced: ReferencedObject[] = [];

  const { rows: assetRows } = await pool.query<{ key: string; size_bytes: number | string | null }>(
    `select storage_key as key, size_bytes
       from assets
      where purged_at is null
      order by storage_key`,
  );
  for (const row of assetRows) {
    referenced.push({
      key: row.key,
      kind: 'asset',
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    });
  }

  const { rows: thumbRows } = await pool.query<{ key: string }>(
    `select id || '/thumbnail' as key
       from boards
      where thumbnail_url is not null
      order by id`,
  );
  for (const row of thumbRows) referenced.push({ key: row.key, kind: 'thumbnail' });

  const { rows: avatarRows } = await pool.query<{ avatar_url: string }>(
    'select avatar_url from users where avatar_url is not null order by id',
  );
  for (const row of avatarRows) {
    const key = avatarKeyOfUrl(row.avatar_url);
    if (key) {
      referenced.push({ key, kind: 'avatar' });
      continue;
    }
    // 外链头像（GitHub 等）不属于本服务存储，跳过；但形如 /api/avatars/ 却解析失败的是脏数据
    if (row.avatar_url.startsWith('/api/avatars/')) {
      warnings.push(`无法解析头像地址：${row.avatar_url}`);
    }
  }

  return { referenced, warnings };
}

export async function runStorageAudit(options: StorageAuditOptions = {}): Promise<StorageAuditRun> {
  const drivers = options.drivers ?? [config.STORAGE_DRIVER];
  const { referenced, warnings } = await collectReferencedObjects();
  const generatedAt = new Date().toISOString();
  const results: StorageAuditRun['drivers'] = {};

  for (const driver of drivers) {
    try {
      const listed = await storageDrivers[driver].list();
      results[driver] = buildStorageAudit({
        driver,
        referenced,
        listed,
        sampleLimit: options.sampleLimit,
        now: new Date(generatedAt),
      });
    } catch (err) {
      results[driver] = {
        driver,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    generatedAt,
    warnings: warnings.slice(0, 20),
    referencedTotal: new Set(referenced.map((item) => item.key)).size,
    drivers: results,
  };
}

const isDirectRun = Boolean(process.argv[1] && /storageAudit\.(ts|js)$/.test(process.argv[1]));

if (isDirectRun) {
  const args = process.argv.slice(2);
  const driverArg = args.find((arg) => arg.startsWith('--driver='))?.split('=')[1] ?? config.STORAGE_DRIVER;
  if (!['local', 's3', 'all'].includes(driverArg)) {
    console.error('[storage:audit] --driver 只支持 local | s3 | all');
    process.exit(1);
  }
  const sampleArg = args.find((arg) => arg.startsWith('--sample='))?.split('=')[1];
  const sampleLimit = sampleArg === undefined ? 50 : Number(sampleArg);
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 1000) {
    console.error('[storage:audit] --sample 必须是 1..1000 的整数');
    process.exit(1);
  }
  const out = args.find((arg) => arg.startsWith('--out='))?.split('=')[1];

  const drivers: StorageDriverName[] = driverArg === 'all' ? ['local', 's3'] : [driverArg as StorageDriverName];

  runStorageAudit({ drivers, sampleLimit })
    .then(async (result) => {
      const json = JSON.stringify(result, null, 2);
      console.log(json);
      if (out) {
        const target = resolve(process.cwd(), out);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `${json}\n`, 'utf8');
        console.log(`\n[storage:audit] 报告已写入 ${target}`);
      }

      let hasError = false;
      for (const [driver, report] of Object.entries(result.drivers)) {
        if ('error' in report) {
          hasError = true;
          console.error(`[storage:audit] ${driver} 不可达：${report.error}`);
          continue;
        }
        const orphanKinds = Object.entries(report.orphanObjects.byKind)
          .filter(([, count]) => count > 0)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(' / ');
        console.log(
          `[storage:audit] ${driver}：库内引用 ${report.referenced.total}（asset ${report.referenced.byKind.asset} / ` +
            `thumbnail ${report.referenced.byKind.thumbnail} / avatar ${report.referenced.byKind.avatar}），` +
            `存储对象 ${report.stored.total}；缺失 ${report.missingObjects.total}，` +
            `无主 ${report.orphanObjects.total}${orphanKinds ? `（${orphanKinds}）` : ''}，` +
            `大小不一致 ${report.sizeMismatch.total}。`,
        );
      }
      if (result.warnings.length > 0) {
        console.warn(`[storage:audit] ${result.warnings.length} 条引用告警（详见 JSON 的 warnings）。`);
      }
      if (hasError) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('[storage:audit] 执行失败', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => undefined));
}
