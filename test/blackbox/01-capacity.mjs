import { registerUser, registerGuest } from "../lib/api.mjs";
import { assert, eq, finish, test } from "../lib/harness.mjs";
import {
  boardRow,
  boardsOfOwner,
  closePool,
  evictions,
  evictionsForGuest,
  guestIdOfBoard,
  query,
  userIdByEmail,
} from "../lib/db.mjs";

/**
 * 容量口径（v1.9 起）：
 * - **12 块上限只针对游客（临时板）**；
 * - 登录账号不限数量：建板/恢复都不判定容量、不淘汰、不写 board_evictions。
 */

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

  await test("游客口径：满 12 且置顶（pinnedIds）→ 429；不置顶 → 淘汰并物理删除", async () => {
    const { api, firstBoard } = await registerGuest();
    const guestId = await guestIdOfBoard(firstBoard.id);
    assert(guestId, "游客 cookie 应落 owner_guest_id");

    const guestMe = await api.get("/api/guest/me");
    eq(guestMe.json.quota.unarchivedMax, 12, "guest/me 未归档上限应等于 BOARD_CAPACITY");
    eq(guestMe.json.quota.per24h, 3, "guest/me 24h 建板频率上限");

    // 游客 3/24h 限流下拿不到 12 块：用 SQL 补齐边界数据（仍由真实接口触发淘汰）
    // id 是应用侧 nanoid(12)，库表没有默认值，这里补 12 位十六进制
    for (let i = 0; i < 11; i += 1) {
      await query(
        `insert into boards (id, title, owner_guest_id, created_at, last_edited_at)
         values (substr(md5(random()::text || $3), 1, 12), $1, $2, now() - interval '20 minutes', now() - interval '20 minutes')`,
        [`g-${i}`, guestId, String(i)],
      );
    }
    const { rows: guestBoards } = await query("select id from boards where owner_guest_id = $1 and deleted_at is null", [guestId]);
    eq(guestBoards.length, 12, "游客 12 块");
    eq((await api.get("/api/guest/me")).json.quota.unarchivedUsed, 12, "guest/me 已用块数");

    const blocked = await api.createBoard({ title: "全置顶", pinnedIds: guestBoards.map((row) => row.id) });
    eq(blocked.status, 429, "全置顶游客建板状态");
    eq(blocked.json?.error?.code, "CAPACITY_ALL_PROTECTED", "游客全保护错误码");
    assert(
      (blocked.json?.error?.message ?? "").includes("12"),
      `429 文案应带上真实容量 12：${blocked.json?.error?.message}`,
    );

    const ok = await api.createBoard({ title: "游客第 13 块", pinnedIds: [guestBoards[0].id] });
    eq(ok.status, 201, `游客第 13 块状态：${JSON.stringify(ok.json)}`);
    const audits = await evictionsForGuest(guestId);
    eq(audits.length, 1, "游客淘汰审计");
    eq(audits[0].mode, "purged", "游客物理删除");
    eq(audits[0].trigger, "create", "游客淘汰也标 trigger=create");
    assert(audits[0].board_id !== guestBoards[0].id, "置顶的板不被淘汰");
    const purged = await boardRow(audits[0].board_id);
    eq(purged, null, "游客被淘汰板物理删除");
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
