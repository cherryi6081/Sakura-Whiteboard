import { registerUser, registerGuest } from "../lib/api.mjs";
import { assert, eq, finish, test } from "../lib/harness.mjs";
import {
  ageBoards,
  boardRow,
  boardsOfOwner,
  closePool,
  evictions,
  evictionsForGuest,
  guestIdOfBoard,
  query,
  userIdByEmail,
} from "../lib/db.mjs";

const spec = "capacity";

async function createMany(api, count, { spaceId, startIndex = 0 } = {}) {
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const res = await api.createBoard({ title: `c-${startIndex + i}`, spaceId });
    assert(res.status === 201, `第 ${startIndex + i + 1} 块建板失败：${res.status} ${JSON.stringify(res.json)}`);
    created.push(res.json);
  }
  return created;
}

async function main() {
  await test("容量 0 / 1 / 15：不满 15 不淘汰", async () => {
    const { api, email } = await registerUser("cap0");
    const empty = await api.list();
    eq(empty.status, 200, "列表状态");
    eq(empty.json.boards.length, 0, "空列表");

    await createMany(api, 1);
    eq((await api.list()).json.boards.length, 1, "1 块");

    await createMany(api, 14, { startIndex: 1 });
    const list = await api.list();
    eq(list.json.boards.length, 15, "15 块");
    const userId = await userIdByEmail(email);
    eq((await evictions(userId)).length, 0, "15 块不应有淘汰");
  });

  await test("15 块都处于保护期：第 16 块 429 CAPACITY_ALL_PROTECTED", async () => {
    const { api } = await registerUser("cap-protected");
    await createMany(api, 15);
    const res = await api.createBoard({ title: "第 16 块" });
    eq(res.status, 429, "全保护时建板状态");
    eq(res.json?.error?.code, "CAPACITY_ALL_PROTECTED", "错误码");
    eq((await api.list()).json.boards.length, 15, "被拒绝后仍是 15 块");
  });

  await test("第 16 块淘汰：最旧、零打开；进回收站可恢复；审计行齐全", async () => {
    const { api, email } = await registerUser("cap-evict");
    const created = await createMany(api, 15, { startIndex: 100 });
    const userId = await userIdByEmail(email);
    // 逐块错开 1 秒并整体推到保护期外，让「最旧」可判定（同一时间戳会退化到按 id 排序）
    await query(
      `update boards b
          set created_at = now() - interval '11 minutes' + (u.ord * interval '1 second'),
              last_edited_at = now() - interval '11 minutes' + (u.ord * interval '1 second')
         from unnest($1::text[]) with ordinality as u(id, ord)
        where b.id = u.id`,
      [created.map((board) => board.id)],
    );

    const opened = await api.opened(created[4].id);
    eq(opened.status, 204, "记录打开");
    const opened2 = await api.opened(created[4].id);
    eq(opened2.status, 204, "再次记录打开");
    const row4 = await boardRow(created[4].id);
    eq(row4.opened_count, 2, "opened_count");
    assert(row4.last_opened_at !== null, "last_opened_at 应写入");

    const res = await api.createBoard({ title: "第 16 块" });
    eq(res.status, 201, `第 16 块建板状态：${JSON.stringify(res.json)}`);
    const list = await api.list();
    eq(list.json.boards.length, 15, "淘汰后仍 15 块");

    const audits = await evictions(userId);
    eq(audits.length, 1, "审计行数");
    const audit = audits[0];
    eq(audit.mode, "trash", "登录用户淘汰进回收站");
    eq(audit.policy, "opened_count asc, created_at asc, id asc", "淘汰策略");
    eq(audit.trigger_board_id, res.json.id, "触发板 id");
    eq(audit.board_id, created[0].id, "淘汰最旧且零打开的板");
    assert(audit.board_title?.startsWith("c-100"), "审计记录板名");
    const evicted = await boardRow(created[0].id);
    assert(evicted.deleted_at !== null, "被淘汰板应为软删");

    const trash = await api.trash();
    eq(trash.status, 200, "回收站状态");
    eq(trash.json.boards.some((item) => item.id === created[0].id), true, "回收站可见被淘汰板");
    const restored = await api.restore(created[0].id);
    eq(restored.status, 200, `恢复状态：${JSON.stringify(restored.json)}`);
    eq((await api.list()).json.boards.length, 16, "恢复后 16 块（容量只在建板时检查）");
  });

  await test("并发创建两块：advisory lock 串行，两次各淘汰一块且不重复", async () => {
    const { api, email } = await registerUser("cap-race");
    await createMany(api, 15, { startIndex: 200 });
    const userId = await userIdByEmail(email);
    await ageBoards(userId, 11);

    const [a, b] = await Promise.all([
      api.createBoard({ title: "并发 A" }),
      api.createBoard({ title: "并发 B" }),
    ]);
    eq([a.status, b.status], [201, 201], `并发建板状态 ${a.status}/${b.status}`);
    const audits = await evictions(userId);
    eq(audits.length, 2, "两次淘汰各留一行审计");
    eq(new Set(audits.map((item) => item.board_id)).size, 2, "两次淘汰不是同一块板");
    const live = (await boardsOfOwner(userId)).filter((row) => row.deleted_at === null);
    eq(live.length, 15, "并发后仍是 15 块");
  });

  await test("游客口径：满 15 且置顶（pinnedIds）→ 429；不置顶 → 淘汰并物理删除", async () => {
    const { api, firstBoard } = await registerGuest();
    const guestId = await guestIdOfBoard(firstBoard.id);
    assert(guestId, "游客 cookie 应落 owner_guest_id");

    // 游客 3/24h 限流下拿不到 15 块：用 SQL 补齐边界数据（仍由真实接口触发淘汰）
    // id 是应用侧 nanoid(12)，库表没有默认值，这里补 12 位十六进制
    for (let i = 0; i < 14; i += 1) {
      await query(
        `insert into boards (id, title, owner_guest_id, created_at, last_edited_at)
         values (substr(md5(random()::text || $3), 1, 12), $1, $2, now() - interval '20 minutes', now() - interval '20 minutes')`,
        [`g-${i}`, guestId, String(i)],
      );
    }
    const { rows: guestBoards } = await query("select id from boards where owner_guest_id = $1 and deleted_at is null", [guestId]);
    eq(guestBoards.length, 15, "游客 15 块");

    const blocked = await api.createBoard({ title: "全置顶", pinnedIds: guestBoards.map((row) => row.id) });
    eq(blocked.status, 429, "全置顶游客建板状态");
    eq(blocked.json?.error?.code, "CAPACITY_ALL_PROTECTED", "游客全保护错误码");

    const ok = await api.createBoard({ title: "游客第 16 块", pinnedIds: [guestBoards[0].id] });
    eq(ok.status, 201, `游客第 16 块状态：${JSON.stringify(ok.json)}`);
    const audits = await evictionsForGuest(guestId);
    eq(audits.length, 1, "游客淘汰审计");
    eq(audits[0].mode, "purged", "游客物理删除");
    assert(audits[0].board_id !== guestBoards[0].id, "置顶的板不被淘汰");
    const purged = await boardRow(audits[0].board_id);
    eq(purged, null, "游客被淘汰板物理删除");
  });

  await test("团队空间：编辑者新建不淘汰他人的板", async () => {
    const owner = await registerUser("team-owner");
    const editor = await registerUser("team-editor");
    const space = await owner.api.createSpace(`e2e-space-${Date.now()}`);
    eq(space.status, 201, `建空间：${JSON.stringify(space.json)}`);
    const spaceId = space.json.id;

    await createMany(owner.api, 15, { spaceId, startIndex: 300 });
    const ownerId = await userIdByEmail(owner.email);
    await query(
      `update boards set created_at = now() - interval '20 minutes', last_edited_at = now() - interval '20 minutes'
        where space_id = $1`,
      [spaceId],
    );

    const invite = await owner.api.invite(spaceId, "editor");
    eq(invite.status, 201, `邀请：${JSON.stringify(invite.json)}`);
    const token = invite.json.token;
    const accept = await editor.api.acceptInvite(token);
    eq([200, 201, 204].includes(accept.status), true, `接受邀请状态 ${accept.status}`);

    const res = await editor.api.createBoard({ title: "编辑者的板", spaceId });
    eq(res.status, 201, `编辑者建板：${JSON.stringify(res.json)}`);
    eq((await evictions(ownerId)).length, 0, "不应淘汰所有者的板");

    const list = await owner.api.list(spaceId, 30);
    eq(list.json.boards.length, 16, "空间内共 16 块");
    const ownerRows = (await boardsOfOwner(ownerId)).filter((row) => row.deleted_at === null);
    eq(ownerRows.length, 15, "所有者的 15 块原样保留");
  });

  await closePool();
  finish(spec);
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
