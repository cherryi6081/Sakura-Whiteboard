import { describe, expect, it } from 'vitest';
import { avatarKeyOfUrl, buildStorageAudit, type ReferencedObject } from './storageAudit.js';

const BOARD = 'AbCdEf123456';
const ASSET_KEY = `${BOARD}/${'a'.repeat(64)}`;
const THUMB_KEY = `${BOARD}/thumbnail`;
const AVATAR_KEY = 'avatars/0190f3a4-1111-4222-8333-444455556666.png';

const referenced: ReferencedObject[] = [
  { key: ASSET_KEY, kind: 'asset', sizeBytes: 100 },
  { key: THUMB_KEY, kind: 'thumbnail' },
  { key: AVATAR_KEY, kind: 'avatar' },
];

describe('buildStorageAudit', () => {
  it('区分「库有引用但对象缺失」与「对象存在但无引用」', () => {
    const report = buildStorageAudit({
      driver: 'local',
      referenced,
      listed: [
        { key: ASSET_KEY, size: 100 },
        // 缩略图与头像缺失
        { key: 'orphanboard1/thumbnail', size: 7 },
        { key: 'avatars/0190f3a4-2222-4222-8333-444455556666.webp', size: 9 },
        { key: 'leftover.tmp', size: 3 },
      ],
      now: new Date('2026-11-18T00:00:00.000Z'),
    });

    expect(report.referenced).toEqual({ total: 3, byKind: { asset: 1, thumbnail: 1, avatar: 1 } });
    expect(report.missingObjects.total).toBe(2);
    expect(report.missingObjects.byKind).toEqual({ asset: 0, thumbnail: 1, avatar: 1 });
    expect(report.missingObjects.sample.map((item) => item.key).sort()).toEqual([THUMB_KEY, AVATAR_KEY].sort());

    expect(report.orphanObjects.total).toBe(3);
    expect(report.orphanObjects.bytes).toBe(19);
    expect(report.orphanObjects.byKind).toEqual({ asset: 0, thumbnail: 1, avatar: 1, unknown: 1 });
  });

  it('资产行大小与对象大小不一致只报告、不判为缺失', () => {
    const report = buildStorageAudit({
      driver: 's3',
      referenced,
      listed: [
        { key: ASSET_KEY, size: 99 },
        { key: THUMB_KEY, size: 1 },
        { key: AVATAR_KEY, size: 2 },
      ],
    });

    expect(report.missingObjects.total).toBe(0);
    expect(report.sizeMismatch.total).toBe(1);
    expect(report.sizeMismatch.sample[0]).toMatchObject({ key: ASSET_KEY, expectedSize: 100, actualSize: 99 });
    expect(report.orphanObjects.total).toBe(0);
  });

  it('sample 受 sampleLimit 限制但总数不受影响', () => {
    const many: ReferencedObject[] = Array.from({ length: 5 }, (_, index) => ({
      key: `Board${String(index).padStart(7, '0')}/${'b'.repeat(64)}`,
      kind: 'asset',
      sizeBytes: 1,
    }));
    const report = buildStorageAudit({ driver: 'local', referenced: many, listed: [], sampleLimit: 2 });
    expect(report.missingObjects.total).toBe(5);
    expect(report.missingObjects.sample).toHaveLength(2);
  });
});

describe('avatarKeyOfUrl', () => {
  it('解析本服务上传的头像', () => {
    expect(avatarKeyOfUrl(`/api/avatars/${AVATAR_KEY.slice('avatars/'.length)}`)).toBe(AVATAR_KEY);
  });

  it('外链头像与非法文件名返回 null', () => {
    expect(avatarKeyOfUrl('https://avatars.githubusercontent.com/u/1')).toBeNull();
    expect(avatarKeyOfUrl('/api/avatars/not-a-uuid.png')).toBeNull();
  });
});
