import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ElementOp } from "@whiteboard/shared";
import { BoardCanvas, type BoardCanvasHandle } from "../canvas/BoardCanvas";
import { EditorToolRail } from "../canvas/EditorToolRail";
import type { CollabSnapshot } from "../collab/BoardCollab";
import { GuestBadge, SaveToAccountBanner } from "../auth/GuestBadge";
import {
  GUEST_OWNER,
  ownerTag,
  recordRecentBoard,
  setActiveOwner,
  titleOf,
  userOwner,
  type RecentOwner,
} from "../boards/recentBoards";
import { markBoardOpened, uploadBoardThumbnail } from "../boards/boardsApi";
import { request } from "../auth/authApi";
import { captureBoardThumb, peekBoardThumb, scheduleThumbCapture } from "../boards/boardThumb";
import { readBoardThumb } from "../store/cacheDb";
import { IconAlert, IconBack, IconCopy, IconImage, IconLibrary, IconLock, IconShare } from "../ui/icons";
import { UserMark } from "../ui/UserMark";
import { ShareDrawer } from "./ShareDrawer";
import { CloudLoadDialog } from "./CloudLoadDialog";
import { createBoardStore, type BoardStore, type BoardStoreSnapshot } from "./createBoardStore";
import { loadBoardScene, type BoardScene } from "./loadScene";
import { resolveBackHref } from "./backTarget";
import { buildCursorLabels } from "./cursorLabels";
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

/** 协作角色在界面上的中文名，与空间切换器保持同一口径 */
const ROLE_TEXT: Record<string, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读",
  unknown: "未知",
};

