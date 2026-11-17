/**
 * 实时通道（Socket.IO `/board`）限流。
 *
 * 两套口径分开放，原因是它们的"超限后果"完全不同：
 *
 * - **op 令牌桶**：按连接计数，容量 200、回填 100 条/s。超限先**整批丢弃**并回
 *   `op:rejected`，让客户端自己退避重试；只有**连续超限满 5s** 才断开——正常拖拽
 *   产生的瞬时突发（一次批量 100 条）不该被踢。
 * - **join 滑动窗口**：按 socket 5 次/分钟、按 IP 20 次/分钟。超限回 `join:error`
 *   但**不断开**：客户端可能是在换板重连，断开只会让它更频繁地重试。
 *
 * 计数在**实例内存**里，不落 Redis：
 * - 一个 socket 只可能活在单个实例上，op 桶按实例计数与全局等价；
 * - join 的 IP 计数在多实例下会各算一份，但 join 没有跨实例统一入口，
 *   且 IP 限流本身就是"防脚本刷房"的粗粒度兜底，多实例放大约 N 倍可以接受。
 *
 * 所有时间参数显式传入 `now`，单测可以完全用假时钟，不依赖真实定时器。
 */

/** op 桶容量：允许一次突发 200 条（= 2 个满批） */
export const OP_BUCKET_CAPACITY = 200;
/** op 桶回填速率：100 条/s，与需求口径一致 */
export const OP_BUCKET_REFILL_PER_SEC = 100;
/** 连续超限达到该时长才断开：短时突发只丢批，不踢人 */
export const OP_OVER_LIMIT_DISCONNECT_MS = 5000;

/** join：同一 socket 每分钟最多 5 次 */
export const JOIN_SOCKET_LIMIT = 5;
/** join：同一 IP 每分钟最多 20 次（覆盖断线重连） */
export const JOIN_IP_LIMIT = 20;
export const JOIN_WINDOW_MS = 60_000;
/** IP 计数表的软上限：只在超过时做一次过期清理，避免长期运行无限增长 */
const JOIN_IP_MAP_SOFT_CAP = 5000;

export type OpRateDecision =
  | { allowed: true; retryAfterMs: 0; overLimitMs: 0; disconnect: false }
  | {
      allowed: false;
      /** 补满本次所需令牌还要等多久（毫秒），回给客户端做退避提示 */
      retryAfterMs: number;
      /** 本轮连续超限已经持续多久（毫秒） */
      overLimitMs: number;
      /** true = 连续超限已满阈值，调用方应断开该连接 */
      disconnect: boolean;
    };

export type ConnectionRateLimiter = {
  /** 尝试消耗 `count` 个令牌；`now` 由调用方给（Date.now()）。 */
  take(count: number, now: number): OpRateDecision;
};

/**
 * 按连接的 op 令牌桶。
 *
 * 令牌是浮点累积的：不用"每秒定时 +1"的定时器，避免每个连接挂一个 interval。
 */
export function createConnectionRateLimiter(options?: {
  capacity?: number;
  refillPerSec?: number;
  disconnectAfterMs?: number;
}): ConnectionRateLimiter {
  const capacity = options?.capacity ?? OP_BUCKET_CAPACITY;
  const refillPerSec = options?.refillPerSec ?? OP_BUCKET_REFILL_PER_SEC;
  const disconnectAfterMs = options?.disconnectAfterMs ?? OP_OVER_LIMIT_DISCONNECT_MS;

  let tokens = capacity;
  /** null = 尚未发生过第一次取用；不能用 0 当哨兵，否则假时钟从 0 起跑时不会回填 */
  let lastRefill: number | null = null;
  /** 本轮连续超限的起点；任何一次放行都会清空 */
  let overSince: number | null = null;

  return {
    take(count, now) {
      if (lastRefill === null) {
        lastRefill = now;
      } else if (now > lastRefill) {
        const elapsedSec = (now - lastRefill) / 1000;
        tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
        lastRefill = now;
      }

      if (tokens >= count) {
        tokens -= count;
        overSince = null;
        return { allowed: true, retryAfterMs: 0, overLimitMs: 0, disconnect: false };
      }

      // 超限：记下起点，判断"连续"超限是否已经够久
      if (overSince === null) overSince = now;
      const overLimitMs = now - overSince;
      const retryAfterMs = refillPerSec > 0
        ? Math.ceil(((count - tokens) / refillPerSec) * 1000)
        : Number.POSITIVE_INFINITY;
      return { allowed: false, retryAfterMs, overLimitMs, disconnect: overLimitMs >= disconnectAfterMs };
    },
  };
}

