import { hostname } from 'node:os';
import { z } from 'zod';

/** `.env` 里的空字符串按“未配置”处理（本地默认文件保留了占位空值）。 */
const optionalString = () =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().min(1).optional());

/** 布尔开关：只把 1/true/yes/on 当 true（`z.coerce.boolean()` 会把 "false" 也当 true）。 */
const booleanFlag = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }, z.boolean().default(defaultValue));

/** 清理/GC 调度默认只在生产开启：本地与测试不会因为启动 API 就触发破坏性任务。 */
const defaultJobsEnabled = process.env.NODE_ENV === 'production';

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
  /** 图片资产落盘根目录（本地磁盘驱动）；相对路径以进程 cwd 为基准。 */
  STORAGE_ROOT: z.string().min(1).default('.storage'),
  /**
   * 存储驱动：`local`（默认，本地磁盘）或 `s3`（S3 兼容对象存储，图片 / 缩略图 / 头像共用）。
   * 切到 s3 时桶不对外暴露，读仍走 `/api/assets|avatars|boards/:id/thumbnail` 服务端代理。
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /** S3 兼容端点；AWS 可留空，MinIO / R2 / OSS(S3 模式) 必须显式填写。 */
  S3_ENDPOINT: optionalString(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: optionalString(),
  S3_ACCESS_KEY_ID: optionalString(),
  S3_SECRET_ACCESS_KEY: optionalString(),
  /** MinIO 需要 path-style（默认 true）；AWS 虚拟主机风格可置 false。 */
  S3_FORCE_PATH_STYLE: booleanFlag(true),
  /**
   * 游客板过期清理调度（每日 03:10 Asia/Shanghai）。
   * 默认只在 production 开启；本地/测试默认关闭，避免误删开发数据。
   */
  GUEST_GC_ENABLED: booleanFlag(defaultJobsEnabled),
  /**
   * 资产 GC 调度（每日 03:20 Asia/Shanghai）。默认只在 production 开启。
   * 调度默认只 dry-run；只有 `ASSET_GC_APPLY=true` 且 NODE_ENV=production 才真正回收。
   */
  ASSET_GC_ENABLED: booleanFlag(defaultJobsEnabled),
  /** 调度执行的资产 GC 是否真正回收（CLI 不受此开关影响，仍要求 --apply --yes）。 */
  ASSET_GC_APPLY: booleanFlag(false),
  /** 资产 GC 宽限期（小时）：孤儿与已软删资产的观察期。 */
  ASSET_GC_GRACE_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** 签名 URL 的 HMAC 密钥；缺省复用 SESSION_SECRET（生产建议单独配置并可轮换）。 */
  ASSET_URL_SECRET: z.string().min(32).optional(),
  /** 签名 URL 有效期（秒），应短于浏览器 HTTP 缓存时间。 */
  ASSET_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  /** 前端静态产物目录（生产镜像由 API 同源托管）；缺省不托管，交给 Vite dev server。 */
  WEB_DIST: z.string().min(1).optional(),
  /** GitHub OAuth：三项齐备才启用；缺任意一项时登录页不展示入口。 */
  GITHUB_CLIENT_ID: optionalString(),
  GITHUB_CLIENT_SECRET: optionalString(),
  /** 注册到 GitHub 的回调地址；缺省按请求的 proto/host 推导。 */
  GITHUB_REDIRECT_URI: optionalString(),
  /**
   * 前端来源：开发环境填 http://localhost:5173，生产可留空（按请求同源）。
   * 只用于 OAuth 回调后的最终 302，不参与接口路由。
   */
  WEB_APP_ORIGIN: optionalString(),
  /**
   * 服务端访问 GitHub 的出站代理（Node 自带 fetch 不读系统代理与 HTTPS_PROXY）。
   * 缺省回落到进程环境里的 HTTPS_PROXY / HTTP_PROXY；都为空则直连。
   */
  GITHUB_PROXY: optionalString(),
  /** 仅测试用：把 OAuth 站点与 API 指到本地假 provider。 */
  GITHUB_OAUTH_BASE_URL: z.string().url().default('https://github.com'),
  GITHUB_API_BASE_URL: z.string().url().default('https://api.github.com'),
  /** Google OAuth（OIDC 授权码 + PKCE）：CLIENT_ID / SECRET 齐备才启用。 */
  GOOGLE_CLIENT_ID: optionalString(),
  GOOGLE_CLIENT_SECRET: optionalString(),
  /** 注册到 Google Cloud 控制台的重定向 URI；缺省按请求的 proto/host 推导。 */
  GOOGLE_REDIRECT_URI: optionalString(),
  /** 服务端访问 Google 的出站代理；缺省回落到 HTTPS_PROXY / HTTP_PROXY。 */
  GOOGLE_PROXY: optionalString(),
  /** 仅测试用：把授权 / 换 token / 用户资料指到本地假 provider。 */
  GOOGLE_OAUTH_BASE_URL: z.string().url().default('https://accounts.google.com'),
  GOOGLE_TOKEN_BASE_URL: z.string().url().default('https://oauth2.googleapis.com'),
  GOOGLE_API_BASE_URL: z.string().url().default('https://openidconnect.googleapis.com'),
  /**
   * 邮件通道：`auto`（默认）在配置了 SMTP_HOST 时走 SMTP，否则落到日志通道；
   * `log` 只把邮件写日志，本地开发/测试无需任何真实凭据；`smtp` 强制走 SMTP。
   */
  MAIL_DRIVER: z.enum(['auto', 'smtp', 'log']).default('auto'),
  SMTP_HOST: optionalString(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  /** 465 端口通常为 true（隐式 TLS），587 端口保持 false（STARTTLS）。 */
  SMTP_SECURE: booleanFlag(false),
  SMTP_USER: optionalString(),
  SMTP_PASS: optionalString(),
  /** 发件人；缺省用 `桜花白板 <no-reply@localhost>`。 */
  MAIL_FROM: optionalString(),
}).superRefine((value, ctx) => {
  if (value.STORAGE_DRIVER !== 's3') return;
  for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
    if (!value[key]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `STORAGE_DRIVER=s3 时 ${key} 必填` });
    }
  }
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
