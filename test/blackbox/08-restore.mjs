import { registerGuest, registerUser } from "../lib/api.mjs";
import { assert, eq, finish, test } from "../lib/harness.mjs";
import { ageBoards, boardRow, closePool, evictions, userIdByEmail } from "../lib/db.mjs";

/**
 * 回收站恢复的容量冲突：确认式替换。
 *
 * 容量 12；满 12 时恢复不会直接成功，而是要求带 replaceBoardId，
 * 服务端在同一事务里「移入回收站 + 恢复」，并写 trigger=restore 的审计。
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
  await test("满 12 恢复：不带 replaceBoardId → 409 CAPACITY_FULL，数据不变", async () => {
    const { api, email } = await registerUser("restore-full");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);
    await ageBoards(userId, 11);

    // 挪一块进回收站，再补一块回到满 12
    eq((await api.removeBoard(created[0].id)).status, 200, "移入回收站");
    await createMany(api, 1, { startIndex: 100 });
    eq((await api.list()).json.boards.length, 12, "回到 12 块");

    const blocked = await api.restore(created[0].id);
    eq(blocked.status, 409, "满额直接恢复应被拒");
    eq(blocked.json?.error?.code, "CAPACITY_FULL", "错误码");
    eq((await api.list()).json.boards.length, 12, "被拒后仍是 12 块");
    eq((await evictions(userId)).length, 0, "被拒时不写淘汰审计");
    assert((await boardRow(created[0].id)).deleted_at !== null, "目标板仍在回收站");
  });

  await test("恢复计划：列出 12 个候选，按打开次数排序", async () => {
    const { api, email } = await registerUser("restore-plan");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);
    // 先补一块、记录一次打开，再把所有板整体推到保护期外：
    // 刚建/刚打开的都算「最近用过」，不推出去就不会进候选
    eq((await api.removeBoard(created[0].id)).status, 200, "移入回收站");
    await createMany(api, 1, { startIndex: 100 });
    eq((await api.opened(created[5].id)).status, 204, "记录一次打开");
    await ageBoards(userId, 11);

    const plan = await api.restorePlan(created[0].id);
    eq(plan.status, 200, "计划状态");
    eq(plan.json.capacity, 12, "容量");
    eq(plan.json.used, 12, "已用");
    eq(plan.json.needsEviction, true, "需要腾位置");
    eq(plan.json.candidates.length, 12, "候选数");
    // 同一批板的 created_at 被整体推到同一时刻，排序退化成按 id；
    // 这里只断言「零打开的排最前、打开过的排后面」
    eq(plan.json.candidates[0].openedCount, 0, "候选首位是零打开的");
    eq(plan.json.candidates[0].id === created[5].id, false, "打开过的板不会是首位");
    assert(
      plan.json.candidates.findIndex((row) => row.id === created[5].id) > 0,
      "打开过的板排在后面",
    );
  });

  await test("确认替换：恢复目标板 + 移入回收站 + trigger=restore 审计，仍 12 块", async () => {
    const { api, email } = await registerUser("restore-replace");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);
    await ageBoards(userId, 11);
    eq((await api.removeBoard(created[0].id)).status, 200, "移入回收站");
    await createMany(api, 1, { startIndex: 100 });
    const plan = await api.restorePlan(created[0].id);
    const victim = plan.json.candidates[0];

    const restored = await api.restore(created[0].id, victim.id);
    eq(restored.status, 200, `替换恢复状态：${JSON.stringify(restored.json)}`);
    eq(restored.json.id, created[0].id, "恢复到目标板");
    eq(restored.json.evicted?.id, victim.id, "被替换的板");
    eq(restored.json.evicted?.title, victim.title, "被替换的板名");

    const list = await api.list();
    eq(list.json.boards.length, 12, "恢复后仍 12 块");
    eq(list.json.boards.some((board) => board.id === created[0].id), true, "目标板回到列表");
    eq(list.json.boards.some((board) => board.id === victim.id), false, "被替换板离开列表");

    assert((await boardRow(victim.id)).deleted_at !== null, "被替换板应为软删");
    const trash = await api.trash();
    eq(trash.json.boards.some((item) => item.id === victim.id), true, "被替换板在回收站可见");

    const audits = await evictions(userId);
    eq(audits.length, 1, "审计行数");
    eq(audits[0].trigger, "restore", "审计来源");
    eq(audits[0].board_id, victim.id, "审计记录被淘汰的板");
    eq(audits[0].trigger_board_id, created[0].id, "审计记录触发板");
  });

  await test("有空位时恢复：直接成功，不弹窗、不淘汰", async () => {
    const { api, email } = await registerUser("restore-room");
    const created = await createMany(api, 3);
    const userId = await userIdByEmail(email);
    eq((await api.removeBoard(created[1].id)).status, 200, "移入回收站");

    const plan = await api.restorePlan(created[1].id);
    eq(plan.status, 200, "计划状态");
    eq(plan.json.needsEviction, false, "有空位不需要替换");
    eq(plan.json.used, 2, "已用 2");

    const restored = await api.restore(created[1].id);
    eq(restored.status, 200, "直接恢复");
    eq(restored.json.evicted, null, "没有淘汰");
    eq((await api.list()).json.boards.length, 3, "恢复到 3 块");
    eq((await evictions(userId)).length, 0, "无审计");
  });

  await test("12 块全在保护期：429 CAPACITY_NO_EVICTABLE，什么都不删", async () => {
    const { api, email } = await registerUser("restore-protected");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);
    eq((await api.removeBoard(created[0].id)).status, 200, "移入回收站");
    // 新板都还在 10 分钟保护窗口内，补一块回到满 12
    await createMany(api, 1, { startIndex: 100 });
    eq((await api.list()).json.boards.length, 12, "满 12 块");

    const plan = await api.restorePlan(created[0].id);
    eq(plan.status, 200, "计划状态");
    eq(plan.json.candidates.length, 0, "没有可淘汰候选");

    const blocked = await api.restore(created[0].id);
    eq(blocked.status, 429, "全保护时恢复状态");
    eq(blocked.json?.error?.code, "CAPACITY_NO_EVICTABLE", "错误码");
    eq((await api.list()).json.boards.length, 12, "仍 12 块，未删任何一块");
    eq((await api.trash()).json.boards.length, 1, "回收站不变");
    eq((await evictions(userId)).length, 0, "无审计");
  });

  await test("并发恢复两块：串行淘汰不同板，不会超过 12", async () => {
    const { api, email } = await registerUser("restore-race");
    const created = await createMany(api, 12);
    const userId = await userIdByEmail(email);
    await ageBoards(userId, 11);
    eq((await api.removeBoard(created[0].id)).status, 200, "回收站第 1 块");
    eq((await api.removeBoard(created[1].id)).status, 200, "回收站第 2 块");
    await createMany(api, 2, { startIndex: 200 });
    eq((await api.list()).json.boards.length, 12, "仍满 12 块");

    const planA = await api.restorePlan(created[0].id);
    const [a, b] = await Promise.all([
      api.restore(created[0].id, planA.json.candidates[0].id),
      api.restore(created[1].id, planA.json.candidates[1].id),
    ]);
    eq([a.status, b.status], [200, 200], `并发恢复状态 ${a.status}/${b.status}`);
    eq((await api.list()).json.boards.length, 12, "并发后仍是 12 块");

    const audits = await evictions(userId);
    eq(audits.length, 2, "两次替换各一行审计");
    eq(new Set(audits.map((item) => item.board_id)).size, 2, "两次淘汰不是同一块板");
    eq(audits.every((item) => item.trigger === "restore"), true, "两条都是 restore 来源");
    const trash = await api.trash();
    eq(trash.json.boards.length, 2, "回收站里正好两块被替换的板");
  });

  await test("游客没有回收站：恢复与计划接口都要求登录", async () => {
    const { api } = await registerGuest();
    eq((await api.trash()).status, 401, "游客回收站 401");
    const plan = await api.restorePlan("aaaaaaaaaaaa");
    eq(plan.status, 401, "游客恢复计划 401");
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
