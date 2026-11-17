import { describe, expect, it } from 'vitest';
import {
  OP_BUCKET_CAPACITY,
  OP_BUCKET_REFILL_PER_SEC,
  OP_OVER_LIMIT_DISCONNECT_MS,
  createConnectionRateLimiter,
  createJoinRateLimiter,
  createWindowLimiter,
  normalizeJoinIp,
} from './realtimeRateLimit.js';

describe('createConnectionRateLimiter（op 令牌桶）', () => {
  it('默认口径：容量 200、回填 100/s', () => {
    const limiter = createConnectionRateLimiter();
    expect(limiter.take(OP_BUCKET_CAPACITY, 0)).toMatchObject({ allowed: true });
    expect(limiter.take(1, 0)).toMatchObject({ allowed: false, disconnect: false });
    // 1s 后回填 100 条
    expect(limiter.take(OP_BUCKET_REFILL_PER_SEC, 1000)).toMatchObject({ allowed: true });
    expect(limiter.take(1, 1000)).toMatchObject({ allowed: false });
  });

  it('超限返回退避时长，未满 5s 不断开', () => {
    const limiter = createConnectionRateLimiter({ capacity: 10, refillPerSec: 1, disconnectAfterMs: 5000 });
    expect(limiter.take(10, 0).allowed).toBe(true);

    const first = limiter.take(10, 0);
    expect(first).toMatchObject({ allowed: false, overLimitMs: 0, disconnect: false });
    expect(first.allowed === false && first.retryAfterMs).toBeGreaterThan(0);

    expect(limiter.take(10, 4999)).toMatchObject({ allowed: false, disconnect: false });
    expect(limiter.take(10, 5000)).toMatchObject({ allowed: false, disconnect: true });
  });

  it('中途一旦放行就重置连续超限计时', () => {
    const limiter = createConnectionRateLimiter({ capacity: 10, refillPerSec: 1, disconnectAfterMs: 5000 });
    limiter.take(10, 0);
    expect(limiter.take(10, 0).allowed).toBe(false);
    // 10s 后桶回满，放行 → 连续超限清零
    expect(limiter.take(10, 10_000).allowed).toBe(true);
    const again = limiter.take(10, 10_000);
    expect(again).toMatchObject({ allowed: false, overLimitMs: 0, disconnect: false });
  });

  it('连续超限阈值取自配置', () => {
    const limiter = createConnectionRateLimiter({ capacity: 1, refillPerSec: 0, disconnectAfterMs: OP_OVER_LIMIT_DISCONNECT_MS });
    limiter.take(1, 0);
    expect(limiter.take(1, 0)).toMatchObject({ allowed: false, disconnect: false });
    expect(limiter.take(1, OP_OVER_LIMIT_DISCONNECT_MS - 1)).toMatchObject({ disconnect: false });
    expect(limiter.take(1, OP_OVER_LIMIT_DISCONNECT_MS)).toMatchObject({ disconnect: true });
  });
});

describe('createWindowLimiter（滑动窗口）', () => {
  it('满额后拒绝，窗口滑出后恢复', () => {
    const limiter = createWindowLimiter(5, 60_000);
    for (let i = 0; i < 5; i += 1) expect(limiter.hit(0).allowed).toBe(true);
    const denied = limiter.hit(0);
    expect(denied).toMatchObject({ allowed: false, count: 5, retryAfterMs: 60_000 });
    // 边界：恰好 60s 时最早一条已滑出
    expect(limiter.hit(60_000).allowed).toBe(true);
  });

  it('被拒绝的尝试不写入窗口（不延长封禁）', () => {
    const limiter = createWindowLimiter(1, 1000);
    expect(limiter.hit(0).allowed).toBe(true);
    expect(limiter.hit(500).allowed).toBe(false);
    expect(limiter.hit(1000).allowed).toBe(true);
  });
});

describe('createJoinRateLimiter（join 双闸门）', () => {
  it('同一 socket 每分钟 5 次，超限返回 socket 口径且不断开', () => {
    const limiter = createJoinRateLimiter();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.hit('s1', '127.0.0.1', 0)).toEqual({ allowed: true });
    }
    expect(limiter.hit('s1', '127.0.0.1', 0)).toMatchObject({ allowed: false, scope: 'socket' });
  });

  it('同 IP 换 socket 重连累计到 20 次后按 IP 拒绝', () => {
    const limiter = createJoinRateLimiter();
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.hit(`s${i}`, '10.0.0.1', 0)).toEqual({ allowed: true });
    }
    expect(limiter.hit('s20', '10.0.0.1', 0)).toMatchObject({ allowed: false, scope: 'ip' });
    // 另一个 IP 不受影响
    expect(limiter.hit('s21', '10.0.0.2', 0)).toEqual({ allowed: true });
  });

  it('socket 维度是更严格的第一道闸：IP 还有余额时也会先撞 socket 上限', () => {
    const limiter = createJoinRateLimiter({ socketLimit: 2, ipLimit: 20 });
    limiter.hit('s1', '10.0.0.1', 0);
    limiter.hit('s1', '10.0.0.1', 0);
    expect(limiter.hit('s1', '10.0.0.1', 0)).toMatchObject({ allowed: false, scope: 'socket' });
  });

  it('drop 释放 socket 窗口但不影响同 IP 计数', () => {
    const limiter = createJoinRateLimiter({ socketLimit: 1, ipLimit: 20 });
    expect(limiter.hit('s1', '10.0.0.1', 0).allowed).toBe(true);
    expect(limiter.hit('s1', '10.0.0.1', 0)).toMatchObject({ allowed: false, scope: 'socket' });
    limiter.drop('s1');
    expect(limiter.hit('s1', '10.0.0.1', 0)).toEqual({ allowed: true });
  });
});

describe('normalizeJoinIp', () => {
  it('IPv4-mapped IPv6 归一成 IPv4', () => {
    expect(normalizeJoinIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeJoinIp('::1')).toBe('::1');
    expect(normalizeJoinIp(undefined)).toBe('unknown');
  });
});
