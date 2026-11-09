import { useCallback, useEffect, useState } from "react";
import { fetchClaimPreview, fetchMe, type ClaimPreview } from "../auth/authApi";
import { ClaimDialog, claimSnoozed } from "../auth/ClaimDialog";
import { SaveToAccountBanner } from "../auth/GuestBadge";
import { createBoard, fetchBoards, ROLE_LABEL, type BoardListItem } from "./boardsApi";
import { listRecentBoards, recordRecentBoard, type RecentBoard } from "./recentBoards";
import { IconAlert, IconBoard, IconPlus } from "../ui/icons";

/**
 * 我的白板列表（视觉方案 §4.2）。
 *
 * - 登录用户：`GET /api/boards`（最近编辑倒序）；游客 401 → 展示本机"最近打开"。
 * - 认领提示条：登录后 `claim-preview` 有可认领板且未 snooze/未关闭时出现，点「查看」开认领对话框。
 * - 空态 / 加载 / 错误 / 只读 四种状态各自有独立视觉。
 */

type ViewState =
  | { kind: "loading" }
  | { kind: "guest"; items: RecentBoard[] }
  | { kind: "user"; items: BoardListItem[]; user: { displayName: string } }
  | { kind: "error"; message: string };

const CLAIM_DISMISSED_KEY = "wb:boardsClaimDismissed";
const SAVE_BANNER_KEY = "wb:saveBannerDismissed";

export function BoardsPage() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [claimBarVisible, setClaimBarVisible] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [guestBannerVisible, setGuestBannerVisible] = useState(() => !readFlag(SAVE_BANNER_KEY));
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    const me = await fetchMe();
    if (!me.ok) {
      setView({ kind: "guest", items: listRecentBoards() });
      return;
    }
    const list = await fetchBoards();
    if (!list.ok) {
      setView({ kind: "error", message: "列表没刷新成功" });
      return;
    }
    setView({ kind: "user", items: list.data.boards, user: { displayName: me.data.user.displayName } });

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

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const newBoard = async () => {
    if (busy) return;
    setBusy(true);
    setCreateError(null);
    const res = await createBoard();
    setBusy(false);
    if (!res.ok) {
      setCreateError(
        res.status === 429 && res.code === "QUOTA_EXCEEDED"
          ? "已建满 3 块临时板，登录后可以继续。"
          : `没建成（${res.code}），再试一次。`,
      );
      return;
    }
    recordRecentBoard({ id: res.data.id, title: res.data.title });
    window.location.href = `/board/${res.data.id}`;
  };

  const dismissClaimBar = () => {
    setClaimBarVisible(false);
    writeFlag(CLAIM_DISMISSED_KEY);
  };

  const dismissGuestBanner = () => {
    setGuestBannerVisible(false);
    writeFlag(SAVE_BANNER_KEY);
  };

  const isGuest = view.kind === "guest";

  return (
    <div className="wb-page">
      <div className="wb-topbar">
        <a className="wb-brand" href="/">
          <span className="wb-brand__mark" aria-hidden>
            白
          </span>
          白板
        </a>
        <div className="wb-board__spacer" />
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

      <div className="wb-container">
        <div className="wb-boards__head">
          <div className="wb-boards__headline">
            <h1 className="wb-display">{isGuest ? "最近打开" : "我的白板"}</h1>
            {view.kind === "user" || view.kind === "guest" ? (
              <span className="wb-boards__count wb-nums">{view.items.length} 块</span>
            ) : null}
          </div>
          <button
            className="wb-btn wb-btn--primary"
            type="button"
            onClick={() => void newBoard()}
            disabled={busy}
            data-testid="boards-new"
          >
            {busy ? <span className="wb-spinner" aria-hidden /> : <IconPlus />}
            {busy ? "正在新建…" : "新建白板"}
          </button>
        </div>

        {createError ? (
          <div className="wb-inline-note wb-inline-note--danger" style={{ marginTop: "var(--space-4)" }} role="alert">
            <IconAlert />
            <span>{createError}</span>
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

        {view.kind === "loading" ? <LoadingGrid /> : null}

        {view.kind === "error" ? (
          <div className="wb-panel--error" style={{ marginTop: "var(--space-6)" }} role="alert">
            <h2 className="wb-subtitle">{view.message}</h2>
            <p className="wb-caption">列表暂时取不到，已有的白板不会受影响。</p>
            <button className="wb-btn wb-btn--primary" type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}

        {view.kind === "user" && view.items.length === 0 ? <EmptyState onNew={() => void newBoard()} /> : null}

        {view.kind === "guest" && view.items.length === 0 ? (
          <EmptyState
            title="还没有打开过白板"
            hint="这块浏览器还没记录任何临时板。新建一块，立刻开始画。"
            onNew={() => void newBoard()}
          />
        ) : null}

        {view.kind === "user" && view.items.length > 0 ? (
          <div className="wb-grid">
            {view.items.map((item) => (
              <BoardCard key={item.id} board={item} />
            ))}
          </div>
        ) : null}

        {view.kind === "guest" && view.items.length > 0 ? (
          <div className="wb-grid">
            {view.items.map((item) => (
              <RecentCard key={item.id} item={item} />
            ))}
          </div>
        ) : null}
      </div>

      {toast ? <div className="wb-toast">{toast}</div> : null}

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

function BoardCard({ board }: { board: BoardListItem }) {
  return (
    <article className="wb-card wb-board-card" data-testid="board-card" data-board-id={board.id}>
      <a className="wb-board-card__link" href={`/board/${board.id}`}>
        <span className="wb-board-card__thumb" aria-hidden>
          <IconBoard size={20} />
        </span>
        <span className="wb-board-card__title" title={board.title}>
          {board.title}
        </span>
      </a>
      <div className="wb-board-card__meta">
        <span className={`wb-badge ${board.role === "viewer" ? "wb-badge--readonly" : "wb-badge--role"}`}>
          {ROLE_LABEL[board.role] ?? board.role}
        </span>
        <time className="wb-board-card__time wb-nums" dateTime={board.lastEditedAt}>
          {formatRelative(board.lastEditedAt)}
        </time>
      </div>
    </article>
  );
}

function RecentCard({ item }: { item: RecentBoard }) {
  return (
    <article className="wb-card wb-board-card" data-testid="board-card" data-board-id={item.id}>
      <a className="wb-board-card__link" href={`/board/${item.id}`}>
        <span className="wb-board-card__thumb" aria-hidden>
          <IconBoard size={20} />
        </span>
        <span className="wb-board-card__title" title={item.title}>
          {item.title}
        </span>
      </a>
      <div className="wb-board-card__meta">
        <span className="wb-badge wb-badge--guest">临时板</span>
        <time className="wb-board-card__time wb-nums" dateTime={item.lastEditedAt}>
          {formatRelative(item.lastEditedAt)}
        </time>
      </div>
    </article>
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

function LoadingGrid() {
  return (
    <div className="wb-grid" aria-busy data-testid="boards-loading">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="wb-card wb-board-card" key={index}>
          <div className="wb-skeleton" style={{ height: 72 }} />
          <div className="wb-skeleton" style={{ height: 18, width: "62%" }} />
          <div className="wb-skeleton" style={{ height: 14, width: "38%" }} />
        </div>
      ))}
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

function readFlag(key: string): boolean {
  try {
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
