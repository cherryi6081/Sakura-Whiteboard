import '../load-env.js';
import { pool } from '../infra/db.js';

/**
 * 图片资产回收任务（v1.1，§4.6 第二章 GC 段）。
 *
 * **本版只做 dry-run**：只查询与报告候选，不改 `status`、不删对象文件；传 `--apply` 会直接拒绝。
 *
 * 两类回收候选：
 * 1. 孤儿资产：超过宽限期，且没有任何**未删除** image 元素引用（元素被删掉/画布清空/上传后没落元素）；
 * 2. 失效引用：仍 active，但只被**已删除**元素引用（元素删除后留下的资产）。
 * 以及第二阶段的"对象待删除"清单：已经置 deleted 且过了宽限期、但尚未 purged 的行。
 *
 * 另外单独报告"元素引用了不存在的资产"的完整性告警（这些不是回收候选，是排障信号）。
 *
 * 用法：`npm run asset:gc -w @whiteboard/server -- [--grace-hours=24]`
 */

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

const args = process.argv.slice(2);
if (args.includes('--apply')) {
  console.error('[asset-gc] 本版只支持 dry-run，--apply 已被拒绝；生产回收请走单独审批过的脚本。');
  process.exit(1);
}

const graceArg = args.find((arg) => arg.startsWith('--grace-hours='))?.split('=')[1];
const graceHours = graceArg === undefined ? 24 : Number(graceArg);
if (!Number.isInteger(graceHours) || graceHours < 1 || graceHours > 24 * 30) {
  console.error('[asset-gc] --grace-hours 必须是 1..720 的整数');
  process.exit(1);
}

const REFERENCED = `(e.data->>'fileId' = a.id::text or coalesce(e.data->'customData'->>'assetId', '') = a.id::text)`;

async function main(): Promise<void> {
  const { rows: orphanRows } = await pool.query<AssetCandidate>(
    `select a.id, a.board_id, a.storage_key, a.size_bytes, a.mime, a.created_at::text as created_at, null::text as deleted_at
       from assets a
      where a.status = 'active'
        and a.created_at < now() - ($1 || ' hours')::interval
        and not exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = false and ${REFERENCED}
        )
        -- 只被已删除元素引用的归到 danglingAssets，避免两类重复计数
        and not exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = true and ${REFERENCED}
        )
      order by a.created_at`,
    [graceHours],
  );

  const { rows: danglingRows } = await pool.query<AssetCandidate>(
    `select a.id, a.board_id, a.storage_key, a.size_bytes, a.mime, a.created_at::text as created_at, null::text as deleted_at
       from assets a
      where a.status = 'active'
        and exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = true and ${REFERENCED}
        )
        and not exists (
          select 1 from elements e
           where e.board_id = a.board_id and e.is_deleted = false and ${REFERENCED}
        )
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
  const { rows: brokenRows } = await pool.query<{ element_id: string; board_id: string; asset_id: string; element_deleted: boolean }>(
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

  const sum = (list: readonly AssetCandidate[]) => list.reduce((total, row) => total + row.size_bytes, 0);
  const summary = {
    mode: 'dry-run',
    graceHours,
    generatedAt: new Date().toISOString(),
    orphanAssets: { count: orphanRows.length, bytes: sum(orphanRows), candidates: orphanRows.map((row) => ({ ...row, reason: 'orphan' })) },
    danglingAssets: {
      count: danglingRows.length,
      bytes: sum(danglingRows),
      candidates: danglingRows.map((row) => ({ ...row, reason: 'referenced-only-by-deleted-elements' })),
    },
    pendingPurge: { count: pendingPurgeRows.length, bytes: sum(pendingPurgeRows), candidates: pendingPurgeRows },
    integrityWarnings: brokenRows,
    reclaimableBytes: sum(orphanRows) + sum(danglingRows) + sum(pendingPurgeRows),
    applied: false,
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\n[asset-gc] dry-run：孤儿 ${orphanRows.length} 个（${sum(orphanRows)}B），失效引用 ${danglingRows.length} 个（${sum(danglingRows)}B），` +
      `待清理对象 ${pendingPurgeRows.length} 个（${sum(pendingPurgeRows)}B），合计可回收 ${summary.reclaimableBytes}B；` +
      `完整性告警 ${brokenRows.length} 条。未删除任何数据。`,
  );
}

main()
  .catch((err) => {
    console.error('[asset-gc] 执行失败', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
