import { registerUser, registerGuest } from "../lib/api.mjs";
import { assert, eq, finish, test } from "../lib/harness.mjs";
import {
  boardRow,
  boardsOfOwner,
  closePool,
  evictions,
  guestIdOfBoard,
  liveElements,
  opsCount,
  query,
  userIdByEmail,
} from "../lib/db.mjs";

/**
 * 容量口径：
 * - 登录账号不限数量：建板/恢复都不判定容量、不淘汰、不写 board_evictions；
 * - **临时板已收敛为一块公共板**：匿名建板统一返回同一块固定 id，不再有
 *   「12 块 / 24h 3 块」配额，也不淘汰、不产生新的游客归属板。
 */

const spec = "capacity";
const PUBLIC_BOARD_ID = "pub_temp_001";

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
  await test("登录账号 0 / 1 / 12 / 13：不限量，始终不淘汰", async () => {
    const { api, email } = await registerUser("cap0");
    const empty = await api.list();
    eq(empty.status, 200, "列表状态");
    eq(empty.json.boards.length, 0, "空列表");

    await createMany(api, 1);
    eq((await api.list()).json.boards.length, 1, "1 块");

    await createMany(api, 11, { startIndex: 1 });
    eq((await api.list()).json.boards.length, 12, "12 块");

    const thirteenth = await api.createBoard({ title: "第 13 块" });
    eq(thirteenth.status, 201, `第 13 块状态：${JSON.stringify(thirteenth.json)}`);
    const list = await api.list();
    eq(list.json.boards.length, 13, "第 13 块后列表 13 块");
    assert(list.json.boards.some((board) => board.id === thirteenth.json.id), "第 13 块在列表里");

    const userId = await userIdByEmail(email);
    eq((await evictions(userId)).length, 0, "登录账号不应有淘汰审计");
    const live = (await boardsOfOwner(userId)).filter((row) => row.deleted_at === null);
    eq(live.length, 13, "13 块都在（没有被软删/物理删）");
  });

  await test("登录账号 12 块全在保护期：第 13 块仍成功，不返回 CAPACITY_*", async () => {
    const { api, email } = await registerUser("cap-protected");
    await createMany(api, 12);
    const res = await api.createBoard({ title: "第 13 块" });
    eq(res.status, 201, `全保护时登录建板仍成功：${JSON.stringify(res.json)}`);
    eq(res.json?.error, undefined, "不应返回容量错误");
    eq((await api.list()).json.boards.length, 13, "13 块");
    const userId = await userIdByEmail(email);
    eq((await evictions(userId)).length, 0, "全保护也不写淘汰审计");
  });

  await test("登录账号 12 块有可淘汰候选：第 13 块不淘汰最旧的那块", async () => {
    const { api, email } = await registerUser("cap-evict");
    const created = await createMany(api, 12, { startIndex: 100 });
    const userId = await userIdByEmail(email);
    // 全部推到保护期外，若还按老逻辑这里一定会淘汰 created[0]
    await query(
      `update boards b
          set created_at = now() - interval '20 minutes', last_edited_at = now() - interval '20 minutes'
        where b.id = any($1::text[])`,
      [created.map((board) => board.id)],
    );

    const res = await api.createBoard({ title: "第 13 块" });
    eq(res.status, 201, `第 13 块状态：${JSON.stringify(res.json)}`);
    eq((await evictions(userId)).length, 0, "不写淘汰审计");
    const oldest = await boardRow(created[0].id);
    assert(oldest !== null && oldest.deleted_at === null, "最旧的板仍在，没有被淘汰");
    eq((await api.list()).json.boards.length, 13, "13 块全部保留");
  });

  await test("并发建两块：登录账号两条都成功，13 → 14 块", async () => {
    const { api, email } = await registerUser("cap-race");
    await createMany(api, 12, { startIndex: 200 });
    const userId = await userIdByEmail(email);

    const [a, b] = await Promise.all([
      api.createBoard({ title: "并发 A" }),
      api.createBoard({ title: "并发 B" }),
    ]);
    eq([a.status, b.status], [201, 201], `并发建板状态 ${a.status}/${b.status}`);
    eq((await evictions(userId)).length, 0, "并发也不淘汰");
    const live = (await boardsOfOwner(userId)).filter((row) => row.deleted_at === null);
    eq(live.length, 14, "并发后 14 块");
  });

  await test("游客口径：匿名建板统一落到同一块公共板，不建新行、不淘汰", async () => {
    const g1 = await registerGuest();
    const g2 = await registerGuest();
    eq(g1.firstBoard.id, PUBLIC_BOARD_ID, "公共板固定 id");
    eq(g2.firstBoard.id, PUBLIC_BOARD_ID, "另一台设备/浏览器打开的是同一块");
    eq(g1.firstBoard.public, true, "匿名建板返回值标记 public");
    eq(await guestIdOfBoard(PUBLIC_BOARD_ID), null, "公共板不归属任何浏览器");

    const again = await g1.api.createBoard({ title: "再建一块" });
    eq(again.json.id, PUBLIC_BOARD_ID, "重复新建仍返回同一块");

    const me = await g1.api.get("/api/guest/me");
    eq(me.json.quota, null, "不再暴露 12 块 / 24h 配额");
    eq(me.json.publicBoard.id, PUBLIC_BOARD_ID, "guest/me 返回公共板");

    const { rows } = await query("select count(*)::int as n from boards where is_public");
    eq(rows[0].n, 1, "全局只有一块公共板");
    // 只看这两个新游客：开发库里有历史用例留下的游客板，不能要求全局为 0
    const g1Id = (await g1.api.get("/api/guest/me")).json.guestId;
    const g2Id = (await g2.api.get("/api/guest/me")).json.guestId;
    const { rows: guestBoards } = await query(
      "select count(*)::int as n from boards where owner_guest_id = any($1::text[])",
      [[g1Id, g2Id]],
    );
    eq(guestBoards[0].n, 0, "匿名建板不再产生游客归属的板");
    eq((await g1.api.get("/api/boards")).status, 401, "游客仍无服务端列表");
  });

  await test("历史游客板保留且原浏览器仍可访问（不迁移、不删除）", async () => {
    const { api } = await registerGuest();
    const me = await api.get("/api/guest/me");
    const guestId = me.json.guestId;
    const { rows } = await query(
      `insert into boards (id, title, owner_guest_id)
       values (substr(md5(random()::text), 1, 12), '历史板', $1) returning id`,
      [guestId],
    );
    const legacyId = rows[0].id;
    const snapshot = await api.get(`/api/boards/${legacyId}/snapshot`);
    eq(snapshot.status, 200, "历史游客板仍可打开");
    const row = await boardRow(legacyId);
    assert(row !== null && row.deleted_at === null, "历史游客板没有被删除");
  });

  await test("清空公共板：必须显式确认；只追加 delete op，不删板也不删审计", async () => {
    const { api } = await registerGuest();
    const refused = await api.post("/api/public-board/reset", {});
    eq(refused.status, 400, "缺 confirm 时拒绝");
    eq(refused.json?.error?.code, "CONFIRM_REQUIRED", "缺少确认的错误码");

    await query("delete from elements where board_id = $1", [PUBLIC_BOARD_ID]);
    await query(
      `insert into elements (board_id, element_id, type, version, version_nonce, zindex_key, data)
       values ($1, 'el_a', 'rectangle', 1, 1, 'a0', '{}'::jsonb),
              ($1, 'el_b', 'note', 1, 2, 'a1', '{}'::jsonb)`,
      [PUBLIC_BOARD_ID],
    );
    const before = await opsCount(PUBLIC_BOARD_ID);
    const res = await api.post("/api/public-board/reset", { confirm: true });
    eq(res.status, 200, `清空状态：${JSON.stringify(res.json)}`);
    eq(res.json.cleared, 2, "清掉两个元素");
    const live = (await liveElements(PUBLIC_BOARD_ID)).filter((row) => row.is_deleted === false);
    eq(live.length, 0, "清空后没有存活元素");
    eq(await opsCount(PUBLIC_BOARD_ID), before + 2, "清空按正常 delete op 追加审计");
    const board = await boardRow(PUBLIC_BOARD_ID);
    assert(board !== null && board.is_public === true && board.deleted_at === null, "板本身保留");
    const repeat = await api.post("/api/public-board/reset", { confirm: true });
    eq(repeat.json.cleared, 0, "重复清空幂等");
  });

  await test("团队空间：所有者建第 13 块、编辑者建板都不淘汰任何人的板", async () => {
    const owner = await registerUser("team-owner");
    const editor = await registerUser("team-editor");
    const space = await owner.api.createSpace(`e2e-space-${Date.now()}`);
    eq(space.status, 201, `建空间：${JSON.stringify(space.json)}`);
    const spaceId = space.json.id;

    await createMany(owner.api, 12, { spaceId, startIndex: 300 });
    const ownerId = await userIdByEmail(owner.email);
    await query(
      `update boards set created_at = now() - interval '20 minutes', last_edited_at = now() - interval '20 minutes'
        where space_id = $1`,
      [spaceId],
    );

    const own13 = await owner.api.createBoard({ title: "所有者的第 13 块", spaceId });
    eq(own13.status, 201, "所有者建第 13 块成功");

    const invite = await owner.api.invite(spaceId, "editor");
    eq(invite.status, 201, `邀请：${JSON.stringify(invite.json)}`);
    const accept = await editor.api.acceptInvite(invite.json.token);
    eq([200, 201, 204].includes(accept.status), true, `接受邀请状态 ${accept.status}`);

    const res = await editor.api.createBoard({ title: "编辑者的板", spaceId });
    eq(res.status, 201, `编辑者建板：${JSON.stringify(res.json)}`);
    eq((await evictions(ownerId)).length, 0, "不应淘汰所有者的板");

    const list = await owner.api.list(spaceId, 30);
    eq(list.json.boards.length, 14, "空间内共 14 块");
    const ownerRows = (await boardsOfOwner(ownerId)).filter((row) => row.deleted_at === null);
    eq(ownerRows.length, 13, "所有者的 13 块原样保留");
  });

  await closePool();
  finish(spec);
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
