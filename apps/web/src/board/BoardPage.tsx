import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ElementOp } from "@whiteboard/shared";
import { BoardCanvas, type BoardCanvasHandle } from "../canvas/BoardCanvas";
import type { CollabSnapshot } from "../collab/BoardCollab";
import { createBoardStore, type BoardStore, type BoardStoreSnapshot } from "./createBoardStore";
import { loadBoardScene, type BoardScene } from "./loadScene";

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
  const storeRef = useRef<BoardStore | null>(null);
  const [scene, setScene] = useState<BoardScene | null>(null);
  const [storeState, setStoreState] = useState<BoardStoreSnapshot | null>(null);
  const timingRef = useRef<BoardTiming>({ startedAt: performance.now() });

  // 最小只读入口：`?view=1`（也接受 `?readonly=1`），join 时向服务端声明 viewOnly。
  // 真正的分享 token 尚未实现，因此这只是「自报只读」，可信度边界见开发文档 §7.2.2。
  const queryViewOnly = readOnlyQuery();
  const collabState = storeState?.collab ?? null;
  const requestedViewOnly =
    queryViewOnly ||
    (collabState?.viewOnly ?? false) ||
    (collabState?.role ?? "unknown") === "viewer";

  useEffect(() => {
    let alive = true;
    setScene(null);
    setStoreState(null);
    void loadBoardScene(boardId, {
      // M3：冷启动快照只有 Web Locks 写者才落盘
      canWriteCache: () => storeRef.current?.snapshot().writer.isWriter ?? false,
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

  // 先让缓存/快照内容渲染出来，再创建 per-tab/per-board store（内部先做 tabId 握手，再连 Socket）
  useEffect(() => {
    const store = createBoardStore({
      boardId,
      viewOnly: queryViewOnly,
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
  }, [boardId, queryViewOnly]);

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
        })) ?? [],
      opBatches: [],
      lastOps: () => hook.opBatches[hook.opBatches.length - 1] ?? [],
      collab: () => storeRef.current?.snapshot().collab ?? null,
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
      <div style={{ display: "grid", placeItems: "center", height: "100vh", fontFamily: "system-ui, sans-serif", color: "#6B5A60" }}>
        正在加载白板 {boardId}…
      </div>
    );
  }

  const status = collabState?.status ?? "connecting";
  const role = collabState?.role ?? "unknown";
  const readonly = requestedViewOnly;
  const presence = collabState?.presence ?? null;
  const cursors = collabState?.cursors ?? [];
  const writer = storeState?.writer;
  const tab = storeState;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid #EADDE2",
          background: "#FFF9FB",
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          color: "#6B5A60",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ color: "#A85C7C" }}>白板</strong>
        <code data-testid="board-id" style={{ color: "#8E4568" }}>{boardId}</code>
        {readonly ? (
          <span data-testid="readonly-badge" style={{ color: "#8E4568", border: "1px solid #E7BFCE", borderRadius: 999, padding: "1px 8px", fontSize: 11 }}>
            只读
          </span>
        ) : null}
        <span data-testid="collab-status" style={{ fontSize: 12, color: status === "connected" ? "#4E8A68" : "#A86A4E" }}>
          {status} · {role}
        </span>
        {collabState && collabState.queuedOps > 0 ? (
          <span data-testid="queued-ops" style={{ fontSize: 12, color: "#A86A4E" }}>
            待补发 {collabState.queuedOps} op
          </span>
        ) : null}
        {collabState && collabState.synced ? (
          <span data-testid="sync-state" style={{ fontSize: 12, color: "#4E8A68" }}>
            已对齐 seq={collabState.cacheSeq ?? 0}
          </span>
        ) : null}
        {tab ? (
          <span data-testid="tab-id" title={`guestId=${tab.guestId}`} style={{ fontSize: 11, color: "#8E4568", border: "1px dashed #E7BFCE", borderRadius: 6, padding: "1px 6px" }}>
            tab {shortId(tab.tabId)}{tab.tabRegenerated ? " · 已重生成" : ""}
          </span>
        ) : null}
        {writer ? (
          <span
            data-testid="cache-writer"
            data-is-writer={writer.isWriter ? "1" : "0"}
            style={{ fontSize: 11, color: writer.isWriter ? "#4E8A68" : "#A86A4E" }}
          >
            {writer.mode === "web-locks" ? "Web Locks" : writer.mode === "broadcast-fallback" ? "降级选举" : "单写者"}
            ：{writer.isWriter ? "缓存写者" : "只读缓存"}
          </span>
        ) : null}
        {/* presence：按用户聚合，一个用户一个头像 + ×N 标签页 */}
        {presence?.users.map((user) => (
          <span
            key={user.identity}
            data-testid="presence-user"
            data-identity={user.identity}
            data-connections={user.connectionCount}
            title={`${user.identity} · ${user.role}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              border: "1px solid #EADDE2",
              borderRadius: 999,
              padding: "1px 8px 1px 4px",
              background: "#fff",
            }}
          >
            <i style={{ width: 14, height: 14, borderRadius: "50%", background: user.color, display: "inline-block" }} />
            <span style={{ fontSize: 11 }}>{user.identity === collabState?.identity ? "我" : shortId(user.identity)}</span>
            {user.connectionCount > 1 ? (
              <b data-testid="presence-tab-count" style={{ fontSize: 11, color: "#8E4568" }}>
                ×{user.connectionCount} 标签页
              </b>
            ) : null}
          </span>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 12 }}>
          {scene.source === "cache"
            ? `本地缓存 ${Math.round(scene.loadMs)}ms · seq=${scene.seq}`
            : scene.source === "snapshot"
              ? `服务端快照 · seq=${scene.seq}`
              : "空场景"}
        </span>
      </header>
      <div
        style={{ position: "relative", flex: 1 }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          storeRef.current?.sendCursor(
            clamp01((event.clientX - rect.left) / rect.width),
            clamp01((event.clientY - rect.top) / rect.height),
          );
        }}
      >
        <BoardCanvas
          initialElements={scene.elements}
          viewModeEnabled={readonly}
          onApiReady={(api, handle) => {
            apiRef.current = api;
            bridgeRef.current = handle;
            timingRef.current.canvasReadyAt = performance.now();
            storeRef.current?.notifyCanvasReady();
            if (window.__board) window.__board.ready = true;
          }}
          onOps={(ops) => {
            window.__board?.opBatches.push(ops);
            storeRef.current?.submit(ops);
          }}
        />
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
