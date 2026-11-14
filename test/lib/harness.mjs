import fs from "node:fs";
import path from "node:path";
import { OUT_DIR } from "./config.mjs";

const results = [];

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: 期望 ${e}，实际 ${a}`);
}

export function near(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: 期望 ${expected}±${tolerance}，实际 ${actual}`);
  }
}

/** 跑一个用例；失败只记录不中断后续用例 */
export async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS  ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, ms: Date.now() - started, error: message });
    console.log(`FAIL  ${name} (${Date.now() - started}ms)`);
    console.log(`      ${message.split("\n").join("\n      ")}`);
  }
}

export function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, error: reason });
  console.log(`SKIP  ${name}（${reason}）`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到 fn 返回真值或超时 */
export async function until(fn, { timeout = 15_000, interval = 250, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

export function screenshotPath(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, `${name}.png`);
}

/** 输出 RESULT_JSON 行并设置退出码；run.mjs 会解析这一段 */
export function finish(specName) {
  const failed = results.filter((item) => !item.ok);
  console.log(`RESULT_JSON ${JSON.stringify({ spec: specName, total: results.length, failed: failed.length, results })}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