export function BoardPage({ boardId }: { boardId: string }) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const bridgeRef = useRef<BoardCanvasHandle | null>(null);
  /** 首帧缩略图每次进板只排一次（画布 API 可能因 StrictMode 重放两次） */
  const thumbScheduledRef = useRef(false);
  /** 当前身份标签（`guest` / `user:<id>`）：身份握手完成前为 null，缩略图读写一律跳过 */
  const ownerTagRef = useRef<string | null>(null);
  /** 编辑后的重拍防抖：连续落笔只在停笔后导出一次 */
  const thumbRefreshTimerRef = useRef<number | null>(null);
  const storeRef = useRef<BoardStore | null>(null);
  const [scene, setScene] = useState<BoardScene | null>(null);
  const [storeState, setStoreState] = useState<BoardStoreSnapshot | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(() => readBannerDismissed());
  const [shareOpen, setShareOpen] = useState(false);
  /** 云端载入弹窗（入口在库主菜单「打开…」旁边） */
  const [cloudOpen, setCloudOpen] = useState(false);
  /** 画布 API 提到 state：竖工具条要拿它 setActiveTool（ref 变化不会触发重渲染） */
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  /** 当前工具/工具锁/选中数/素材库侧栏开合：驱动竖工具条高亮与顶栏 Library 胶囊的按下态 */
  const [uiState, setUiState] = useState({ tool: "selection", locked: false, selected: 0, library: false });
  /** 右侧 272 列的折叠：收起后画布回到整宽，偏好写入 localStorage */
  const [inspectorCollapsed, setInspectorCollapsed] = useState(readInspectorCollapsed);
  /** 轮询闭包里读最新的折叠态，避免把整个 interval 跟着状态重建 */
  const inspectorCollapsedRef = useRef(inspectorCollapsed);
  inspectorCollapsedRef.current = inspectorCollapsed;
  /** 上一次轮询看到的编辑态元素 id：只在「开始一次新编辑」时展开面板 */
  const editingIdRef = useRef<string | null>(null);

  const toggleInspector = useCallback(() => {
    setInspectorCollapsed((prev) => {
      writeInspectorCollapsed(!prev);
      return !prev;
    });
  }, []);

  // 宽度变化后让库重算画布尺寸（滚轮缩放/元素命中都依赖 viewport 偏移）
  useEffect(() => {
    if (!api) return;
    const frame = requestAnimationFrame(() => api.refresh());
    return () => cancelAnimationFrame(frame);
  }, [api, inspectorCollapsed]);

  // 库的 onChange 只在场景变化时回调，纯选中/切工具不触发，所以低频率读一次 appState。
  // 只取三个字段做浅比较，值没变就不 setState，避免拖动画布时反复重渲染外壳。
  useEffect(() => {
    if (!api) return;
    let lastKey = "";
    const sync = () => {
      const appState = api.getAppState();

      // 进入编辑态（双击文本、双击折线加点等）时自动展开右侧面板：
      // 只在编辑会话开始（id 从空变非空，或换到另一个元素）沿触发一次；
      // 编辑进行中用户手动收起不会反复弹开，退出编辑后再次进入才算新会话。
      const editingId = appState.editingTextElement?.id ?? appState.editingLinearElement?.elementId ?? null;
      if (editingId !== editingIdRef.current) {
        editingIdRef.current = editingId;
        if (editingId && inspectorCollapsedRef.current) {
          setInspectorCollapsed(false);
          writeInspectorCollapsed(false);
        }
      }

      const next = {
        tool: appState.activeTool.type,
        locked: appState.activeTool.locked,
        selected: Object.keys(appState.selectedElementIds).length,
        library: appState.openSidebar?.name === "default",
      };
      const nextKey = `${next.tool}|${next.locked}|${next.selected}|${next.library}`;
      if (nextKey === lastKey) return;
      lastKey = nextKey;
      setUiState(next);
    };
    sync();
    const timer = window.setInterval(sync, 150);
    return () => window.clearInterval(timer);
  }, [api]);

  /**
   * 库自带的弹窗（Help、加载确认、导出、清空画布等）大多只留了 Esc / 点遮罩退出，
   * 没有角上的关闭键。这里等弹窗挂载后给每张卡片补一颗统一的圆形关闭键
   * （外观见 pages.css 的 `.wb-dialog-close`，位置见 excalidraw-theme.css 的 `.wb-modal-close`）。
   * 几何与外观同时写进内联样式：弹窗是从库的 portal 里长出来的，样式表万一没命中
   * （如定位父级/选择器上下文变化），按钮会退回文档流落到弹窗底部，内联值是兜底。
   * 点击走 Esc 关闭，Esc 与遮罩点击保持库的原生行为不变。
   */
  useEffect(() => {
    if (!api) return;
    const inject = () => {
      const modal = document.querySelector(".excalidraw-modal-container .Modal__content");
      if (!modal) return;
      const card = modal.querySelector(":scope > .Island") ?? modal;
      if (card.querySelector("[data-wb-dialog-close]")) return;
      // 库自己已经给了关闭键的弹窗（带 .Dialog__close）不重复加
      if (card.querySelector(".Dialog__close")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wb-dialog-close wb-modal-close";
      button.title = "关闭";
      button.setAttribute("aria-label", "关闭");
      button.setAttribute("data-wb-dialog-close", "1");
      button.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>';
      // 兜底只写几何（位置 + 点击区大小），颜色/描边/悬停/焦点环仍交给 `.wb-dialog-close`：
      // 内联属性优先级高于样式表，若把外观也钉死，`:hover` 就再也改不动了。
      Object.assign(button.style, {
        position: "absolute",
        top: "12px",
        right: "12px",
        zIndex: "2",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "32px",
        height: "32px",
        padding: "0",
        boxSizing: "border-box",
        cursor: "pointer",
      });
      // 「加载确认」这类弹窗的开合不走 appState.openDialog，Esc 是库内唯一通用的关闭入口。
      // 库的 Esc 监听挂在 React 事件树上，必须把事件派发到弹窗内部（document 上不会进合成事件），
      // 所以在卡片上派发一次 keydown/keyup，等价用户按 Esc。
      const pressEscape = () => {
        const options = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
        card.dispatchEvent(new KeyboardEvent("keydown", options));
        card.dispatchEvent(new KeyboardEvent("keyup", options));
      };
      button.addEventListener("click", pressEscape);
      card.append(button);
    };
    inject();
    const observer = new MutationObserver(inject);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [api]);
  /** 标题在身份握手完成后才能按归属读取本机记录，先渲染占位 */
  const [title, setTitle] = useState<string | null>(null);
  const displayTitle = title ?? "未命名白板";
  const timingRef = useRef<BoardTiming>({ startedAt: performance.now() });

  // 最小只读入口：`?view=1`（也接受 `?readonly=1`），join 时向服务端声明 viewOnly。
  // 真正的分享权限由服务端按 token 判定（M5-2）；token 通过 REST 的 `x-share-token`
  // 头与 WS join payload 传递，**不再放 URL query**（见 readShareToken）。
  const queryViewOnly = readOnlyQuery();
  const shareInfo = readShareToken();
  const shareToken = shareInfo.token;
  const collabState = storeState?.collab ?? null;
  const requestedViewOnly =
    queryViewOnly ||
    (collabState?.viewOnly ?? false) ||
    (collabState?.role ?? "unknown") === "viewer";
  const readonly = requestedViewOnly;
  const isGuest = storeState?.authenticated === false;
  const user = storeState?.user ?? null;
  /**
   * 本机记录归属：登录用户用自己的 key，游客用游客 key。
   * 身份握手完成前是 null——此时既不读也不写，避免把已登录白板误记进游客列表。
   */
  const owner = useMemo<RecentOwner | null>(() => {
    if (!storeState?.identityReady) return null;
    return storeState.authenticated && storeState.user
      ? userOwner(storeState.user.id)
      : GUEST_OWNER;
  }, [storeState?.identityReady, storeState?.authenticated, storeState?.user?.id]);

  /** 只有登录且非只读才展示上传入口；服务端还会独立校验一次（Q5） */
  const canUpload = !readonly && !isGuest && Boolean(user);

  /**
   * 云端载入：游客没有服务端空间列表（接口 401），只读成员不能覆盖画布，
   * 这两种情况下主菜单里不出现入口。
   */
  const canCloudLoad = !readonly && !isGuest && Boolean(user);
  /** 当前空间：团队空间从 `?from=/boards?space=…` 带入；否则按个人空间查询 */
  const cloudSpaceId = useMemo(readSpaceQuery, []);

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

  // 被所有者移出：只提示一次；画布已由协作层转成只读并停止重连
  const memberRemovedNotified = useRef(false);
  useEffect(() => {
    if (!collabState?.memberRemoved || memberRemovedNotified.current) return;
    memberRemovedNotified.current = true;
    notify(
      collabState.memberRemovedScope === "space"
        ? "你已被移出该空间，当前为只读"
        : "你已被移出该白板，当前为只读",
    );
  }, [collabState?.memberRemoved, collabState?.memberRemovedScope, notify]);

  // 老链接兼容一个版本：`?share=` 仍可读，但离开 query 是既定方向，给一次提示
  const legacyShareNotified = useRef(false);
  useEffect(() => {
    if (!shareInfo.legacy || legacyShareNotified.current) return;
    legacyShareNotified.current = true;
    notify("分享链接已升级为 #share= 形式，请向所有者索取新链接；旧链接将在下个版本停用");
  }, [shareInfo.legacy, notify]);

  /**
   * 白板级成员管理（仅 owner）：右键在线头像 → 改角色 / 移出。
   * 空间成员不在 `board_members` 里，服务端会回 404，这里提示去空间设置调整。
   */
  const [memberMenu, setMemberMenu] = useState<{
    userId: string;
    displayName: string;
    left: number;
    top: number;
  } | null>(null);

  const openMemberMenu = (event: ReactMouseEvent, identity: string, displayName: string) => {
    if ((collabState?.role ?? "unknown") !== "owner") return;
    if (!identity.startsWith("user:")) return;
    // 自己（所有者）不能把自己移出/降权
    if (identity === collabState?.identity) return;
    event.preventDefault();
    setMemberMenu({
      userId: identity.slice("user:".length),
      displayName,
      left: Math.min(event.clientX, window.innerWidth - 200),
      top: Math.min(event.clientY, window.innerHeight - 160),
    });
  };

  const mutateMember = async (userId: string, action: "editor" | "viewer" | "remove") => {
    setMemberMenu(null);
    const url = `/api/boards/${boardId}/members/${encodeURIComponent(userId)}`;
    const res =
      action === "remove"
        ? await request<null>(url, { method: "DELETE" })
        : await request<{ role: string }>(url, { method: "PATCH", body: JSON.stringify({ role: action }) });
    if (!res.ok) {
      notify(
        res.status === 404
          ? "该协作者由空间权限管理，请到空间设置中调整"
          : `操作失败（${res.code}）`,
      );
      return;
    }
    notify(action === "remove" ? "已移出该协作者" : action === "viewer" ? "已设为只读" : "已设为可编辑");
  };


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

  /**
   * 首帧缩略图：画布就绪与身份握手谁先完成不确定，两边都调一次，内部只放行一次。
   * 身份未知时直接跳过，绝不用错归属的 key 写图。
   */
  const captureFirstFrame = useCallback(() => {
    const api = apiRef.current;
    const tag = ownerTagRef.current;
    if (!api || !tag || thumbScheduledRef.current) return;
    thumbScheduledRef.current = true;
    scheduleThumbCapture(api, tag, boardId);
  }, [boardId]);

  // 身份就绪后：记下本页归属，按归属取标题，并补拍首帧缩略图（画布可能先于握手就绪）
  useEffect(() => {
    if (!owner) return;
    ownerTagRef.current = ownerTag(owner);
    setActiveOwner(owner);
    setTitle(titleOf(boardId, owner) ?? "未命名白板");
    captureFirstFrame();
  }, [boardId, owner, captureFirstFrame]);

  // 标题解析完成后才写回本机记录，避免占位标题覆盖已存的自定义名。
  // 游客侧只有一块固定 id 的公共板，不再累积「最近打开」；缩略图仍按身份落 IndexedDB。
  useEffect(() => {
    if (!owner || title === null) return;
    if (owner.kind === "guest") return;
    recordRecentBoard({ id: boardId, title }, owner);
  }, [boardId, owner, title]);

  useEffect(() => {
    // 打开次数：列表容量 15 的淘汰排序依据；fire-and-forget，不阻塞首帧
    markBoardOpened(boardId);
  }, [boardId]);

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
      const tag = ownerTagRef.current;
      if (api && tag) scheduleThumbCapture(api, tag, boardId, { fast: true });
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

  /**
   * 离板时把本机缩略图上传到服务端一次（覆盖旧副本），换设备/换浏览器也能看到卡片图。
   *
   * 游客与只读观众不上传：前者没有服务端账号，后者没有写权限；失败静默，
   * 列表页仍能回退到本机 IndexedDB 的副本。
   */
  const flushThumbUpload = useCallback(
    async (tag: string): Promise<void> => {
      if (!tag.startsWith("user:")) return;
      if (storeRef.current?.snapshot().collab?.role === "viewer") return;
      const record = await readBoardThumb(tag, boardId).catch(() => null);
      if (!record || !(record.blob instanceof Blob) || record.blob.size === 0) return;
      await uploadBoardThumbnail(boardId, record.blob);
    },
    [boardId],
  );

  /** 已经有 Blob 时的直传（pagehide 用）：不 await 任何异步前置，fetch 在事件里同步发出。 */
  const flushThumbBlob = useCallback(
    async (tag: string, blob: Blob): Promise<void> => {
      if (!tag.startsWith("user:")) return;
      if (storeRef.current?.snapshot().collab?.role === "viewer") return;
      if (!(blob instanceof Blob) || blob.size === 0) return;
      await uploadBoardThumbnail(boardId, blob);
    },
    [boardId],
  );

  // 页面隐藏/离开（点返回、切标签、刷新）再兜一次：导出是异步的，尽力而为，
  // 正常路径由 refreshThumbSoon 的防抖保证已经写完。
  useEffect(() => {
    const flush = () => {
      const api = apiRef.current;
      const tag = ownerTagRef.current;
      if (!api || !tag) return;
      // 卸载阶段 IndexedDB 读取会被打断：内存里有现成 Blob 就立刻发 keepalive 请求；
      // 没有才退回「异步拍摄 → 读盘 → 上传」的尽力而为路径。
      const cached = peekBoardThumb(tag, boardId);
      if (cached) {
        void flushThumbBlob(tag, cached);
        return;
      }
      void captureBoardThumb(api, tag, boardId).then(() => flushThumbUpload(tag));
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
  }, [boardId, flushThumbUpload, flushThumbBlob]);

  /**
   * 返回列表前把最新画面写进缩略图再跳转。
   * 只靠编辑后的防抖重拍时，画完立刻点返回会在导出完成前卸载页面，列表还是旧图；
   * 这里等一次拍摄（内容没变时只是一次指纹比对），再走原来的整页导航。
   */
  const leavingRef = useRef(false);
  /**
   * 返回到进入本板时的上一级页面：`?from` → 同源 referrer → `/boards`。
   * 团队空间列表带 `?space=` 进板时会被完整带回；分享链接/直接打开回 `/boards`。
   */
  const backHref = resolveBackHref({
    search: window.location.search,
    referrer: document.referrer,
    origin: window.location.origin,
  });
  const handleBack = async (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const api = apiRef.current;
    if (!api || leavingRef.current) return;
    event.preventDefault();
    leavingRef.current = true;
    const tag = ownerTagRef.current;
    try {
      if (tag) {
        await captureBoardThumb(api, tag, boardId);
        // 上传是尽力而为：网络慢时最多等 1.5s，不能因为缩略图卡住「返回」
        await Promise.race([
          flushThumbUpload(tag),
          new Promise((resolve) => window.setTimeout(resolve, 1500)),
        ]);
      }
    } finally {
      // 用 replace 而不是 push：返回是"上移一层"，不该在历史里再留一条白板页，
      // 否则返回列表后再按浏览器后退键会又回到白板，与页面内返回的行为不一致。
      window.location.replace(backHref);
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
          <a className="wb-board__back" href={backHref} aria-label="返回上一级" onClick={handleBack}>
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
  /** 方案 A：同色连接按加入顺序编号，第 2 条起显示「昵称 · 2」（纯函数，最多 40 条，无需缓存） */
  const cursorLabels = buildCursorLabels(cursors);
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
        <a className="wb-board__back" href={backHref} aria-label="返回上一级" data-testid="board-back" onClick={handleBack}>
          <IconBack />
        </a>

        <div className="wb-board__title" tabIndex={0}>
          <div className="wb-board__name" title={displayTitle}>
            {displayTitle}
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
          <span className="wb-user-chip" tabIndex={0} data-testid="auth-user">
            {user.avatarUrl ? <img className="wb-user-chip__avatar" src={user.avatarUrl} alt="" /> : <UserMark />}
            <span className="wb-caption">{user.displayName}</span>
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
                title={`${member.displayName} · ${ROLE_TEXT[member.role] ?? member.role} · ${member.connectionCount} 个标签页`}
                style={{ background: member.color }}
                onContextMenu={(event) => openMemberMenu(event, member.identity, member.displayName)}
              >
                {member.avatarUrl ? (
                  <img src={member.avatarUrl} alt="" />
                ) : member.identity === collabState?.identity ? (
                  "我"
                ) : (
                  shortId(member.identity).slice(-2)
                )}
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

        <span className="wb-user-chip wb-board__status" data-testid="collab-status" data-status={status}>
          <span className={`wb-board__dot wb-board__dot--${statusTone}`} aria-hidden />
          <span className="wb-board__status-text">
            {statusText} · {ROLE_TEXT[role] ?? role}
          </span>
        </span>

        {isGuest ? (
          <a
            className="wb-user-chip"
            data-testid="header-login"
            href={`/login?next=${encodeURIComponent(pageHref)}`}
          >
            <UserMark />
            <span className="wb-caption">登录</span>
          </a>
        ) : null}

        {canUpload ? (
          <>
            <button
              className="wb-user-chip wb-board__image"
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

        {/* 素材库入口：原画布右上角那颗 Library 已隐藏，统一收到顶栏「图片」之后 */}
        {api ? (
          <button
            className="wb-user-chip wb-board__library"
            type="button"
            data-testid="library-toggle"
            aria-pressed={uiState.library}
            aria-label="素材库"
            title="素材库"
            onClick={() =>
              // 侧栏开着时，库会在 pointerdown 阶段先按「点在外面」把它关掉（见 useOutsideClick），
              // 此刻再读实时状态会误判成「该打开」。所以按这一刻渲染出的开合态给 force：
              // 之前是开的 → 关；之前是关的 → 开。
              api.toggleSidebar({ name: "default", force: !uiState.library })
            }
          >
            <IconLibrary />
            <span className="wb-board__share-text">素材库</span>
          </button>
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
        <div
          className={`wb-canvas${!readonly && !inspectorCollapsed ? " wb-canvas--docked" : ""}${
            !readonly && inspectorCollapsed ? " wb-canvas--inspector-collapsed" : ""
          }`}
          style={{ height: "100%" }}
        >
          <BoardCanvas
            initialElements={scene.elements}
            viewModeEnabled={readonly}
            shareToken={shareToken}
            onApiReady={(api, handle) => {
              apiRef.current = api;
              bridgeRef.current = handle;
              setApi(api);
              timingRef.current.canvasReadyAt = performance.now();
              storeRef.current?.notifyCanvasReady();
              if (window.__board) window.__board.ready = true;
              // 首帧快照：身份可能晚于画布就绪，captureFirstFrame 内部只放行一次
              captureFirstFrame();
            }}
            onOps={(ops) => {
              window.__board?.opBatches.push(ops);
              storeRef.current?.submit(ops);
              // 本地改动才需要更新卡片缩略图；远端回放不产生 op，不会触发
              refreshThumbSoon();
            }}
            onCloudLoad={canCloudLoad ? () => setCloudOpen(true) : null}
          />
        </div>

        {/* 左侧竖工具条：只做入口，工具切换仍走库的 setActiveTool；只读时整条隐藏 */}
        {!readonly ? (
          <EditorToolRail
            api={api}
            activeTool={uiState.tool}
            locked={uiState.locked}
            disabled={readonly}
          />
        ) : null}

        {/* 右侧 272 列的折叠入口：面板/空态共用，只读态不出现 */}
        {!readonly ? (
          <button
            type="button"
            className={`wb-inspector-toggle${inspectorCollapsed ? " wb-inspector-toggle--collapsed" : ""}`}
            data-testid="inspector-toggle"
            aria-expanded={!inspectorCollapsed}
            title={inspectorCollapsed ? "展开属性面板" : "收起属性面板"}
            aria-label={inspectorCollapsed ? "展开属性面板" : "收起属性面板"}
            onClick={toggleInspector}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ transform: inspectorCollapsed ? "rotate(180deg)" : undefined }}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        ) : null}

        {/* 右侧属性槽：库面板只在选中元素时挂载，未选中时由外壳补空态，避免 272 列空着 */}
        {!readonly && !inspectorCollapsed && uiState.selected === 0 ? (
          <aside className="wb-board__inspector-empty" data-testid="inspector-empty">
            <div className="wb-board__inspector-empty-title">样式</div>
            <div className="wb-board__inspector-empty-sub">未选中元素</div>
            <p className="wb-board__inspector-empty-hint">
              在画布上选中一个元素，这里会显示描边、背景、线宽、线型、透明度与图层顺序；
              文本、箭头还会多出各自的专属属性。
            </p>
            <p className="wb-board__inspector-empty-hint">
              画框用 <span className="wb-board__inspector-empty-kbd">R</span>、文字用{" "}
              <span className="wb-board__inspector-empty-kbd">T</span>、橡皮用{" "}
              <span className="wb-board__inspector-empty-kbd">E</span>。
            </p>
          </aside>
        ) : null}

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
              {cursorLabels.get(cursor.connectionId) ?? cursor.displayName}
            </span>
          </div>
        ))}
      </div>

      {/* 状态条：桌面可见，移动端隐藏；同时承载验收用的调试读数 */}
      <footer className="wb-board__statusbar">
        <span className="wb-board__debug">
          {collabState && collabState.queuedOps > 0 ? (
            <span className="wb-board__debug-item" data-testid="queued-ops">
              待补发 {collabState.queuedOps} 条操作
            </span>
          ) : null}
          {collabState && collabState.synced ? (
            <span className="wb-board__debug-item" data-testid="sync-state">
              已对齐序号={collabState.cacheSeq ?? 0}
            </span>
          ) : null}
          {tab ? (
            <span className="wb-board__debug-item" data-testid="tab-id" title={`guestId=${tab.guestId}`}>
              标签页 {shortId(tab.tabId)}
              {tab.tabRegenerated ? " · 已重生成" : ""}
            </span>
          ) : null}
          {writer ? (
            <span
              className="wb-board__debug-item"
              data-testid="cache-writer"
              data-is-writer={writer.isWriter ? "1" : "0"}
            >
              {writer.mode === "web-locks" ? "网页锁" : writer.mode === "broadcast-fallback" ? "降级选举" : "单写者"}：
              {writer.isWriter ? "缓存写者" : "只读缓存"}
            </span>
          ) : null}
        </span>
        <span className="wb-board__statusbar-right">
          <span className="wb-nums">{scene.source === "cache" ? `本地缓存 ${Math.round(scene.loadMs)} 毫秒` : scene.source === "snapshot" ? "服务端快照" : "空场景"}</span>
          <span className="wb-nums">序号 {scene.seq}</span>
        </span>
      </footer>

      {shareOpen ? <ShareDrawer boardId={boardId} readonly={readonly} onClose={() => setShareOpen(false)} /> : null}

      {cloudOpen && canCloudLoad ? (
        <CloudLoadDialog
          boardId={boardId}
          spaceId={cloudSpaceId}
          onClose={() => setCloudOpen(false)}
          onLoaded={(title, elements) => {
            bridgeRef.current?.replaceElements(elements);
            setCloudOpen(false);
            notify(`已从「${title}」载入画布`);
          }}
        />
      ) : null}

      {memberMenu ? (
        <>
          <div className="wb-scrim" style={{ zIndex: 58 }} onClick={() => setMemberMenu(null)} />
          <div
            role="menu"
            data-testid="member-menu"
            style={{
              position: "fixed",
              left: memberMenu.left,
              top: memberMenu.top,
              zIndex: 59,
              minWidth: 180,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              padding: "var(--space-2)",
              background: "var(--surface-raised)",
              border: "1px solid var(--line-soft)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-raised)",
            }}
          >
            <span className="wb-caption" style={{ padding: "2px 8px" }}>
              {memberMenu.displayName}
            </span>
            <button className="wb-btn wb-btn--ghost wb-btn--pill" type="button" onClick={() => void mutateMember(memberMenu.userId, "editor")}>
              设为可编辑
            </button>
            <button className="wb-btn wb-btn--ghost wb-btn--pill" type="button" onClick={() => void mutateMember(memberMenu.userId, "viewer")}>
              设为只读
            </button>
            <button
              className="wb-btn wb-btn--ghost wb-btn--pill wb-btn--danger-text"
              type="button"
              onClick={() => void mutateMember(memberMenu.userId, "remove")}
            >
              移除协作者
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * 当前空间 id：团队空间列表进板时会把 `?space=` 编码进 `?from=`；
 * 个人空间不带参数（接口缺省即个人空间）。
 */
function readSpaceQuery(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const pick = (value: string | null) =>
    value && /^sp_[A-Za-z0-9_-]{10,32}$/.test(value) ? value : undefined;
  const direct = pick(params.get("space"));
  if (direct) return direct;
  const from = params.get("from");
  if (!from) return undefined;
  return pick(new URLSearchParams(from.split("?")[1] ?? "").get("space"));
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

const SHARE_TOKEN_MIN_LENGTH = 8;
const SHARE_TOKEN_MAX_LENGTH = 128;

function isValidShareToken(token: string | null): token is string {
  return Boolean(token && token.length >= SHARE_TOKEN_MIN_LENGTH && token.length <= SHARE_TOKEN_MAX_LENGTH);
}

/**
 * 分享 token 读取：**优先 fragment**（`/board/:id#share=<token>`）。
 *
 * 选 fragment 而不是 `/s/:token` 路径的理由：fragment 不会随 HTTP 请求发给服务端，
 * 因此不会出现在 access log、反向代理日志和静态资源请求的 Referer 里；路径/query
 * 都会进日志。fragment 也不改变现有路由，不需要新增 `/s/:token` 的落地页。
 * 老 `?share=` 保留读取**一个版本**，由调用方提示升级；token 在 REST/WS 中
 * 走 `x-share-token` 头与 join payload，不再回到 URL。
 */
function readShareToken(): { token: string | null; legacy: boolean } {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  const fromHash = new URLSearchParams(hash).get("share");
  if (isValidShareToken(fromHash)) return { token: fromHash, legacy: false };

  const fromQuery = new URLSearchParams(window.location.search).get("share");
  if (isValidShareToken(fromQuery)) return { token: fromQuery, legacy: true };
  return { token: null, legacy: false };
}

const BANNER_KEY = "wb:saveBannerDismissed";

function readBannerDismissed(): boolean {
  try {
    return sessionStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return false;
  }
}

/** 右侧属性列的折叠偏好：跨会话记住（刷新/重进板都保持用户选择） */
const INSPECTOR_COLLAPSED_KEY = "wb:inspectorCollapsed";

function readInspectorCollapsed(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInspectorCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(INSPECTOR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* 隐私模式下写不进去就只在本次会话生效 */
  }
}
