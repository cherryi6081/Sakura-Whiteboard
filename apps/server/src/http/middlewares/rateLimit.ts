import type { Request } from 'express';
import { ensureRedisConnected, redis } from '../../infra/redis.js';
import { logger } from '../../infra/logger.js';

/**
 * 登录 / 注册限流（开发文档 §7.1.1）。
 *
 * 计数存 Redis（多实例共享）：键第一次自增时设过期，窗口到期自动清零。
 * Redis 不可用时**放行**（fail-open）：限流是防爆破的兜底，不应因缓存故障把登录整体打死；
 * 失败会打 warn 日志，便于告警。
 */

export type RateLimitRule = {
  key: string;
  limit: number;
  windowSeconds: number;
};

export const LOGIN_EMAIL_LIMIT = 5;
export const LOGIN_IP_LIMIT = 20;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const REGISTER_IP_LIMIT = 100;
export const REGISTER_WINDOW_SECONDS = 60 * 60;

/** 找回密码发信：同一邮箱 3 次 / 15 分钟，同一 IP 10 次 / 小时。 */
export const FORGOT_EMAIL_LIMIT = 3;
export const FORGOT_EMAIL_WINDOW_SECONDS = 15 * 60;
export const FORGOT_IP_LIMIT = 10;
export const FORGOT_IP_WINDOW_SECONDS = 60 * 60;
/** 重置密码提交：同一 IP 20 次 / 15 分钟（token 本身是 256 位随机值）。 */
export const RESET_IP_LIMIT = 20;
export const RESET_IP_WINDOW_SECONDS = 15 * 60;
/** 登录态发送邮箱验证：同一用户 3 次 / 15 分钟，同一 IP 10 次 / 小时。 */
export const VERIFY_SEND_LIMIT = 3;
export const VERIFY_SEND_WINDOW_SECONDS = 15 * 60;

export const loginEmailRule = (email: string): RateLimitRule => ({
  key: `rl:login:email:${email}`,
  limit: LOGIN_EMAIL_LIMIT,
  windowSeconds: LOGIN_WINDOW_SECONDS,
});

export const loginIpRule = (ip: string): RateLimitRule => ({
  key: `rl:login:ip:${ip}`,
  limit: LOGIN_IP_LIMIT,
  windowSeconds: LOGIN_WINDOW_SECONDS,
});

export const registerIpRule = (ip: string): RateLimitRule => ({
  key: `rl:register:ip:${ip}`,
  limit: REGISTER_IP_LIMIT,
  windowSeconds: REGISTER_WINDOW_SECONDS,
});

export const forgotEmailRule = (email: string): RateLimitRule => ({
  key: `rl:forgot:email:${email}`,
  limit: FORGOT_EMAIL_LIMIT,
  windowSeconds: FORGOT_EMAIL_WINDOW_SECONDS,
});

export const forgotIpRule = (ip: string): RateLimitRule => ({
  key: `rl:forgot:ip:${ip}`,
  limit: FORGOT_IP_LIMIT,
  windowSeconds: FORGOT_IP_WINDOW_SECONDS,
});

export const resetIpRule = (ip: string): RateLimitRule => ({
  key: `rl:reset:ip:${ip}`,
  limit: RESET_IP_LIMIT,
  windowSeconds: RESET_IP_WINDOW_SECONDS,
});

export const verifySendUserRule = (userId: string): RateLimitRule => ({
  key: `rl:verify:user:${userId}`,
  limit: VERIFY_SEND_LIMIT,
  windowSeconds: VERIFY_SEND_WINDOW_SECONDS,
});

export const verifySendIpRule = (ip: string): RateLimitRule => ({
  key: `rl:verify:send:ip:${ip}`,
  limit: FORGOT_IP_LIMIT,
  windowSeconds: FORGOT_IP_WINDOW_SECONDS,
});

export const verifyEmailIpRule = (ip: string): RateLimitRule => ({
  key: `rl:verify:consume:ip:${ip}`,
  limit: 30,
  windowSeconds: 15 * 60,
});

/** 直连部署（compose 暴露 8080）下 `req.ip` 即客户端地址；开发期经 Vite 代理会统一成回环地址。 */
export function clientIp(req: Request): string {
  const raw = req.ip || req.socket.remoteAddress || 'unknown';
  // IPv4-mapped IPv6（::ffff:127.0.0.1）与纯 IPv4 归一，避免同一客户端落两个计数键
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * 只读检查：已达上限返回需要等待的秒数，未达上限返回 null。
 * 用于「失败才计数」的登录场景，成功请求不消耗额度。
 */
export async function rateLimitWait(rules: RateLimitRule[]): Promise<number | null> {
  try {
    await ensureRedisConnected();
    let wait: number | null = null;
    for (const rule of rules) {
      const count = Number(await redis.get(rule.key) ?? 0);
      if (count < rule.limit) continue;
      const ttl = await redis.ttl(rule.key);
      wait = Math.max(wait ?? 0, ttl > 0 ? ttl : rule.windowSeconds);
    }
    return wait;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'rate limit check failed');
    return null;
  }
}

/** 记一次失败（或一次尝试）：自增并在首次写入时设置窗口过期。 */
export async function rateLimitRecord(rules: RateLimitRule[]): Promise<void> {
  try {
    await ensureRedisConnected();
    for (const rule of rules) {
      const count = await redis.incr(rule.key);
      if (count === 1) await redis.expire(rule.key, rule.windowSeconds);
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'rate limit record failed');
  }
}

/** 消耗一次额度（注册这类「所有尝试都计数」的场景）。超限返回等待秒数。 */
export async function rateLimitConsume(rule: RateLimitRule): Promise<number | null> {
  try {
    await ensureRedisConnected();
    const count = await redis.incr(rule.key);
    if (count === 1) await redis.expire(rule.key, rule.windowSeconds);
    if (count <= rule.limit) return null;
    const ttl = await redis.ttl(rule.key);
    return ttl > 0 ? ttl : rule.windowSeconds;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'rate limit consume failed');
    return null;
  }
}

/** 多规则同时消耗（发信这类所有尝试都计数的场景），任一超限返回需要等待的秒数。 */
export async function rateLimitConsumeAll(rules: RateLimitRule[]): Promise<number | null> {
  let wait: number | null = null;
  for (const rule of rules) {
    const remaining = await rateLimitConsume(rule);
    if (remaining !== null) wait = Math.max(wait ?? 0, remaining);
  }
  return wait;
}

/** 登录成功后清掉该账号的失败计数（IP 计数保留，抵御换账号继续撞库）。 */
export async function rateLimitClear(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await ensureRedisConnected();
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'rate limit clear failed');
  }
}
