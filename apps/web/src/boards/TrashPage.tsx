import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchMe, type AuthUser } from "../auth/authApi";
import { boardHref } from "../board/backTarget";
import { SakuraBranch } from "./SakuraBranch";
import {
  emptyTrash,
  fetchTrash,
  purgeBoard,
  restoreBoard,
  type TrashBoardItem,
  type TrashFilter,
} from "./boardsApi";
import {
  formatDeletedAt,
  formatPurgeTitle,
  isExpiringSoon,
  TRASH_PAGE_SIZE,
  TRASH_RETENTION_DAYS,
  trashPill,
} from "./trashMeta";
import { skeletonVisible, useSkeletonPhase } from "./useSkeletonPhase";
import { IconAlert, IconBoard, IconMore, IconRestore, IconTrash, IconUser } from "../ui/icons";

/**
 * 回收站（「我的白板」v1.2 第 1 步）。
 *
 * 布局与文案严格按 `boards-trash` 设计稿：
 * - 紧凑行列表 72px 行高、占位缩略图、12 行一页「加载更多」；
 * - 保留期文案按**实际清理时刻**（每日 03:00）换算，7 天内 warning、24 小时内 danger；
 * - 恢复不弹窗，行内 loading 后直接消失；彻底删除与清空必须二次确认；
 * - 390 窄屏行高 68px，操作收成图标 + 底部弹层。
 *
 * 状态矩阵：loading / ready / empty / error / guest，切筛选时保留旧行并降透明度，
 * 不出现骨架闪换。
 */

type View = "loading" | "ready" | "error" | "guest";

type Toast = { text: string; tone: "ok" | "error"; boardId?: string };

