import '../load-env.js';
import { pool } from '../infra/db.js';
import { storageDrivers, type StorageDriverName } from '../infra/storage.js';

/**
 * 存储迁移脚本：把本地磁盘上已有的对象搬到 S3 兼容存储（或反向搬回）。
 *
 * **默认 dry-run**：逐个检查源端是否存在、目标端是否已有同名对象，只输出报告。
 * 传 `--apply --yes` 才真正复制：写入目标端后读回逐字节比对，成功才算搬完；
 * 默认保留源端文件（`--delete-source` 才在比对通过后删除），避免迁移中途出错丢数据。
 *
 * 迁移对象覆盖三类：图片资产（`assets.storage_key`）、白板缩略图（`<boardId>/thumbnail`）、
 * 用户头像（`avatars/<uuid>.<ext>`）。key 布局不变，桶不对外暴露，业务侧始终走服务端代理。
 *
 * 推荐顺序：
 *   1. `npm run storage:migrate -w @whiteboard/server -- --from=local --to=s3`（预览）
 *   2. 同上加 `--apply --yes`（复制 + 校验，源文件保留）
 *   3. 服务端配置 `STORAGE_DRIVER=s3` 重启，抽查图片/缩略图/头像
 *   4. 稳定后加 `--delete-source` 再跑一次清理本地副本
 */

type Kind = 'asset' | 'thumbnail' | 'avatar';
type Candidate = { key: string; kind: Kind };

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];

const APPLY = args.includes('--apply');
if (APPLY && !args.includes('--yes')) {
  console.error('[storage-migrate] --apply 必须同时传 --yes 确认；只传 --apply 时按 dry-run 退出，未复制任何对象。');
  process.exit(1);
}

const from = (valueOf('from') ?? 'local') as StorageDriverName;
const to = (valueOf('to') ?? 's3') as StorageDriverName;
if (!(from in storageDrivers) || !(to in storageDrivers)) {
  console.error(`[storage-migrate] --from/--to 只能是 ${Object.keys(storageDrivers).join(' / ')}`);
  process.exit(1);
}
if (from === to) {
  console.error('[storage-migrate] --from 与 --to 不能相同');
  process.exit(1);
}

const DELETE_SOURCE = args.includes('--delete-source');
if (DELETE_SOURCE && !APPLY) {
  console.error('[storage-migrate] --delete-source 只能和 --apply --yes 一起用');
  process.exit(1);
}
const source = storageDrivers[from];
const target = storageDrivers[to];

/** 头像地址形如 `/api/avatars/<uuid>.<ext>`，反推出存储 key；不符合就跳过并计入告警 */
function avatarKeyOf(avatarUrl: string): string | null {
  const match = /^\/api\/avatars\/([^/?#]+)$/.exec(avatarUrl);
  return match ? `avatars/${match[1]}` : null;
}

async function collectCandidates(): Promise<{ items: Candidate[]; warnings: string[] }> {
  const { rows: assetRows } = await pool.query<{ key: string; kind: Kind }>(
    `select storage_key as key, 'asset' as kind from assets where purged_at is null
     union
     select b.id || '/thumbnail' as key, 'thumbnail' as kind from boards b where b.thumbnail_url is not null`,
  );
  const { rows: avatarRows } = await pool.query<{ avatar_url: string }>(
    'select avatar_url from users where avatar_url is not null',
  );

  const warnings: string[] = [];
  const seen = new Set<string>();
  const items: Candidate[] = [];
  for (const row of assetRows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    items.push({ key: row.key, kind: row.kind });
  }
  for (const row of avatarRows) {
    const key = avatarKeyOf(row.avatar_url);
    if (!key) {
      warnings.push(`无法解析头像地址：${row.avatar_url}`);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: 'avatar' });
  }
  return { items, warnings };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { items, warnings } = await collectCandidates();

  const missingInSource: string[] = [];
  const conflicts: string[] = [];
  const failures: Array<{ key: string; message: string }> = [];
  let copied = 0;
  let verified = 0;
  let deletedSource = 0;
  let bytes = 0;
  let processed = 0;

  for (const item of items) {
    processed += 1;
    if (processed % 100 === 0) console.error(`[storage-migrate] 进度 ${processed}/${items.length}`);
    try {
      const data = await source.read(item.key);
      if (!data) {
        missingInSource.push(item.key);
        continue;
      }
      bytes += data.byteLength;
      if (!APPLY) {
        if (await target.read(item.key)) conflicts.push(item.key);
        continue;
      }
      if (await target.read(item.key)) conflicts.push(item.key);
      await target.put(item.key, data);
      copied += 1;
      const back = await target.read(item.key);
      if (!back || !back.equals(data)) {
        failures.push({ key: item.key, message: '读回校验不一致' });
        continue;
      }
      verified += 1;
      if (DELETE_SOURCE) {
        await source.delete(item.key);
        deletedSource += 1;
      }
    } catch (err) {
      failures.push({ key: item.key, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = {
    mode: APPLY ? 'apply' : 'dry-run',
    from,
    to,
    deleteSource: DELETE_SOURCE,
    total: items.length,
    bytes,
    copied,
    verified,
    deletedSource,
    missingInSource: { count: missingInSource.length, keys: missingInSource.slice(0, 50) },
    conflicts: { count: conflicts.length, keys: conflicts.slice(0, 50) },
    failures,
    warnings,
    durationMs: Date.now() - startedAt,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) {
    console.log(
      `\n[storage-migrate] dry-run：共 ${items.length} 个对象（${bytes}B），源端缺失 ${missingInSource.length} 个，` +
        `目标端已存在 ${conflicts.length} 个。未复制任何对象。`,
    );
  } else {
    console.log(
      `\n[storage-migrate] apply：复制 ${copied} 个、读回校验通过 ${verified} 个、删除源端 ${deletedSource} 个，` +
        `失败 ${failures.length} 个，源端缺失 ${missingInSource.length} 个。`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[storage-migrate] 执行失败', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
