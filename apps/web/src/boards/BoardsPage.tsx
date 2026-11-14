import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { fetchClaimPreview, fetchMe, type ClaimPreview } from "../auth/authApi";
import { ClaimDialog, claimSnoozed } from "../auth/ClaimDialog";
import { SaveToAccountBanner } from "../auth/GuestBadge";
import {
  batchPinBoards,
  batchTrashBoards,
  createShareLink,
  fetchBoards,
  fetchTrashCount,
  renameBoard,
  reorderBoard,
  restoreBoard,
  ROLE_LABEL,
  setBoardPinned,
  setSortMode,
  type BoardListItem,
  type BoardSortMode,
} from "./boardsApi";
import { moveBoardToTrash } from "./boardActions";
import { clearBoardCache } from "../store/cacheDb";
import { BatchSelectionBar } from "./BatchSelectionBar";
import { BatchTrashDialog } from "./BatchTrashDialog";
import { BoardCardMenu, type BoardMenuTarget } from "./BoardCardMenu";
import type { MenuAnchor } from "./boardMenu";
import { BOARDS_CAPACITY, isPinned, sortBoards } from "./boardList";
import { boardsLayout, pinTargets, rangeIds, selectionState, trashTargets, type SelectableCard } from "./selection";
import { dropIndex, moveItem, neighborsAt, splitGroups } from "./sortOrder";
import { loadThumbUrls } from "./boardThumb";
import { listRecentBoards, removeRecentBoard, setRecentPinned, type RecentBoard } from "./recentBoards";
import { SakuraBranch } from "./SakuraBranch";
import { useCreateBoard, type CreateBoardFailureKind } from "./useCreateBoard";
import { skeletonVisible, useSkeletonPhase } from "./useSkeletonPhase";
import { IconAlert, IconBoard, IconCheck, IconFlower, IconMore, IconPin, IconPlus, IconTrash } from "../ui/icons";
import type { SpaceSummary } from "@whiteboard/shared";import { fetchSpaces } from "./spaceApi";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { SpaceSettings } from "./SpaceSettings";

/**
 * 我的白板列表（视觉方案 §4.2）。
 *
 * - 登录用户：`GET /api/boards`（置顶优先，其次最近编辑倒序）；游客 401 → 展示本机"最近打开"。
 * - 背景 A：天空渐变前四档在 420px 内淡回 `--bg`，右上角一枝樱花；<700px 隐藏枝条。
 * - 卡片缩略图来自进板首帧快照（IndexedDB `wb-cache/thumbs`），没有快照时回退线稿图标。
 * - 骨架与真实卡片同盒模型（16:10 缩略图 / 22px 标题行 / 24px 元信息行）；
 *   加载超过 200ms 才显示骨架，数据到达时两者交叉淡出淡入，首屏不闪白、不位移。
 * - 一页最多 15 张（5 列 × 3 行），不翻页；服务端在创建第 16 块时淘汰一块，
 *   所以正常情况下列表永远不超过 15。
 */

type ViewState =
  | { kind: "loading" }
  | { kind: "guest"; items: RecentBoard[] }
  | { kind: "user"; items: BoardListItem[]; user: { displayName: string } }
  | { kind: "error"; message: string }
  /** `?space=` 指向的空间不存在 / 已不是成员：404 面板，不自动回退 */
  | { kind: "missing" };

type CardModel = {
  id: string;
  title: string;
  lastEditedAt: string;
  pinned: boolean;
  badge: string;
  badgeTone: "role" | "readonly" | "guest" | "member";
  role: string;
  guest?: boolean;
  /** 团队空间：这块板是不是我创建的 */
  isOwn?: boolean;
};

type UndoState =
  | { kind: "trash"; ids: string[]; title?: string; failed?: number; ttl: number }
  | { kind: "pin"; changes: { id: string; pinned: boolean }[]; pinned: boolean; skipped: number; ttl: number }
  /** 排序保存失败：整表已回滚，toast 提供一次重试 */
  | { kind: "sort"; id: string; neighbors: { beforeId: string | null; afterId: string | null }; ttl: number }
  /** 首次拖动切到自定义顺序：toast 提供「恢复自动」 */
  | { kind: "mode"; ttl: number };

type DragGroupKey = "pinned" | "others";

type DragSession = {
  id: string;
  group: DragGroupKey;
  from: number;
  to: number;
  ghost: { left: number; top: number; width: number; height: number };
  line: { kind: "v" | "h"; left: number; top: number; width: number; height: number } | null;
  noDrop: boolean;
};

type DragSource = {
  id: string;
  group: DragGroupKey;
  from: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** 按下点相对卡片左上角，ghost 跟手但不跳位 */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  active: boolean;
};

type TrashConfirm = {
  rows: SelectableCard[];
  targets: SelectableCard[];
  skipped: SelectableCard[];
};

const CLAIM_DISMISSED_KEY = "wb:boardsClaimDismissed";
const SAVE_BANNER_KEY = "wb:saveBannerDismissed";
/** 列表容量 15（桌面 4 列 × 3 行只能完整显示 12 张，多出的续到第 4 行、页面可滚动） */
const FETCH_LIMIT = BOARDS_CAPACITY;
/** 700 以下交给 CSS 单列滚动，不再按宽度均分 */
const MOBILE_BREAKPOINT = 700;
const SPACE_ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读",
};

/** 本页的建板失败文案：沿用这一页原来的措辞，避免因为共用 hook 改掉已有提示 */
function boardsMessageFor({ kind, code }: { kind: CreateBoardFailureKind; code?: string }): string {
  if (kind === "quota") return "已建满 3 块临时板，登录后可以继续。";
  if (kind === "offline") return "连不上服务器，恢复网络后再试。";
  return `没建成（${code}），再试一次。`;
}