export function TrashPage() {
  const [view, setView] = useState<View>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [user, setUser] = useState<AuthUser | null>(null);

  const [items, setItems] = useState<TrashBoardItem[]>([]);
  const [total, setTotal] = useState(0);
  const [allTotal, setAllTotal] = useState(0);
  const [expiringSoon, setExpiringSoon] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  const [filter, setFilter] = useState<TrashFilter>("all");
  const [filterLoading, setFilterLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [purgeTarget, setPurgeTarget] = useState<TrashBoardItem | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyConfirmed, setEmptyConfirmed] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [sheetItem, setSheetItem] = useState<TrashBoardItem | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const requestIdRef = useRef(0);
  const skeletonPhase = useSkeletonPhase(view === "loading");
  // shown / exiting 都继续渲染骨架：数据到达后骨架先淡出 180ms，真实行再出现
  const showSkeleton = skeletonVisible(skeletonPhase);

  const load = useCallback(async (nextFilter: TrashFilter, offset: number, append: boolean) => {
    const requestId = ++requestIdRef.current;
    if (append) setLoadingMore(true);
    else setFilterLoading(true);

    const result = await fetchTrash({ filter: nextFilter, offset, limit: TRASH_PAGE_SIZE });
    if (requestId !== requestIdRef.current) return;

    if (!result.ok) {
      setLoadingMore(false);
      setFilterLoading(false);
      if (result.status === 401) {
        setView("guest");
        return;
      }
      setErrorMessage("回收站暂时打不开，请稍后重试。");
      setView("error");
      return;
    }

    const data = result.data;
    setItems((prev) => (append ? [...prev, ...data.boards] : data.boards));
    setTotal(data.total);
    setAllTotal(data.allTotal);
    setExpiringSoon(data.expiringSoon);
    setNextOffset(data.nextOffset);
    setView("ready");
    setLoadingMore(false);
    setFilterLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [meResult, trashResult] = await Promise.all([fetchMe(), fetchTrash({ filter: "all", limit: TRASH_PAGE_SIZE })]);
      if (cancelled) return;

      if (!meResult.ok) {
        if (meResult.status === 401) {
          setView("guest");
          return;
        }
        setErrorMessage("账号信息没取到，请刷新重试。");
        setView("error");
        return;
      }
      setUser(meResult.data.user);

      if (!trashResult.ok) {
        if (trashResult.status === 401) {
          setView("guest");
          return;
        }
        setErrorMessage("回收站暂时打不开，请稍后重试。");
        setView("error");
        return;
      }

      const data = trashResult.data;
      setItems(data.boards);
      setTotal(data.total);
      setAllTotal(data.allTotal);
      setExpiringSoon(data.expiringSoon);
      setNextOffset(data.nextOffset);
      setView("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const changeFilter = (next: TrashFilter) => {
    if (next === filter || filterLoading) return;
    setFilter(next);
    setItems([]);
    void load(next, 0, false);
  };

  const handleRestore = async (item: TrashBoardItem) => {
    if (busyId) return;
    setBusyId(item.id);
    const result = await restoreBoard(item.id);
    setBusyId(null);
    setSheetItem(null);

    if (!result.ok) {
      setToast({ text: result.code === "NOT_FOUND" ? "这块白板已被清理，无法恢复。" : "恢复失败，请重试。", tone: "error" });
      void load(filter, 0, false);
      return;
    }

    setItems((prev) => prev.filter((row) => row.id !== item.id));
    setTotal((value) => Math.max(0, value - 1));
    setAllTotal((value) => Math.max(0, value - 1));
    if (isExpiringSoon(item.purgeAt)) setExpiringSoon((value) => Math.max(0, value - 1));
    setToast({
      text: result.data.renamed
        ? `已恢复，并重命名为「${result.data.title}」`
        : `已恢复「${result.data.title}」`,
      tone: "ok",
      boardId: item.id,
    });
  };

  const handlePurge = async () => {
    if (!purgeTarget || dialogBusy) return;
    setDialogBusy(true);
    const target = purgeTarget;
    const result = await purgeBoard(target.id);
    setDialogBusy(false);

    if (!result.ok) {
      setPurgeTarget(null);
      setToast({ text: result.code === "NOT_FOUND" ? "这块白板已经不在回收站了。" : "删除失败，请重试。", tone: "error" });
      void load(filter, 0, false);
      return;
    }

    setItems((prev) => prev.filter((row) => row.id !== target.id));
    setTotal((value) => Math.max(0, value - 1));
    setAllTotal((value) => Math.max(0, value - 1));
    setPurgeTarget(null);
    setToast({ text: `已彻底删除「${target.title}」`, tone: "ok" });
  };

  const handleEmpty = async () => {
    if (!emptyConfirmed || dialogBusy) return;
    setDialogBusy(true);
    const result = await emptyTrash();
    setDialogBusy(false);

    if (!result.ok) {
      setEmptyOpen(false);
      setToast({ text: "清空失败，请重试。", tone: "error" });
      void load(filter, 0, false);
      return;
    }

    setItems([]);
    setTotal(0);
    setAllTotal(0);
    setExpiringSoon(0);
    setNextOffset(null);
    setEmptyOpen(false);
    setEmptyConfirmed(false);
    setToast({ text: `已清空回收站，永久删除 ${result.data.purged} 块白板`, tone: "ok" });
  };

  return (
    <div className="wb-page wb-page--boards wb-page--trash">
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
        <a className="wb-link wb-trash__back" href="/boards">
          我的白板
        </a>
        <span className="wb-trash__nav is-active" aria-current="page">
          <IconTrash size={15} />
          <span className="wb-trash__nav-text">回收站</span>
          {allTotal > 0 ? <span className="wb-trash__badge wb-nums">{allTotal > 99 ? "99+" : allTotal}</span> : null}
        </span>
        {user ? (
          <span className="wb-caption" data-testid="trash-user">
            {user.displayName}
          </span>
        ) : null}
      </div>

      <div className="wb-container wb-container--boards wb-trash">
        <div className="wb-boards__head">
          <div className="wb-boards__headline">
            <h1 className="wb-display">回收站</h1>
            {view === "ready" ? <span className="wb-boards__count wb-nums">{allTotal} 块</span> : null}
          </div>
          <button
            className="wb-btn wb-btn--danger-outline wb-btn--sm wb-trash__clear"
            type="button"
            disabled={view !== "ready" || allTotal === 0 || filterLoading}
            onClick={() => {
              setEmptyConfirmed(false);
              setEmptyOpen(true);
            }}
            data-testid="trash-empty"
          >
            <IconTrash size={15} />
            清空回收站
          </button>
        </div>
        <p className="wb-trash__sub">删除的白板会在这里保留 {TRASH_RETENTION_DAYS} 天，到期后自动彻底删除。</p>

        {view === "ready" && expiringSoon > 0 ? (
          <div className="wb-trash__notice" role="status">
            <IconAlert size={16} />
            <span>
              还有 <strong className="wb-nums">{expiringSoon}</strong> 块白板将在 7 天内到期
            </span>
            <button
              className="wb-trash__notice-link"
              type="button"
              onClick={() => changeFilter("expiring")}
              disabled={filter === "expiring"}
            >
              只看即将到期
            </button>
          </div>
        ) : null}

        {view === "ready" ? (
          <div className="wb-trash__chips" role="tablist" aria-label="回收站筛选">
            <button
              className={`wb-trash__chip${filter === "all" ? " is-on" : ""}`}
              type="button"
              role="tab"
              aria-selected={filter === "all"}
              onClick={() => changeFilter("all")}
            >
              全部
              <span className="wb-trash__chip-count wb-nums">{allTotal}</span>
            </button>
            <button
              className={`wb-trash__chip${filter === "expiring" ? " is-on" : ""}`}
              type="button"
              role="tab"
              aria-selected={filter === "expiring"}
              onClick={() => changeFilter("expiring")}
            >
              7 天内到期
              <span className="wb-trash__chip-count wb-nums">{expiringSoon}</span>
            </button>
          </div>
        ) : null}

        {view === "error" ? (
          <div className="wb-panel--error" style={{ marginTop: "var(--space-6)" }} role="alert">
            <h2 className="wb-subtitle">{errorMessage}</h2>
            <p className="wb-caption">已删除的白板不会因此丢失。</p>
            <button className="wb-btn wb-btn--primary" type="button" onClick={() => window.location.reload()}>
              刷新重试
            </button>
          </div>
        ) : null}

        {view === "guest" ? (
          <div className="wb-trash__empty">
            <span className="wb-trash__empty-icon" aria-hidden>
              <IconTrash size={22} />
            </span>
            <h2 className="wb-subtitle">登录后才能使用回收站</h2>
            <p className="wb-caption">临时白板没有回收站，删除后无法恢复。</p>
            <a className="wb-btn wb-btn--primary" href="/login?returnTo=%2Fboards%2Ftrash">
              登录 / 注册
            </a>
          </div>
        ) : null}

        {view === "ready" || showSkeleton ? (
          <div
            className={`wb-trash__list${filterLoading ? " is-busy" : ""}`}
            aria-busy={filterLoading || showSkeleton}
            data-testid="trash-list"
          >
            <div className="wb-trash__head" aria-hidden>
              <span />
              <span>白板</span>
              <span>所在空间</span>
              <span>删除时间</span>
              <span>保留期</span>
              <span className="wb-trash__head-acts">操作</span>
            </div>

            {showSkeleton
              ? Array.from({ length: 7 }).map((_, index) => (
                  <div className="wb-trash__row wb-trash__row--skeleton" key={`skeleton-${index}`} aria-hidden>
                    <span className="wb-trash__tile wb-skeleton" />
                    <span className="wb-trash__sk-line wb-skeleton" />
                    <span className="wb-trash__sk-line wb-trash__sk-line--short wb-skeleton" />
                    <span className="wb-trash__sk-line wb-trash__sk-line--short wb-skeleton" />
                    <span className="wb-trash__sk-pill wb-skeleton" />
                    <span />
                  </div>
                ))
              : null}

            {view === "ready" && !showSkeleton && items.length === 0 ? (
              <div className="wb-trash__empty wb-trash__empty--inlist">
                <span className="wb-trash__empty-icon" aria-hidden>
                  <IconTrash size={22} />
                </span>
                <h2 className="wb-subtitle">{filter === "expiring" ? "没有即将到期的白板" : "回收站是空的"}</h2>
                <p className="wb-caption">
                  {filter === "expiring"
                    ? "切换到「全部」看看其他已删除的白板。"
                    : "删除的白板会出现在这里，30 天内都可以恢复。"}
                </p>
                {filter === "expiring" ? (
                  <button className="wb-btn wb-btn--secondary wb-btn--sm" type="button" onClick={() => changeFilter("all")}>
                    查看全部
                  </button>
                ) : (
                  <a className="wb-btn wb-btn--secondary wb-btn--sm" href="/boards">
                    回到我的白板
                  </a>
                )}
              </div>
            ) : null}

            {view === "ready" && !showSkeleton
              ? items.map((item) => {
                  const pill = trashPill(item.purgeAt);
                  return (
                    <div className="wb-trash__row" key={item.id} data-testid="trash-row">
                      <span className="wb-trash__tile" aria-hidden>
                        <IconBoard size={18} />
                      </span>
                      <div className="wb-trash__body">
                        <span className="wb-trash__title" title={item.title}>
                          {item.title}
                        </span>
                        <span className="wb-trash__meta-mobile">
                          <IconUser size={12} />
                          个人空间
                          <span className="wb-trash__dot" aria-hidden />
                          <span className="wb-nums">{formatDeletedAt(item.deletedAt)}</span>
                          <span className="wb-trash__dot" aria-hidden />
                          <span className={`wb-trash__meta-pill is-${pill.tone}`}>{pill.label}</span>
                        </span>
                      </div>
                      <span className="wb-trash__space">
                        <IconUser size={13} />
                        个人空间
                      </span>
                      <span className="wb-trash__time wb-nums" title={formatPurgeTitle(item.purgeAt)}>
                        {formatDeletedAt(item.deletedAt)}
                      </span>
                      <span className="wb-trash__keep">
                        <span className={`wb-trash__pill is-${pill.tone}`} title={formatPurgeTitle(item.purgeAt)}>
                          {pill.label}
                        </span>
                      </span>
                      <span className="wb-trash__acts">
                        <button
                          className="wb-trash__act"
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => void handleRestore(item)}
                          data-testid="trash-restore"
                        >
                          {busyId === item.id ? <span className="wb-spinner wb-spinner--sm" aria-hidden /> : <IconRestore size={14} />}
                          恢复
                        </button>
                        <button
                          className="wb-trash__act wb-trash__act--danger"
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => setPurgeTarget(item)}
                        >
                          彻底删除
                        </button>
                      </span>
                      <span className="wb-trash__acts-mobile">
                        <button
                          className="wb-trash__icon-btn"
                          type="button"
                          aria-label={`恢复「${item.title}」`}
                          disabled={busyId === item.id}
                          onClick={() => void handleRestore(item)}
                        >
                          {busyId === item.id ? <span className="wb-spinner wb-spinner--sm" aria-hidden /> : <IconRestore size={16} />}
                        </button>
                        <button
                          className="wb-trash__icon-btn"
                          type="button"
                          aria-label={`更多操作：${item.title}`}
                          onClick={() => setSheetItem(item)}
                        >
                          <IconMore size={16} />
                        </button>
                      </span>
                    </div>
                  );
                })
              : null}
          </div>
        ) : null}

        {view === "ready" && nextOffset !== null ? (
          <div className="wb-trash__more">
            <button
              className="wb-btn wb-btn--secondary wb-btn--sm"
              type="button"
              disabled={loadingMore}
              onClick={() => void load(filter, nextOffset, true)}
            >
              {loadingMore ? <span className="wb-spinner wb-spinner--sm" aria-hidden /> : null}
              {loadingMore ? "加载中…" : `加载更多（还有 ${Math.max(0, total - items.length)} 块）`}
            </button>
          </div>
        ) : null}

        {view === "ready" ? (
          <div className="wb-trash__foot">
            <span>回收站保留 30 天，每天 03:00 自动清理到期白板。</span>
            <span className="wb-trash__foot-count wb-nums">
              共 {total} 块 · 已显示 {items.length} 块
            </span>
          </div>
        ) : null}
      </div>

      {purgeTarget ? (
        <ConfirmDialog
          title={`彻底删除「${purgeTarget.title}」？`}
          description="这块白板、所有画布内容与协作记录都会被永久删除，无法恢复。"
          confirmLabel="彻底删除"
          busy={dialogBusy}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={() => void handlePurge()}
        />
      ) : null}

      {emptyOpen ? (
        <ConfirmDialog
          title="清空回收站？"
          description={`回收站里的 ${allTotal} 块白板会被永久删除，无法恢复。`}
          confirmLabel={`永久删除 ${allTotal} 块`}
          busy={dialogBusy}
          confirmDisabled={!emptyConfirmed}
          onCancel={() => setEmptyOpen(false)}
          onConfirm={() => void handleEmpty()}
        >
          <label className="wb-trash__check">
            <input
              type="checkbox"
              checked={emptyConfirmed}
              onChange={(event) => setEmptyConfirmed(event.target.checked)}
            />
            <span>我知道这些白板无法恢复</span>
          </label>
        </ConfirmDialog>
      ) : null}

      {sheetItem ? (
        <div className="wb-sheet-layer" role="presentation" onClick={() => setSheetItem(null)}>
          <div
            className="wb-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`操作：${sheetItem.title}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="wb-sheet__grip" aria-hidden />
            <p className="wb-sheet__title">{sheetItem.title}</p>
            <button
              className="wb-sheet__item"
              type="button"
              onClick={() => void handleRestore(sheetItem)}
            >
              <IconRestore size={16} />
              恢复白板
            </button>
            <button
              className="wb-sheet__item wb-sheet__item--danger"
              type="button"
              onClick={() => {
                setPurgeTarget(sheetItem);
                setSheetItem(null);
              }}
            >
              <IconTrash size={16} />
              彻底删除
            </button>
            <button className="wb-sheet__item wb-sheet__item--cancel" type="button" onClick={() => setSheetItem(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className={`wb-toast wb-trash__toast is-${toast.tone}`} role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.boardId ? (
            <a className="wb-toast__link" href={boardHref(toast.boardId, "/boards/trash")}>
              打开
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConfirmDialog(props: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !props.busy) props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.busy, props.onCancel]);

  return (
    <div className="wb-overlay" role="presentation" onClick={() => (props.busy ? undefined : props.onCancel())}>
      <div
        className="wb-dialog wb-trash__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="wb-dialog__title">{props.title}</h2>
        <p className="wb-dialog__desc">{props.description}</p>
        {props.children}
        <div className="wb-dialog__actions">
          <button ref={cancelRef} className="wb-btn wb-btn--ghost" type="button" disabled={props.busy} onClick={props.onCancel}>
            取消
          </button>
          <button
            className="wb-btn wb-btn--danger"
            type="button"
            disabled={props.busy || props.confirmDisabled}
            onClick={props.onConfirm}
          >
            {props.busy ? <span className="wb-spinner wb-spinner--sm" aria-hidden /> : null}
            {props.busy ? "正在删除…" : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
