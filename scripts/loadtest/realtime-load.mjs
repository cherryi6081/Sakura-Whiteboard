#!/usr/bin/env node
/**
 * 实时协作白板 · Socket.IO 并发压测（单机、可复现）
 *
 * 做什么：
 * 1. 用一次性账号建一块白板，签一张 edit 分享链接（这样每个压测 socket 都是独立身份，presence 聚合接近真实）；
 * 2. 起 N 个 websocket 客户端加入同一块板，同时持续发 `cursor:move` 与 `op:submit`；
 * 3. 按档位（默认 5 / 10 / 20 / 50 / 100）逐档加压，测完一档断开再进下一档；
 * 4. 每档记录：加入成功数、join 延迟、光标广播延迟、op ack 延迟、op 广播延迟、事件吞吐、
 *    op 拒绝率、掉线数、服务端进程 CPU/RSS、Redis 命令速率、Postgres 活跃连接与事务速率；
 * 5. 输出结论表（控制台 + Markdown + JSON），并自动判定拐点；
 * 6. 压测结束断开所有 socket、吊销分享链接、注销临时账号（级联删除测试板），并清掉 Redis 里
 *    这块板的 `seq:` / `idem:` / `dirty:boards` 残留。
 *
 * 不做什么：不启动/重启/杀掉 dev server，不执行 git，不装依赖。被测服务由你事先跑起来。
 *
 * 用法见 scripts/loadtest/README.md，最短路径：
 *   node scripts/loadtest/realtime-load.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { io } from 'socket.io-client';
import { Redis } from 'ioredis';
import pg from 'pg';

const { Pool } = pg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

/* -------------------------------------------------------------------------- */
/* 参数与环境                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {
    base: process.env.WB_API_URL || '',
    levels: '5,10,20,50,100',
    duration: 10,
    warmup: 2,
    cursorHz: 4,
    opHz: 1,
    opBytes: 256,
    observers: 20,
    joinTimeout: 20,
    out: path.join(HERE, 'results'),
    keep: false,
    serverPid: null,
    board: null,
    shareToken: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 缺少值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--base':
        out.base = next();
        break;
      case '--levels':
        out.levels = next();
        break;
      case '--duration':
        out.duration = Number(next());
        break;
      case '--warmup':
        out.warmup = Number(next());
        break;
      case '--cursor-hz':
        out.cursorHz = Number(next());
        break;
      case '--op-hz':
        out.opHz = Number(next());
        break;
      case '--op-bytes':
        out.opBytes = Number(next());
        break;
      case '--observers':
        out.observers = Number(next());
        break;
      case '--join-timeout':
        out.joinTimeout = Number(next());
        break;
      case '--out':
        out.out = path.resolve(next());
        break;
      case '--server-pid':
        out.serverPid = Number(next());
        break;
      case '--board':
        out.board = next();
        break;
      case '--share-token':
        out.shareToken = next();
        break;
      case '--keep':
        out.keep = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }

  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) loadDotEnv();
  if (!out.base) out.base = `http://127.0.0.1:${process.env.PORT || 8080}`;
  out.base = out.base.replace(/\/$/, '');
  out.levelList = out.levels
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  if (out.levelList.length === 0) throw new Error('--levels 里没有有效档位');
  return out;
}

function printHelp() {
  console.log(`实时协作压测

  node scripts/loadtest/realtime-load.mjs [选项]

  --base <url>          被测服务地址，默认 http://127.0.0.1:\${PORT:-8080}
  --levels <a,b,c>      并发档位，默认 5,10,20,50,100
  --duration <秒>       每档测量时长（不含预热），默认 10
  --warmup <秒>         每档预热时长（指标清零），默认 2
  --cursor-hz <n>       每个客户端光标上行频率，默认 4
  --op-hz <n>           每个客户端元素更新频率，默认 1
  --op-bytes <n>        op 内 data 的填充字节数，默认 256
  --observers <n>       记录延迟分布的接收端样本数，默认 20（其余端只计数）
  --join-timeout <秒>   单档 join 等待上限，默认 20
  --out <dir>           结果输出目录，默认 scripts/loadtest/results
  --server-pid <pid>    直接指定被测 Node 进程（默认按监听端口自动探测）
  --board <id>          复用已有白板（需同时给 --share-token 且为 edit 权限）
  --share-token <tok>   复用已有分享 token
  --keep                压测后不清理测试账号/白板
`);
}

/** 与 test/lib/config.mjs 同口径：仓库根 `.env` 只补缺，不覆盖已有环境变量。 */
function loadDotEnv() {
  const file = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}

const PASSWORD = process.env.WB_LOADTEST_PASSWORD || 'Xk7#mQ2vLp9wZ';

const nowStamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

/* -------------------------------------------------------------------------- */
/* 极简 HTTP（带 cookie jar）                                                   */
/* -------------------------------------------------------------------------- */

class HttpClient {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  async request(method, pathname, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (this.cookies.size > 0) {
      init.headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(`${ARGS.base}${pathname}`, init);
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  }
}

/* -------------------------------------------------------------------------- */
/* 采纳指标：服务端进程 / Redis / Postgres                                      */
/* -------------------------------------------------------------------------- */

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).trim()),
    );
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** 按端口探测监听中的 Node 进程 pid（只读查询，绝不 kill）。 */
async function detectServerPid(port) {
  try {
    if (process.platform === 'win32') {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const out = await runPowerShell(
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
        );
        if (out && /^\d+$/.test(out)) return Number(out);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    }
    if (process.platform === 'linux') {
      const out = await run('ss', ['-ltnp']);
      if (out) {
        const line = out.split('\n').find((item) => new RegExp(`:${port}\\s`).test(item));
        const match = line && /pid=(\d+)/.exec(line);
        if (match) return Number(match[1]);
      }
    }
    const lsof = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    const first = lsof && lsof.trim().split(/\s+/)[0];
    return first && /^\d+$/.test(first) ? Number(first) : null;
  } catch {
    return null;
  }
}

