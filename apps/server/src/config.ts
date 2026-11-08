import { hostname } from 'node:os';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
      } catch {
        return false;
      }
    }, 'DATABASE_URL 必须是 postgres:// 或 postgresql:// 连接串'),
  REDIS_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), 'REDIS_URL 必须是 redis:// 或 rediss:// 连接串'),
  SESSION_SECRET: z.string().min(16),
  /** 游客 cookie `wb_gid` 的 HMAC 密钥（≥32 字节，缺失即拒绝启动）。 */
  GUEST_COOKIE_SECRET: z.string().min(32),
  /** 轮换期并行验签的上一代密钥（可选）。 */
  GUEST_COOKIE_SECRET_PREV: z.string().min(32).optional(),
  // 容器内未显式指定时用容器主机名，双实例才能各自区分
  INSTANCE_ID: z.string().default(() => hostname()),
  DB_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export type Config = z.infer<typeof EnvSchema>;

export const config: Config = EnvSchema.parse(process.env);

/**
 * 解析数据库连接串。
 *
 * Windows 上 `localhost` 可能先解析到 `::1`，而 PostgreSQL 只监听 IPv4 时连接会一直
 * ECONNREFUSED（Node 17+ 默认不再把 localhost 只当 IPv4）。这里统一改写成 `127.0.0.1`，
 * 同时把 user/password/database 拆成独立参数，避免连接串里含特殊字符时被 `pg` 误解析。
 */
export function parseDatabaseUrl(raw: string = config.DATABASE_URL) {
  const url = new URL(raw);
  const hostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;

  return {
    host: hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    sslmode: url.searchParams.get('sslmode'),
  };
}

/** 供日志与错误提示用的脱敏目标描述：不含密码。 */
export function describeDatabaseTarget(raw: string = config.DATABASE_URL): string {
  const { host, port, user, database } = parseDatabaseUrl(raw);
  return `${user}@${host}:${port}/${database}`;
}

/** 供日志与错误提示用的脱敏目标描述：不含密码。 */
export function describeRedisTarget(raw: string = config.REDIS_URL): string {
  const url = new URL(raw);
  const hostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
  return `${hostname}:${url.port || 6379}`;
}
