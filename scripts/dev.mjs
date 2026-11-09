#!/usr/bin/env node
/**
 * 单终端开发启动器：并行起 API（tsx watch，改后端自动重启）与 Web（vite HMR，改前端即时生效）。
 * 不引入 concurrently，避免为一条命令再装一个依赖；输出统一加 [api] / [web] 前缀。
 *
 * Ctrl+C 一次停掉两个子进程（Windows 下用 taskkill /T 连带杀掉 npm 派生的 tsx/vite）。
 */
import { spawn, spawnSync } from "node:child_process";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const targets = [
  { name: "api", color: "\x1b[35m", script: "dev:server" },
  { name: "web", color: "\x1b[36m", script: "dev:web" },
];

const children = [];
let shuttingDown = false;

function prefix(name, color, text) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => `${color}[${name}]\x1b[0m ${line}`)
    .join("\n");
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.killed) continue;
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

for (const target of targets) {
  // Windows 上 npm 是 .cmd，必须经 shell 启动（Node 22 直接 spawn .cmd 会 EINVAL）
  const child = spawn(`${npmCmd} run ${target.script}`, { stdio: ["ignore", "pipe", "pipe"], shell: true });
  child.stdout.on("data", (chunk) => process.stdout.write(`${prefix(target.name, target.color, chunk.toString())}\n`));
  child.stderr.on("data", (chunk) => process.stderr.write(`${prefix(target.name, target.color, chunk.toString())}\n`));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`${target.name} 退出（code=${code}），一并停止另一个进程`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