/** 进程 CPU 累计秒数 + RSS 字节；拿不到返回 null。 */
function readProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return { cpuSec: ticks / 100, rssBytes: rssKb * 1024 };
  } catch {
    return null;
  }
}

/**
 * 常驻进程采样器：一次拉起 helper，循环输出 `cpu秒|RSS字节`。
 * 不在每个采样点重启 PowerShell —— Windows 上反复冷启动 powershell.exe 本身就会明显扰动被测机，
 * 让 p95 整体虚高（实测会把 20 并发下的光标 p95 从个位数抬到 25ms 量级）。
 */
function startProcessSampler(pid) {
  if (!pid) return null;
  const state = { latest: null, stop: () => undefined };

  const ingest = (line) => {
    const [cpu, rss] = String(line).trim().split('|');
    const cpuSec = Number(cpu);
    const rssBytes = Number(rss);
    if (!Number.isFinite(cpuSec) || !Number.isFinite(rssBytes)) return;
    state.latest = { cpuSec, rssBytes, at: Date.now() };
  };

  try {
    if (process.platform === 'win32') {
      const script =
        `$target = ${pid}; while ($true) { $p = Get-Process -Id $target -ErrorAction SilentlyContinue; ` +
        `if (-not $p) { break }; "{0}|{1}" -f $p.CPU, $p.WorkingSet64; Start-Sleep -Milliseconds 500 }`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          ingest(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      });
      child.on('error', () => undefined);
      state.stop = () => child.kill();
    } else if (process.platform === 'linux') {
      const tick = () => {
        const usage = readProcStat(pid);
        if (usage) state.latest = { ...usage, at: Date.now() };
      };
      tick();
      const timer = setInterval(tick, 500);
      timer.unref();
      state.stop = () => clearInterval(timer);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  return state;
}

function parseRedisInfo(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index <= 0) continue;
    out[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return out;
}

function parseCommandStats(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const match = /^cmdstat_([a-z0-9_]+):calls=(\d+)/.exec(line.trim());
    if (match) out[match[1]] = Number(match[2]);
  }
  return out;
}

async function redisSnapshot(redis) {
  const [info, stats] = await Promise.all([redis.info(), redis.info('commandstats')]);
  const parsed = parseRedisInfo(info);
  return {
    totalCommands: Number(parsed.total_commands_processed ?? 0),
    usedMemoryBytes: Number(parsed.used_memory ?? 0),
    connectedClients: Number(parsed.connected_clients ?? 0),
    commands: parseCommandStats(stats),
  };
}

