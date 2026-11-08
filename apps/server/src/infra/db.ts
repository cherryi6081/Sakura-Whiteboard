import { Pool } from 'pg';
import { config, describeDatabaseTarget, parseDatabaseUrl } from '../config.js';

const target = parseDatabaseUrl();

export const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
  keepAlive: true,
  application_name: `whiteboard-api@${config.INSTANCE_ID}`,
  // 防止慢查询长期占住连接池
  statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
});

pool.on('error', () => {
  // 空闲连接被服务端断开（如重启）时 pg 会在这里抛，不能让它冒泡成未处理异常
});

export type PingResult = {
  ok: boolean;
  latencyMs?: number;
  target: string;
  error?: string;
};

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : String(err);
  const code = (err as NodeJS.ErrnoException).code;
  const base = message || code || 'connection failed';

  if (code === 'ECONNREFUSED' || base.includes('ECONNREFUSED')) {
    return `${base}（${describeDatabaseTarget()} 无应答：确认 PostgreSQL 已启动，端口与 .env 一致）`;
  }
  if (code === '28P01' || base.includes('password authentication failed')) {
    return `${base}（${describeDatabaseTarget()} 认证失败：核对 .env 中的用户名/密码）`;
  }
  if (code === '3D000') {
    return `${base}（${describeDatabaseTarget()} 数据库不存在：先执行 npm run db:create）`;
  }
  return `${base}（target=${describeDatabaseTarget()}）`;
}

export async function pingDb(): Promise<PingResult> {
  const startedAt = performance.now();
  try {
    await pool.query('select 1');
    return { ok: true, latencyMs: Number((performance.now() - startedAt).toFixed(2)), target: describeDatabaseTarget() };
  } catch (err) {
    return { ok: false, target: describeDatabaseTarget(), error: describeError(err) };
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
