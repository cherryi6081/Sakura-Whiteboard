import '../load-env.js';
import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { storage } from '../infra/storage.js';
import {
  GUEST_BOARD_PURGE_DELAY_DAYS,
  GUEST_BOARD_RETENTION_DAYS,
  GUEST_CLEANUP_HOUR,
  GUEST_CLEANUP_MINUTE,
} from '../domain/retention.js';
import { startDailyJob } from './dailySchedule.js';
import { withJobLock } from './jobLock.js';
import { hasRunToday, markRunCompleted } from './jobRuns.js';

/**
 * 游客板过期清理（开发文档 §13.4 / 数据保留章节）。
 *
 * 两阶段，与回收站清理分开：
 *   1. `last_edited_at` 超过 30 天（默认）→ 写 `deleted_at` 软删；
 *   2. 软删再满 7 天（默认）→ 物理删除行（级联 elements / board_ops / snapshots /
 *      share_links / assets），并尽力删除对应的图片与缩略图对象。
 *
 * 为什么软删用 `deleted_at` 而不是 `archived_at`：
 * - 归档板按现有授权规则**仍然可打开**，只从默认列表挪走；游客列表本来就在本机，
 *   归档对游客没有可见效果；
 * - 游客没有回收站，`deleted_at` 不会出现在任何人的回收站里，
 *   但 `resolveBoardAccess` 会立即按 404 拒绝访问，过期语义才真正生效。
 *
 * 安全默认：
 * - CLI 默认 dry-run，必须 `--apply --yes` 才改库/删对象；
 * - 进程内调度由 `GUEST_GC_ENABLED` 控制，默认只在 production 开启；
 * - 多副本靠 `withJobLock` 只让一个实例执行；
 * - 只处理 `owner_guest_id is not null and is_public = false` 的板，
 *   公共临时板与已认领（`owner_guest_id` 被清空）的板天然不在范围内。
 */

export type GuestGcOptions = {
  retentionDays?: number;
  purgeDelayDays?: number;
  batchSize?: number;
  /** false（默认）= 只出报告，不改库、不删对象 */
  apply?: boolean;
};

type ExpiredBoard = {
  id: string;
  title: string;
  owner_guest_id: string;
  last_edited_at: string;
  deleted_at: string | null;
};

type ObjectFailure = { key: string; message: string };

export type GuestGcSummary = {
  mode: 'dry-run' | 'apply';
  retentionDays: number;
  purgeDelayDays: number;
  batchSize: number;
  generatedAt: string;
  expiredBoards: { count: number; sample: ExpiredBoard[] };
  pendingPurgeBoards: { count: number; sample: ExpiredBoard[] };
  applied: boolean;
  applyResults: null | {
    softDeleted: number;
    hardDeleted: number;
    objectsDeleted: number;
    objectFailures: ObjectFailure[];
  };
};

const CANDIDATE_COLUMNS =
  'id, title, owner_guest_id, last_edited_at::text as last_edited_at, deleted_at::text as deleted_at';

const validateInt = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} 必须是 ${min}..${max} 的整数`);
  }
  return value;
};

/** 阶段一：到期游客板软删（批量 `for update skip locked`，并发跑也不会互相阻塞）。 */
export async function softDeleteExpiredGuestBoards(retentionDays: number, batchSize: number): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `with picked as (
         select id from boards
          where owner_guest_id is not null
            and is_public = false
            and deleted_at is null
            and last_edited_at <= now() - make_interval(days => $1::int)
          order by last_edited_at
          limit $2
          for update skip locked
       )
       update boards b
          set deleted_at = now()
         from picked
        where b.id = picked.id`,
      [retentionDays, batchSize],
    );
    const count = rowCount ?? 0;
    total += count;
    if (count < batchSize) return total;
  }
}

/**
 * 阶段二：软删满 7 天的游客板物理删除。
 *
 * 每批一个事务：锁行 → 收集该批板的资产/缩略图 key → 删行 → 提交；
 * 提交后再删对象。对象删除失败只记日志（行已经没了，留下的是无主对象，
 * 由 `storage:audit` 报告，不阻塞清理）。
 */
export async function purgeExpiredGuestBoards(
  purgeDelayDays: number,
  batchSize: number,
): Promise<{ hardDeleted: number; objectsDeleted: number; objectFailures: ObjectFailure[] }> {
  let hardDeleted = 0;
  const objectKeys = new Set<string>();
  const client = await pool.connect();

  try {
    for (;;) {
      await client.query('begin');
      let ids: string[] = [];
      try {
        const { rows } = await client.query<{ id: string }>(
          `select id from boards
            where owner_guest_id is not null
              and is_public = false
              and deleted_at is not null
              and deleted_at <= now() - make_interval(days => $1::int)
            order by deleted_at
            limit $2
            for update skip locked`,
          [purgeDelayDays, batchSize],
        );
        ids = rows.map((row) => row.id);
        if (ids.length === 0) {
          await client.query('commit');
          break;
        }

        const { rows: assetRows } = await client.query<{ storage_key: string }>(
          'select storage_key from assets where board_id = any($1::text[])',
          [ids],
        );
        const { rows: thumbRows } = await client.query<{ id: string }>(
          'select id from boards where id = any($1::text[]) and thumbnail_url is not null',
          [ids],
        );
        for (const row of assetRows) objectKeys.add(row.storage_key);
        for (const row of thumbRows) objectKeys.add(`${row.id}/thumbnail`);

        const deleted = await client.query('delete from boards where id = any($1::text[])', [ids]);
        hardDeleted += deleted.rowCount ?? 0;
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      }
      if (ids.length < batchSize) break;
    }
  } finally {
    client.release();
  }

  const keys = [...objectKeys];
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
  const objectFailures: ObjectFailure[] = [];
  let objectsDeleted = 0;
  results.forEach((result, index) => {
    const key = keys[index]!;
    if (result.status === 'fulfilled') {
      objectsDeleted += 1;
    } else {
      objectFailures.push({
        key,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return { hardDeleted, objectsDeleted, objectFailures };
}

async function countBoards(whereSql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from boards where ${whereSql}`,
    params,
  );
  return Number(rows[0]?.count ?? 0);
}

