import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 存储驱动单测。config 在模块加载时解析 env，因此先 stub 再动态 import。
 * 这里只验证纯逻辑（key 形状与驱动选择），不触碰真实磁盘 / 对象存储。
 */

let storageModule: typeof import('./storage.js');

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
  vi.stubEnv('SESSION_SECRET', 'unit-test-session-secret');
  vi.stubEnv('GUEST_COOKIE_SECRET', 'unit-test-guest-secret-0123456789abcdef');
  vi.stubEnv('STORAGE_DRIVER', 'local');
  storageModule = await import('./storage.js');
});

describe('存储 key 校验', () => {
  it('允许图片资产 / 缩略图 / 头像三种固定形状', () => {
    expect(storageModule.isValidStorageKey(`AbC123xyz_-9/${'a'.repeat(64)}`)).toBe(true);
    expect(storageModule.isValidStorageKey('AbC123xyz_-9/thumbnail')).toBe(true);
    expect(storageModule.isValidStorageKey('avatars/3f2504e0-4f89-11d3-9a0c-0305e82c3301.png')).toBe(true);
  });

  it('拒绝路径穿越、绝对路径与未登记形状', () => {
    expect(storageModule.isValidStorageKey('../etc/passwd')).toBe(false);
    expect(storageModule.isValidStorageKey('/etc/passwd')).toBe(false);
    expect(storageModule.isValidStorageKey('AbC123xyz_-9/thumbnail.png')).toBe(false);
    expect(storageModule.isValidStorageKey('avatars/not-a-uuid.png')).toBe(false);
    expect(storageModule.isValidStorageKey('AbC123xyz_-9/short')).toBe(false);
  });
});

describe('驱动选择', () => {
  it('默认走本地磁盘，且迁移脚本能按名字拿到两种驱动', () => {
    expect(storageModule.storage).toBe(storageModule.storageDrivers.local);
    expect(typeof storageModule.storageDrivers.s3.put).toBe('function');
    expect(typeof storageModule.storageDrivers.s3.read).toBe('function');
    expect(typeof storageModule.storageDrivers.s3.delete).toBe('function');
  });

  it('两种驱动都实现同一份契约', () => {
    for (const driver of Object.values(storageModule.storageDrivers)) {
      expect(typeof driver.put).toBe('function');
      expect(typeof driver.read).toBe('function');
      expect(typeof driver.delete).toBe('function');
    }
  });
});
