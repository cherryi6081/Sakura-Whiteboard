#!/usr/bin/env node
/**
 * 全站 e2e 入口。
 *
 *   npm run e2e                    # 白盒单测 + 全部页面黑盒
 *   npm run e2e -- capacity        # 只跑容量（其他 spec 名字同理）
 *   npm run e2e -- --no-whitebox   # 只跑黑盒
 *
 * 服务没起时会自动 `npm run dev`，跑完关掉；已有服务则直接复用。
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./lib/config.mjs";
import { ensureServers } from "./lib/servers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const filter = args.filter((arg) => !arg.startsWith("--"));
const skipWhitebox = args.includes("--no-whitebox");

const BLACKBOX = [
  ["capacity", "01-capacity.mjs"],
  ["boards", "02-boards-list.mjs"],
  ["drag", "03-drag.mjs"],
  ["thumb", "04-thumb.mjs"],
  ["theme", "05-theme.mjs"],
  ["permissions", "06-permissions.mjs"],
  ["editor", "07-editor.mjs"],
];

const WHITEBOX = [
  {
    label: "web: selection / sortOrder / thumbPolicy / boardList / route / returnTo / backTarget",
    cwd: path.join(REPO_ROOT, "apps/web"),
    files: [
      "src/boards/selection.test.ts",
      "src/boards/sortOrder.test.ts",
      "src/boards/thumbPolicy.test.ts",
      "src/boards/boardList.test.ts",
      "src/board/route.test.ts",
      "src/auth/returnTo.test.ts",
      "src/board/backTarget.test.ts",
    ],
  },
  {
    label: "server: boardCapacity / roles / boardOrder",
    cwd: path.join(REPO_ROOT, "apps/server"),
    files: ["src/domain/boardCapacity.test.ts", "src/domain/roles.test.ts", "src/domain/boardOrder.test.ts"],
  },
];

function run(command, commandArgs = [], { cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function tail(text, lines = 40) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

async function main() {
  const results = [];
  const shouldRun = (key) => filter.length === 0 || filter.some((item) => key.includes(item));

  if (!skipWhitebox && shouldRun("whitebox")) {
    for (const group of WHITEBOX) {
      console.log(`\n=== 白盒：${group.label} ===`);
      const out = await run("npx", ["vitest", "run", ...group.files], { cwd: group.cwd });
      const ok = out.code === 0;
      console.log(ok ? "PASS" : tail(out.stdout + out.stderr));
      results.push({ name: `whitebox:${group.label}`, ok });
    }
  }

  const specs = BLACKBOX.filter(([key]) => shouldRun(key));
  const servers = await ensureServers();
  try {
    for (const [key, file] of specs) {
      console.log(`\n=== 黑盒：${file} ===`);
      const out = await run(process.execPath, [path.join(here, "blackbox", file)]);
      const line = out.stdout.split(/\r?\n/).find((item) => item.startsWith("RESULT_JSON "));
      let detail = null;
      if (line) {
        try {
          detail = JSON.parse(line.slice("RESULT_JSON ".length));
        } catch {
          detail = null;
        }
      }
      console.log(tail(out.stdout.replace(line ?? "", "").trim()));
      if (out.stderr.trim()) console.log(tail(out.stderr));
      results.push({
        name: `blackbox:${key}`,
        ok: out.code === 0,
        detail,
        failed: detail?.results.filter((item) => !item.ok) ?? [],
      });
    }
  } finally {
    await servers.stop();
  }

  console.log("\n========== 汇总 ==========");
  let failed = 0;
  for (const item of results) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}`);
    if (!item.ok) failed += 1;
    for (const f of item.failed ?? []) console.log(`        - ${f.name}: ${f.error}`);
  }
  console.log(`\n${results.length - failed}/${results.length} 组通过`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