async function pgSnapshot(pool) {
  const [activity, settings, txns] = await Promise.all([
    pool.query(
      `select
         count(*) filter (where state = 'active')::int as active,
         count(*) filter (where application_name like 'whiteboard-api@%')::int as app_total,
         count(*) filter (where application_name like 'whiteboard-api@%' and state = 'active')::int as app_active,
         count(distinct application_name) filter (where application_name like 'whiteboard-api@%')::int as app_instances
       from pg_stat_activity`,
    ),
    pool.query(`select setting::int as max_connections from pg_settings where name = 'max_connections'`),
    pool.query(
      `select coalesce(xact_commit + xact_rollback, 0)::bigint as xacts
         from pg_stat_database where datname = current_database()`,
    ),
  ]);
  return {
    active: activity.rows[0]?.active ?? 0,
    appTotal: activity.rows[0]?.app_total ?? 0,
    appActive: activity.rows[0]?.app_active ?? 0,
    appInstances: activity.rows[0]?.app_instances ?? 0,
    maxConnections: settings.rows[0]?.max_connections ?? 0,
    xacts: Number(txns.rows[0]?.xacts ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* 统计                                                                        */
/* -------------------------------------------------------------------------- */

const pct = (sorted, p) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
};

function summarize(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: round(sorted[Math.floor((sorted.length - 1) * 0.5)]),
    p95: round(pct(sorted, 0.95)),
    p99: round(pct(sorted, 0.99)),
    max: round(sorted[sorted.length - 1]),
  };
}

const round = (value, digits = 2) => (value === null || value === undefined ? null : Number(Number(value).toFixed(digits)));

const fmtMs = (value) => (value === null ? '—' : `${value}`);
const fmtPct = (value) => (value === null ? '—' : `${value.toFixed(1)}%`);

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

const ARGS = parseArgs(process.argv.slice(2));

let sharedState = {
  clients: [],
  timers: [],
  http: null,
  boardId: ARGS.board,
  shareToken: ARGS.shareToken,
  cleanup: null,
  redis: null,
  pgPool: null,
  processSampler: null,
  stopping: false,
};

/**
 * 一条压测连接。
 *
 * 延迟口径：
 * - join：connect → 收到 `joined`（含身份解析 + 权限查询 + presence 登记）；
 * - cursor：发送端记录发送时刻，接收端按 **connectionId + 到达顺序** 与发送时刻配对
 *   （websocket 保证同连接内有序，服务端不回显发送者）；所有 socket 在同一个进程里，
 *   共享一张发送时刻表即可，不需要改动协议；
 * - op ack：`op:submit` → 该 opId 的 `op:ack`；
 * - op 广播：发送端把毫秒时间戳编进 opId 首段（base36），接收端解析后与本地时钟相减。
 */
function createClient(level, index, opts) {
  const clientId = `lt${opts.runId}${index}`;
  const tabId = `tab-${opts.runId}-${index}`;
  const socket = io(`${ARGS.base}/board`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 10_000,
    forceNew: true,
  });

  const client = {
    index,
    clientId,
    socket,
    connectionId: null,
    joined: false,
    joinStartedAt: 0,
    observer: index < ARGS.observers,
    ackSentAt: new Map(),
    opSeq: 0,
    cursorSeq: 0,
    elementVersion: 0,
    cursorTimer: null,
    opTimer: null,
    unexpectedDisconnect: 0,
  };

  const levelMetrics = opts.metrics;
  let settled = false;

  socket.on('connect', () => {
    client.connectionId = socket.id;
    client.joinStartedAt = performance.now();
    socket.emit('join', {
      boardId: opts.boardId,
      clientId,
      viewOnly: false,
      tabId,
      shareToken: opts.shareToken,
    });
  });

  socket.on('joined', () => {
    if (client.joined || settled) return;
    settled = true;
    client.joined = true;
    levelMetrics.joinLatency.push(performance.now() - client.joinStartedAt);
    levelMetrics.joined += 1;
    opts.onJoined?.();
  });

  socket.on('join:error', (payload) => {
    if (client.joined || settled) return;
    settled = true;
    const code = payload?.code ?? 'INTERNAL';
    levelMetrics.joinErrors[code] = (levelMetrics.joinErrors[code] ?? 0) + 1;
    opts.onJoinFailed?.();
  });

  socket.on('connect_error', () => {
    levelMetrics.connectErrors += 1;
    if (client.joined || settled) return;
    settled = true;
    levelMetrics.joinErrors.CONNECT_ERROR = (levelMetrics.joinErrors.CONNECT_ERROR ?? 0) + 1;
    opts.onJoinFailed?.();
  });

  socket.on('disconnect', (reason) => {
    if (client.joined && !opts.intentionalClose && ARGS_META.measuring) {
      client.unexpectedDisconnect += 1;
      levelMetrics.unexpectedDisconnects += 1;
      levelMetrics.disconnectReasons[reason] = (levelMetrics.disconnectReasons[reason] ?? 0) + 1;
    }
    client.joined = false;
  });

  socket.on('op:ack', (payload) => {
    if (!payload || typeof payload.opId !== 'string') return;
    levelMetrics.acks += 1;
    const sentAt = client.ackSentAt.get(payload.opId);
    if (sentAt === undefined) return;
    client.ackSentAt.delete(payload.opId);
    if (client.observer) levelMetrics.ackLatency.push(performance.now() - sentAt);
  });

  socket.on('op:rejected', (payload) => {
    const reason = payload?.reason ?? 'UNKNOWN';
    levelMetrics.rejects += 1;
    levelMetrics.rejectReasons[reason] = (levelMetrics.rejectReasons[reason] ?? 0) + 1;
  });

  socket.on('op:apply', (payload) => {
    levelMetrics.applies += 1;
    if (!client.observer || !payload?.op?.opId) return;
    const ms = parseInt(String(payload.op.opId).split('-')[0], 36);
    if (!Number.isFinite(ms)) return;
    const latency = Date.now() - ms;
    if (latency >= 0 && latency < 60_000) levelMetrics.applyLatency.push(latency);
  });

  /**
   * 合帧后延迟口径：发送端把 `performance.now()` 放进 `cursor:move.t`，服务端原样回带。
   * 同一连接内 websocket 有序投递，但合帧允许丢中间帧，因此不能再按“第 N 条到达配第 N 次发送”，
   * 直接用携带的时间戳算真实端到端；自回显（本连接自己的光标）不计入，口径与原 `socket.to(room)` 一致。
   */
  const recordCursor = (payload) => {
    const connectionId = payload?.connectionId;
    if (!connectionId || connectionId === client.connectionId) return;
    levelMetrics.cursors += 1;
    if (!client.observer) return;
    const sentAt = payload.t;
    if (typeof sentAt !== 'number') return;
    const latency = performance.now() - sentAt;
    if (latency >= 0 && latency < 60_000) levelMetrics.cursorLatency.push(latency);
  };

  // 新服务端走合帧事件；保留单条事件分支，便于脚本对旧版本复测
  socket.on('presence:cursor:frame', (payload) => {
    if (!Array.isArray(payload?.cursors)) return;
    for (const cursor of payload.cursors) recordCursor(cursor);
  });
  socket.on('presence:cursor', recordCursor);

  return client;
}

