import '../load-env.js';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { config, describeDatabaseTarget, parseDatabaseUrl } from '../config.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

type AppliedRow = { filename: string; checksum: string };

async function listMigrations(): Promise<{ filename: string; sql: string; checksum: string }[]> {
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function main() {
  const target = parseDatabaseUrl();
  const pool = new Pool({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    max: 2,
    connectionTimeoutMillis: 5_000,
    application_name: 'whiteboard-migrate',
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  });

  try {
    await pool.query('select 1');
    console.log(`[migrate] connected: ${describeDatabaseTarget()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.trim() : String(err);
    const code = (err as NodeJS.ErrnoException).code;
    const hint = (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED'))
      ? '确认 PostgreSQL 已启动（npm run db:up），且 .env 的端口与实例一致'
      : code === '28P01'
        ? '认证失败：核对 .env 里的用户名/密码'
        : code === '3D000'
          ? '数据库不存在：先执行 npm run db:create'
          : '检查 .env 与 deploy/scripts 里的启动参数';
    console.error(`[migrate] cannot connect to PostgreSQL: ${message || code || 'unknown error'}`);
    console.error(`[migrate] target=${describeDatabaseTarget()} hint=${hint}`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await pool.query<AppliedRow>('select filename, checksum from schema_migrations');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  let count = 0;
  for (const m of await listMigrations()) {
    const previousChecksum = applied.get(m.filename);

    if (previousChecksum && previousChecksum !== m.checksum) {
      throw new Error(`[migrate] ${m.filename} 已被修改（checksum 不一致）。不要改历史迁移，请新增一个文件。`);
    }
    if (previousChecksum) continue;

    const startedAt = performance.now();
    await pool.query('begin');
    try {
      await pool.query(m.sql);
      await pool.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [
        m.filename,
        m.checksum,
      ]);
      await pool.query('commit');
      count += 1;
      console.log(`[migrate] applied ${m.filename} (${Math.round(performance.now() - startedAt)}ms)`);
    } catch (err) {
      await pool.query('rollback');
      throw new Error(`[migrate] failed on ${m.filename}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(count === 0 ? '[migrate] up to date, nothing to apply' : `[migrate] done, ${count} applied`);
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
