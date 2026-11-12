import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { fetchClaimPreview, fetchMe, type ClaimPreview } from "../auth/authApi";
import { ClaimDialog, claimSnoozed } from "../auth/ClaimDialog";
import { SaveToAccountBanner } from "../auth/GuestBadge";
import {
  createShareLink,
  fetchBoards,
  fetchTrashCount,
  renameBoard,
  restoreBoard,
  ROLE_LABEL,
  setBoardPinned,
  type BoardListItem,
} from "./boardsApi";
import { moveBoardToTrash } from "./boardActions";
import { BoardCardMenu, type BoardMenuTarget } from "./BoardCardMenu";
import type { MenuAnchor } from "./boardMenu";
import { hasMoreBoards, isPinned, sortBoards, visibleBoards } from "./boardList";
import { loadThumbUrls } from "./boardThumb";
import { listRecentBoards, setRecentPinned, type RecentBoard } from "./recentBoards";
import { SakuraBranch } from "./SakuraBranch";
import { useCreateBoard, type CreateBoardFailureKind } from "./useCreateBoard";
import { skeletonVisible, useSkeletonPhase } from "./useSkeletonPhase";
import { IconAlert, IconBoard, IconFlower, IconMore, IconPin, IconPlus, IconTrash } from "../ui/icons";

/**
 * 我的白板列表（视觉方案 §4.2）。
 *
 * - 登录用户：`GET /api/boards`（置顶优先，其次最近编辑倒序）；游客 401 → 展示本机"最近打开"。
 * - 背景 A：天空渐变前四档在 420px 内淡回 `--bg`，右上角一枝樱花；<700px 隐藏枝条。
 * - 卡片缩略图来自进板首帧快照（IndexedDB `wb-cache/thumbs`），没有快照时回退线稿图标。
 * - 骨架与真实卡片同盒模型（16:10 缩略图 / 22px 标题行 / 24px 元信息行）；
 *   加载超过 200ms 才显示骨架，数据到达时两者交叉淡出淡入，首屏不闪白、不位移。
 * - 每页 6 张，点「加载更多」累加，不做跨页跳转。
 */

type ViewState =
  | { kind: "loading" }
  | { kind: "guest"; items: RecentBoard[] }
  | { kind: "user"; items: BoardListItem[]; user: { displayName: string } }
  | { kind: "error"; message: string };

type CardModel = {
  id: string;
  title: string;
  lastEditedAt: string;
  pinned: boolean;
  badge: string;
  badgeTone: "role" | "readonly" | "guest";
  role: string;
  guest?: boolean;
};

const CLAIM_DISMISSED_KEY = "wb:boardsClaimDismissed";
const SAVE_BANNER_KEY = "wb:saveBannerDismissed";
/** 列表一次取满 30 条（接口上限），页内再按 6 张/页加载更多 */
const FETCH_LIMIT = 30;

/** 本页的建板失败文案：沿用这一页原来的措辞，避免因为共用 hook 改掉已有提示 */
function boardsMessageFor({ kind, code }: { kind: CreateBoardFailureKind; code?: string }): string {
  if (kind === "quota") return "已建满 3 块临时板，登录后可以继续。";
  if (kind === "offline") return "连不上服务器，恢复网络后再试。";
  return `没建成（${code}），再试一次。`;
}

