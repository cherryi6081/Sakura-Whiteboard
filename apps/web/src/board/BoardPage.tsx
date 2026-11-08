import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ElementOp } from "@whiteboard/shared";
import { BoardCanvas, type BoardCanvasHandle } from "../canvas/BoardCanvas";
import { createBoardCollab, type BoardCollab, type CollabSnapshot } from "../collab/BoardCollab";
import { cacheDebugInfo, clearQueuedOps, enqueueOps, getCachedSeq, listQueuedOps, removeQueuedOps, writeCachedScene } from "../store/cacheDb";
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
  /** C5：首帧来源与各阶段耗时（缓存先行验收） */
  sceneSource: () => BoardScene["source"];
  timing: BoardTiming;
  /** C5：IndexedDB 结构/复合键/localStorage 断言 */
  cache: () => ReturnType<typeof cacheDebugInfo>;
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
  const collabRef = useRef<BoardCollab | null>(null);
  const [scene, setScene] = useState<BoardScene | null>(null);
  const [collabState, setCollabState] = useState<CollabSnapshot | null>(null);
  const timingRef = useRef<BoardTiming>({ startedAt: performance.now() });

  // 最小只读入口：`?view=1`（也接受 `?readonly=1`），join 时向服务端声明 viewOnly。
  // 真正的分享 token 尚未实现，因此这只是「自报只读」，可信度边界见开发文档 §7.2.2。
  const requestedViewOnly =
    readOnlyQuery() ||
    (collabState?.viewOnly ?? false) ||
    (collabState?.role ?? "unknown") === "viewer";

  useEffect(() => {
    let alive = true;
    setScene(null);
    void loadBoardScene(boardId).then((loaded) => {
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

  // 先让缓存/快照内容渲染出来，再开始连接与补拉（保证"缓存先行"的顺序）
  useEffect(() => {
    if (!scene) return;
    const collab = createBoardCollab({
      boardId,
      viewOnly: readOnlyQuery(),
      cache: {
        getSeq: getCachedSeq,
        writeScene: writeCachedScene,
        enqueue: enqueueOps,
        listQueued: listQueuedOps,
        removeQueued: removeQueuedOps,
        clearQueue: clearQueuedOps,
      },
      getBridge: () => bridgeRef.current,
      onChange: (snapshot) => {
        const timing = timingRef.current;
        if (snapshot.joined && timing.joinedAt === undefined) timing.joinedAt = performance.now();
        if (snapshot.synced && timing.syncedAt === undefined) timing.syncedAt = performance.now();
        setCollabState(snapshot);
      },
    });
    collabRef.current = collab;
    collab.start();
    return () => {
      collab.stop();
      collabRef.current = null;
    };
  }, [boardId, scene]);

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
      collab: () => collabRef.current?.snapshot() ?? null,
      sceneSource: () => scene?.source ?? "placeholder",
      timing: timingRef.current,
      cache: () => cacheDebugInfo(boardId),
      syncNow: () => collabRef.current?.syncNow(),
      socketDisconnect: () => collabRef.current?.debugDisconnect(),
      socketConnect: () => collabRef.current?.debugConnect(),
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
        <span style={{ marginLeft: "auto", fontSize: 12 }}>
          {scene.source === "cache"
            ? `本地缓存 ${Math.round(scene.loadMs)}ms · seq=${scene.seq}`
            : scene.source === "snapshot"
              ? `服务端快照 · seq=${scene.seq}`
              : "空场景"}
        </span>
      </header>
      <div style={{ position: "relative", flex: 1 }}>
        <BoardCanvas
          initialElements={scene.elements}
          viewModeEnabled={readonly}
          onApiReady={(api, handle) => {
            apiRef.current = api;
            bridgeRef.current = handle;
            timingRef.current.canvasReadyAt = performance.now();
            collabRef.current?.notifyCanvasReady();
            if (window.__board) window.__board.ready = true;
          }}
          onOps={(ops) => {
            window.__board?.opBatches.push(ops);
            collabRef.current?.submit(ops);
          }}
        />
      </div>
    </div>
  );
}

function readOnlyQuery(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "1" || params.get("readonly") === "1";
}
