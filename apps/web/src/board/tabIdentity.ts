/**
 * M3：每标签的身份标识与"复制标签页"检测。
 *
 * 背景
 * - `tabId` 存在 **sessionStorage**（每标签一份）。浏览器"复制标签页"会把 sessionStorage
 *   一起复制，于是两个标签拿到同一个 `tabId`；而 `BroadcastChannel` 是浏览器级共享的，
 *   正好可以用来发现重复。
 * - `guestId` 存在 **cookie**（`wb_gid`，浏览器级共享）。同一浏览器的标签因此聚合为一个用户，
 *   presence 显示 "×2 标签页"；这是设计特性，不是隔离失败（见开发文档 §6.2）。
 *
 * 检测协议（频道 `wb-handshake`）：
 * 1. 启动时读取 sessionStorage 的 `wb:tabId`，没有则生成；
 * 2. 广播 `{type:'hello', boardId, tabId, nonce, bootedAt}`（nonce 每次页面加载一份，用于区分"哪一次加载"）；
 * 3. 收到**同 tabId、不同 nonce** 的 hello：
 *    - 页面加载更晚的一方（`bootedAt` 更大，平局比 nonce）重新生成 tabId；
 *    - 更早的一方回复 `{type:'duplicate', toNonce}`，让新标签立即重新生成，而不是干等 200ms；
 * 4. 重新生成后把新 tabId 写回 sessionStorage 并再广播一次 hello；
 * 5. 频道在整个页面生命周期内保持打开：老标签继续响应后出现的复制标签。
 *
 * 说明：`BroadcastChannel` 不可用时无法检测，退化为"信任 sessionStorage"（单标签正常，复制标签会撞 tabId），
 * 该降级会在返回值 `supported=false` 中标注，并写进开发文档 §6。
 */

export const TAB_ID_KEY = "wb:tabId";
export const GUEST_COOKIE = "wb_gid";
export const HANDSHAKE_CHANNEL = "wb-handshake";

export type TabFingerprint = { bootedAt: number; nonce: string };

/**
 * 纯判定：收到同 tabId 的另一份 hello 时，**当前标签**是否应该重新生成。
 * 规则：更晚加载的一方让路（平局按 nonce 字典序，保证双方判定一致）。
 */
export function shouldRegenerateTabId(self: TabFingerprint, peer: TabFingerprint): boolean {
  if (self.bootedAt !== peer.bootedAt) return self.bootedAt > peer.bootedAt;
  return self.nonce > peer.nonce;
}

export type TabHandshakeEvent = {
  at: number;
  type: "hello" | "duplicate" | "regenerated";
  tabId: string;
  peerTabId?: string;
  peerNonce?: string;
};

export type TabIdentity = {
  tabId: string;
  guestId: string;
  bootedAt: number;
  nonce: string;
  /** 本次启动是否因重复而重新生成过 tabId */
  regenerated: boolean;
  /** 是否支持 BroadcastChannel 检测 */
  supported: boolean;
  /** 检测日志（验收用） */
  events: TabHandshakeEvent[];
  /** 保持频道打开，供运行期检测/停止时释放 */
  dispose: () => void;
};

type HandshakeMessage =
  | { type: "hello"; boardId: string; tabId: string; nonce: string; bootedAt: number; toNonce?: string }
  | { type: "duplicate"; boardId: string; tabId: string; toNonce: string; fromTabId?: string };

const randomId = (prefix: string): string => {
  const uuid = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14);
  return `${prefix}_${uuid}`.replace(/[^A-Za-z0-9_-]/g, "");
};

/**
 * 每次**页面加载**一份的指纹（模块作用域天然是每标签独立，不是跨标签单例）。
 * 放在模块级别而不是每次 `resolveTabIdentity` 生成，是为了让同一页面内的多次调用
 * （React StrictMode 双执行、调试重检）互相识别为"自己"，避免误判成复制标签。
 */
const PAGE_BOOTED_AT = Date.now();
const PAGE_NONCE = randomId("n");

function safeSessionGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* 隐私模式/禁用存储：只能用内存态，刷新会丢，但不会阻塞白板 */
  }
}