export function BoardsPage() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  // 空间上下文：spaceId 为空表示尚未确定；个人空间在 URL 上不写 ?space=
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const spaceIdRef = useRef("");
  const [spaceRole, setSpaceRole] = useState<string>("owner");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [claimBarVisible, setClaimBarVisible] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [guestBannerVisible, setGuestBannerVisible] = useState(() => !readFlag(SAVE_BANNER_KEY));
  const [toast, setToast] = useState<string | null>(null);
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
  const [undoToast, setUndoToast] = useState<UndoState | null>(null);
  // 批量选择：Set 只存 id，范围选择与权限判断都走 selection.ts
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allScope, setAllScope] = useState(false);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [trashConfirm, setTrashConfirm] = useState<TrashConfirm | null>(null);
  /** 游客删除临时板：物理删除不可恢复，先确认再走接口 */
  const [guestTrash, setGuestTrash] = useState<CardModel | null>(null);
  const [guestTrashBusy, setGuestTrashBusy] = useState(false);
  const selectEntryRef = useRef<HTMLButtonElement>(null);
  // 拖拽排序：组内接管（方案 B），置顶组与普通组固定，不跨组
  const [sortMode, setSortModeState] = useState<BoardSortMode>("auto");
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [movedId, setMovedId] = useState<string | null>(null);
  const [sortBusy, setSortBusy] = useState(false);
  const [picker, setPicker] = useState<{ board: CardModel; group: DragGroupKey } | null>(null);
  const [pickTarget, setPickTarget] = useState(0);
  const [kbPick, setKbPick] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const dragSourceRef = useRef<DragSource | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const previewGroupsRef = useRef<{ pinned: string[]; others: string[] } | null>(null);
  const dragApiRef = useRef<{ begin: (source: DragSource) => void; move: (x: number, y: number) => void; end: (commit: boolean) => void } | null>(null);
  const touchTimerRef = useRef<number | null>(null);
  const currentSpace = spaces.find((space) => space.id === spaceId) ?? null;
  const role = currentSpace?.role ?? spaceRole;
  const readOnly = role === "viewer";
  // 建板逻辑（含配额/离线/慢请求处理）统一走 useCreateBoard，与旧首页入口同一份实现
  const { busy, slow, error: createError, start } = useCreateBoard({
    messageFor: boardsMessageFor,
    spaceId: currentSpace?.kind === "team" ? currentSpace.id : undefined,
  });

  const load = useCallback(async (targetSpace?: string) => {
    setView({ kind: "loading" });
    setSelectMode(false);
    setSelected(new Set());
    setAllScope(false);
    setAnchorId(null);
    setFocusedId(null);
    setTrashConfirm(null);
    setGuestTrash(null);
    setMenu(null);
    setSettingsOpen(false);
    setPreviewIds(null);
    previewGroupsRef.current = null;
    const me = await fetchMe();
    if (!me.ok) {
      setSpaces([]);
      setView({ kind: "guest", items: listRecentBoards() });
      return;
    }

    // 空间是列表的一级上下文：先取空间列表，再按空间取白板
    const spacesResult = await fetchSpaces();
    if (!spacesResult.ok) {
      setView({ kind: "error", message: "列表没刷新成功" });
      return;
    }
    const listSpaces = spacesResult.data.spaces;
    setSpaces(listSpaces);
    const personal = listSpaces.find((space) => space.kind === "personal");
    const requested = targetSpace ?? new URLSearchParams(window.location.search).get("space") ?? "";
    const candidate = requested || personal?.id || "";
    if (!candidate || !listSpaces.some((space) => space.id === candidate)) {
      // 地址栏是唯一真相：空间没了就显示 404，不偷偷切回个人空间
      setView({ kind: "missing" });
      return;
    }
    spaceIdRef.current = candidate;
    setSpaceId(candidate);

    const list = await fetchBoards(FETCH_LIMIT, 0, candidate);
    if (!list.ok) {
      setView(list.status === 404 ? { kind: "missing" } : { kind: "error", message: "列表没刷新成功" });
      return;
    }
    setSpaceRole(list.data.spaceRole ?? "owner");
    setSortModeState(list.data.sortMode);
    setView({
      kind: "user",
      items: sortBoards(list.data.boards, list.data.sortMode),
      user: { displayName: me.data.user.displayName },
    });

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

  // 前进 / 后退按地址栏重新加载；切空间用 pushState，刷新后仍停在同一个空间
  useEffect(() => {
    const onPop = () => void load();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
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

  // 撤销 toast：单卡删除 5 秒，批量删除 8 秒，置顶 5 秒
  useEffect(() => {
    if (!undoToast) return;
    const timer = window.setTimeout(() => setUndoToast(null), undoToast.ttl);
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
      ? sortBoards(view.items, sortMode).map((item) => ({
          id: item.id,
          title: item.title,
          lastEditedAt: item.lastEditedAt,
          pinned: isPinned(item),
          // 团队空间把徽标换成「谁创建」：空间名已经在标题区，卡片里不再重复
          badge:
            currentSpace?.kind === "team"
              ? item.isOwn
                ? "我创建"
                : (item.ownerName ?? "成员")
              : (ROLE_LABEL[item.role] ?? item.role),
          badgeTone:
            currentSpace?.kind === "team"
              ? item.isOwn
                ? "role"
                : "member"
              : item.role === "viewer"
                ? "readonly"
                : "role",
          role: item.role,
          isOwn: item.isOwn,
        }))
      : sortBoards(view.items, sortMode).map((item) => ({
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

  // 容量 15：服务端已按容量淘汰，这里再截一次兜底（脏数据/竞态时不渲染第 16 张）
  const paged = cards.slice(0, BOARDS_CAPACITY);
  // 拖拽中的乐观顺序：只在预览里重排，松手保存成功后才回落到服务端顺序
  const visible = previewIds
    ? (() => {
        const byId = new Map(paged.map((card) => [card.id, card]));
        const ordered = previewIds
          .map((id) => byId.get(id))
          .filter((card): card is CardModel => Boolean(card));
        const seen = new Set(ordered.map((card) => card.id));
        return [...ordered, ...paged.filter((card) => !seen.has(card.id))];
      })()
    : paged;
  const selectedCount = cards.filter((card) => selected.has(card.id)).length;
  // 只读成员不能批量选择（批量动作全是写操作）；游客可以，但只保留物理删除
  const isSelectable = isGuest || (view.kind === "user" && !readOnly);
  const canSort = view.kind === "user" && !selectMode && !sortBusy && !readOnly;
  const groupsNow = splitGroups(visible);
  const groupIdsOf = (group: DragGroupKey): string[] =>
    (group === "pinned" ? groupsNow.pinned : groupsNow.others).map((card) => card.id);

  /**
   * 桌面端宽度优先：卡片宽度只由列宽决定，四列均分内容区并铺满，不因高度不足而缩小。
   * 页头留白收一档（上下 16、网格上边距 8）当作软预算；三行仍放不下时让页面滚动。
   */
  const cardCount = groupsNow.pinned.length + groupsNow.others.length;
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const container = grid.closest<HTMLElement>(".wb-container");
    const wrapper = grid.parentElement;

    const reset = () => {
      grid.style.removeProperty("--wb-card-w");
      grid.style.removeProperty("--wb-cols");
      container?.style.removeProperty("padding-top");
      container?.style.removeProperty("padding-bottom");
      wrapper?.style.removeProperty("margin-top");
    };

    const apply = () => {
      if (window.innerWidth <= MOBILE_BREAKPOINT) {
        reset();
        return;
      }
      const width = grid.clientWidth;
      if (!(width > 0)) return;
      container?.style.setProperty("padding-top", "16px");
      container?.style.setProperty("padding-bottom", "16px");
      wrapper?.style.setProperty("margin-top", "8px");
      const { cardWidth, columns } = boardsLayout({ width });
      grid.style.setProperty("--wb-card-w", `${cardWidth}px`);
      grid.style.setProperty("--wb-cols", String(columns));
    };
    apply();
    window.addEventListener("resize", apply);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(grid);
    return () => {
      window.removeEventListener("resize", apply);
      observer?.disconnect();
    };
  }, [cardCount, cardsReady]);

  // 翻页 / 列表变化后，焦点卡不在当前页时回落到第一张
  useEffect(() => {
    if (!selectMode) return;
    if (focusedId && visible.some((card) => card.id === focusedId)) return;
    setFocusedId(visible[0]?.id ?? null);
  }, [selectMode, focusedId, visible]);

  const focusCheckbox = (id: string) => {
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-select-check="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true });
    });
  };

  const enterSelect = () => {
    if (!isSelectable) return;
    setSelectMode(true);
    setSelected(new Set());
    setAllScope(false);
    setAnchorId(null);
    setFocusedId(visible[0]?.id ?? null);
  };

  const exitSelect = (restoreFocus = true) => {
    setSelectMode(false);
    setSelected(new Set());
    setAllScope(false);
    setAnchorId(null);
    setFocusedId(null);
    setTrashConfirm(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => selectEntryRef.current?.focus({ preventScroll: true }));
    }
  };

  const toggleCard = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAllScope(false);
    setAnchorId(id);
    setFocusedId(id);
    focusCheckbox(id);
  };

  const extendSelection = (id: string) => {
    const order = visible.map((card) => card.id);
    const range = rangeIds(order, anchorId ?? id, id);
    setSelected((current) => new Set([...current, ...range]));
    setAllScope(false);
    setAnchorId(id);
    setFocusedId(id);
    focusCheckbox(id);
  };

  /** Cmd/Ctrl/Shift + 点击卡片链接：进入选择态并勾选；普通点击仍然进板。 */
  const enterSelectWith = (id: string, extend: boolean) => {
    if (!isSelectable) return;
    setSelectMode(true);
    if (extend) {
      const order = visible.map((card) => card.id);
      setSelected((current) => new Set([...current, ...rangeIds(order, anchorId ?? id, id)]));
    } else {
      setSelected((current) => new Set([...current, id]));
    }
    setAllScope(false);
    setAnchorId(id);
    setFocusedId(id);
    focusCheckbox(id);
  };

  const toggleAll = () => {
    const ids = visible.map((card) => card.id);
    if (selectionState(ids, selected) === "all") {
      setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((current) => new Set([...current, ...ids]));
      setAnchorId(ids[0] ?? null);
    }
    setAllScope(false);
    setFocusedId(ids[0] ?? null);
  };

  const selectAllLoaded = () => {
    setSelected(new Set(cards.map((card) => card.id)));
    setAllScope(true);
    setAnchorId(cards[0]?.id ?? null);
    setFocusedId(cards[0]?.id ?? null);
  };

  const clearAll = () => {
    setSelected(new Set());
    setAllScope(false);
    setAnchorId(null);
    setFocusedId(visible[0]?.id ?? null);
  };

  const invertVisible = () => {
    const ids = visible.map((card) => card.id);
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => (next.has(id) ? next.delete(id) : next.add(id)));
      return next;
    });
    setAllScope(false);
    setAnchorId(ids[0] ?? null);
  };

  const moveSelectionFocus = (id: string | undefined, extend: boolean) => {
    if (!id) return;
    setFocusedId(id);
    if (extend) {
      const order = visible.map((card) => card.id);
      const range = rangeIds(order, anchorId ?? id, id);
      setSelected((current) => new Set([...current, ...range]));
      setAllScope(false);
    }
    focusCheckbox(id);
  };

  const openBatchTrash = () => {
    if (selectedCount === 0) return;
    const rows = cards.filter((card) => selected.has(card.id));
    const result = trashTargets(cards, selected);
    setTrashConfirm({ rows, targets: result.targets, skipped: result.skipped });
  };

  const onPageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!selectMode) return;
    if (event.key === "Escape" && !trashConfirm) {
      event.preventDefault();
      exitSelect();
    }
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!selectMode) return;
    const target = event.target as HTMLElement;
    const current =
      target.closest<HTMLElement>("[data-select-check]")?.dataset.selectCheck ?? null;
    const order = visible.map((card) => card.id);
    const index = current ? order.indexOf(current) : -1;

    if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (index < 0) return;
      event.preventDefault();
      const columns = gridColumnsNow();
      const delta =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" ? columns : -columns;
      const next = Math.min(order.length - 1, Math.max(0, index + delta));
      moveSelectionFocus(order[next], event.shiftKey);
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      if (index < 0) return;
      event.preventDefault();
      moveSelectionFocus(event.key === "Home" ? order[0] : order[order.length - 1], event.shiftKey);
      return;
    }

    if ((event.key === "a" || event.key === "A") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      toggleAll();
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      openBatchTrash();
    }
  };

  const onBlankPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectMode) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        '[data-testid="board-card"], .wb-boards__head, .wb-selection-mobile, .wb-batch-menu, .wb-sheet-layer, .wb-toast, .wb-overlay',
      )
    ) {
      return;
    }
    exitSelect();
  };

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

  const selectSpace = (id: string) => {
    const space = spaces.find((entry) => entry.id === id);
    if (!space || id === spaceIdRef.current) return;
    window.history.pushState(
      {},
      "",
      space.kind === "team" ? `/boards?space=${encodeURIComponent(id)}` : "/boards",
    );
    window.scrollTo({ top: 0, behavior: "auto" });
    void load(id);
  };

  const handleSpaceCreated = (space: SpaceSummary) => {
    setSpaces((current) => [...current, space]);
    window.history.pushState({}, "", `/boards?space=${encodeURIComponent(space.id)}`);
    void load(space.id);
  };

  const backToPersonal = () => {
    window.history.pushState({}, "", "/boards");
    void load();
  };

  const refreshList = useCallback(async () => {
    const list = await fetchBoards(FETCH_LIMIT, 0, spaceIdRef.current || undefined);
    if (!list.ok) return;
    setSortModeState(list.data.sortMode);
    setView((current) =>
      current.kind === "user" ? { ...current, items: sortBoards(list.data.boards, list.data.sortMode) } : current,
    );
  }, []);

  const trashBoard = async (board: CardModel) => {
    const index = cards.findIndex((item) => item.id === board.id);
    const result = await moveBoardToTrash(board.id);
    if (!result) {
      setToast("没删成功，再试一次。");
      return;
    }
    // 游客临时板是物理删除：不进回收站、没有 5 秒撤销，本机最近记录与缩略图一起清掉
    if (result.mode === "purged") {
      removeRecentBoard(board.id);
      setView((current) =>
        current.kind === "guest"
          ? { ...current, items: current.items.filter((item) => item.id !== board.id) }
          : current,
      );
      setToast(`已删除临时板「${board.title}」`);
    } else {
      setView((current) =>
        current.kind === "user"
          ? { ...current, items: current.items.filter((item) => item.id !== board.id) }
          : current,
      );
      setTrashCount((count) => count + 1);
      setUndoToast({ kind: "trash", ids: [board.id], title: board.title, ttl: 5000 });
    }
    // 焦点落到原位置的下一条卡片，避免删除后焦点丢回 body
    window.requestAnimationFrame(() => {
      const links = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="board-card"] .wb-board-card__link'),
      );
      links[Math.min(index, links.length - 1)]?.focus({ preventScroll: true });
    });
  };

  const confirmGuestTrash = async () => {
    const board = guestTrash;
    if (!board || guestTrashBusy) return;
    setGuestTrashBusy(true);
    await trashBoard(board);
    setGuestTrashBusy(false);
    setGuestTrash(null);
  };

  const undoLast = async () => {
    const target = undoToast;
    if (!target) return;
    setUndoToast(null);

    if (target.kind === "trash") {
      let restored = 0;
      for (const id of target.ids) {
        const result = await restoreBoard(id);
        if (result.ok) restored += 1;
      }
      if (restored === 0) {
        setToast("恢复没成功，请到回收站里恢复。");
        return;
      }
      setTrashCount((count) => Math.max(0, count - restored));
      await refreshList();
      setToast(
        target.ids.length === 1 && target.title
          ? `已恢复「${target.title}」`
          : `已恢复 ${restored} 块白板`,
      );
      return;
    }

    if (target.kind === "sort") {
      await commitOrder(target.id, target.neighbors);
      return;
    }

    if (target.kind === "mode") {
      await restoreAutoSort();
      return;
    }

    let undone = 0;
    for (const change of target.changes) {
      const result = await setBoardPinned(change.id, change.pinned);
      if (result.ok) undone += 1;
    }
    await refreshList();
    setToast(undone > 0 ? "已撤销置顶操作" : "撤销没成功，再试一次。");
  };

  const runBatchPin = async (pinned: boolean) => {
    const targets = pinTargets(cards, selected).targets;
    if (targets.length === 0) return;
    const ids = targets.map((card) => card.id);
    const previous = targets.map((card) => ({ id: card.id, pinned: card.pinned === true }));
    setBatchBusy(true);
    const result = await batchPinBoards(ids, pinned);
    setBatchBusy(false);
    if (!result.ok) {
      setToast("批量置顶没保存成功，再试一次。");
      return;
    }

    const applied = new Map(
      result.data.items.filter((item) => item.ok).map((item) => [item.id, item.pinnedAt ?? null]),
    );
    setView((current) =>
      current.kind === "user"
        ? {
            ...current,
            items: current.items.map((item) =>
              applied.has(item.id) ? { ...item, pinnedAt: applied.get(item.id)! } : item,
            ),
          }
        : current,
    );

    if (result.data.okCount === 0) {
      setToast("没有可置顶的白板");
      return;
    }
    setUndoToast({
      kind: "pin",
      changes: previous.filter((change) => applied.has(change.id)),
      pinned,
      skipped: result.data.skippedCount,
      ttl: 5000,
    });
  };

  const confirmBatchTrash = async () => {
    const confirm = trashConfirm;
    if (!confirm || confirm.targets.length === 0) return;
    const ids = confirm.targets.map((card) => card.id);
    setBatchBusy(true);
    const result = await batchTrashBoards(ids);
    setBatchBusy(false);
    if (!result.ok) {
      setToast("批量移入回收站失败，再试一次。");
      return;
    }

    const moved = result.data.items.filter((item) => item.ok).map((item) => item.id);
    if (moved.length === 0) {
      setTrashConfirm(null);
      setToast("没删成功，再试一次。");
      return;
    }

    // 游客：服务端物理删除，清本机最近记录与缩略图，不进回收站、不提供撤销
    if (result.data.mode === "purged") {
      await Promise.all(moved.map((id) => clearBoardCache(id)));
      moved.forEach((id) => removeRecentBoard(id));
      setView((current) =>
        current.kind === "guest"
          ? { ...current, items: current.items.filter((item) => !moved.includes(item.id)) }
          : current,
      );
      const failed = ids.length - moved.length;
      setTrashConfirm(null);
      exitSelect(false);
      setToast(failed > 0 ? `已删除 ${moved.length} 块临时板，${failed} 块未删除` : `已删除 ${moved.length} 块临时板`);
      return;
    }

    await Promise.all(moved.map((id) => clearBoardCache(id)));
    setView((current) =>
      current.kind === "user"
        ? { ...current, items: current.items.filter((item) => !moved.includes(item.id)) }
        : current,
    );
    setTrashCount((count) => count + moved.length);
    const failed = ids.length - moved.length;
    const singleTitle =
      moved.length === 1 ? confirm.targets.find((card) => card.id === moved[0])?.title : undefined;
    setTrashConfirm(null);
    exitSelect(false);
    setUndoToast({ kind: "trash", ids: moved, title: singleTitle, failed, ttl: 8000 });
  };

  /* ---------------- 拖拽排序（方案 B：组内接管，不跨组） ---------------- */

  const dragOriginalRef = useRef<{ pinned: string[]; others: string[] } | null>(null);
  const kbFromRef = useRef(0);

  const titleOf = (id: string) => visible.find((card) => card.id === id)?.title ?? "白板";

  /** 把某一组的新顺序写进预览；预览只影响渲染，保存失败会整体丢弃。 */
  const applyPreview = (group: DragGroupKey, ids: string[]) => {
    const original = dragOriginalRef.current;
    if (!original) return;
    const pinned = group === "pinned" ? ids : original.pinned;
    const others = group === "others" ? ids : original.others;
    previewGroupsRef.current = { pinned, others };
    setPreviewIds([...pinned, ...others]);
  };

  const clearPreview = () => {
    previewGroupsRef.current = null;
    dragOriginalRef.current = null;
    setPreviewIds(null);
  };

  const groupRects = (ids: string[]) => {
    const grid = gridRef.current;
    if (!grid) return [];
    return ids
      .map((id) => {
        const el = grid.querySelector<HTMLElement>(`[data-board-id="${CSS.escape(id)}"]`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { id, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })
      .filter((rect): rect is { id: string; left: number; top: number; width: number; height: number } => Boolean(rect));
  };

  const swallowNextClick = () => {
    const handler = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", handler, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", handler, true), 300);
  };

  const commitOrder = async (
    id: string,
    neighbors: { beforeId: string | null; afterId: string | null },
  ) => {
    setSortBusy(true);
    const wasAuto = sortMode !== "manual";
    const result = await reorderBoard(id, neighbors);
    setSortBusy(false);

    if (!result.ok) {
      clearPreview();
      if (result.status === 409) {
        await refreshList();
        setToast("顺序已更新，请再拖一次。");
        return;
      }
      setUndoToast({ kind: "sort", id, neighbors, ttl: 6000 });
      setLiveText("排序没保存成功，已回到原位。");
      return;
    }

    setSortModeState("manual");
    await refreshList();
    clearPreview();
    setMovedId(id);
    setLiveText("已保存新的顺序。");
    if (wasAuto) setUndoToast({ kind: "mode", ttl: 8000 });
  };

  const beginDrag = (source: DragSource) => {
    const ids = groupIdsOf(source.group);
    const from = ids.indexOf(source.id);
    if (from < 0) return;
    source.active = true;
    dragOriginalRef.current = { pinned: groupIdsOf("pinned"), others: groupIdsOf("others") };
    applyPreview(source.group, ids);
    const session: DragSession = {
      id: source.id,
      group: source.group,
      from,
      to: from,
      ghost: {
        left: source.startX - source.offsetX,
        top: source.startY - source.offsetY,
        width: source.width,
        height: source.height,
      },
      line: null,
      noDrop: false,
    };
    dragSessionRef.current = session;
    setDrag(session);
    document.body.classList.add("wb-sorting");
    setLiveText(`已拿起《${titleOf(source.id)}》，第 ${from + 1} 位，共 ${ids.length} 位。`);
  };

  const moveDrag = (x: number, y: number) => {
    const source = dragSourceRef.current;
    const session = dragSessionRef.current;
    if (!source?.active || !session) return;

    const ghost = {
      left: x - source.offsetX,
      top: y - source.offsetY,
      width: source.width,
      height: source.height,
    };
    const center = { x: ghost.left + ghost.width / 2, y: ghost.top + ghost.height / 2 };
    const horizontal = gridColumnsNow() > 1;

    const mine = groupRects(groupIdsOf(session.group));
    const otherGroup: DragGroupKey = session.group === "pinned" ? "others" : "pinned";
    const other = groupRects(groupIdsOf(otherGroup));
    const otherBand =
      other.length > 0
        ? {
            top: Math.min(...other.map((rect) => rect.top)) - 12,
            bottom: Math.max(...other.map((rect) => rect.top + rect.height)) + 12,
          }
        : null;
    // 组边界不可跨越：跨组等于改置顶状态，走卡片菜单
    const noDrop = Boolean(otherBand && center.y > otherBand.top && center.y < otherBand.bottom);

    const to = dropIndex(mine, center, session.id, horizontal);
    const rest = mine.filter((rect) => rect.id !== session.id);
    let line: DragSession["line"] = null;
    if (!noDrop && rest.length > 0) {
      if (to < rest.length) {
        const target = rest[to];
        const prev = to > 0 ? rest[to - 1] : null;
        if (target && prev && horizontal && Math.abs(prev.top - target.top) > 2) {
          // 换排：横线贯穿内容宽，落在两排间隙中线
          const gridRect = gridRef.current?.getBoundingClientRect();
          line = {
            kind: "h",
            left: gridRect?.left ?? 0,
            top: (prev.top + prev.height + target.top) / 2 - 1,
            width: gridRect?.width ?? 0,
            height: 2,
          };
        } else if (target) {
          line = { kind: "v", left: target.left - 9, top: target.top, width: 2, height: target.height };
        }
      } else {
        const last = rest[rest.length - 1];
        if (last) {
          line = { kind: "v", left: last.left + last.width + 9, top: last.top, width: 2, height: last.height };
        }
      }
    }

    const next: DragSession = { ...session, to, ghost, line, noDrop };
    dragSessionRef.current = next;
    setDrag(next);

    if (to !== session.to) {
      // 预览必须始终从「拖起时的组顺序」重排：当前的 groupIdsOf 已经含上一次预览，
      // 再套用原下标 from 会把别的卡当成源卡，连续拖动时预览会错位。
      const original = dragOriginalRef.current;
      const base = original
        ? session.group === "pinned"
          ? original.pinned
          : original.others
        : groupIdsOf(session.group);
      applyPreview(session.group, moveItem(base, session.from, to));
      setLiveText(`第 ${to + 1} 位，共 ${mine.length} 位。`);
    }
  };

  const finishDrag = (commit: boolean) => {
    const session = dragSessionRef.current;
    const source = dragSourceRef.current;
    dragSessionRef.current = null;
    dragSourceRef.current = null;
    document.body.classList.remove("wb-sorting");
    setDrag(null);
    if (!session || !source?.active) {
      clearPreview();
      return;
    }
    swallowNextClick();

    if (!commit || session.to === session.from) {
      clearPreview();
      setLiveText(commit ? "顺序未变。" : "已取消移动。");
      return;
    }

    const group = previewGroupsRef.current?.[session.group];
    if (!group) {
      clearPreview();
      return;
    }
    const neighbors = neighborsAt(
      group.map((id) => ({ id })),
      session.to,
    );
    setLiveText(`《${titleOf(session.id)}》已移到第 ${session.to + 1} 位，正在保存。`);
    void commitOrder(session.id, neighbors);
  };

  dragApiRef.current = { begin: beginDrag, move: moveDrag, end: finishDrag };

  // 指针与键盘共用同一套事件：阈值在 window 上判定，避免卡片内的 click 抢跑
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const source = dragSourceRef.current;
      if (!source || event.pointerId !== source.pointerId) return;
      if (!source.active) {
        const distance = Math.hypot(event.clientX - source.startX, event.clientY - source.startY);
        if (distance < 6) return;
        dragApiRef.current?.begin(source);
      }
      dragApiRef.current?.move(event.clientX, event.clientY);
      event.preventDefault();
    };
    const onUp = (event: PointerEvent) => {
      const source = dragSourceRef.current;
      if (!source || event.pointerId !== source.pointerId) return;
      dragApiRef.current?.end(event.type === "pointerup");
    };
    const onCancel = () => {
      if (dragSourceRef.current) dragApiRef.current?.end(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragSessionRef.current) return;
      event.preventDefault();
      dragApiRef.current?.end(false);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onCancel);
    };
  }, []);

  useEffect(() => {
    if (!movedId) return;
    const timer = window.setTimeout(() => setMovedId(null), 2400);
    return () => window.clearTimeout(timer);
  }, [movedId]);

  const armDrag = (event: ReactPointerEvent<HTMLElement>, card: CardModel) => {
    if (!canSort || !event.isPrimary) return;
    const cardEl = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-testid="board-card"]');
    const rect = (cardEl ?? event.currentTarget).getBoundingClientRect();
    const group: DragGroupKey = card.pinned ? "pinned" : "others";
    const from = groupIdsOf(group).indexOf(card.id);
    if (from < 0) return;
    dragSourceRef.current = {
      id: card.id,
      group,
      from,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      active: false,
    };
  };

  const onCardPointerDown = (event: ReactPointerEvent<HTMLElement>, card: CardModel) => {
    if ((event.target as HTMLElement).closest("button, [data-no-drag]")) return;
    armDrag(event, card);
  };

  /** 抓手起手：触屏唯一可靠的拖动入口（抓手自己 touch-action: none）。 */
  const onHandlePointerDown = (event: ReactPointerEvent<HTMLElement>, card: CardModel) => {
    event.stopPropagation();
    armDrag(event, card);
  };

  /* ---------------- 键盘排序 ---------------- */

  const keyboardPickUp = (id: string) => {
    if (!canSort) return;
    const group: DragGroupKey = visible.find((card) => card.id === id)?.pinned ? "pinned" : "others";
    dragOriginalRef.current = { pinned: groupIdsOf("pinned"), others: groupIdsOf("others") };
    applyPreview(group, groupIdsOf(group));
    kbFromRef.current = groupIdsOf(group).indexOf(id);
    setKbPick(id);
    setLiveText(
      `已拿起《${titleOf(id)}》，第 ${kbFromRef.current + 1} 位，共 ${groupIdsOf(group).length} 位。方向键移动，空格放下，Esc 取消。`,
    );
  };

  const keyboardMove = (id: string, delta: number) => {
    const group: DragGroupKey = visible.find((card) => card.id === id)?.pinned ? "pinned" : "others";
    const ids = previewGroupsRef.current?.[group] ?? groupIdsOf(group);
    const current = ids.indexOf(id);
    const to = Math.min(ids.length - 1, Math.max(0, current + delta));
    if (to === current) {
      setLiveText(delta > 0 ? "已到组末尾，不能再往后。" : "已到组首，不能再往前。");
      return;
    }
    if (!dragOriginalRef.current) {
      dragOriginalRef.current = { pinned: groupIdsOf("pinned"), others: groupIdsOf("others") };
    }
    applyPreview(group, moveItem(dragOriginalRef.current[group], kbFromRef.current, to));
    setLiveText(`第 ${to + 1} 位，共 ${ids.length} 位。`);
  };

  const keyboardDrop = (id: string) => {
    setKbPick(null);
    const groups = previewGroupsRef.current;
    if (!groups) return;
    const group: DragGroupKey = visible.find((card) => card.id === id)?.pinned ? "pinned" : "others";
    const ids = groups[group];
    const position = ids.indexOf(id);
    if (position < 0 || position === kbFromRef.current) {
      clearPreview();
      setLiveText("顺序未变。");
      return;
    }
    setLiveText(`《${titleOf(id)}》已移到第 ${position + 1} 位，正在保存。`);
    void commitOrder(
      id,
      neighborsAt(
        ids.map((entry) => ({ id: entry })),
        position,
      ),
    );
  };

  const keyboardCancel = () => {
    setKbPick(null);
    clearPreview();
    setLiveText("已取消，顺序没变。");
  };

  const restoreAutoSort = async () => {
    setUndoToast(null);
    const result = await setSortMode("auto");
    if (!result.ok) {
      setToast("恢复自动排序没成功，再试一次。");
      return;
    }
    setSortModeState("auto");
    clearPreview();
    await refreshList();
    setToast("已恢复自动排序");
  };

  /* ---------------- 移动到…（单列 / 读屏的精确入口） ---------------- */

  const openPicker = (board: CardModel) => {
    setPicker({ board, group: board.pinned ? "pinned" : "others" });
    setPickTarget(Math.max(0, groupIdsOf(board.pinned ? "pinned" : "others").indexOf(board.id)));
  };

  const confirmPicker = () => {
    const target = picker;
    if (!target) return;
    const group = target.group;
    const ids = groupIdsOf(group);
    const from = ids.indexOf(target.board.id);
    setPicker(null);
    if (from < 0 || from === pickTarget) return;
    const next = moveItem(ids, from, pickTarget);
    dragOriginalRef.current = { pinned: groupIdsOf("pinned"), others: groupIdsOf("others") };
    applyPreview(group, next);
    void commitOrder(
      target.board.id,
      neighborsAt(
        next.map((id) => ({ id })),
        pickTarget,
      ),
    );
  };

  const copyBoardLink = async (board: CardModel) => {    const ok = await copyText(`${window.location.origin}/board/${board.id}`);
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
      case "move-to":
        openPicker(board);
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
        // 游客没有回收站：物理删除前先用确认框讲清后果
        if (board.guest) setGuestTrash(board);
        else void trashBoard(board);
        return;
      default:
        return;
    }
  };

  const renderBoardCard = (board: CardModel) => (
    <BoardCard
      key={board.id}
      board={board}
      thumbUrl={thumbs[board.id]}
      pinBusy={pinBusyId === board.id}
      menuOpen={menu?.board.id === board.id}
      selectMode={selectMode}
      readOnly={readOnly}
      canSelect={isSelectable}
      selected={selected.has(board.id)}
      focused={focusedId === board.id}
      sortable={canSort}
      dragging={drag?.id === board.id}
      dropBlocked={Boolean(drag?.noDrop && drag.id !== board.id)}
      justMoved={movedId === board.id}
      picked={kbPick === board.id}
      onTogglePin={togglePin}
      onOpenMenu={openMenu}
      onCloseMenu={() => closeMenu(true)}
      onToggleSelect={toggleCard}
      onExtendSelect={extendSelection}
      onEnterSelect={enterSelectWith}
      onFocusSelect={setFocusedId}
      onPointerDownCard={onCardPointerDown}
      onHandlePointerDown={onHandlePointerDown}
      onPickUp={keyboardPickUp}
      onKeyboardMove={keyboardMove}
      onKeyboardDrop={keyboardDrop}
      onKeyboardCancel={keyboardCancel}
    />
  );

  const dragCard = drag ? cards.find((card) => card.id === drag.id) : null;

  return (
    <div
      className={`wb-page wb-page--boards${selectMode ? " wb-page--selecting" : ""}${drag ? " wb-page--sorting" : ""}`}
      onKeyDown={onPageKeyDown}
      onPointerDown={onBlankPointerDown}
    >
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
        {view.kind === "user" && spaces.length > 0 ? (
          <SpaceSwitcher
            spaces={spaces}
            currentId={spaceId}
            onSelect={selectSpace}
            onCreated={handleSpaceCreated}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}
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
        {selectMode && isSelectable ? (
          <BatchSelectionBar
            cards={cards}
            visible={visible}
            selected={selected}
            allScope={allScope}
            busy={batchBusy}
            guest={isGuest}
            contextLabel={isGuest ? "最近打开" : "我的白板"}
            onToggleAll={toggleAll}
            onSelectAllLoaded={selectAllLoaded}
            onClearAll={clearAll}
            onInvert={invertVisible}
            onPin={() => void runBatchPin(true)}
            onUnpin={() => void runBatchPin(false)}
            onTrash={openBatchTrash}
            onExit={() => exitSelect()}
          />
        ) : (
          <div className="wb-boards__head">
            <div className="wb-boards__headline">
              <p className="wb-boards__eyebrow">
                {isGuest
                  ? "本机临时板"
                  : currentSpace?.kind === "team"
                    ? `团队空间 · ${currentSpace.memberCount} 位成员`
                    : "个人空间 · 只有你能看到"}
              </p>
              <div className="wb-boards__titleline">
                <h1 className="wb-display">
                  {isGuest ? "最近打开" : currentSpace?.kind === "team" ? currentSpace.name : "我的白板"}
                </h1>
                {!isGuest && currentSpace ? (
                  <span className={`wb-space-role wb-space-role--${role}`} data-testid="space-role">
                    {SPACE_ROLE_LABEL[role] ?? role}
                  </span>
                ) : null}
                {listReady ? <span className="wb-boards__count wb-nums">{view.items.length} 块</span> : null}
              </div>
            </div>
            <div className="wb-boards__head-actions">
              {canSort && cards.length > 1 && !isGuest ? (
                sortMode === "manual" ? (
                  <button
                    className="wb-sortchip wb-sortchip--manual"
                    type="button"
                    onClick={() => void restoreAutoSort()}
                    title="当前按你拖过的顺序排列，点击恢复自动排序"
                    data-testid="boards-sort-chip"
                  >
                    <span className="wb-sortchip__dot" aria-hidden />
                    自定义顺序
                    <span className="wb-sortchip__hint">恢复自动</span>
                  </button>
                ) : (
                  <span
                    className="wb-sortchip"
                    title="按住卡片拖动可排序，也可用 Ctrl + ↑ ↓ 或卡片菜单里的「移动到…」"
                    data-testid="boards-sort-chip"
                  >
                    <span className="wb-sortchip__dot" aria-hidden />
                    自动排序
                  </span>
                )
              ) : null}
              {isSelectable && cards.length > 0 ? (
                <button
                  ref={selectEntryRef}
                  className="wb-btn wb-btn--ghost"
                  type="button"
                  onClick={enterSelect}
                  data-testid="boards-select"
                >
                  选择
                </button>
              ) : null}
              {readOnly ? (
                <span className="wb-boards__readonly" data-testid="boards-readonly">
                  只读空间 · 可浏览、复制到个人空间
                </span>
              ) : (
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
              )}
            </div>
          </div>
        )}

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

        {view.kind === "missing" ? (
          <div className="wb-panel--error" style={{ marginTop: "var(--space-6)" }} role="alert">
            <h2 className="wb-subtitle">这个空间不存在，或你没有访问权限</h2>
            <p className="wb-caption">可能是邀请被撤销，或你已被移出空间。</p>
            <button className="wb-btn wb-btn--primary" type="button" onClick={backToPersonal}>
              返回我的白板
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
          readOnly ? (
            <div className="wb-empty" data-testid="boards-empty">
              <span className="wb-empty__icon" aria-hidden>
                <IconBoard size={24} />
              </span>
              <h2 className="wb-title">这个空间还没有白板</h2>
              <p className="wb-caption">只读成员不能新建，等编辑者创建后会出现在这里。</p>
            </div>
          ) : (
            <EmptyState
              title={isGuest ? "还没有打开过白板" : "还没有白板"}
              hint={
                isGuest
                  ? "这块浏览器还没记录任何临时板。新建一块，立刻开始画。"
                  : currentSpace?.kind === "team"
                    ? "新建一块，空间里的成员都能看到。"
                    : "新建一块，立刻开始画。"
              }
              onNew={() => void start()}
            />
          )
        ) : null}

        {cards.length > 0 || skeletonVisible(skeletonPhase) ? (
          <div className="wb-boards__grid">
            {cardsReady && visible.length > 0 ? (
              <div
                className={`wb-grid wb-grid--cards${drag ? " is-sorting" : ""}`}
                ref={gridRef}
                data-testid="boards-grid"
                onKeyDown={onGridKeyDown}
              >
                {groupsNow.pinned.length > 0 ? (
                  <>
                    <div className="wb-boards__group-title" aria-hidden>
                      <span>置顶</span>
                      <span className="wb-boards__group-count wb-nums">{groupsNow.pinned.length}</span>
                      <span className="wb-boards__group-note">组内可排序，不跨组</span>
                    </div>
                    {groupsNow.pinned.map(renderBoardCard)}
                    <div className="wb-boards__group-title" aria-hidden>
                      <span>其余白板</span>
                      <span className="wb-boards__group-count wb-nums">{groupsNow.others.length}</span>
                      <span className="wb-boards__group-note">{sortMode === "manual" ? "自定义顺序" : "最近编辑"}</span>
                    </div>
                  </>
                ) : null}
                {groupsNow.others.map(renderBoardCard)}
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
      </div>

      {/* 落点指示线：组内排序时贯穿卡片高度，换排时贯穿内容宽度 */}
      {drag?.line ? (
        <div
          className={`wb-dropline wb-dropline--${drag.line.kind}${drag.noDrop ? " is-blocked" : ""}`}
          style={{ left: drag.line.left, top: drag.line.top, width: drag.line.width, height: drag.line.height }}
          aria-hidden
        />
      ) : null}

      {drag && dragCard ? (
        <div
          className={`wb-drag-ghost${drag.noDrop ? " is-blocked" : ""}`}
          style={{ left: drag.ghost.left, top: drag.ghost.top, width: drag.ghost.width, height: drag.ghost.height }}
          aria-hidden
        >
          <span className="wb-drag-ghost__title">{dragCard.title}</span>
          <span className="wb-drag-ghost__note">{drag.noDrop ? "不能跨组" : `第 ${drag.to + 1} 位`}</span>
        </div>
      ) : null}

      {toast ? <div className="wb-toast">{toast}</div> : null}

      {undoToast ? (
        <div className="wb-toast wb-toast--action" role="status" aria-live="polite">
          <span>{undoText(undoToast)}</span>
          <button className="wb-toast__action" type="button" onClick={() => void undoLast()}>
            {undoLabel(undoToast)}
          </button>
        </div>
      ) : null}

      {/* 拖拽与键盘排序共用一条播报，避免读屏用户听不到落点变化 */}
      <div className="wb-sr-only" role="status" aria-live="polite">
        {liveText}
      </div>

      {picker ? (
        <div
          className="wb-overlay wb-overlay--sheet"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPicker(null);
          }}
        >
          <div
            className="wb-sheet wb-move-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-move-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setPicker(null);
              }
            }}
          >
            <h2 className="wb-subtitle" id="wb-move-title">
              移动到第几位？
            </h2>
            <p className="wb-caption">
              《{picker.board.title}》 · {picker.group === "pinned" ? "置顶组" : "其余白板"}
            </p>
            <div className="wb-move-sheet__list" role="listbox" aria-labelledby="wb-move-title">
              {(picker.group === "pinned" ? groupsNow.pinned : groupsNow.others).map((card, index) => (
                <button
                  key={card.id}
                  className={`wb-move-sheet__item${index === pickTarget ? " is-current" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={index === pickTarget}
                  onClick={() => setPickTarget(index)}
                >
                  <span className="wb-move-sheet__index wb-nums">{index + 1}</span>
                  <span className="wb-move-sheet__title">{card.title}</span>
                  {card.id === picker.board.id ? <span className="wb-move-sheet__tag">当前</span> : null}
                </button>
              ))}
            </div>
            <div className="wb-move-sheet__actions">
              <button className="wb-btn wb-btn--ghost" type="button" onClick={() => setPicker(null)}>
                取消
              </button>
              <button className="wb-btn wb-btn--primary" type="button" onClick={confirmPicker}>
                移动
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {guestTrash ? (
        <div
          className="wb-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !guestTrashBusy) setGuestTrash(null);
          }}
        >
          <div
            className="wb-dialog wb-trash__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-guest-trash-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !guestTrashBusy) {
                event.preventDefault();
                setGuestTrash(null);
              }
            }}
          >
            <h2 className="wb-dialog__title" id="wb-guest-trash-title">
              删除临时板「{guestTrash.title}」？
            </h2>
            <p className="wb-dialog__desc">
              游客的临时板不进入回收站，删除后无法恢复；本机的缩略图与最近打开记录会一起清掉。
            </p>
            <div className="wb-dialog__actions">
              <button
                className="wb-btn wb-btn--ghost"
                type="button"
                autoFocus
                disabled={guestTrashBusy}
                onClick={() => setGuestTrash(null)}
              >
                取消
              </button>
              <button
                className="wb-btn wb-btn--danger"
                type="button"
                disabled={guestTrashBusy}
                onClick={() => void confirmGuestTrash()}
              >
                {guestTrashBusy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {trashConfirm ? (
        <BatchTrashDialog
          rows={trashConfirm.rows}
          targets={trashConfirm.targets}
          skipped={trashConfirm.skipped}
          busy={batchBusy}
          guest={isGuest}
          onCancel={() => {
            if (!batchBusy) setTrashConfirm(null);
          }}
          onConfirm={() => void confirmBatchTrash()}
        />
      ) : null}

      {menu ? (
        <BoardCardMenu
          target={{
            boardId: menu.board.id,
            title: menu.board.title,
            role: menu.board.role,
            pinned: menu.board.pinned,
            guest: menu.board.guest,
            isOwn: menu.board.isOwn,
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

      {settingsOpen && currentSpace ? (
        <SpaceSettings space={currentSpace} onClose={() => setSettingsOpen(false)} />
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
  selectMode,
  readOnly,
  canSelect,
  selected,
  focused,
  sortable,
  dragging,
  dropBlocked,
  justMoved,
  picked,
  onTogglePin,
  onOpenMenu,
  onCloseMenu,
  onToggleSelect,
  onExtendSelect,
  onEnterSelect,
  onFocusSelect,
  onPointerDownCard,
  onHandlePointerDown,
  onPickUp,
  onKeyboardMove,
  onKeyboardDrop,
  onKeyboardCancel,
}: {
  board: CardModel;
  thumbUrl?: string;
  pinBusy: boolean;
  menuOpen: boolean;
  selectMode: boolean;
  readOnly: boolean;
  /** 能否进入批量选择；游客与只读成员为 false，勾选热区不渲染 */
  canSelect: boolean;
  selected: boolean;
  focused: boolean;
  sortable: boolean;
  dragging: boolean;
  dropBlocked: boolean;
  justMoved: boolean;
  picked: boolean;
  onTogglePin: (id: string, pinned: boolean) => void;
  onOpenMenu: (board: CardModel, anchor: MenuAnchor, trigger: HTMLElement | null) => void;
  onCloseMenu: () => void;
  onToggleSelect: (id: string) => void;
  onExtendSelect: (id: string) => void;
  onEnterSelect: (id: string, extend: boolean) => void;
  onFocusSelect: (id: string) => void;
  onPointerDownCard: (event: ReactPointerEvent<HTMLElement>, board: CardModel) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, board: CardModel) => void;
  onPickUp: (id: string) => void;
  onKeyboardMove: (id: string, delta: number) => void;
  onKeyboardDrop: (id: string) => void;
  onKeyboardCancel: () => void;
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
    if (selectMode) return;
    if (!event.isPrimary) return;
    // 鼠标/触控笔由页面判断 6px 阈值后接管；触屏仍走长按出菜单，避免和滚动打架
    onPointerDownCard(event, board);
    if (event.pointerType === "mouse") return;
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
    if (selectMode) return;
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onOpenMenu(
        board,
        { type: "button", left: rect.left, right: rect.right, top: rect.top, bottom: rect.top + 4 },
        event.currentTarget,
      );
      return;
    }
    // Ctrl/⌘ + ↑ ↓：不用拿起也能挪一位，适合只想微调的场景
    if (sortable && (event.ctrlKey || event.metaKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const step = gridColumnsNow();
      onPickUp(board.id);
      onKeyboardMove(board.id, event.key === "ArrowUp" ? -step : step);
      onKeyboardDrop(board.id);
    }
  };

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!picked) {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        onPickUp(board.id);
      }
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onKeyboardDrop(board.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onKeyboardCancel();
      return;
    }
    const step = gridColumnsNow();
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (delta !== 0) {
      event.preventDefault();
      onKeyboardMove(board.id, delta);
    }
  };

  return (
    <article
      className={`wb-card wb-board-card${selectMode ? " is-selecting" : ""}${selected ? " is-selected" : ""}${
        dragging ? " is-dragging" : ""
      }${picked ? " is-picked" : ""}${dropBlocked ? " is-drop-blocked" : ""}${justMoved ? " is-just-moved" : ""}`}
      data-testid="board-card"
      data-board-id={board.id}
      data-selected={selected ? "true" : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        if (selectMode) return;
        onOpenMenu(board, { type: "pointer", x: event.clientX, y: event.clientY }, event.currentTarget);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onPointerLeave={clearHold}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (!selectMode) return;
        if ((event.target as HTMLElement).closest("a, button")) return;
        onToggleSelect(board.id);
      }}
    >
      {sortable && !selectMode ? (
        <button
          className="wb-board-card__handle"
          type="button"
          aria-label={`拖动排序：${board.title}`}
          aria-pressed={picked}
          title="拖动排序（空格拿起，方向键移动，空格放下）"
          data-drag-handle={board.id}
          onPointerDown={(event) => onHandlePointerDown(event, board)}
          onKeyDown={onHandleKeyDown}
        >
          <span className="wb-board-card__grip" aria-hidden>
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        </button>
      ) : null}
      <a
        className="wb-board-card__link"
        href={`/board/${board.id}`}
        // 链接默认可原生拖拽，会抢走 pointermove：排序必须关掉
        draggable={false}
        tabIndex={selectMode ? -1 : undefined}
        onClick={(event) => {
          if (selectMode) {
            event.preventDefault();
            if (event.shiftKey) onExtendSelect(board.id);
            else onToggleSelect(board.id);
            return;
          }
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            event.preventDefault();
            onEnterSelect(board.id, event.shiftKey);
          }
        }}
      >
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
      {selectMode ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`${selected ? "取消选择" : "选择"}：${board.title}`}
          className="wb-board-card__check wb-checkhit"
          data-select-check={board.id}
          tabIndex={focused ? 0 : -1}
          onFocus={() => onFocusSelect(board.id)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleSelect(board.id);
          }}
        >
          <span className={`wb-check${selected ? " is-checked" : ""}`} aria-hidden>
            {selected ? <IconCheck size={12} /> : null}
          </span>
        </button>
      ) : canSelect ? (
        <span
          className="wb-board-card__check-hint"
          aria-hidden
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onEnterSelect(board.id, false);
          }}
        >
          <span className="wb-check" />
        </span>
      ) : null}
      <div className="wb-board-card__meta">
        <span className={`wb-badge wb-badge--${board.badgeTone}`}>{board.badge}</span>
        <span className="wb-board-card__meta-right">
          <time className="wb-board-card__time wb-nums" dateTime={board.lastEditedAt}>
            {formatRelative(board.lastEditedAt)}
          </time>
          {!selectMode && !readOnly ? (
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
          ) : null}
          {!selectMode ? (
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
          ) : null}
        </span>
      </div>
    </article>
  );
}

/** 骨架卡片：结构、行高、间距与 BoardCard 完全一致，换成真实数据时不产生位移。 */
function SkeletonCards() {
  return (
    <>
      {Array.from({ length: BOARDS_CAPACITY }, (_, index) => (
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

/**
 * 当前实际列数：直接读网格容器算好的 column tracks（`--wb-cols` 的结果）。
 * 用 DOM 实测而不是 window.innerWidth，宽屏 4 列、变窄 3/2/1 列都能拿到真实值，
 * 拖拽落点、键盘换行、框选都按它走。
 */
function gridColumnsNow(): number {
  const grid = document.querySelector<HTMLElement>('[data-testid="boards-grid"]');
  if (!grid) return 1;
  const tracks = getComputedStyle(grid).gridTemplateColumns;
  return tracks.split(" ").filter(Boolean).length || 1;
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

function undoText(state: UndoState): string {
  if (state.kind === "trash") {
    const base =
      state.ids.length === 1 && state.title
        ? `已移到回收站「${state.title}」`
        : `已将 ${state.ids.length} 块白板移入回收站`;
    return state.failed ? `${base}，${state.failed} 块没成功` : base;
  }
  if (state.kind === "sort") return "顺序没保存成功";
  if (state.kind === "mode") return "已切换为自定义顺序";
  const verb = state.pinned ? "置顶" : "取消置顶";
  const skipped = state.skipped > 0 ? `，${state.skipped} 块跳过` : "";
  return `已${verb} ${state.changes.length} 块白板${skipped}`;
}

function undoLabel(state: UndoState): string {
  if (state.kind === "sort") return "重试";
  if (state.kind === "mode") return "恢复自动";
  return "撤销";
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
