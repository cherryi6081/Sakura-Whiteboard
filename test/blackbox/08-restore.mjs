import { registerGuest, registerUser } from "../lib/api.mjs";
import { assert, eq, finish, test } from "../lib/harness.mjs";
import { boardRow, closePool, evictions, userIdByEmail } from "../lib/db.mjs";

/**
 * 回收站恢复（v1.9）：上限只针对游客，登录账号不限量。
 *
 * 满 12 块时恢复也直接成功，不再有 CAPACITY_FULL / 恢复并替换 / restore-plan；
 * 恢复不淘汰任何已有板，也不写 board_evictions。
 */

const spec = "restore";

async function createMany(api, count, { startIndex = 0 } = {}) {
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const res = await api.createBoard({ title: `r-${startIndex + i}` });
    assert(res.status === 201, `建板失败：${res.status} ${JSON.stringify(res.json)}`);
    created.push(res.json);
  }
  return created;
}

async function main() {
  await test("满 12 恢复：直接成功到 13 块，不再 409 CAPACITY_FULL", async () => {
    const { api, email } = await registerUser("restore-full");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);

    // 挪一块进回收站，再补一块回到满 12
    eq((await api.removeBoard(created[0].id)).status, 200, "移入回收站");
    await createMany(api, 1, { startIndex: 100 });
    eq((await api.list()).json.boards.length, 12, "回到 12 块");

    const restored = await api.restore(created[0].id);
    eq(restored.status, 200, `满额恢复应直接成功：${JSON.stringify(restored.json)}`);
    eq(restored.json?.error, undefined, "不应返回容量错误");
    eq((await api.list()).json.boards.length, 13, "恢复后 13 块");
    eq((await api.list()).json.boards.some((board) => board.id === created[0].id), true, "目标板回到列表");
    eq((await evictions(userId)).length, 0, "恢复不写淘汰审计");
    assert((await boardRow(created[0].id)).deleted_at === null, "目标板已恢复");
  });

  await test("12 块全在保护期：恢复仍成功，不删任何一块", async () => {
    const { api, email } = await registerUser("restore-protected");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);
    eq((await api.removeBoard(created[0].id)).status, 200, "移入回收站");
    await createMany(api, 1, { startIndex: 100 });
    eq((await api.list()).json.boards.length, 12, "满 12 块");

    const restored = await api.restore(created[0].id);
    eq(restored.status, 200, "全保护时恢复也成功");
    eq((await api.list()).json.boards.length, 13, "13 块，未删任何一块");
    eq((await api.trash()).json.boards.length, 0, "回收站已空");
    eq((await evictions(userId)).length, 0, "无审计");
  });

  await test("有空位时恢复：直接成功，不淘汰", async () => {
    const { api, email } = await registerUser("restore-room");
    const created = await createMany(api, 3);
    const userId = await userIdByEmail(email);
    eq((await api.removeBoard(created[1].id)).status, 200, "移入回收站");

    const restored = await api.restore(created[1].id);
    eq(restored.status, 200, "直接恢复");
    eq((await api.list()).json.boards.length, 3, "恢复到 3 块");
    eq((await evictions(userId)).length, 0, "无审计");
  });

  await test("并发恢复两块：两条都成功，12 → 14 块，不淘汰", async () => {
    const { api, email } = await registerUser("restore-race");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);
    eq((await api.removeBoard(created[0].id)).status, 200, "回收站第 1 块");
    eq((await api.removeBoard(created[1].id)).status, 200, "回收站第 2 块");
    await createMany(api, 2, { startIndex: 200 });
    eq((await api.list()).json.boards.length, 12, "仍满 12 块");

    const [a, b] = await Promise.all([api.restore(created[0].id), api.restore(created[1].id)]);
    eq([a.status, b.status], [200, 200], `并发恢复状态 ${a.status}/${b.status}`);
    eq((await api.list()).json.boards.length, 14, "并发后 14 块");

    eq((await evictions(userId)).length, 0, "恢复不写淘汰审计");
    eq((await api.trash()).json.boards.length, 0, "两块都恢复成功");
  });

  await test("游客没有回收站：回收站与恢复接口都要求登录", async () => {
    const { api } = await registerGuest();
    eq((await api.trash()).status, 401, "游客回收站 401");
    const restored = await api.restore("aaaaaaaaaaaa");
    eq(restored.status, 401, "游客恢复 401");
  });

  await closePool();
  finish(spec);
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
