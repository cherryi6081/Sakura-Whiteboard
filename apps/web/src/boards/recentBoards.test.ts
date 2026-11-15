import { beforeEach, describe, expect, it } from 'vitest';
import {
  GUEST_OWNER,
  listRecentBoards,
  migrateRecentBoards,
  ownerKey,
  ownerTag,
  recordRecentBoard,
  renameRecentBoard,
  setActiveOwner,
  setRecentPinned,
  titleOf,
  userOwner,
} from './recentBoards';

/** node 环境没有 localStorage，这里给一个最小实现 */
const store = new Map<string, string>();
const stub: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (key) => store.get(key) ?? null,
  key: (index) => [...store.keys()][index] ?? null,
  removeItem: (key) => void store.delete(key),
  setItem: (key, value) => void store.set(key, String(value)),
};
Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true });

const alice = userOwner('u-alice');
const bob = userOwner('u-bob');

describe('recentBoards.renameRecentBoard', () => {
  beforeEach(() => {
    store.clear();
    setActiveOwner(GUEST_OWNER);
  });

  it('改名只动目标行，并保留置顶与打开时间', () => {
    recordRecentBoard({ id: 'b1', title: '旧名' }, GUEST_OWNER);
    recordRecentBoard({ id: 'b2', title: '另一块' }, GUEST_OWNER);
    setRecentPinned('b1', true, GUEST_OWNER);
    const before = listRecentBoards(GUEST_OWNER).find((item) => item.id === 'b1')!;

    renameRecentBoard('b1', '新名', GUEST_OWNER);

    const after = listRecentBoards(GUEST_OWNER).find((item) => item.id === 'b1')!;
    expect(after.title).toBe('新名');
    expect(after.pinned).toBe(true);
    expect(after.lastEditedAt).toBe(before.lastEditedAt);
    expect(titleOf('b2', GUEST_OWNER)).toBe('另一块');
  });

  it('不在本机列表里的 id 不会被凭空插入', () => {
    recordRecentBoard({ id: 'b1', title: '旧名' }, GUEST_OWNER);
    renameRecentBoard('missing', '新名', GUEST_OWNER);
    expect(listRecentBoards(GUEST_OWNER).map((item) => item.id)).toEqual(['b1']);
  });
});

describe('recentBoards 身份隔离', () => {
  beforeEach(() => {
    store.clear();
    setActiveOwner(GUEST_OWNER);
  });

  it('游客与两个登录用户各写各自的 key，互不可见', () => {
    recordRecentBoard({ id: 'g1', title: '游客板' }, GUEST_OWNER);
    recordRecentBoard({ id: 'a1', title: 'Alice 的板' }, alice);
    recordRecentBoard({ id: 'b1', title: 'Bob 的板' }, bob);

    expect(ownerKey(GUEST_OWNER)).toBe('wb:recentBoards:guest');
    expect(ownerKey(alice)).toBe('wb:recentBoards:user:u-alice');
    expect(ownerTag(alice)).toBe('user:u-alice');
    expect(ownerTag(GUEST_OWNER)).toBe('guest');

    expect(listRecentBoards(GUEST_OWNER).map((item) => item.id)).toEqual(['g1']);
    expect(listRecentBoards(alice).map((item) => item.id)).toEqual(['a1']);
    expect(listRecentBoards(bob).map((item) => item.id)).toEqual(['b1']);
    expect(titleOf('a1', GUEST_OWNER)).toBeNull();
    expect(titleOf('a1', bob)).toBeNull();
    expect(titleOf('a1', alice)).toBe('Alice 的板');
  });

  it('改名/置顶只落自己的那份，退出后读游客不会读到上一个账号', () => {
    recordRecentBoard({ id: 'shared', title: '原题' }, alice);
    recordRecentBoard({ id: 'shared', title: '游客题' }, GUEST_OWNER);

    renameRecentBoard('shared', 'Alice 改的名', alice);
    setRecentPinned('shared', true, alice);

    expect(listRecentBoards(alice).find((item) => item.id === 'shared')!.title).toBe('Alice 改的名');
    expect(listRecentBoards(GUEST_OWNER).find((item) => item.id === 'shared')!.title).toBe('游客题');
    expect(listRecentBoards(GUEST_OWNER).find((item) => item.id === 'shared')!.pinned).toBe(false);
  });

  it('默认归属跟随 setActiveOwner（退出登录后切回游客）', () => {
    setActiveOwner(alice);
    recordRecentBoard({ id: 'a1', title: 'Alice 的板' });

    setActiveOwner(GUEST_OWNER);
    expect(listRecentBoards()).toEqual([]);
    expect(Object.keys(Object.fromEntries(store)).sort()).toEqual(['wb:recentBoards:user:u-alice']);
  });
});

describe('recentBoards.migrateRecentBoards（临时板转入账号）', () => {
  beforeEach(() => {
    store.clear();
    setActiveOwner(GUEST_OWNER);
  });

  it('只搬转入的那批：账号侧追加、游客侧删除，标题与置顶原样带过去', () => {
    recordRecentBoard({ id: 'g1', title: '游客一' }, GUEST_OWNER);
    recordRecentBoard({ id: 'g2', title: '游客二' }, GUEST_OWNER);
    recordRecentBoard({ id: 'g3', title: '游客三' }, GUEST_OWNER);
    recordRecentBoard({ id: 'a1', title: '账号已有' }, alice);
    setRecentPinned('g1', true, GUEST_OWNER);

    const moved = migrateRecentBoards(GUEST_OWNER, alice, ['g1', 'g3']);

    expect(moved).toBe(2);
    expect(listRecentBoards(alice).map((item) => item.id).sort()).toEqual(['a1', 'g1', 'g3']);
    expect(listRecentBoards(GUEST_OWNER).map((item) => item.id)).toEqual(['g2']);
    expect(titleOf('g3', alice)).toBe('游客三');
    // 置顶是激活项排序的第一优先级，搬家后仍在第一位
    expect(listRecentBoards(alice)[0]?.id).toBe('g1');
  });

  it('账号侧已有同 id 时不重复插入，以账号那条为准', () => {
    recordRecentBoard({ id: 'g1', title: '游客标题' }, GUEST_OWNER);
    recordRecentBoard({ id: 'g1', title: '账号标题' }, alice);

    migrateRecentBoards(GUEST_OWNER, alice, ['g1']);

    const rows = listRecentBoards(alice).filter((item) => item.id === 'g1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('账号标题');
    expect(listRecentBoards(GUEST_OWNER)).toEqual([]);
  });

  it('同一身份或空 id 列表是空操作', () => {
    recordRecentBoard({ id: 'g1', title: '游客一' }, GUEST_OWNER);
    expect(migrateRecentBoards(GUEST_OWNER, GUEST_OWNER, ['g1'])).toBe(0);
    expect(migrateRecentBoards(GUEST_OWNER, alice, [])).toBe(0);
    expect(listRecentBoards(GUEST_OWNER).map((item) => item.id)).toEqual(['g1']);
  });
});
