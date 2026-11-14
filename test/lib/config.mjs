import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（test/lib → ../..） */
export const REPO_ROOT = path.resolve(here, "../..");

/**
 * 服务端依赖根目录 `.env`（仓库里没有 dotenv，dev 启动器靠外部环境变量）。
 * e2e 自己读一遍，缺省值才不会把 API/DB 指错。
 */
function loadDotEnv() {
  const file = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}

loadDotEnv();

export const API = process.env.WB_API_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
export const WEB = process.env.WB_WEB_URL || "http://127.0.0.1:5173";
export const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/whiteboard";
export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const CHROME =
  process.env.WB_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

export const OUT_DIR = process.env.WB_E2E_OUT || path.join(REPO_ROOT, ".verify/e2e");

/** 测试账号统一密码（仅本地 dev 库） */
export const PASSWORD = "Xk7#mQ2vLp9wZ";

export const HEADLESS = process.env.WB_E2E_HEADFUL !== "1";
