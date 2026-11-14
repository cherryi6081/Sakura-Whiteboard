import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ElementOp } from "@whiteboard/shared";
import { BoardCanvas, type BoardCanvasHandle } from "../canvas/BoardCanvas";
import type { CollabSnapshot } from "../collab/BoardCollab";
import { GuestBadge, SaveToAccountBanner } from "../auth/GuestBadge";
import { recordRecentBoard, titleOf } from "../boards/recentBoards";
import { markBoardOpened } from "../boards/boardsApi";
import { captureBoardThumb, scheduleThumbCapture } from "../boards/boardThumb";
import { IconAlert, IconBack, IconCopy, IconImage, IconLock, IconShare } from "../ui/icons";
import { ShareDrawer } from "./ShareDrawer";
import { createBoardStore, type BoardStore, type BoardStoreSnapshot } from "./createBoardStore";
import { loadBoardScene, type BoardScene } from "./loadScene";
import { useImageUpload } from "./useImageUpload";

type SceneElementSummary = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  x: number;
  y: number;
  isDeleted: boolean;
};

type BoardTiming = {
  startedAt: number;
  sceneReadyAt?: number;
  cacheLoadMs?: number;
  canvasReadyAt?: number;
  joinedAt?: number;
  syncedAt?: number;
};

type BoardWindow = {
  boardId: string;
  sceneIds: () => string[];
  sceneElements: () => SceneElementSummary[];
  ready: boolean;
  /** C2 起可用：已 flush 的 op 批次，用于验收"拖一次 = 1 条 upsert" */
  opBatches: ElementOp[][];
  lastOps: () => ElementOp[];
  /** C4：协作连接/角色/队列的实时快照 */
  collab: () => CollabSnapshot | null;
  /** v1.1：画布已装载的图片文件 id（= assets.id），用于验收"对端拿到字节" */
  files: () => string[];
  /** v1.1：文件装载详情（mime / dataURL 长度），用于排查破图 */
  fileInfo: () => Array<{ id: string; mime: string; dataUrlLength: number }>;
  /** M3：tabId / guestId / Web Locks 写者 / 失效通知 / presence / 光标 */
  store: () => BoardStoreSnapshot | null;
  tab: () => {
    tabId: string;
    guestId: string;
    supported: boolean;
    regenerated: boolean;
    retiredConnections: number;
    events: BoardStoreSnapshot["tabEvents"];
  } | null;
  writer: () => (BoardStoreSnapshot["writer"] & { idbName?: string }) | null;
  presence: () => NonNullable<CollabSnapshot["presence"]> | null;
  cursors: () => NonNullable<CollabSnapshot["cursors"]>;
  invalidations: () => BoardStoreSnapshot["invalidation"] | null;
  /** M3：运行期重新握手（复制标签检测；返回是否重生成与检测日志） */
  recheckTabIdentity: () => Promise<{
    previous: string | null;
    tabId: string;
    changed: boolean;
    regenerated: boolean;
    events: BoardStoreSnapshot["tabEvents"];
  }> | null;
  /** C5：首帧来源与各阶段耗时（缓存先行验收） */
  sceneSource: () => BoardScene["source"];
  timing: BoardTiming;
  /** C5：IndexedDB 结构/复合键/localStorage 断言 */
  cache: () => ReturnType<BoardStore["cacheInfo"]>;
  syncNow: () => void;
  socketDisconnect: () => void;
  socketConnect: () => void;
};

declare global {
  interface Window {
    __board?: BoardWindow;
  }
}

