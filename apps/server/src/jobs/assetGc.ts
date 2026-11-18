import '../load-env.js';
import { pool } from '../infra/db.js';
import { storage } from '../infra/storage.js';
import { logger } from '../infra/logger.js';
import { config } from '../config.js';
import { ASSET_GC_HOUR, ASSET_GC_MINUTE } from '../domain/retention.js';
import { startDailyJob } from './dailySchedule.js';
import { withJobLock } from './jobLock.js';
import { hasRunToday, markRunCompleted } from './jobRuns.js';

/**
 * 图片资产回收任务（v1.1，§4.6 第二章 GC 段）。
 *
 * **默认 dry-run**：只查询与报告候选，不改 `status`、不删对象文件。
 * `apply:true` 才执行两阶段回收：
 *   1. 孤儿资产 / 失效引用 → `status='deleted'`，保留 `deleted_at` 供追溯；
 *   2. 已软删且超过宽限期的行 → 删对象文件，再写 `purged_at`；删对象失败只记失败、下次重试。
 *
 * 两类回收候选：
 * 1. 孤儿资产：超过宽限期，且没有任何**未删除** image 元素引用（元素被删掉/画布清空/上传后没落元素）；
 * 2. 失效引用：仍 active，但只被**已删除**元素引用（元素删除后留下的资产）。
 * 以及第二阶段的"对象待删除"清单：已经置 deleted 且过了宽限期、但尚未 purged 的行。
 *
 * 另外单独报告"元素引用了不存在的资产"的完整性告警（这些不是回收候选，是排障信号）。
 *
 * 两种运行方式：
 * - CLI：`npm run asset:gc -w @whiteboard/server -- [--grace-hours=24] [--batch-size=200] [--apply --yes]`
 * - 进程内调度：`ASSET_GC_ENABLED=true` 时每日 03:20（Asia/Shanghai）跑一轮；
 *   默认只 dry-run，只有 `ASSET_GC_APPLY=true` 且 `NODE_ENV=production` 才真正回收。
 */

export type AssetGcOptions = {
  graceHours?: number;
  batchSize?: number;
  apply?: boolean;
};

type AssetCandidate = {
  id: string;
  board_id: string;
  storage_key: string;
  size_bytes: number;
  mime: string;
  created_at: string;
  deleted_at: string | null;
  reason: string;
};

type PurgeFailure = { id: string; storageKey: string; message: string };

export type AssetGcSummary = {
  mode: 'apply' | 'dry-run';
  graceHours: number;
  batchSize: number;
  generatedAt: string;
  orphanAssets: { count: number; bytes: number; candidates: AssetCandidate[] };
  danglingAssets: { count: number; bytes: number; candidates: AssetCandidate[] };
  pendingPurge: { count: number; bytes: number; candidates: AssetCandidate[] };
  integrityWarnings: Array<{ element_id: string; board_id: string; asset_id: string; element_deleted: boolean }>;
  reclaimableBytes: number;
  applied: boolean;
  applyResults: null | {
    softDeleted: { orphan: number; dangling: number };
    purged: number;
    purgeFailures: PurgeFailure[];
  };
};

const REFERENCED = `(e.data->>'fileId' = a.id::text or coalesce(e.data->'customData'->>'assetId', '') = a.id::text)`;

/** 孤儿：过了宽限期，且没有任何未删除元素引用（也没有仅被已删除元素引用，后者单列） */
const ORPHAN_WHERE = `a.status = 'active'
        and a.created_at < now() - ($1 || ' hours')::interval
        and not exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = false and ${REFERENCED}
        )
        -- 只被已删除元素引用的归到 danglingAssets，避免两类重复计数
        and not exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = true and ${REFERENCED}
        )`;

/** 失效引用：仍 active，只被已删除元素引用 */
const DANGLING_WHERE = `a.status = 'active'
        and exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = true and ${REFERENCED}
        )
        and not exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = false and ${REFERENCED}
        )`;

/**
 * 把一批候选置为 deleted。
 * 先 `for update skip locked` 取行再更新：并发跑两次 GC 时不会互相阻塞，
 * 每批最多 batchSize 行，取不满一批就结束。
 */
async function softDeleteCandidates(
  whereSql: string,
  params: readonly unknown[],
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `with picked as (
         select a.id from assets a
          where ${whereSql}
          order by a.created_at
          limit $${params.length + 1}
          for update skip locked
       )
       update assets a
          set status = 'deleted', deleted_at = now()
         from picked
        where a.id = picked.id`,
      [...params, batchSize],
    );
    const count = rowCount ?? 0;
    total += count;
    if (count < batchSize) return total;
  }
}