function startTraffic(client, opts) {
  // 0 表示不产生该类流量：用于单独归因光标扇出与 op 写/广播各自的成本
  const cursorPeriod = ARGS.cursorHz > 0 ? 1000 / ARGS.cursorHz : 0;
  const opPeriod = ARGS.opHz > 0 ? 1000 / ARGS.opHz : 0;
  const jitter = Math.random() * 200;

  const sendCursor = () => {
    if (!client.joined) return;
    client.cursorSeq += 1;
    client.socket.emit('cursor:move', {
      x: Math.min(1, Math.max(0, Math.random())),
      y: Math.min(1, Math.max(0, Math.random())),
      // 合帧会丢中间帧，用发送时刻直接算端到端延迟；同一进程内 performance.now() 共享时钟
      t: performance.now(),
    });
  };

  const sendOp = () => {
    if (!client.joined) return;
    client.opSeq += 1;
    client.elementVersion += 1;
    const elementId = `lt-el-${opts.level}-${client.index}`;
    const opId = `${Date.now().toString(36)}-${client.index}-${client.opSeq}`;
    const pad = 'x'.repeat(Math.max(0, ARGS.opBytes));
    const op = {
      opId,
      id: elementId,
      type: 'rectangle',
      baseVersion: client.elementVersion - 1,
      version: client.elementVersion,
      versionNonce: 0,
      kind: 'upsert',
      zindexKey: `a${String(client.index).padStart(4, '0')}`,
      data: {
        id: elementId,
        type: 'rectangle',
        version: client.elementVersion,
        versionNonce: 0,
        x: client.cursorSeq,
        y: client.opSeq,
        width: 160,
        height: 90,
        strokeColor: '#333333',
        backgroundColor: 'transparent',
        seed: 7,
        opacity: 100,
        pad,
      },
    };
    client.ackSentAt.set(opId, performance.now());
    ARGS_META.submitted += 1;
    client.socket.emit('op:submit', { boardId: opts.boardId, clientId: client.clientId, ops: [op] });
  };

  if (cursorPeriod > 0) {
    client.cursorTimer = setTimeout(() => {
      sendCursor();
      client.cursorTimer = setInterval(sendCursor, cursorPeriod);
    }, jitter);
  }
  if (opPeriod > 0) {
    client.opTimer = setTimeout(() => {
      sendOp();
      client.opTimer = setInterval(sendOp, opPeriod);
    }, jitter + 50);
  }
}

function emptyMetrics() {
  return {
    requested: 0,
    joined: 0,
    connectErrors: 0,
    joinErrors: {},
    joinLatency: [],
    unexpectedDisconnects: 0,
    disconnectReasons: {},
    applies: 0,
    cursors: 0,
    acks: 0,
    rejects: 0,
    rejectReasons: {},
    ackLatency: [],
    applyLatency: [],
    cursorLatency: [],
    measuredSec: 0,
  };
}

let ARGS_META = { submitted: 0, measuring: false };

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLevel(level, opts) {
  const metrics = emptyMetrics();
  metrics.requested = level;
  ARGS_META.measuring = false;
  ARGS_META.submitted = 0;

  const clients = [];
  let joinedOrFailed = 0;
  let resolveJoinGate;
  const joinGate = new Promise((resolve) => {
    resolveJoinGate = resolve;
  });
  const onSettled = () => {
    joinedOrFailed += 1;
    if (joinedOrFailed >= level) resolveJoinGate();
  };
  const onJoined = () => onSettled();
  const onJoinFailed = () => onSettled();

  const usage = { rssPeak: 0, appActivePeak: 0, appTotalPeak: 0, samples: 0 };
  let sampler = null;

  const snapshotAll = async () => {
    const proc = sharedState.processSampler?.latest ?? null;
    const at = Date.now();
    const [red, database] = await Promise.all([
      sharedState.redis ? redisSnapshot(sharedState.redis).catch(() => null) : Promise.resolve(null),
      sharedState.pgPool ? pgSnapshot(sharedState.pgPool).catch(() => null) : Promise.resolve(null),
    ]);
    if (proc) {
      usage.rssPeak = Math.max(usage.rssPeak, proc.rssBytes);
      usage.samples += 1;
    }
    if (database) {
      usage.appActivePeak = Math.max(usage.appActivePeak, database.appActive);
      usage.appTotalPeak = Math.max(usage.appTotalPeak, database.appTotal);
    }
    return { at, proc, red, database };
  };

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  try {
    for (let i = 0; i < level; i += 1) {
      const client = createClient(level, i, { ...opts, metrics, onJoined, onJoinFailed });
      clients.push(client);
      sharedState.clients.push(client);
    }

    const timeout = new Promise((resolve) => setTimeout(resolve, ARGS.joinTimeout * 1000));
    await Promise.race([joinGate, timeout]);
    // 等最后一个 join 的 joined 事件落账
    await wait(200);

    const liveClients = clients.filter((client) => client.joined);
    for (const client of liveClients) startTraffic(client, opts);

    // 预热结束后清零流量口径，避免把 join 风暴算进稳态延迟/吞吐
    await wait(ARGS.warmup * 1000);
    metrics.ackLatency.length = 0;
    metrics.applyLatency.length = 0;
    metrics.cursorLatency.length = 0;
    metrics.applies = 0;
    metrics.cursors = 0;
    metrics.acks = 0;
    metrics.rejects = 0;
    metrics.rejectReasons = {};
    metrics.unexpectedDisconnects = 0;
    metrics.disconnectReasons = {};
    ARGS_META.submitted = 0;
    ARGS_META.measuring = true;
    loopDelay.reset();

    const baseline = await snapshotAll();
    sampler = setInterval(() => void snapshotAll(), 500);

    const startedAt = performance.now();
    await wait(ARGS.duration * 1000);
    metrics.measuredSec = (performance.now() - startedAt) / 1000;

    ARGS_META.measuring = false;
    for (const client of liveClients) {
      if (client.cursorTimer) clearInterval(client.cursorTimer);
      if (client.opTimer) clearInterval(client.opTimer);
      client.cursorTimer = null;
      client.opTimer = null;
    }
    // 收尾：等在途 ack / 广播落账
    await wait(1000);
    const final = await snapshotAll();
    clearInterval(sampler);
    sampler = null;

    return buildLevelResult(level, metrics, { baseline, final, usage, loopDelay, liveClients });
  } finally {
    loopDelay.disable();
    if (sampler) clearInterval(sampler);
    // 本档结束即断连，避免上一档的连接把下一档的 fan-out 成本叠上去
    for (const client of clients) {
      try {
        client.socket.removeAllListeners();
        client.socket.disconnect();
      } catch {
        // ignore
      }
    }
    sharedState.clients = sharedState.clients.filter((item) => !clients.includes(item));
    await wait(300);
  }
}

