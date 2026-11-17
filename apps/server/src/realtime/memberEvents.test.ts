import { describe, expect, it, vi } from 'vitest';
import type { Namespace } from 'socket.io';
import { createMemberNotifier, MEMBER_REMOVED_EVENT, MEMBER_ROLE_EVENT } from './memberEvents.js';

function fakeNamespace(identities: string[]) {
  const roomEmits: Array<{ room: string; event: string; payload: unknown }> = [];
  const serverEmits: Array<{ event: string; payload: unknown }> = [];
  const socketEmits: Array<{ identity: string; event: string; payload: unknown }> = [];
  const disconnected: string[] = [];

  const sockets = identities.map((identity) => ({
    data: { identity },
    emit(event: string, payload: unknown) {
      socketEmits.push({ identity, event, payload });
    },
    disconnect() {
      disconnected.push(identity);
    },
  }));

  const ns = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => roomEmits.push({ room, event, payload }),
    }),
    in: () => ({
      fetchSockets: async () => sockets,
    }),
    serverSideEmit: (event: string, payload: unknown) => serverEmits.push({ event, payload }),
  } as unknown as Namespace;

  return { ns, roomEmits, serverEmits, socketEmits, disconnected };
}

describe('createMemberNotifier', () => {
  it('角色变更：本实例就地更新 + 其它实例 serverSideEmit + 房间广播', async () => {
    const fake = fakeNamespace([]);
    const applyLocalRole = vi.fn();
    const notifier = createMemberNotifier({ ns: fake.ns, roomOf: (id) => `board:${id}`, applyLocalRole });

    await notifier.roleChanged('b1', 'user:u1', 'viewer');

    expect(applyLocalRole).toHaveBeenCalledWith('b1', 'user:u1', 'viewer');
    expect(fake.serverEmits).toHaveLength(1);
    expect(fake.serverEmits[0]).toMatchObject({ event: MEMBER_ROLE_EVENT, payload: { boardId: 'b1', identity: 'user:u1', role: 'viewer' } });
    expect(fake.roomEmits).toHaveLength(1);
    expect(fake.roomEmits[0]).toMatchObject({ room: 'board:b1', event: MEMBER_ROLE_EVENT });
  });

  it('移出：只通知并断开目标身份的连接，其它人不受影响', async () => {
    const fake = fakeNamespace(['user:u1', 'user:u2', 'guest:g1']);
    const notifier = createMemberNotifier({ ns: fake.ns, roomOf: (id) => `board:${id}`, applyLocalRole: () => {} });

    await notifier.removed('b1', 'user:u1');

    expect(fake.socketEmits).toEqual([
      { identity: 'user:u1', event: MEMBER_REMOVED_EVENT, payload: expect.objectContaining({ boardId: 'b1', identity: 'user:u1' }) },
    ]);
    expect(fake.disconnected).toEqual(['user:u1']);
  });
});
