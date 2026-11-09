# 实时协作白板

一个可多人同时在线的无限画布白板：基于 Excalidraw 渲染，自己实现操作（op）管线、身份与权限、分享链接和图片资产，目标是把「实时协作」这条链路端到端做通，而不是套一个现成协作服务。

## 核心能力

- **实时协作**：Socket.IO + Redis Adapter 房间广播；op 先落库再广播，`seq` 单调递增，断线后按 `since` 补拉，跨度超过阈值回落整板快照。
- **冲突处理**：前端从 Excalidraw 全量数组 diff 出 op，50ms 批合并；冲突按 `version` + `versionNonce` 的 LWW 解决，本地不动远端正在编辑的可见结果。
- **身份与权限**：邮箱密码（argon2id）+ Redis 会话（HttpOnly cookie）；游客用签名 `wb_gid` cookie，可建板、可分享；访问权统一由 `resolveBoardAccess` 推导（owner / editor / viewer / 有效分享 token），REST 与 WS 都只信 cookie，不信任客户端自报身份。
- **分享链接**：只读 / 可编辑两种权限，可设过期时间、可吊销；吊销即时删除 `share:` 缓存。
- **游客认领**：注册后把本机游客板一次性迁到账号下，单事务全量提交、失败回滚，重复认领幂等。
- **图片（v1.1）**：粘贴、拖入、工具栏选图三条入口；单张 ≤5MB、单板 ≤50MB、仅 `png/jpeg/webp/gif`（不收 SVG）；服务端按魔数解析真实宽高，不信任扩展名与 `Content-Type`；同板同 `sha256` 秒传；读取走短时签名 URL，op 里只带 `fileId`，不传 base64。
- **资产 GC（dry-run）**：报告孤儿资产、失效引用（只被已删除元素引用）、待清理对象与完整性告警；`--apply` 明确拒绝，不动数据。
- **降级**：存储不可用时上传返回 `503 STORAGE_UNAVAILABLE`，画布其余操作不受影响；Redis 配额计数失败时退回 PG 计数。

## 架构

```mermaid
flowchart LR
  B["浏览器<br/>React 18 + Excalidraw 0.18"]
  A["Express API<br/>REST + 静态托管"]
  S["Socket.IO<br/>/board 房间"]
  P[("PostgreSQL 16<br/>boards / elements / ops / assets")]
  R[("Redis 7<br/>会话 / seq / presence / 广播")]
  D[("本地磁盘<br/>图片资产")]

  B -->|"/api"| A
  B <-->|"WebSocket"| S
  S --> P
  S --> R
  A --> P
  A --> R
  A --> D
```

- **单 op 的路径**：画布 `onChange` → diff → 50ms 批 → `op:submit` → 服务端校验/落库/分配 `seq` → `op:apply` 广播 → 对端 `applyRemoteElements`（`CaptureUpdateAction.NEVER`，不打断本地编辑）。
- **图片的路径**：上传原始字节 → 魔数校验/配额/秒传 → 落盘 + `assets` 行 → 返回 `assetId` → 前端构造 image 元素（`fileId = assetId`）→ 元素走 op 管线同步 → 对端按签名 URL 拉字节并 `addFiles`。
- **多实例**：`--scale api=2` 时广播经 Redis 扇出；静态产物与图片卷各实例共享。

## 目录结构

```
apps/
  web/          Vite + React 18 + Excalidraw；协作管线、缓存、页面与自绘 UI
  server/       Express 4 + TypeScript；REST、Socket.IO、迁移、GC 任务
packages/
  shared/       协议类型、op schema（zod）、错误码、角色枚举、限额
deploy/
  docker-compose.yml   pg / redis / api / 自动迁移 / 一次性迁移
docs/           开发文档（接口契约、数据模型、决策记录）
.github/workflows/ci.yml   typecheck / test / build 三个独立 job
```

## 运行方式

### 方式一：本地开发（前后端分开）

需要 Node 22、PostgreSQL 16、Redis 7（没有 PG/Redis 时可以只用 compose 起这两个）：

```bash
cp .env.example .env
docker compose -f deploy/docker-compose.yml up -d postgres redis   # 已有本机 PG/Redis 可跳过

npm ci
npm run migrate
npm run dev -w @whiteboard/server   # API :8080
npm run dev -w @whiteboard/web      # Vite :5173，/api 与 /socket.io 代理到 8080
```

打开 <http://127.0.0.1:5173>。开发期前端是 Vite dev server（HMR、快速反馈），不做静态构建；API 不托管前端。

### 方式二：容器一键起（生产形态）

首次启动（构建镜像、建卷、自动迁移、起全栈）：

```bash
docker compose -f deploy/docker-compose.yml up --build -d
```

日常启动（镜像与卷已存在，只重启服务）：

