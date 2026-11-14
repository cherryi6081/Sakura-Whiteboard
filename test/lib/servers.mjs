import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { API, OUT_DIR, REPO_ROOT, WEB } from "./config.mjs";

async function reachable(url, expectStatus = (status) => status < 500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return expectStatus(res.status);
  } catch {
    return false;
  }
}

async function waitFor(url, { timeout = 120_000, label } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await reachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待 ${label ?? url} 超时`);
}

/**
 * 确保 API 与 Web 都在跑；缺哪个就起 `npm run dev`（两个一起起）。
 * 返回 stop()，只在本次真正拉起进程时才会杀进程。
 */
export async function ensureServers({ spawnMissing = process.env.WB_E2E_NO_SPAWN !== "1" } = {}) {
  const apiUp = await reachable(`${API}/api/health`);
  const webUp = await reachable(WEB);
  if (apiUp && webUp) return { started: false, stop: async () => {} };
  if (!spawnMissing) {
    throw new Error(`服务未就绪且禁止自动启动：api=${apiUp} web=${webUp}`);
  }

  const logDir = path.join(OUT_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "dev.log");
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(`${npmCmd} run dev`, {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);

  try {
    await waitFor(`${API}/api/health`, { label: "API", timeout: 150_000 });
    await waitFor(WEB, { label: "Web", timeout: 150_000 });
  } catch (error) {
    stream.end();
    await stopTree(child.pid);
    throw new Error(`${error.message}，日志见 ${logFile}`);
  }

  return {
    started: true,
    logFile,
    stop: async () => {
      await stopTree(child.pid);
      stream.end();
    },
  };
}

function stopTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
}
