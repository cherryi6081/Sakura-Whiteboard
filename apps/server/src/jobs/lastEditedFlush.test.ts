import { describe, expect, it, vi } from 'vitest';
import {
  FLUSH_BATCH_MAX,
  FLUSH_INTERVAL_MS,
  flushDirtyBoards,
  type DirtyBoardStore,
  type DirtyEntry,
} from './dirtyFlushCore.js';

function storeOf(entries: DirtyEntry[]) {
  const claim = vi.fn(async (_windowMs: number, _limit: number) => entries);
  const requeue = vi.fn(async (_entries: DirtyEntry[]) => undefined);
  const store: DirtyBoardStore = { claim, requeue };
  return { store, claim, requeue };
}

describe('flushDirtyBoards', () => {
  it('一轮只调一次 touch，把一批板合并成一条 UPDATE', async () => {
    const entries: DirtyEntry[] = [
      { id: 'board_aaaaaa', atMs: 1_700_000_000_000 },
      { id: 'board_bbbbbb', atMs: 1_700_000_005_000 },
    ];
    const { store, claim } = storeOf(entries);
    const touch = vi.fn(async () => 2);

    await expect(flushDirtyBoards(store, touch)).resolves.toBe(2);

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(FLUSH_INTERVAL_MS, FLUSH_BATCH_MAX);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith(entries);
  });

  it('窗口内没有到期记录时不写库', async () => {
    const { store } = storeOf([]);
    const touch = vi.fn(async () => 0);

    await expect(flushDirtyBoards(store, touch)).resolves.toBe(0);
    expect(touch).not.toHaveBeenCalled();
  });

  it('写库失败时按原分数重新入队，并向上抛错', async () => {
    const entries: DirtyEntry[] = [{ id: 'board_cccccc', atMs: 1_700_000_000_000 }];
    const { store, requeue } = storeOf(entries);
    const touch = vi.fn(async () => {
      throw new Error('db down');
    });

    await expect(flushDirtyBoards(store, touch)).rejects.toThrow('db down');
    expect(requeue).toHaveBeenCalledWith(entries);
  });
});