function buildLevelResult(level, metrics, ctx) {
  const { baseline, final, usage, loopDelay, liveClients } = ctx;
  const seconds = metrics.measuredSec || 1;

  const cpuPct = (() => {
    if (!baseline.proc || !final.proc) return null;
    const wallSec = (final.proc.at - baseline.proc.at) / 1000;
    if (wallSec <= 0) return null;
    const delta = final.proc.cpuSec - baseline.proc.cpuSec;
    if (delta < 0) return null;
    return round((delta / wallSec) * 100, 1);
  })();

  const redisCmdsPerSec = (() => {
    if (!baseline.red || !final.red) return null;
    const delta = final.red.totalCommands - baseline.red.totalCommands;
    if (delta < 0) return null;
    return round(delta / seconds, 1);
  })();

  const redisTop = (() => {
    if (!baseline.red || !final.red) return {};
    const out = {};
    for (const name of ['eval', 'publish', 'get', 'set', 'incr', 'del', 'zadd', 'exists']) {
      const before = baseline.red.commands[name] ?? 0;
      const after = final.red.commands[name] ?? 0;
      if (after > before) out[name] = round((after - before) / seconds, 1);
    }
    return out;
  })();

  const pgXactsPerSec = (() => {
    if (!baseline.database || !final.database) return null;
    return round((final.database.xacts - baseline.database.xacts) / seconds, 1);
  })();

  const delivered = metrics.cursors + metrics.applies;
  const joinFailed = level - metrics.joined;
  const submittedTotal = ARGS_META.submitted;
  const attempted = Math.max(1, level + submittedTotal);
  const errorCount =
    joinFailed + metrics.rejects + metrics.unexpectedDisconnects + metrics.connectErrors;
  const errorRate = round((errorCount / attempted) * 100, 2);
  const opRejectRate = round((metrics.rejects / Math.max(1, submittedTotal)) * 100, 2);
  const joinErrorRate = round((joinFailed / Math.max(1, level)) * 100, 2);
  const unackedOps = Math.max(0, Math.round(submittedTotal - metrics.acks));

  const join = summarize(metrics.joinLatency);
  const cursor = summarize(metrics.cursorLatency);
  const ack = summarize(metrics.ackLatency);
  const apply = summarize(metrics.applyLatency);

  const offeredPerSec = level * (ARGS.cursorHz + ARGS.opHz);
  // 期望投递量：光标不进发送者（N-1 份），op:apply 含发送者（N 份）
  const expectedDeliveredPerSec = level * (level - 1) * ARGS.cursorHz + level * level * ARGS.opHz;
  const deliveryRatio = round((delivered / seconds) / Math.max(1, expectedDeliveredPerSec), 3);
  const result = {
    level,
    requested: level,
    joined: metrics.joined,
    joinFailed,
    joinErrors: metrics.joinErrors,
    unexpectedDisconnects: metrics.unexpectedDisconnects,
    disconnectReasons: metrics.disconnectReasons,
    connectErrors: metrics.connectErrors,
    errorRate,
    opRejectRate,
    joinErrorRate,
    unackedOps,
    join,
    cursor,
    ack,
    apply,
    submittedPerSec: round(ARGS_META.submitted / seconds, 1),
    acksPerSec: round(metrics.acks / seconds, 1),
    rejectsPerSec: round(metrics.rejects / seconds, 1),
    rejectReasons: metrics.rejectReasons,
    deliveredPerSec: round(delivered / seconds, 1),
    expectedDeliveredPerSec: round(expectedDeliveredPerSec, 1),
    deliveryRatio,
    offeredPerSec: round(offeredPerSec, 1),
    cursorEventsPerSec: round(metrics.cursors / seconds, 1),
    applyEventsPerSec: round(metrics.applies / seconds, 1),
    liveClients: liveClients.length,
    server: {
      cpuPct,
      cpuCores: os.cpus().length,
      rssPeakMb: usage.samples > 0 ? round(usage.rssPeak / 1024 / 1024, 1) : null,
      samples: usage.samples,
    },
    redis: {
      cmdsPerSec: redisCmdsPerSec,
      usedMemoryMb: round((final.red?.usedMemoryBytes || 0) / 1024 / 1024, 1),
      connectedClients: final.red?.connectedClients ?? null,
      top: redisTop,
    },
    pg: {
      appActivePeak: usage.appActivePeak,
      appTotalPeak: usage.appTotalPeak,
      appInstances: final.database?.appInstances ?? null,
      maxConnections: final.database?.maxConnections ?? null,
      xactsPerSec: pgXactsPerSec,
      poolMax: Number(process.env.DB_POOL_MAX || 10),
    },
    harness: {
      eventLoopP95Ms: round(loopDelay.percentile(95) / 1e6, 2),
    },
  };

  result.verdict = verdictOf(result);
  return result;
}

