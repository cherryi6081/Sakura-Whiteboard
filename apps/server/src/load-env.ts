import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 本地开发读取 .env；生产由容器环境变量注入，不读文件。
 *
 * 同一条路径在三种运行方式下并不一致：
 * - `tsx src/index.ts`：模块位于 apps/server/src/**，仓库根在 ../../../；
 * - 编译产物 `node dist/index.js`：模块位于 apps/server/dist/**，仓库根仍是 ../../../；
 * - 从仓库根直接 `node apps/server/dist/index.js`：cwd 才是仓库根。
 * 所以不能只按模块位置算一条固定路径，改为「先按 cwd 向上找，再按模块位置向上找」。
 */
function findEnvFile(): string | undefined {
  const explicit = process.env.DOTENV_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const here = dirname(fileURLToPath(import.meta.url));

  for (const start of [process.cwd(), here]) {
    let dir = start;
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = resolve(dir, '.env');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return undefined;
}

const envPath = findEnvFile();

if (envPath) {
  process.loadEnvFile(envPath);
  // 不打印内容，只在 debug 级说明命中了哪个文件
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[env] loaded ${envPath}`);
  }
}