function readCookie(name: string): string | null {
  try {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 浏览器级游客标识：整块浏览器共享，多标签聚合为一个用户。
 * 未签名，服务端按"自报身份"处理（与 M2 的鉴权缺口边界一致，见开发文档 §7.2.1）。
 */
export function ensureGuestId(): string {
  const existing = readCookie(GUEST_COOKIE);
  if (existing && /^[A-Za-z0-9_-]{4,64}$/.test(existing)) return existing;
  const guestId = randomId("g");
  try {
    document.cookie = `${GUEST_COOKIE}=${encodeURIComponent(guestId)}; path=/; max-age=${365 * 24 * 3600}; SameSite=Lax`;
  } catch {
    /* ignore */
  }
  return guestId;
}

async function resolveTabIdentityCore(options: {
  boardId: string;
  handshakeMs?: number;
  now?: () => number;
}): Promise<TabIdentity> {
  const { boardId } = options;
  const now = options.now ?? (() => Date.now());
  const handshakeMs = options.handshakeMs ?? 200;

  const bootedAt = PAGE_BOOTED_AT;
  const nonce = PAGE_NONCE;
  let tabId = safeSessionGet(TAB_ID_KEY) ?? randomId("tab");
  safeSessionSet(TAB_ID_KEY, tabId);

  const events: TabHandshakeEvent[] = [];
  let regenerated = false;
  let disposed = false;

  const supported = typeof BroadcastChannel !== "undefined";
  if (!supported) {
    return {
      tabId,
      guestId: ensureGuestId(),
      bootedAt,
      nonce,
      regenerated: false,
      supported: false,
      events,
      dispose: () => undefined,
    };
  }

  const channel = new BroadcastChannel(HANDSHAKE_CHANNEL);
  const post = (message: HandshakeMessage) => {
    if (disposed) return;
    try {
      channel.postMessage(message);
    } catch {
      /* channel 已关闭 */
    }
  };

  const regenerate = (peer: { tabId: string; nonce: string }) => {
    const previous = tabId;
    tabId = randomId("tab");
    safeSessionSet(TAB_ID_KEY, tabId);
    regenerated = true;
    events.push({ at: now(), type: "regenerated", tabId, peerTabId: peer.tabId, peerNonce: peer.nonce });
    console.info(`[tab] 检测到重复 tabId=${previous}（对端 nonce=${peer.nonce}），已重新生成为 ${tabId}`);
    post({ type: "hello", boardId, tabId, nonce, bootedAt });
  };

  channel.onmessage = (event: MessageEvent<HandshakeMessage>) => {
    const message = event.data;
    if (!message || message.boardId !== boardId) return;

    if (message.type === "hello") {
      if (message.toNonce && message.toNonce !== nonce) return;
      if (message.tabId !== tabId || message.nonce === nonce) return;

      events.push({
        at: now(),
        type: "hello",
        tabId,
        peerTabId: message.tabId,
        peerNonce: message.nonce,
      });

      if (shouldRegenerateTabId({ bootedAt, nonce }, { bootedAt: message.bootedAt, nonce: message.nonce })) {
        regenerate({ tabId: message.tabId, nonce: message.nonce });
      } else {
        // 对端更晚加载：明确告诉它"让路"，避免它等满 200ms
        post({ type: "duplicate", boardId, tabId, toNonce: message.nonce, fromTabId: tabId });
      }
      return;
    }

    if (message.type === "duplicate" && message.toNonce === nonce && message.tabId === tabId) {
      events.push({ at: now(), type: "duplicate", tabId, peerTabId: message.fromTabId, peerNonce: message.toNonce });
      regenerate({ tabId: message.tabId, nonce: message.toNonce });
    }
  };

  post({ type: "hello", boardId, tabId, nonce, bootedAt });
  await new Promise<void>((resolve) => setTimeout(resolve, handshakeMs));

  return {
    tabId,
    guestId: ensureGuestId(),
    bootedAt,
    nonce,
    regenerated,
    supported: true,
    events,
    dispose: () => {
      disposed = true;
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    },
  };
}

type SharedEntry = { promise: Promise<TabIdentity>; refs: number };

/**
 * 同页面并发调用（React StrictMode 会把 effect 跑两遍）共享同一次握手，
 * 避免同一标签开两个频道、对着同一个对端重复触发生成 tabId。
 * 频道按引用计数释放：最后一个使用者 `dispose()` 时才真正关闭。
 */
const sharedHandshakes = new Map<string, SharedEntry>();

export function resolveTabIdentity(options: {
  boardId: string;
  handshakeMs?: number;
  now?: () => number;
}): Promise<TabIdentity> {
  const key = options.boardId;
  let entry = sharedHandshakes.get(key);
  if (!entry) {
    const promise = resolveTabIdentityCore(options);
    const created: SharedEntry = { promise, refs: 0 };
    sharedHandshakes.set(key, created);
    void promise.finally(() => {
      // 握手完成后不再复用结果：运行期 recheck 必须重新走一次握手。
      // 已持有结果的调用者仍通过 `created` 引用自行 dispose。
      if (sharedHandshakes.get(key) === created) sharedHandshakes.delete(key);
    });
    entry = created;
  }

  const current = entry;
  current.refs += 1;

  return current.promise.then((identity) => ({
    ...identity,
    dispose: () => {
      current.refs -= 1;
      if (current.refs <= 0) {
        identity.dispose();
        if (sharedHandshakes.get(key) === current) sharedHandshakes.delete(key);
      }
    },
  }));
}