export function BoardsPage() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [claimBarVisible, setClaimBarVisible] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [guestBannerVisible, setGuestBannerVisible] = useState(() => !readFlag(SAVE_BANNER_KEY));
  const [toast, setToast] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [thumbsReady, setThumbsReady] = useState(false);
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  // 右键菜单只允许一个实例：右键 / 长按 / 「更多」都写同一份 state
  const [menu, setMenu] = useState<{ board: CardModel; anchor: MenuAnchor; trigger: HTMLElement | null } | null>(null);
  const [rename, setRename] = useState<{ board: CardModel; trigger: HTMLElement | null } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<{ id: string; title: string } | null>(null);
  // 建板逻辑（含配额/离线/慢请求处理）统一走 useCreateBoard，与旧首页入口同一份实现
  const { busy, slow, error: createError, start } = useCreateBoard({ messageFor: boardsMessageFor });

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    setPage(1);
    const me = await fetchMe();
    if (!me.ok) {
      setView({ kind: "guest", items: listRecentBoards() });
      return;
    }
    const list = await fetchBoards(FETCH_LIMIT);
    if (!list.ok) {
      setView({ kind: "error", message: "列表没刷新成功" });
      return;
    }
    setView({ kind: "user", items: sortBoards(list.data.boards), user: { displayName: me.data.user.displayName } });

    if (!claimSnoozed() && !readFlag(CLAIM_DISMISSED_KEY)) {
      const p = await fetchClaimPreview();
      if (p.ok && p.data.count > 0) {
        setPreview(p.data);
        setClaimBarVisible(true);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 回收站入口徽标：登录用户才取，401/网络失败都静默降级为不显示徽标
  useEffect(() => {
    let alive = true;
    void fetchTrashCount().then((result) => {
      if (alive && result.ok) setTrashCount(result.data.count);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 缩略图与列表并行取：列表先到也要等缩略图，避免卡片先显示线稿再换成图片
  useEffect(() => {
    let alive = true;
    let created: string[] = [];
    void loadThumbUrls()
      .then((urls) => {
        created = Object.values(urls);
        if (!alive) {
          created.forEach((url) => URL.revokeObjectURL(url));
          return;
        }
        setThumbs(urls);
      })
      .catch((err) => {
        console.warn("[boards] 读取缩略图失败，回退线稿占位", err);
      })
      .finally(() => {
        if (alive) setThumbsReady(true);
      });

    return () => {
      alive = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 回收站 toast 的 5 秒撤销期
  useEffect(() => {
    if (!undoToast) return;
    const timer = window.setTimeout(() => setUndoToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [undoToast]);

  const dismissClaimBar = () => {
    setClaimBarVisible(false);
    writeFlag(CLAIM_DISMISSED_KEY);
  };

  const dismissGuestBanner = () => {
    setGuestBannerVisible(false);
    writeFlag(SAVE_BANNER_KEY);
  };

  const togglePin = async (id: string, pinned: boolean) => {
    setPinBusyId(id);
    try {
      if (view.kind === "user") {
        const result = await setBoardPinned(id, pinned);
        if (!result.ok) {
          setToast("置顶没保存成功，再试一次。");
          return;
        }
        setView((current) =>
          current.kind === "user"
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.id === id ? { ...item, pinnedAt: result.data.pinnedAt } : item,
                ),
              }
            : current,
        );
      } else if (view.kind === "guest") {
        const next = setRecentPinned(id, pinned);
        setView((current) => (current.kind === "guest" ? { ...current, items: next } : current));
      }
    } finally {
      setPinBusyId(null);
    }
  };

  const isGuest = view.kind === "guest";
  const listReady = view.kind === "user" || view.kind === "guest";
  const cards: CardModel[] = !listReady
    ? []
    : view.kind === "user"
      ? sortBoards(view.items).map((item) => ({
          id: item.id,
          title: item.title,
          lastEditedAt: item.lastEditedAt,
          pinned: isPinned(item),
          badge: ROLE_LABEL[item.role] ?? item.role,
          badgeTone: item.role === "viewer" ? "readonly" : "role",
          role: item.role,
        }))
      : sortBoards(view.items).map((item) => ({
          id: item.id,
          title: item.title,
          lastEditedAt: item.lastEditedAt,
          pinned: isPinned(item),
          badge: "临时板",
          badgeTone: "guest",
          role: "owner",
          guest: true,
        }));

  const cardsReady = listReady && thumbsReady;
  const showEmpty = listReady && cards.length === 0;
  const skeletonActive = view.kind === "loading" || (listReady && cards.length > 0 && !thumbsReady);
  const skeletonPhase = useSkeletonPhase(skeletonActive);

  const visible = visibleBoards(cards, page);
  const more = hasMoreBoards(cards.length, page);

  const closeMenu = (restoreFocus = false) => {
    const trigger = menu?.trigger ?? null;
    setMenu(null);
    if (restoreFocus && trigger) {
      window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
  };

  const openMenu = (board: CardModel, anchor: MenuAnchor, trigger: HTMLElement | null) => {
    setMenu({ board, anchor, trigger });
  };

  const refreshList = useCallback(async () => {
    const list = await fetchBoards(FETCH_LIMIT);
    if (!list.ok) return;
    setView((current) =>
      current.kind === "user" ? { ...current, items: sortBoards(list.data.boards) } : current,
    );
  }, []);

  const trashBoard = async (board: CardModel) => {
    const index = cards.findIndex((item) => item.id === board.id);
    const result = await moveBoardToTrash(board.id);
    if (!result) {
      setToast("没删成功，再试一次。");
      return;
    }
    setView((current) =>
      current.kind === "user"
        ? { ...current, items: current.items.filter((item) => item.id !== board.id) }
        : current,
    );
    setTrashCount((count) => count + 1);
    setUndoToast({ id: board.id, title: board.title });
    // 焦点落到原位置的下一条卡片，避免删除后焦点丢回 body
    window.requestAnimationFrame(() => {
      const links = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="board-card"] .wb-board-card__link'),
      );
      links[Math.min(index, links.length - 1)]?.focus({ preventScroll: true });
    });
  };

  const undoTrash = async () => {
    const target = undoToast;
    if (!target) return;
    setUndoToast(null);
    const result = await restoreBoard(target.id);
    if (!result.ok) {
      setToast("恢复没成功，请到回收站里恢复。");
      return;
    }
    setTrashCount((count) => Math.max(0, count - 1));
    await refreshList();
    setToast(
      result.data.renamed ? `已恢复，并重命名为「${result.data.title}」` : `已恢复「${result.data.title}」`,
    );
  };

  const copyBoardLink = async (board: CardModel) => {
    const ok = await copyText(`${window.location.origin}/board/${board.id}`);
    setToast(ok ? "链接已复制" : "复制失败，请手动复制地址栏链接。");
  };

  const inviteCollaborator = async (board: CardModel) => {
    const result = await createShareLink(board.id, "read");
    if (!result.ok) {
      setToast("邀请链接没生成成功，再试一次。");
      return;
    }
    const ok = await copyText(new URL(result.data.url, window.location.origin).toString());
    setToast(ok ? "邀请链接已复制" : "邀请链接已生成，但复制失败，请到分享面板查看。");
  };

  const closeRename = () => {
    const trigger = rename?.trigger ?? null;
    setRename(null);
    setRenameError(null);
    if (trigger) window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!rename) return;
    const title = renameValue.trim();
    if (!title) {
      setRenameError("标题不能为空");
      return;
    }
    setRenameBusy(true);
    const result = await renameBoard(rename.board.id, title);
    setRenameBusy(false);
    if (!result.ok) {
      setRenameError("改名没成功，再试一次。");
      return;
    }
    const nextTitle = result.data.title;
    setView((current) =>
      current.kind === "user"
        ? {
            ...current,
            items: current.items.map((item) => (item.id === rename.board.id ? { ...item, title: nextTitle } : item)),
          }
        : current,
    );
    const trigger = rename.trigger;
    setRename(null);
    setRenameError(null);
    setToast("已重命名");
    if (trigger) window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
  };

  const handleMenuAction = (key: string) => {
    const target = menu;
    if (!target) return;
    const board = target.board;
    const trigger = target.trigger;
    setMenu(null);

    switch (key) {
      case "open":
        window.location.href = `/board/${board.id}`;
        return;
      case "rename":
        setRename({ board, trigger });
        setRenameValue(board.title);
        setRenameError(null);
        return;
      case "pin":
        void togglePin(board.id, !board.pinned);
        return;
      case "copy-link":
        void copyBoardLink(board);
        return;
      case "invite":
        void inviteCollaborator(board);
        return;
      case "trash":
        void trashBoard(board);
        return;
      default:
        return;
    }
  };

  return (
    <div className="wb-page wb-page--boards">
      <div className="wb-boards__deco" aria-hidden>
        <SakuraBranch />
      </div>

      <div className="wb-topbar">
        <a className="wb-brand" href="/">
          <span className="wb-brand__mark" aria-hidden>
            白
          </span>
          白板
        </a>
        <div className="wb-board__spacer" />
        {view.kind === "user" ? (
          <a className="wb-trash__nav" href="/boards/trash" data-testid="boards-trash-link">
            <IconTrash size={15} />
            <span className="wb-trash__nav-text">回收站</span>
            {trashCount > 0 ? (
              <span className="wb-trash__badge wb-nums">{trashCount > 99 ? "99+" : trashCount}</span>
            ) : null}
          </a>
        ) : null}
        {view.kind === "user" ? (
          <span className="wb-caption" data-testid="boards-user">
            {view.user.displayName}
          </span>
        ) : null}
        {isGuest ? (
          <a className="wb-link" href="/login?next=%2Fboards" data-testid="boards-login">
            登录 / 注册
          </a>
        ) : null}
      </div>

      {isGuest && guestBannerVisible ? (
        <SaveToAccountBanner onLogin={() => (window.location.href = "/login?next=%2Fboards")} onDismiss={dismissGuestBanner} />
      ) : null}

      <div className="wb-container wb-container--boards">
        <div className="wb-boards__head">
          <div className="wb-boards__headline">
            <h1 className="wb-display">{isGuest ? "最近打开" : "我的白板"}</h1>
            {listReady ? <span className="wb-boards__count wb-nums">{view.items.length} 块</span> : null}
          </div>
          <button
            className="wb-btn wb-btn--primary"
            type="button"
            onClick={() => void start()}
            disabled={busy}
            data-testid="boards-new"
          >
            {busy ? <span className="wb-spinner" aria-hidden /> : <IconPlus />}
            {busy ? (slow ? "还在连接…" : "正在新建…") : "新建白板"}
          </button>
        </div>

        {createError ? (
          <div className="wb-inline-note wb-inline-note--danger" style={{ marginTop: "var(--space-4)" }} role="alert">
            <IconAlert />
            <span>{createError.message}</span>
          </div>
        ) : null}

        {claimBarVisible && preview && preview.count > 0 ? (
          <div className="wb-banner wb-banner--info wb-boards__banner" role="status">
            <span>有 {preview.count} 块临时白板可以转入账号。临时板只保存在这台浏览器。</span>
            <span className="wb-banner__spacer" />
            <button className="wb-btn wb-btn--ghost wb-btn--sm" type="button" onClick={() => setDialogOpen(true)}>
              查看
            </button>
            <button className="wb-btn wb-btn--ghost wb-btn--sm" type="button" onClick={dismissClaimBar} aria-label="关闭">
              关闭
            </button>
          </div>
        ) : null}

        {view.kind === "error" ? (
          <div className="wb-panel--error" style={{ marginTop: "var(--space-6)" }} role="alert">
            <h2 className="wb-subtitle">{view.message}</h2>
            <p className="wb-caption">列表暂时取不到，已有的白板不会受影响。</p>
            <button className="wb-btn wb-btn--primary" type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}

        {showEmpty ? (
          <EmptyState
            title={isGuest ? "还没有打开过白板" : "还没有白板"}
            hint={isGuest ? "这块浏览器还没记录任何临时板。新建一块，立刻开始画。" : "新建一块，立刻开始画。"}
            onNew={() => void start()}
          />
        ) : null}

        {cards.length > 0 || skeletonVisible(skeletonPhase) ? (
          <div className="wb-boards__grid">
            {cardsReady && visible.length > 0 ? (
              <div className="wb-grid wb-grid--cards" data-testid="boards-grid">
                {visible.map((board) => (
                  <BoardCard
                    key={board.id}
                    board={board}
                    thumbUrl={thumbs[board.id]}
                    pinBusy={pinBusyId === board.id}
                    menuOpen={menu?.board.id === board.id}
                    onTogglePin={togglePin}
                    onOpenMenu={openMenu}
                    onCloseMenu={() => closeMenu(true)}
                  />
                ))}
              </div>
            ) : null}

            {skeletonVisible(skeletonPhase) ? (
              <div
                className={`wb-grid wb-grid--skeleton${skeletonPhase === "exiting" ? " is-exiting" : ""}`}
                aria-busy={skeletonPhase !== "exiting"}
                aria-hidden={skeletonPhase === "exiting"}
                data-testid="boards-loading"
              >
                <SkeletonCards />
              </div>
            ) : null}
          </div>
        ) : null}

        {cardsReady && more ? (
          <div className="wb-boards__more">
            <button className="wb-btn wb-btn--secondary" type="button" onClick={() => setPage((current) => current + 1)}>
              加载更多
              <span className="wb-boards__more-count wb-nums" aria-hidden>
                还有 {cards.length - visible.length} 块
              </span>
            </button>
          </div>
        ) : null}
      </div>

      {toast ? <div className="wb-toast">{toast}</div> : null}

      {undoToast ? (
        <div className="wb-toast wb-toast--action" role="status" aria-live="polite">
          <span>已移到回收站「{undoToast.title}」</span>
          <button className="wb-toast__action" type="button" onClick={() => void undoTrash()}>
            撤销
          </button>
        </div>
      ) : null}

      {menu ? (
        <BoardCardMenu
          target={{
            boardId: menu.board.id,
            title: menu.board.title,
            role: menu.board.role,
            pinned: menu.board.pinned,
            guest: menu.board.guest,
            anchor: menu.anchor,
            trigger: menu.trigger,
          }}
          onAction={handleMenuAction}
          onClose={closeMenu}
        />
      ) : null}

      {rename ? (
        <div
          className="wb-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeRename();
          }}
        >
          <form
            className="wb-rename"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-rename-title"
            onSubmit={(event) => void submitRename(event)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeRename();
              }
            }}
          >
            <h2 className="wb-dialog__title" id="wb-rename-title">
              重命名白板
            </h2>
            <label className="wb-field">
              <span className="wb-field__label">白板名称</span>
              <input
                className="wb-input"
                value={renameValue}
                maxLength={80}
                autoFocus
                aria-invalid={renameError ? "true" : undefined}
                onChange={(event) => {
                  setRenameValue(event.target.value);
                  if (renameError) setRenameError(null);
                }}
                data-testid="rename-input"
              />
            </label>
            {renameError ? (
              <p className="wb-rename__error" role="alert">
                {renameError}
              </p>
            ) : null}
            <div className="wb-dialog__actions">
              <button className="wb-btn wb-btn--ghost" type="button" onClick={closeRename}>
                取消
              </button>
              <button className="wb-btn wb-btn--primary" type="submit" disabled={renameBusy}>
                {renameBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {dialogOpen && preview && preview.count > 0 ? (
        <ClaimDialog
          preview={preview}
          onClose={() => {
            setDialogOpen(false);
            setClaimBarVisible(false);
          }}
          onClaimed={(result) => {
            setDialogOpen(false);
            setClaimBarVisible(false);
            if (result.transferred > 0) setToast(`已转入 ${result.transferred} 块白板`);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function BoardCard({
  board,
  thumbUrl,
  pinBusy,
  menuOpen,
  onTogglePin,
  onOpenMenu,
  onCloseMenu,
}: {
  board: CardModel;
  thumbUrl?: string;
  pinBusy: boolean;
  menuOpen: boolean;
  onTogglePin: (id: string, pinned: boolean) => void;
  onOpenMenu: (board: CardModel, anchor: MenuAnchor, trigger: HTMLElement | null) => void;
  onCloseMenu: () => void;
}) {
  // 触屏长按 400ms 打开同一实例；移动超过 8px 视为滚动/拖拽，取消长按
  const holdTimer = useRef<number | null>(null);
  const holdStart = useRef<{ x: number; y: number } | null>(null);

  const clearHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdStart.current = null;
  };

  useEffect(() => clearHold, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const trigger = event.currentTarget;
    holdStart.current = { x: event.clientX, y: event.clientY };
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      const start = holdStart.current;
      holdStart.current = null;
      if (start) onOpenMenu(board, { type: "pointer", x: start.x, y: start.y }, trigger);
    }, 400);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = holdStart.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > 8 || Math.abs(event.clientY - start.y) > 8) clearHold();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onOpenMenu(
        board,
        { type: "button", left: rect.left, right: rect.right, top: rect.top, bottom: rect.top + 4 },
        event.currentTarget,
      );
    }
  };

  return (
    <article
      className="wb-card wb-board-card"
      data-testid="board-card"
      data-board-id={board.id}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(board, { type: "pointer", x: event.clientX, y: event.clientY }, event.currentTarget);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onPointerLeave={clearHold}
      onKeyDown={onKeyDown}
    >
      <a className="wb-board-card__link" href={`/board/${board.id}`}>
        <span className="wb-board-card__thumb">
          {thumbUrl ? (
            // 缩略图是本地 Blob 的 objectURL；加载失败时由 onError 隐藏，露出下面的线稿占位
            <img
              className="wb-board-card__thumb-img"
              src={thumbUrl}
              alt=""
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : null}
          <span className="wb-board-card__thumb-fallback" aria-hidden>
            <IconBoard size={28} />
          </span>
          {board.pinned ? (
            <span className="wb-board-card__pin">
              <IconFlower size={12} />
              置顶
            </span>
          ) : null}
        </span>
        <span className="wb-board-card__title" title={board.title}>
          {board.title}
        </span>
      </a>
      <div className="wb-board-card__meta">
        <span className={`wb-badge wb-badge--${board.badgeTone}`}>{board.badge}</span>
        <span className="wb-board-card__meta-right">
          <time className="wb-board-card__time wb-nums" dateTime={board.lastEditedAt}>
            {formatRelative(board.lastEditedAt)}
          </time>
          <button
            className="wb-board-card__pinbtn"
            type="button"
            aria-pressed={board.pinned}
            aria-label={board.pinned ? `取消置顶：${board.title}` : `置顶：${board.title}`}
            title={board.pinned ? "取消置顶" : "置顶"}
            disabled={pinBusy}
            onClick={() => onTogglePin(board.id, !board.pinned)}
          >
            <IconPin size={14} />
          </button>
          <button
            className="wb-board-card__more"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${board.title} 的更多操作`}
            title="更多操作"
            onClick={(event) => {
              event.stopPropagation();
              if (menuOpen) {
                onCloseMenu();
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenMenu(
                board,
                { type: "button", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                event.currentTarget,
              );
            }}
          >
            <IconMore size={16} />
          </button>
        </span>
      </div>
    </article>
  );
}

/** 骨架卡片：结构、行高、间距与 BoardCard 完全一致，换成真实数据时不产生位移。 */
function SkeletonCards() {
  return (
    <>
      {Array.from({ length: 6 }, (_, index) => (
        <article className="wb-card wb-board-card wb-board-card--skeleton" key={index}>
          <span className="wb-board-card__thumb wb-skeleton" />
          <span className="wb-board-card__title">
            <span className="wb-skeleton wb-board-card__sk-title" />
          </span>
          <div className="wb-board-card__meta">
            <span className="wb-skeleton wb-board-card__sk-badge" />
            <span className="wb-skeleton wb-board-card__sk-time" />
          </div>
        </article>
      ))}
    </>
  );
}

function EmptyState({
  title = "还没有白板",
  hint = "新建一块，立刻开始画。",
  onNew,
}: {
  title?: string;
  hint?: string;
  onNew: () => void;
}) {
  return (
    <div className="wb-empty" data-testid="boards-empty">
      <span className="wb-empty__icon" aria-hidden>
        <IconBoard size={24} />
      </span>
      <h2 className="wb-title">{title}</h2>
      <p className="wb-caption">{hint}</p>
      <button className="wb-btn wb-btn--primary" type="button" onClick={onNew}>
        新建第一块
      </button>
    </div>
  );
}

function formatRelative(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(time);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 剪贴板在非安全上下文没有 `navigator.clipboard`，退回隐藏 textarea + execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function readFlag(key: string): boolean {  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    /* 本次生效 */
  }
}