/**
 * 物理清理第二阶段：软删且已过宽限期的行，先删对象再写 `purged_at`。
 * 对象删除失败不写 `purged_at`，留到下次运行重试；整批都失败时提前退出，避免空转。
 */
async function purgeExpired(
  graceHours: number,
  batchSize: number,
): Promise<{ scanned: number; purged: number; failures: PurgeFailure[] }> {
  let scanned = 0;
  let purged = 0;
  const failures: PurgeFailure[] = [];
  for (;;) {
    const { rows } = await pool.query<{ id: string; storage_key: string }>(
      `select id, storage_key
         from assets
        where status = 'deleted'
          and deleted_at < now() - ($1 || ' hours')::interval
          and purged_at is null
        order by deleted_at
        limit $2`,
      [graceHours, batchSize],
    );
    if (rows.length === 0) break;
    scanned += rows.length;
    let batchPurged = 0;
    for (const row of rows) {
      try {
        await storage.delete(row.storage_key);
      } catch (err) {
        failures.push({
          id: row.id,
          storageKey: row.storage_key,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const result = await pool.query('update assets set purged_at = now() where id = $1 and purged_at is null', [
        row.id,
      ]);
      if ((result.rowCount ?? 0) > 0) {
        purged += 1;
        batchPurged += 1;
      }
    }
    if (rows.length < batchSize) break;
    if (batchPurged === 0) break;
  }
  return { scanned, purged, failures };
}

const validateInt = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} 必须是 ${min}..${max} 的整数`);
  }
  return value;
};

/** 执行一次资产 GC；`apply:false`（默认）只出报告。 */
export async function runAssetGc(options: AssetGcOptions = {}): Promise<AssetGcSummary> {
  const graceHours = validateInt('graceHours', options.graceHours ?? 24, 1, 24 * 30);
  const batchSize = validateInt('batchSize', options.batchSize ?? 200, 1, 1000);
  const apply = options.apply === true;

  const { rows: orphanRows } = await pool.query<AssetCandidate>(
    `select a.id, a.board_id, a.storage_key, a.size_bytes, a.mime, a.created_at::text as created_at, null::text as deleted_at
       from assets a
      where ${ORPHAN_WHERE}
      order by a.created_at`,
    [graceHours],
  );

  const { rows: danglingRows } = await pool.query<AssetCandidate>(
    `select a.id, a.board_id, a.storage_key, a.size_bytes, a.mime, a.created_at::text as created_at, null::text as deleted_at
       from assets a
      where ${DANGLING_WHERE}
      order by a.created_at`,
    [],
  );

  const { rows: pendingPurgeRows } = await pool.query<AssetCandidate>(
    `select a.id, a.board_id, a.storage_key, a.size_bytes, a.mime, a.created_at::text as created_at, a.deleted_at::text as deleted_at
       from assets a
      where a.status = 'deleted'
        and a.deleted_at < now() - ($1 || ' hours')::interval
        and a.purged_at is null
      order by a.deleted_at`,
    [graceHours],
  );

  // 完整性告警：元素指向的资产不存在或已删除（说明上传/同步时序出过问题，或对象被误删）
  const { rows: brokenRows } = await pool.query<
    { element_id: string; board_id: string; asset_id: string; element_deleted: boolean }
  >(
    `select e.element_id as element_id, e.board_id, coalesce(e.data->>'fileId', e.data->'customData'->>'assetId') as asset_id,
            e.is_deleted as element_deleted
       from elements e
      left join assets a
        on a.id::text = coalesce(e.data->>'fileId', e.data->'customData'->>'assetId')
       and a.board_id = e.board_id
      where e.type = 'image'
        and coalesce(e.data->>'fileId', e.data->'customData'->>'assetId') is not null
        and (a.id is null or a.status <> 'active')
      order by e.element_id
      limit 50`,
  );

  // 先出报告：apply 也保留这一份快照，便于对照"报告了什么、实际改了什么"
  const sum = (list: readonly AssetCandidate[]) => list.reduce((total, row) => total + row.size_bytes, 0);
  const summary: AssetGcSummary = {
    mode: apply ? 'apply' : 'dry-run',
    graceHours,
    batchSize,
    generatedAt: new Date().toISOString(),
    orphanAssets: {
      count: orphanRows.length,
      bytes: sum(orphanRows),
      candidates: orphanRows.map((row) => ({ ...row, reason: 'orphan' })),
    },
    danglingAssets: {
      count: danglingRows.length,
      bytes: sum(danglingRows),
      candidates: danglingRows.map((row) => ({ ...row, reason: 'referenced-only-by-deleted-elements' })),
    },
    pendingPurge: { count: pendingPurgeRows.length, bytes: sum(pendingPurgeRows), candidates: pendingPurgeRows },
    integrityWarnings: brokenRows,
    reclaimableBytes: sum(orphanRows) + sum(danglingRows) + sum(pendingPurgeRows),
    applied: false,
    applyResults: null,
  };

  if (apply) {
    const orphan = await softDeleteCandidates(ORPHAN_WHERE, [graceHours], batchSize);
    const dangling = await softDeleteCandidates(DANGLING_WHERE, [], batchSize);
    const purged = await purgeExpired(graceHours, batchSize);
    summary.applied = true;
    summary.applyResults = {
      softDeleted: { orphan, dangling },
      purged: purged.purged,
      purgeFailures: purged.failures,
    };
  }

  return summary;
}

/** API 进程内每日调度；调用方负责用 `ASSET_GC_ENABLED` 决定是否注册。 */
export function startAssetGc(): () => void {
  return startDailyJob({
    name: 'asset-gc',
    hour: ASSET_GC_HOUR,
    minute: ASSET_GC_MINUTE,
    run: async () => {
      if (await hasRunToday('asset-gc')) {
        logger.info({ job: 'asset-gc' }, 'already ran today, skip');
        return;
      }
      // 破坏性模式需要两个条件同时成立：显式开启回收 + 生产环境
      const apply = config.ASSET_GC_APPLY && config.NODE_ENV === 'production';
      const outcome = await withJobLock('asset-gc', () =>
        runAssetGc({ graceHours: config.ASSET_GC_GRACE_HOURS, apply }),
      );
      if (!outcome.locked) return;
      await markRunCompleted('asset-gc');
      const summary = outcome.result;
      logger.info(
        {
          mode: summary.mode,
          orphanAssets: summary.orphanAssets.count,
          danglingAssets: summary.danglingAssets.count,
          pendingPurge: summary.pendingPurge.count,
          integrityWarnings: summary.integrityWarnings.length,
          reclaimableBytes: summary.reclaimableBytes,
          applyResults: summary.applyResults,
        },
        'asset gc finished',
      );
    },
  });
}

const isDirectRun = Boolean(process.argv[1] && /assetGc\.(ts|js)$/.test(process.argv[1]));

if (isDirectRun) {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  if (APPLY && !args.includes('--yes')) {
    console.error('[asset-gc] --apply 必须同时传 --yes 确认；只传 --apply 时按 dry-run 退出，未改动任何数据。');
    process.exit(1);
  }

  const graceArg = args.find((arg) => arg.startsWith('--grace-hours='))?.split('=')[1];
  const graceHours = graceArg === undefined ? 24 : Number(graceArg);
  if (!Number.isInteger(graceHours) || graceHours < 1 || graceHours > 24 * 30) {
    console.error('[asset-gc] --grace-hours 必须是 1..720 的整数');
    process.exit(1);
  }

  const batchArg = args.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1];
  const batchSize = batchArg === undefined ? 200 : Number(batchArg);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    console.error('[asset-gc] --batch-size 必须是 1..1000 的整数');
    process.exit(1);
  }

  runAssetGc({ apply: APPLY, graceHours, batchSize })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (summary.applied) {
        const result = summary.applyResults!;
        console.log(
          `\n[asset-gc] apply：软删孤儿 ${result.softDeleted.orphan} 个、失效引用 ${result.softDeleted.dangling} 个；` +
            `物理清理对象 ${result.purged} 个；对象删除失败 ${result.purgeFailures.length} 个（下次运行重试）。`,
        );
      } else {
        console.log(
          `\n[asset-gc] dry-run：孤儿 ${summary.orphanAssets.count} 个（${summary.orphanAssets.bytes}B），` +
            `失效引用 ${summary.danglingAssets.count} 个（${summary.danglingAssets.bytes}B），` +
            `待清理对象 ${summary.pendingPurge.count} 个（${summary.pendingPurge.bytes}B），合计可回收 ${summary.reclaimableBytes}B；` +
            `完整性告警 ${summary.integrityWarnings.length} 条。未删除任何数据。`,
        );
      }
    })
    .catch((err) => {
      console.error('[asset-gc] 执行失败', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => undefined));
}