async function sampleBoards(
  whereSql: string,
  params: unknown[],
  limit: number,
): Promise<ExpiredBoard[]> {
  const { rows } = await pool.query<ExpiredBoard>(
    `select ${CANDIDATE_COLUMNS} from boards where ${whereSql} order by last_edited_at limit $${params.length + 1}`,
    [...params, limit],
  );
  return rows;
}

/** 执行一次清理；`apply:false` 只返回待处理清单，不写库、不删对象。 */
export async function runGuestGc(options: GuestGcOptions = {}): Promise<GuestGcSummary> {
  const retentionDays = validateInt('retentionDays', options.retentionDays ?? GUEST_BOARD_RETENTION_DAYS, 1, 3650);
  const purgeDelayDays = validateInt('purgeDelayDays', options.purgeDelayDays ?? GUEST_BOARD_PURGE_DELAY_DAYS, 1, 365);
  const batchSize = validateInt('batchSize', options.batchSize ?? 200, 1, 1000);
  const apply = options.apply === true;

  const expiredWhere = `owner_guest_id is not null and is_public = false and deleted_at is null
        and last_edited_at <= now() - make_interval(days => $1::int)`;
  const pendingWhere = `owner_guest_id is not null and is_public = false and deleted_at is not null
        and deleted_at <= now() - make_interval(days => $1::int)`;

  const expiredCount = await countBoards(expiredWhere, [retentionDays]);
  const pendingCount = await countBoards(pendingWhere, [purgeDelayDays]);
  const expiredSample = await sampleBoards(expiredWhere, [retentionDays], 50);
  const pendingSample = await sampleBoards(pendingWhere, [purgeDelayDays], 50);

  const summary: GuestGcSummary = {
    mode: apply ? 'apply' : 'dry-run',
    retentionDays,
    purgeDelayDays,
    batchSize,
    generatedAt: new Date().toISOString(),
    expiredBoards: { count: expiredCount, sample: expiredSample },
    pendingPurgeBoards: { count: pendingCount, sample: pendingSample },
    applied: false,
    applyResults: null,
  };

  if (!apply) return summary;

  const softDeleted = await softDeleteExpiredGuestBoards(retentionDays, batchSize);
  const purged = await purgeExpiredGuestBoards(purgeDelayDays, batchSize);
  summary.applied = true;
  summary.applyResults = {
    softDeleted,
    hardDeleted: purged.hardDeleted,
    objectsDeleted: purged.objectsDeleted,
    objectFailures: purged.objectFailures,
  };
  return summary;
}

/** API 进程内每日调度；调用方负责用 `GUEST_GC_ENABLED` 决定是否注册。 */
export function startGuestGc(): () => void {
  return startDailyJob({
    name: 'guest-gc',
    hour: GUEST_CLEANUP_HOUR,
    minute: GUEST_CLEANUP_MINUTE,
    run: async () => {
      if (await hasRunToday('guest-gc')) {
        logger.info({ job: 'guest-gc' }, 'already ran today, skip');
        return;
      }
      const outcome = await withJobLock('guest-gc', () => runGuestGc({ apply: true }));
      if (!outcome.locked) return;
      await markRunCompleted('guest-gc');
      const summary = outcome.result;
      logger.info(
        {
          softDeleted: summary.applyResults?.softDeleted ?? 0,
          hardDeleted: summary.applyResults?.hardDeleted ?? 0,
          objectsDeleted: summary.applyResults?.objectsDeleted ?? 0,
          objectFailures: summary.applyResults?.objectFailures.length ?? 0,
          retentionDays: summary.retentionDays,
          purgeDelayDays: summary.purgeDelayDays,
        },
        'guest gc finished',
      );
    },
  });
}

const isDirectRun = Boolean(process.argv[1] && /guestGc\.(ts|js)$/.test(process.argv[1]));

if (isDirectRun) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply && !args.includes('--yes')) {
    console.error('[guest-gc] --apply 必须同时传 --yes 确认；只传 --apply 时按 dry-run 退出，未改动任何数据。');
    process.exit(1);
  }

  const valueOf = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  const parseArg = (name: string, fallback: number): number => {
    const raw = valueOf(name);
    return raw === undefined ? fallback : Number(raw);
  };

  runGuestGc({
    apply,
    retentionDays: parseArg('retention-days', GUEST_BOARD_RETENTION_DAYS),
    purgeDelayDays: parseArg('purge-delay-days', GUEST_BOARD_PURGE_DELAY_DAYS),
    batchSize: parseArg('batch-size', 200),
  })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (summary.applied) {
        const result = summary.applyResults!;
        console.log(
          `\n[guest-gc] apply：软删 ${result.softDeleted} 块、硬删 ${result.hardDeleted} 块、删除对象 ${result.objectsDeleted} 个，` +
            `对象删除失败 ${result.objectFailures.length} 个（由 storage:audit 报告）。`,
        );
      } else {
        console.log(
          `\n[guest-gc] dry-run：待软删 ${summary.expiredBoards.count} 块（超 ${summary.retentionDays} 天未编辑），` +
            `待硬删 ${summary.pendingPurgeBoards.count} 块（软删满 ${summary.purgeDelayDays} 天）。未删除任何数据。`,
        );
      }
    })
    .catch((err) => {
      console.error('[guest-gc] 执行失败', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => undefined));
}