const THRESHOLDS = {
  joinP95Ms: 300,
  cursorP95Ms: 150,
  ackP95Ms: 200,
  applyP95Ms: 250,
  errorRatePct: 1,
  cpuPct: 85,
};

function verdictOf(row) {
  const failures = [];
  if (row.joined < row.requested) failures.push(`join ${row.joined}/${row.requested}`);
  if (row.join.p95 !== null && row.join.p95 > THRESHOLDS.joinP95Ms) failures.push(`join p95 ${row.join.p95}ms`);
  if (row.cursor.p95 !== null && row.cursor.p95 > THRESHOLDS.cursorP95Ms) failures.push(`cursor p95 ${row.cursor.p95}ms`);
  if (row.ack.p95 !== null && row.ack.p95 > THRESHOLDS.ackP95Ms) failures.push(`ack p95 ${row.ack.p95}ms`);
  if (row.apply.p95 !== null && row.apply.p95 > THRESHOLDS.applyP95Ms) failures.push(`apply p95 ${row.apply.p95}ms`);
  if (row.errorRate > THRESHOLDS.errorRatePct) failures.push(`error ${row.errorRate}%`);
  if (row.deliveryRatio !== null && row.deliveryRatio < 0.9) failures.push(`投递率 ${Math.round(row.deliveryRatio * 100)}%`);
  if (row.server.cpuPct !== null && row.server.cpuPct > THRESHOLDS.cpuPct) failures.push(`cpu ${row.server.cpuPct}%`);
  if (failures.length === 0) return { status: 'PASS', reasons: [] };

  const hardFail =
    row.joined < row.requested * 0.9 ||
    row.errorRate > 5 ||
    (row.deliveryRatio !== null && row.deliveryRatio < 0.75) ||
    (row.ack.p95 !== null && row.ack.p95 > THRESHOLDS.ackP95Ms * 2.5) ||
    (row.cursor.p95 !== null && row.cursor.p95 > THRESHOLDS.cursorP95Ms * 2.5);
  return { status: hardFail ? 'FAIL' : 'DEGRADED', reasons: failures };
}

/** 拐点：第一个未 PASS 的档位；同时标出吞吐不再线性增长的档位。 */
function findKnee(rows) {
  const firstBad = rows.find((row) => row.verdict.status !== 'PASS');
  let saturation = null;
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const offeredGrowth = cur.offeredPerSec / Math.max(1, prev.offeredPerSec);
    const deliveredGrowth = cur.deliveredPerSec / Math.max(1, prev.deliveredPerSec);
    if (offeredGrowth >= 1.5 && (deliveredGrowth < 1.25 || cur.deliveryRatio < 0.9)) {
      saturation = {
        from: prev.level,
        to: cur.level,
        offeredGrowth: round(offeredGrowth, 2),
        deliveredGrowth: round(deliveredGrowth, 2),
        deliveryRatio: cur.deliveryRatio,
      };
      break;
    }
  }
  return {
    firstFailingLevel: firstBad ? firstBad.level : null,
    firstFailingReasons: firstBad ? firstBad.verdict.reasons : [],
    throughputSaturation: saturation,
  };
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