```bash
docker compose -f deploy/docker-compose.yml up -d
```

打开 <http://localhost:8080>。前端在构建阶段产出静态资源，由 API 同源托管（`WEB_DIST=apps/web/dist`），因此只有 `pg / redis / migrate-auto / api` 四个服务，没有额外 nginx。

- **取舍**：少一个服务、少一层代理，cookie 天然同源（不依赖 Vite 代理，也就绕开了代理改写 `Host` 带来的同源校验问题）；代价是前端与 API 同进程、同滚动发布，静态资源缓存交给了 Express 默认头（未做 CDN）。若后续要独立发布前端，把 `apps/web/dist` 交给 nginx/CDN 即可，API 不设 `WEB_DIST` 就回到纯后端。
- **迁移**：默认路径里的 `migrate-auto` 跑完即退出，`api` 等它成功后才启动；迁移幂等（`schema_migrations` 记录 checksum），每天重复 `up` 也只会输出 `up to date`。
- **手动迁移（能力保留）**：`docker compose -f deploy/docker-compose.yml --profile init run --rm migrate`。
- **双实例**：`docker compose -f deploy/docker-compose.yml up -d --scale api=2`，宿主端口 8080/8081，健康检查各自返回不同 `instance`。

## 环境变量

完整清单见 [.env.example](.env.example)。常用项：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `8080` | API 端口 |
| `DATABASE_URL` | 是 | — | `postgres://user:pass@host:5432/db` |
| `REDIS_URL` | 是 | — | `redis://host:6379` |
| `SESSION_SECRET` | 是 | — | 会话签名，≥16 字符；生产请用 ≥32 字节随机值 |
| `GUEST_COOKIE_SECRET` | 是 | — | 游客 cookie 的 HMAC 密钥，≥32 字节 |
| `GUEST_COOKIE_SECRET_PREV` | 否 | — | 轮换期并行验签的上一代密钥 |
| `INSTANCE_ID` | 否 | 主机名 | 日志与双实例验证用 |
| `STORAGE_ROOT` | 否 | `.storage` | 图片本地磁盘根目录 |
| `ASSET_URL_SECRET` | 否 | 复用 `SESSION_SECRET` | 资产签名密钥（≥32 字节） |
| `ASSET_URL_TTL_SECONDS` | 否 | `900` | 签名 URL 有效期 |
| `WEB_DIST` | 否 | — | 前端静态产物目录；容器镜像内已设为 `apps/web/dist` |

`GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_REDIRECT_URI` 是**预留项**，当前代码不读取。

## 常用命令

```bash
npm run typecheck      # shared 先构建，再对 server / web 做 tsc --noEmit
npm test               # server + web 单测（vitest，固定 forks + 单 fork）
npm run build          # shared → server（tsc）→ web（vite build）
npm run migrate        # 执行 0001–0004 迁移（幂等）
npm run asset:gc -w @whiteboard/server -- --grace-hours=24   # 资产回收 dry-run
```

CI（[ci.yml](.github/workflows/ci.yml)）触发于 push 到 `main` 与所有 PR，三个独立 job：`typecheck`、`test`（server + web）、`build`；统一 `npm ci` + Node 22 + npm 缓存。

## 已验证的实测口径（本机）

- 资产接口验收 22 个用例全部通过：上传、秒传、超 5MB、超单板配额、非法类型、未登录/游客/非成员/只读分享/可编辑分享、签名 URL 与篡改拒绝、按板列表。
- 浏览器端到端 8 个用例全部通过：三入口上传、对端（无 cookie 只读链接）同步到 3 个 image 元素并补齐字节、渲染无占位框。
- `typecheck` 通过；server 49 个、web 31 个单测通过。
- 双实例跨实例广播、游客配额、分享吊销等链路的验证脚本在 `docs/` 与仓库外验收脚本中记录。

## 已知边界

- **生产对象存储未联调**：当前只有本地磁盘驱动（`StorageDriver` 接口已抽象），换 S3/OSS 需要另做驱动与联调。
- **GC 仅 dry-run**：只输出候选与结论，`--apply` 会被拒绝；真实删除需单独审批与演练。
- **移动端裁切**：Excalidraw 工具岛在窄屏下约 20px 被裁切，未修。
- **视觉待优化**：当前视觉是冻结版本，等全部功能完成后再统一优化。
- **presence 注册表是进程内的**：多实例下各实例只看到自己的连接，presence 聚合不完整；完整方案需把注册表搬到 Redis 或使用粘性房间。
- **未实现**：GitHub OAuth、成员管理、白板重命名/归档/删除接口、导出 PNG。
- **口子**：单张 5MB / 单板 50MB 是硬编码常量（`packages/shared` 的 `LIMITS`），要按套餐区分需改为可配置。

## License

MIT