export type WindowDecision = {
  allowed: boolean;
  /** 窗口内已用次数（超限时是未计入本次的已有次数） */
  count: number;
  /** 最早一条记录滑出窗口还要多久 */
  retryAfterMs: number;
};

export type WindowLimiter = {
  hit(now: number): WindowDecision;
  /** 清理过期记录；长期不用时由调用方在 join 前顺手调用 */
  prune(now: number): void;
};

/** 精确滑动窗口：保留窗口内的时间戳，超限不写入新记录。 */
export function createWindowLimiter(limit: number, windowMs: number = JOIN_WINDOW_MS): WindowLimiter {
  let hits: number[] = [];

  return {
    hit(now) {
      hits = hits.filter((at) => now - at < windowMs);
      if (hits.length >= limit) {
        const oldest = hits[0] ?? now;
        return { allowed: false, count: hits.length, retryAfterMs: Math.max(0, windowMs - (now - oldest)) };
      }
      hits.push(now);
      return { allowed: true, count: hits.length, retryAfterMs: 0 };
    },
    prune(now) {
      hits = hits.filter((at) => now - at < windowMs);
    },
  };
}

export type JoinRejection = {
  allowed: false;
  /** 触发的是哪一层，前端提示与会话排查都靠它 */
  scope: 'socket' | 'ip';
  retryAfterMs: number;
  count: number;
};

export type JoinDecision = { allowed: true } | JoinRejection;

export type JoinRateLimiter = {
  /** 记一次 join 尝试；`socketId` 与 `ip` 任一超限即拒绝。 */
  hit(socketId: string, ip: string, now: number): JoinDecision;
  /** 连接断开时释放按 socket 的窗口 */
  drop(socketId: string): void;
};

/**
 * join 双闸门：先判 socket（更严格、无歧义），再判 IP。
 * 两层都按"尝试次数"计数（不区分成败）——失败重试正是要拦的行为。
 */
export function createJoinRateLimiter(options?: {
  socketLimit?: number;
  ipLimit?: number;
  windowMs?: number;
  ipMapSoftCap?: number;
}): JoinRateLimiter {
  const windowMs = options?.windowMs ?? JOIN_WINDOW_MS;
  const socketLimit = options?.socketLimit ?? JOIN_SOCKET_LIMIT;
  const ipLimit = options?.ipLimit ?? JOIN_IP_LIMIT;
  const ipMapSoftCap = options?.ipMapSoftCap ?? JOIN_IP_MAP_SOFT_CAP;

  const bySocket = new Map<string, WindowLimiter>();
  const byIp = new Map<string, { limiter: WindowLimiter; lastHit: number }>();

  const pruneIps = (now: number): void => {
    for (const [ip, entry] of byIp) {
      if (now - entry.lastHit >= windowMs) byIp.delete(ip);
    }
  };

  return {
    hit(socketId, ip, now) {
      let socketLimiter = bySocket.get(socketId);
      if (!socketLimiter) {
        socketLimiter = createWindowLimiter(socketLimit, windowMs);
        bySocket.set(socketId, socketLimiter);
      }
      const socketDecision = socketLimiter.hit(now);
      if (!socketDecision.allowed) {
        return { allowed: false, scope: 'socket', retryAfterMs: socketDecision.retryAfterMs, count: socketDecision.count };
      }

      // 表只增不减会随长期运行膨胀；超软上限时顺手清一遍过期项
      if (byIp.size > ipMapSoftCap) pruneIps(now);
      let ipEntry = byIp.get(ip);
      if (!ipEntry) {
        ipEntry = { limiter: createWindowLimiter(ipLimit, windowMs), lastHit: now };
        byIp.set(ip, ipEntry);
      }
      ipEntry.lastHit = now;
      const ipDecision = ipEntry.limiter.hit(now);
      if (!ipDecision.allowed) {
        return { allowed: false, scope: 'ip', retryAfterMs: ipDecision.retryAfterMs, count: ipDecision.count };
      }
      return { allowed: true };
    },
    drop(socketId) {
      bySocket.delete(socketId);
    },
  };
}

/** IPv4-mapped IPv6（`::ffff:127.0.0.1`）与纯 IPv4 归一到同一个键。 */
export function normalizeJoinIp(raw: string | undefined | null): string {
  if (!raw) return 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}