function printResults(rows, knee, meta) {
  const header = [
    '并发',
    '加入',
    'join p95',
    '光标 p95',
    'ack p95',
    '广播 p95',
    '投递/s',
    '投递/期望',
    '失败率',
    '掉线',
    'CPU',
    'RSS',
    'Redis/s',
    'PG活跃',
    '判定',
  ];
  const lines = rows.map((row) => [
    String(row.level),
    `${row.joined}/${row.requested}`,
    fmtMs(row.join.p95),
    fmtMs(row.cursor.p95),
    fmtMs(row.ack.p95),
    fmtMs(row.apply.p95),
    String(row.deliveredPerSec),
    row.deliveryRatio === null ? '—' : `${Math.round(row.deliveryRatio * 100)}%`,
    fmtPct(row.errorRate),
    String(row.unexpectedDisconnects),
    row.server.cpuPct === null ? '—' : `${row.server.cpuPct}%`,
    row.server.rssPeakMb === null ? '—' : `${row.server.rssPeakMb}`,
    row.redis.cmdsPerSec === null ? '—' : String(row.redis.cmdsPerSec),
    `${row.pg.appActivePeak}/${row.pg.poolMax}`,
    row.verdict.status,
  ]);
  const widths = header.map((title, index) =>
    Math.max(displayWidth(title), ...lines.map((line) => displayWidth(line[index]))),
  );
  const format = (line) =>
    line
      .map((cell, index) => cell + ' '.repeat(Math.max(0, widths[index] - displayWidth(cell))))
      .join('  ');

  console.log('');
  console.log(`目标 ${meta.base}  机器 ${meta.cores}C/${meta.totalMemGb}GB  档位 ${meta.levels.join('/')}`);
  console.log(`每档：预热 ${meta.warmup}s + 测量 ${meta.duration}s；光标 ${meta.cursorHz}Hz/端，op ${meta.opHz}Hz/端，op data ≈ ${meta.opBytes}B`);
  console.log('');
  console.log(format(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const line of lines) console.log(format(line));
  console.log('');
  if (knee.firstFailingLevel !== null) {
    console.log(`拐点档位：${knee.firstFailingLevel}（${knee.firstFailingReasons.join('；')}）`);
  } else {
    console.log('拐点档位：本次所测档位内全部 PASS，未出现拐点');
  }
  if (knee.throughputSaturation) {
    const s = knee.throughputSaturation;
    console.log(
      `吞吐饱和：${s.from} → ${s.to}（供给 ×${s.offeredGrowth}，投递仅 ×${s.deliveredGrowth}，${s.to} 档实际投递 ${Math.round(s.deliveryRatio * 100)}% 期望值）`,
    );
  }
  console.log('');
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
  return width;
}

function toMarkdown(rows, knee, meta) {
  const head =
    '| 并发 | 加入成功 | join p95 (ms) | 光标 p95 (ms) | op ack p95 (ms) | op 广播 p95 (ms) | 投递事件/s | 投递/期望 | 失败率 | 掉线 | 服务端 CPU | RSS (MB) | Redis 命令/s | PG 活跃连接 | 判定 |\n' +
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n';
  const body = rows
    .map(
      (row) =>
        `| ${row.level} | ${row.joined}/${row.requested} | ${fmtMs(row.join.p95)} | ${fmtMs(row.cursor.p95)} | ${fmtMs(row.ack.p95)} | ${fmtMs(row.apply.p95)} | ${row.deliveredPerSec} | ${row.deliveryRatio === null ? '—' : `${Math.round(row.deliveryRatio * 100)}%`} | ${fmtPct(row.errorRate)} | ${row.unexpectedDisconnects} | ${row.server.cpuPct === null ? '—' : `${row.server.cpuPct}%`} | ${row.server.rssPeakMb ?? '—'} | ${row.redis.cmdsPerSec ?? '—'} | ${row.pg.appActivePeak}/${row.pg.poolMax} | ${row.verdict.status} |`,
    )
    .join('\n');

  const notes = [
    '',
    `- 目标：\`${meta.base}\`；机器 ${meta.cores}C / ${meta.totalMemGb}GB；每档预热 ${meta.warmup}s + 测量 ${meta.duration}s`,
    `- 负载：每端光标 ${meta.cursorHz}Hz + op ${meta.opHz}Hz（op data ≈ ${meta.opBytes}B），共 ${meta.levels.join(' / ')} 档`,
    knee.firstFailingLevel === null
      ? '- 拐点：本次所测档位内全部 PASS'
      : `- 拐点：**${knee.firstFailingLevel}** 并发起未 PASS（${knee.firstFailingReasons.join('；')}）`,
    knee.throughputSaturation
      ? `- 吞吐饱和：${knee.throughputSaturation.from} → ${knee.throughputSaturation.to} 时供给 ×${knee.throughputSaturation.offeredGrowth}，投递仅 ×${knee.throughputSaturation.deliveredGrowth}（${knee.throughputSaturation.to} 档实际投递为期望值的 ${Math.round(knee.throughputSaturation.deliveryRatio * 100)}%）`
      : '- 吞吐：所测档位内仍随供给增长',
    `- 判定阈值：join p95 ≤ ${THRESHOLDS.joinP95Ms}ms、光标 p95 ≤ ${THRESHOLDS.cursorP95Ms}ms、ack p95 ≤ ${THRESHOLDS.ackP95Ms}ms、广播 p95 ≤ ${THRESHOLDS.applyP95Ms}ms、失败率 ≤ ${THRESHOLDS.errorRatePct}%、服务端 CPU ≤ ${THRESHOLDS.cpuPct}%`,
  ].join('\n');

  return `${head}${body}\n${notes}\n`;
}

/* -------------------------------------------------------------------------- */
/* 准备 / 清理                                                                 */
/* -------------------------------------------------------------------------- */

async function prepareTarget(http, opts) {
  if (ARGS.board && ARGS.shareToken) {
    return { boardId: ARGS.board, shareToken: ARGS.shareToken, owner: null };
  }

  const email = `loadtest.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`;
  const register = await http.request('POST', '/api/auth/register', {
    email,
    password: PASSWORD,
    displayName: '压测账号',
  });
  if (register.status !== 201) {
    throw new Error(`注册压测账号失败 ${register.status}: ${JSON.stringify(register.json)}`);
  }

  const created = await http.request('POST', '/api/boards', { title: '压测板（可删除）' });
  if (created.status !== 201) {
    throw new Error(`创建压测白板失败 ${created.status}: ${JSON.stringify(created.json)}`);
  }
  const boardId = created.json.id;

  const share = await http.request('POST', `/api/boards/${boardId}/share-links`, {
    permission: 'edit',
    expiresInDays: 1,
  });
  if (share.status !== 201) {
    throw new Error(`创建分享链接失败 ${share.status}: ${JSON.stringify(share.json)}`);
  }

  return { boardId, shareToken: share.json.token, owner: { email, userId: register.json.id } };
}

async function cleanup() {
  ARGS_META.measuring = false;
  for (const client of sharedState.clients) {
    for (const timer of [client.cursorTimer, client.opTimer]) {
      if (timer) clearTimeout(timer);
    }
    try {
      client.socket.removeAllListeners();
      client.socket.disconnect();
    } catch {
      // ignore
    }
  }
  sharedState.clients = [];

  const boardId = sharedState.boardId;
  const info = sharedState.cleanup;

  if (sharedState.redis && boardId && info?.owner) {
    // 只清理本次压测自己建的板；--board 复用的真实白板不动它的 seq / 幂等键
    try {
      const idemKeys = [];
      let cursor = '0';
      do {
        const [next, keys] = await sharedState.redis.scan(cursor, 'MATCH', `idem:${boardId}:*`, 'COUNT', 200);
        cursor = next;
        idemKeys.push(...keys);
      } while (cursor !== '0');
      if (idemKeys.length > 0) await sharedState.redis.del(...idemKeys);
      await sharedState.redis.del(`seq:${boardId}`);
      await sharedState.redis.zrem('dirty:boards', boardId);
    } catch (err) {
      console.warn(`[cleanup] 清理 Redis 残留失败：${err.message}`);
    }
  }

  if (info?.owner && !ARGS.keep) {
    try {
      const res = await info.http.request('DELETE', '/api/auth/me', { currentPassword: PASSWORD });
      if (res.status !== 200) {
        console.warn(`[cleanup] 注销压测账号失败 ${res.status}：${JSON.stringify(res.json)}`);
      }
    } catch (err) {
      console.warn(`[cleanup] 注销压测账号异常：${err.message}`);
    }
  }

  if (sharedState.redis) {
    try {
      sharedState.redis.disconnect();
    } catch {
      // ignore
    }
  }
  if (sharedState.pgPool) {
    try {
      await sharedState.pgPool.end();
    } catch {
      // ignore
    }
  }
  if (sharedState.processSampler) {
    try {
      sharedState.processSampler.stop();
    } catch {
      // ignore
    }
    sharedState.processSampler = null;
  }
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const port = Number(new URL(ARGS.base).port || (ARGS.base.startsWith('https') ? 443 : 80));
  const http = new HttpClient('loadtest');
  sharedState.http = http;

  console.log('[1/5] 检查目标服务…');
  const health = await http.request('GET', '/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    throw new Error(`目标 ${ARGS.base} 不可用（先 npm run dev 或 npm run dev:server）`);
  }
  console.log(`      ${health.json?.service ?? 'unknown'} / instance=${health.json?.instance ?? '?'}`);

  const serverPid = ARGS.serverPid ?? (await detectServerPid(port));
  if (serverPid) {
    sharedState.processSampler = startProcessSampler(serverPid);
    console.log(
      sharedState.processSampler
        ? `[2/5] 被测进程 pid=${serverPid}（常驻采样 CPU / RSS）`
        : `[2/5] 被测进程 pid=${serverPid}，但当前平台无法采样 CPU / RSS`,
    );
  } else {
    console.log('[2/5] 未探测到被测进程 pid，跳过服务端 CPU/RSS（可用 --server-pid 指定）');
  }

  console.log('[3/5] 准备 Redis / Postgres 采样连接…');
  if (process.env.REDIS_URL) {
    sharedState.redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    sharedState.redis.on('error', () => undefined);
  }
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL.replace('@localhost:', '@127.0.0.1:');
    sharedState.pgPool = new Pool({ connectionString: url, max: 2, application_name: 'whiteboard-loadtest' });
    sharedState.pgPool.on('error', () => undefined);
  }

  const target = await prepareTarget(http, {});
  sharedState.boardId = target.boardId;
  sharedState.shareToken = target.shareToken;
  sharedState.cleanup = { ...target, http };
  console.log(`[4/5] 测试板 ${target.boardId}（编辑分享链接已签发）`);

  const runId = Math.random().toString(36).slice(2, 6);
  const results = [];
  for (const level of ARGS.levelList) {
    process.stdout.write(`[5/5] ${level} 并发…`);
    const row = await runLevel(level, {
      boardId: target.boardId,
      shareToken: target.shareToken,
      serverPid,
      runId,
      level,
    });
    results.push(row);
    console.log(
      ` 加入 ${row.joined}/${row.requested} / 光标 p95 ${fmtMs(row.cursor.p95)}ms / ack p95 ${fmtMs(row.ack.p95)}ms / ${row.verdict.status}`,
    );
    // 档位之间留一点冷却，让上一档的 disconnect / 广播彻底收尾
    await wait(1200);
  }

  const knee = findKnee(results);
  const meta = {
    base: ARGS.base,
    cores: os.cpus().length,
    totalMemGb: round(os.totalmem() / 1024 / 1024 / 1024, 1),
    levels: ARGS.levelList,
    warmup: ARGS.warmup,
    duration: ARGS.duration,
    cursorHz: ARGS.cursorHz,
    opHz: ARGS.opHz,
    opBytes: ARGS.opBytes,
    thresholds: THRESHOLDS,
  };

  printResults(results, knee, meta);

  fs.mkdirSync(ARGS.out, { recursive: true });
  const base = path.join(ARGS.out, `realtime-${nowStamp()}`);
  const payload = { meta, knee, results, env: { node: process.version, platform: process.platform } };
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, toMarkdown(results, knee, meta));
  console.log(`结果已写入 ${path.relative(REPO_ROOT, `${base}.json`)} / .md`);

  await cleanup();
  console.log('已清理：socket 全部断开、分享链接随账号级联删除、Redis seq/idem/dirty 残留已清。');
}

process.on('SIGINT', () => {
  if (sharedState.stopping) return;
  sharedState.stopping = true;
  console.log('\n收到中断，正在清理…');
  void cleanup().then(() => process.exit(130));
});

main().catch(async (err) => {
  console.error(`压测失败：${err?.stack ?? err}`);
  await cleanup();
  process.exit(1);
});
