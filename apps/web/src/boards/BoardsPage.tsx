import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClaimPreview, fetchMe, type ClaimPreview } from "../auth/authApi";
import { ClaimDialog, claimSnoozed } from "../auth/ClaimDialog";
import { SaveToAccountBanner } from "../auth/GuestBadge";
import { fetchBoards, ROLE_LABEL, setBoardPinned, type BoardListItem } from "./boardsApi";
import { hasMoreBoards, isPinned, sortBoards, visibleBoards } from "./boardList";
import { loadThumbUrls } from "./boardThumb";
import { listRecentBoards, setRecentPinned, type RecentBoard } from "./recentBoards";
import { SakuraBranch } from "./SakuraBranch";
import { useCreateBoard, type CreateBoardFailureKind } from "./useCreateBoard";
import { IconAlert, IconBoard, IconFlower, IconPin, IconPlus } from "../ui/icons";

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
};

const CLAIM_DISMISSED_KEY = "wb:boardsClaimDismissed";
const SAVE_BANNER_KEY = "wb:saveBannerDismissed";
/** 列表一次取满 30 条（接口上限），页内再按 6 张/页加载更多 */
const FETCH_LIMIT = 30;
const SKELETON_DELAY_MS = 200;
const SKELETON_EXIT_MS = 180;
/** 骨架一旦出现，至少显示这么久再退场，避免「刚出现就消失」的闪烁 */
const SKELETON_MIN_SHOW_MS = 360;

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
        }))
      : sortBoards(view.items).map((item) => ({
          id: item.id,
          title: item.title,
          lastEditedAt: item.lastEditedAt,
          pinned: isPinned(item),
          badge: "临时板",
          badgeTone: "guest",
        }));

  const cardsReady = listReady && thumbsReady;
  const showEmpty = listReady && cards.length === 0;
  const skeletonActive = view.kind === "loading" || (listReady && cards.length > 0 && !thumbsReady);
  const skeletonPhase = useSkeletonPhase(skeletonActive);

  const visible = visibleBoards(cards, page);
  const more = hasMoreBoards(cards.length, page);

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
                    onTogglePin={togglePin}
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
  onTogglePin,
}: {
  board: CardModel;
  thumbUrl?: string;
  pinBusy: boolean;
  onTogglePin: (id: string, pinned: boolean) => void;
}) {
  return (
    <article className="wb-card wb-board-card" data-testid="board-card" data-board-id={board.id}>
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

type SkeletonPhase = "idle" | "waiting" | "shown" | "exiting";

/** waiting 是「已排队但还没到 200ms」的静默阶段，不渲染任何灰块 */
function skeletonVisible(phase: SkeletonPhase): boolean {
  return phase === "shown" || phase === "exiting";
}

/**
 * 延迟显示 + 最短展示 + 交叉淡出：
 * - 数据 200ms 内到达就完全不出现骨架（首屏只看到卡片淡入）；
 * - 真的慢时才显示骨架；一旦显示就至少停留 360ms，再淡出 180ms，
 *   这样不会出现"骨架闪一下就换真实卡片"的抖动。
 */
function useSkeletonPhase(active: boolean, delayMs = SKELETON_DELAY_MS, exitMs = SKELETON_EXIT_MS): SkeletonPhase {
  const [phase, setPhase] = useState<SkeletonPhase>("idle");
  const shownAtRef = useRef(0);

  useEffect(() => {
    if (active) {
      setPhase((current) => (current === "idle" ? "waiting" : current === "exiting" ? "shown" : current));
      return undefined;
    }
    if (phase === "waiting") {
      setPhase("idle");
      return undefined;
    }
    if (phase === "shown") {
      const remain = Math.max(0, shownAtRef.current + SKELETON_MIN_SHOW_MS - performance.now());
      const timer = window.setTimeout(() => setPhase("exiting"), remain);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [active, phase]);

  useEffect(() => {
    if (phase === "waiting") {
      const timer = window.setTimeout(() => {
        shownAtRef.current = performance.now();
        setPhase("shown");
      }, delayMs);
      return () => window.clearTimeout(timer);
    }
    if (phase === "exiting") {
      const timer = window.setTimeout(() => setPhase("idle"), exitMs);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [phase, delayMs, exitMs]);

  return phase;
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