export function BoardPage({ boardId }: { boardId: string }) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const bridgeRef = useRef<BoardCanvasHandle | null>(null);
  /** 首帧缩略图每次进板只排一次（画布 API 可能因 StrictMode 重放两次） */
  const thumbScheduledRef = useRef(false);
  /** 编辑后的重拍防抖：连续落笔只在停笔后导出一次 */
  const thumbRefreshTimerRef = useRef<number | null>(null);
  const storeRef = useRef<BoardStore | null>(null);
  const [scene, setScene] = useState<BoardScene | null>(null);
  const [storeState, setStoreState] = useState<BoardStoreSnapshot | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(() => readBannerDismissed());
  const [shareOpen, setShareOpen] = useState(false);
  const [title] = useState(() => titleOf(boardId) ?? "未命名白板");
  const timingRef = useRef<BoardTiming>({ startedAt: performance.now() });

  // 最小只读入口：`?view=1`（也接受 `?readonly=1`），join 时向服务端声明 viewOnly。
  // 真正的分享权限由服务端按 token 判定（M5-2）；`?share=` 的 token 会在 REST/WS 一起带上。
  const queryViewOnly = readOnlyQuery();
  const shareToken = readShareQuery();
  const collabState = storeState?.collab ?? null;
  const requestedViewOnly =
    queryViewOnly ||
    (collabState?.viewOnly ?? false) ||
    (collabState?.role ?? "unknown") === "viewer";
  const readonly = requestedViewOnly;
  const isGuest = storeState?.authenticated === false;
  const user = storeState?.user ?? null;

  /** 只有登录且非只读才展示上传入口；服务端还会独立校验一次（Q5） */
  const canUpload = !readonly && !isGuest && Boolean(user);

  const pickerRef = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const uploads = useImageUpload({
    boardId,
    shareToken,
    canUpload,
    blockedMessage: readonly ? "只读白板上不能上传图片" : "登录后才能上传图片",
    onBlocked: notify,
    onUploaded: (asset, dataUrl, point) => {
      bridgeRef.current?.insertImage(asset, dataUrl, point);
    },
  });

  const dismissBanner = () => {
    setBannerDismissed(true);
    try {
      sessionStorage.setItem(BANNER_KEY, "1");
    } catch {
      /* sessionStorage 不可用时仅本次生效 */
    }
  };

  useEffect(() => {
    let alive = true;
    thumbScheduledRef.current = false;
    setScene(null);
    setStoreState(null);
    void loadBoardScene(boardId, {
      // M3：冷启动快照只有 Web Locks 写者才落盘
      canWriteCache: () => storeRef.current?.snapshot().writer.isWriter ?? false,
      shareToken,
    }).then((loaded) => {
      if (!alive) return;
      const timing = timingRef.current;
      timing.cacheLoadMs = loaded.loadMs;
      timing.sceneReadyAt = performance.now();
      setScene(loaded);
    });
    return () => {
      alive = false;
    };
  }, [boardId]);

  useEffect(() => {
    recordRecentBoard({ id: boardId, title });
    // 打开次数：列表容量 15 的淘汰排序依据；fire-and-forget，不阻塞首帧
    markBoardOpened(boardId);
  }, [boardId, title]);

  // 先让缓存/快照内容渲染出来，再创建 per-tab/per-board store（内部先做 tabId 握手，再连 Socket）
  useEffect(() => {
    const store = createBoardStore({
      boardId,
      viewOnly: queryViewOnly,
      shareToken,
      getBridge: () => bridgeRef.current,
      onChange: (snapshot) => {
        const timing = timingRef.current;
        if (snapshot.collab?.joined && timing.joinedAt === undefined) timing.joinedAt = performance.now();
        if (snapshot.collab?.synced && timing.syncedAt === undefined) timing.syncedAt = performance.now();
        setStoreState(snapshot);
      },
    });
    storeRef.current = store;
    store.start();
    return () => {
      store.stop();
      storeRef.current = null;
    };
  }, [boardId, queryViewOnly, shareToken]);

  /**
   * 编辑后重拍缩略图：本地改动落盘成 op 后防抖一次再导出。
   * 只拍首帧的话，用户画的这一笔永远进不了卡片——下次进板拍到的才是上次的内容，
   * 列表里就总是"上次进入前"的旧图。
   */
  const refreshThumbSoon = useCallback(() => {
    if (thumbRefreshTimerRef.current !== null) window.clearTimeout(thumbRefreshTimerRef.current);
    thumbRefreshTimerRef.current = window.setTimeout(() => {
      thumbRefreshTimerRef.current = null;
      const api = apiRef.current;
      if (api) scheduleThumbCapture(api, boardId, { fast: true });
    }, 50);
  }, [boardId]);

  useEffect(
    () => () => {
      if (thumbRefreshTimerRef.current !== null) {
        window.clearTimeout(thumbRefreshTimerRef.current);
        thumbRefreshTimerRef.current = null;
      }
    },
    [],
  );

  // 页面隐藏/离开（点返回、切标签、刷新）再兜一次：导出是异步的，尽力而为，
  // 正常路径由 refreshThumbSoon 的防抖保证已经写完。
  useEffect(() => {
    const flush = () => {
      const api = apiRef.current;
      if (api) void captureBoardThumb(api, boardId);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [boardId]);

  /**
   * 返回列表前把最新画面写进缩略图再跳转。
   * 只靠编辑后的防抖重拍时，画完立刻点返回会在导出完成前卸载页面，列表还是旧图；
   * 这里等一次拍摄（内容没变时只是一次指纹比对），再走原来的整页导航。
   */
  const leavingRef = useRef(false);
  const handleBack = async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const api = apiRef.current;
    if (!api || leavingRef.current) return;
    event.preventDefault();
    leavingRef.current = true;
    try {
      await captureBoardThumb(api, boardId);
    } finally {
      window.location.href = "/boards";
    }
  };

  useEffect(() => {
    const hook: BoardWindow = {
      boardId,
      ready: false,
      sceneIds: () => apiRef.current?.getSceneElements().map((el) => el.id) ?? [],
      sceneElements: () =>
        apiRef.current?.getSceneElements().map((el) => ({
          id: el.id,
          type: el.type,
          version: el.version,
          versionNonce: el.versionNonce,
          x: el.x,
          y: el.y,
          isDeleted: el.isDeleted,
          fileId: (el as { fileId?: string }).fileId ?? null,
          status: (el as { status?: string }).status ?? null,
        })) ?? [],
      opBatches: [],
      lastOps: () => hook.opBatches[hook.opBatches.length - 1] ?? [],
      collab: () => storeRef.current?.snapshot().collab ?? null,
      files: () => Object.keys(apiRef.current?.getFiles() ?? {}),
      fileInfo: () =>
        Object.values(apiRef.current?.getFiles() ?? {}).map((file) => ({
          id: file.id,
          mime: file.mimeType,
          dataUrlLength: file.dataURL?.length ?? 0,
        })),
      store: () => storeRef.current?.snapshot() ?? null,
      tab: () => {
        const snap = storeRef.current?.snapshot();
        if (!snap) return null;
        return {
          tabId: snap.tabId,
          guestId: snap.guestId,
          supported: snap.tabSupported,
          regenerated: snap.tabRegenerated,
          retiredConnections: snap.retiredConnections,
          events: snap.tabEvents,
        };
      },
      writer: () => storeRef.current?.snapshot().writer ?? null,
      presence: () => storeRef.current?.snapshot().collab?.presence ?? null,
      cursors: () => storeRef.current?.snapshot().collab?.cursors ?? [],
      invalidations: () => storeRef.current?.snapshot().invalidation ?? null,
      recheckTabIdentity: () => storeRef.current?.recheckTabIdentity() ?? null,
      sceneSource: () => scene?.source ?? "placeholder",
      timing: timingRef.current,
      cache: () => {
        const store = storeRef.current;
        if (!store) return Promise.reject(new Error("store not ready")) as never;
        return store.cacheInfo();
      },
      syncNow: () => storeRef.current?.syncNow(),
      socketDisconnect: () => storeRef.current?.debugDisconnect(),
      socketConnect: () => storeRef.current?.debugConnect(),
    };
    window.__board = hook;
    return () => {
      delete window.__board;
    };
  }, [boardId, scene]);

  if (!scene) {
    return (
      <div className="wb-board">
        <div className="wb-board__topbar">
          <a className="wb-board__back" href="/boards" aria-label="返回我的白板">
            <IconBack />
          </a>
          <span className="wb-board__name">正在加载白板…</span>
        </div>
        <div className="wb-board__canvas" style={{ display: "grid", placeItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-3)" }}>
            <span className="wb-spinner wb-spinner--dark" aria-hidden />
            <span className="wb-caption">正在加载白板</span>
            <code className="wb-mono" data-testid="board-id" style={{ color: "var(--text-secondary)" }}>
              {boardId}
            </code>
          </div>
        </div>
      </div>
    );
  }

  const status = collabState?.status ?? "connecting";
  const role = collabState?.role ?? "unknown";
  const presence = collabState?.presence ?? null;
  const cursors = collabState?.cursors ?? [];
  const writer = storeState?.writer;
  const tab = storeState;

  const statusText = status === "connected" ? "已连接" : status === "connecting" ? "连接中" : "离线";
  const statusTone = status === "connected" ? "ok" : status === "connecting" ? "busy" : "bad";
  const users = presence?.users ?? [];
  const shownUsers = users.slice(0, 4);
  const extraUsers = users.length - shownUsers.length;
  const pageHref = window.location.pathname + window.location.search;

  return (
    <div className="wb-board">
      <header className="wb-board__topbar">
        <a className="wb-board__back" href="/boards" aria-label="返回我的白板" data-testid="board-back">
          <IconBack />
        </a>

        <div style={{ minWidth: 0 }}>
          <div className="wb-board__name" title={title}>
            {title}
          </div>
          <div className="wb-board__name-sub wb-mono" data-testid="board-id">
            {boardId}
          </div>
        </div>

        {isGuest && !readonly ? <GuestBadge /> : null}
        {readonly ? (
          <span className="wb-badge wb-badge--readonly" data-testid="readonly-badge">
            <IconLock />
            只读
          </span>
        ) : null}
        {!isGuest && user ? (
          <span className="wb-badge wb-badge--neutral" data-testid="auth-user">
            {user.displayName}
          </span>
        ) : null}

        <div className="wb-board__spacer" />

        {/* presence：一个用户一个头像，多标签用 ×N 标注 */}
        {users.length > 0 ? (
          <div className="wb-avatar-stack" data-testid="presence" aria-label="在线协作者">
            {shownUsers.map((member) => (
              <span
                key={member.identity}
                className="wb-avatar"
                data-testid="presence-user"
                data-identity={member.identity}
                data-connections={member.connectionCount}
                title={`${member.identity} · ${member.role} · ${member.connectionCount} 个标签页`}
                style={{ background: member.color }}
              >
                {member.identity === collabState?.identity ? "我" : shortId(member.identity).slice(-2)}
                {member.connectionCount > 1 ? (
                  <b data-testid="presence-tab-count" style={{ fontSize: 9, marginLeft: 1 }}>
                    ×{member.connectionCount}
                  </b>
                ) : null}
              </span>
            ))}
            {extraUsers > 0 ? <span className="wb-avatar wb-avatar--more">+{extraUsers}</span> : null}
          </div>
        ) : null}

        <span className="wb-board__status" data-testid="collab-status" data-status={status}>
          <span className={`wb-board__dot wb-board__dot--${statusTone}`} aria-hidden />
          <span className="wb-board__status-text">
            {statusText} · {role}
          </span>
        </span>

        {isGuest ? (
          <a className="wb-link" data-testid="header-login" href={`/login?next=${encodeURIComponent(pageHref)}`}>
            登录
          </a>
        ) : null}

        {canUpload ? (
          <>
            <button
              className="wb-btn wb-btn--ghost wb-btn--sm wb-board__image"
              type="button"
              data-testid="image-upload"
              aria-label="插入图片"
              title="插入图片（也可直接粘贴或拖入画布）"
              onClick={() => pickerRef.current?.click()}
            >
              <IconImage />
              <span className="wb-board__share-text">图片</span>
            </button>
            <input
              ref={pickerRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              data-testid="image-input"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                uploads.start(files, null);
              }}
            />
          </>
        ) : null}

        <button
          className="wb-btn wb-btn--primary wb-btn--sm wb-board__share"
          type="button"
          data-testid="share-open"
          aria-label={readonly ? "复制链接" : "分享"}
          title={readonly ? "复制链接" : "分享"}
          onClick={() => {
            if (readonly) {
              void navigator.clipboard.writeText(window.location.href).catch(() => {});
              return;
            }
            setShareOpen(true);
          }}
        >
          {readonly ? <IconCopy /> : <IconShare />}
          <span className="wb-board__share-text">{readonly ? "复制链接" : "分享"}</span>
        </button>
      </header>

      {notice ? (
        <div className="wb-board__notice" role="status" data-testid="image-notice">
          <IconAlert />
          <span>{notice}</span>
        </div>
      ) : null}

      {status === "disconnected" ? (
        <div className="wb-banner wb-banner--warning" role="status" data-testid="offline-banner">
          <IconAlert />
          <span>连接中断，改动会在恢复后同步。</span>
          <span className="wb-banner__spacer" />
          <button className="wb-btn wb-btn--ghost wb-btn--sm" type="button" onClick={() => storeRef.current?.debugConnect()}>
            重试
          </button>
        </div>
      ) : null}

      {isGuest && !readonly && !bannerDismissed ? (
        <SaveToAccountBanner
          onLogin={() => {
            window.location.href = `/login?next=${encodeURIComponent(pageHref)}`;
          }}
          onDismiss={dismissBanner}
        />
      ) : null}

      <div
        className="wb-board__canvas"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          storeRef.current?.sendCursor(
            clamp01((event.clientX - rect.left) / rect.width),
            clamp01((event.clientY - rect.top) / rect.height),
          );
        }}
      >
        <div className="wb-canvas" style={{ height: "100%" }}>
          <BoardCanvas
            initialElements={scene.elements}
            viewModeEnabled={readonly}
            shareToken={shareToken}
            onApiReady={(api, handle) => {
              apiRef.current = api;
              bridgeRef.current = handle;
              timingRef.current.canvasReadyAt = performance.now();
              storeRef.current?.notifyCanvasReady();
              if (window.__board) window.__board.ready = true;
              // 首帧快照：每次进板只排一次，已有快照且内容未改时 captureBoardThumb 内部会跳过
              if (!thumbScheduledRef.current) {
                thumbScheduledRef.current = true;
                scheduleThumbCapture(api, boardId);
              }
            }}
            onOps={(ops) => {
              window.__board?.opBatches.push(ops);
              storeRef.current?.submit(ops);
              // 本地改动才需要更新卡片缩略图；远端回放不产生 op，不会触发
              refreshThumbSoon();
            }}
          />
        </div>

        {uploads.dragActive ? (
          <div className="wb-board__dropzone" data-testid="image-dropzone">
            <span className="wb-board__dropzone-text">松开以上传图片</span>
          </div>
        ) : null}

        {uploads.items.length > 0 ? (
          <div className="wb-upload-tray" data-testid="upload-tray" aria-live="polite">
            {uploads.items.map((item) => (
              <div className="wb-upload-item" key={item.key} data-testid="upload-item" data-state={item.state}>
                {item.state === "uploading" ? <span className="wb-spinner wb-spinner--dark" aria-hidden /> : null}
                <div className="wb-upload-item__body">
                  <div className="wb-upload-item__name" title={item.name}>
                    {item.name}
                  </div>
                  <div className="wb-upload-item__meta">
                    {item.state === "uploading" ? "正在上传…" : item.message ?? "上传失败"}
                  </div>
                </div>
                {item.state === "error" ? (
                  <>
                    <button
                      className="wb-btn wb-btn--ghost wb-btn--sm"
                      type="button"
                      data-testid="upload-retry"
                      onClick={() => uploads.retry(item.key)}
                    >
                      重试
                    </button>
                    <button
                      className="wb-btn wb-btn--ghost wb-btn--sm"
                      type="button"
                      data-testid="upload-dismiss"
                      aria-label="移除"
                      onClick={() => uploads.remove(item.key)}
                    >
                      移除
                    </button>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {/* 远端光标按连接渲染（同一用户的多标签各有一个，位置不合并） */}
        {cursors.map((cursor) => (
          <div
            key={cursor.connectionId}
            data-testid="remote-cursor"
            data-connection={cursor.connectionId}
            data-identity={cursor.identity}
            style={{
              position: "absolute",
              left: `${cursor.x * 100}%`,
              top: `${cursor.y * 100}%`,
              transform: "translate(6px, 6px)",
              pointerEvents: "none",
              display: "flex",
              alignItems: "center",
              gap: 4,
              zIndex: 4,
            }}
          >
            <i
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: cursor.color,
                boxShadow: "0 0 0 2px rgba(255,255,255,.85)",
                display: "inline-block",
              }}
            />
            <span
              style={{
                fontSize: 10,
                color: "#fff",
                background: cursor.color,
                borderRadius: 4,
                padding: "1px 5px",
                whiteSpace: "nowrap",
              }}
            >
              {shortId(cursor.identity)}
              {cursor.tabId ? ` · ${shortId(cursor.tabId)}` : ""}
            </span>
          </div>
        ))}
      </div>

      {/* 状态条：桌面可见，移动端隐藏；同时承载验收用的调试读数 */}
      <footer className="wb-board__statusbar">
        <span className="wb-board__debug">
          {collabState && collabState.queuedOps > 0 ? (
            <span className="wb-board__debug-item" data-testid="queued-ops">
              待补发 {collabState.queuedOps} op
            </span>
          ) : null}
          {collabState && collabState.synced ? (
            <span className="wb-board__debug-item" data-testid="sync-state">
              已对齐 seq={collabState.cacheSeq ?? 0}
            </span>
          ) : null}
          {tab ? (
            <span className="wb-board__debug-item" data-testid="tab-id" title={`guestId=${tab.guestId}`}>
              tab {shortId(tab.tabId)}
              {tab.tabRegenerated ? " · 已重生成" : ""}
            </span>
          ) : null}
          {writer ? (
            <span
              className="wb-board__debug-item"
              data-testid="cache-writer"
              data-is-writer={writer.isWriter ? "1" : "0"}
            >
              {writer.mode === "web-locks" ? "Web Locks" : writer.mode === "broadcast-fallback" ? "降级选举" : "单写者"}：
              {writer.isWriter ? "缓存写者" : "只读缓存"}
            </span>
          ) : null}
        </span>
        <span className="wb-board__statusbar-right">
          <span className="wb-nums">{scene.source === "cache" ? `本地缓存 ${Math.round(scene.loadMs)}ms` : scene.source === "snapshot" ? "服务端快照" : "空场景"}</span>
          <span className="wb-nums">seq {scene.seq}</span>
        </span>
      </footer>

      {shareOpen ? <ShareDrawer boardId={boardId} readonly={readonly} onClose={() => setShareOpen(false)} /> : null}
    </div>
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function shortId(value: string): string {
  const plain = value.includes(":") ? value.split(":").pop() ?? value : value;
  return plain.length <= 8 ? plain : plain.slice(-8);
}

function readOnlyQuery(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "1" || params.get("readonly") === "1";
}

/** M5-2：`/board/:id?share=<token>` 的分享 token；长度上限与 `shareLinks` 校验口径一致。 */
function readShareQuery(): string | null {
  const token = new URLSearchParams(window.location.search).get("share");
  return token && token.length >= 8 && token.length <= 128 ? token : null;
}

const BANNER_KEY = "wb:saveBannerDismissed";

function readBannerDismissed(): boolean {
  try {
    return sessionStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return false;
  }
}
