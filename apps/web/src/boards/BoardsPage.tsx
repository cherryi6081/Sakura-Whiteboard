import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { fetchClaimPreview, fetchMe, logout, type AuthUser, type ClaimPreview } from "../auth/authApi";
import { AccountSettingsDialog, oauthBindErrorMessage } from "../auth/AccountSettingsDialog";
import { ClaimDialog } from "../auth/ClaimDialog";
import { migrateGuestLocalData } from "../auth/claimLocalData";
import { SaveToAccountBanner } from "../auth/GuestBadge";
import {
  batchPinBoards,
  batchTrashBoards,
  createShareLink,
  fetchAllBoards,
  fetchTrashCount,
  renameBoard,
  reorderBoard,
  resetPublicBoard,
  restoreBoard,
  ROLE_LABEL,
  setBoardArchived,
  setBoardPinned,
  setSortMode,
  type BoardListItem,
  type BoardSortMode,
} from "./boardsApi";
import { moveBoardToTrash } from "./boardActions";
import { boardHref, currentListHref } from "../board/backTarget";
import { clearBoardCache } from "../store/cacheDb";
import { BatchSelectionBar } from "./BatchSelectionBar";
import { BatchTrashDialog } from "./BatchTrashDialog";
import { BoardCardMenu, type BoardMenuTarget } from "./BoardCardMenu";
import type { MenuAnchor } from "./boardMenu";
import { BOARDS_CAPACITY, isPinned, matchesBoardTitle, sortBoards } from "./boardList";
import { boardsLayout, pinTargets, rangeIds, selectionState, trashTargets, type SelectableCard } from "./selection";
import { dropIndex, moveItem, neighborsAt, splitGroups } from "./sortOrder";
import { edgeScrollStep } from "./autoScroll";
import { loadThumbUrls } from "./boardThumb";
import {
  GUEST_OWNER,
  ownerTag,
  removeRecentBoard,
  renameRecentBoard,
  setActiveOwner,
  setRecentPinned,
  userOwner,
  type RecentBoard,
  type RecentOwner,
} from "./recentBoards";
import { publishLogout, subscribeLogout } from "../auth/authEvents";
import { SakuraBranch } from "./SakuraBranch";
import { createBoardMessage, useCreateBoard, type CreateBoardFailureKind } from "./useCreateBoard";
import { skeletonVisible, useSkeletonPhase } from "./useSkeletonPhase";
import { IconAlert, IconBoard, IconCheck, IconFlower, IconLogout, IconMore, IconPin, IconPlus, IconTrash } from "../ui/icons";
import { DialogClose } from "../ui/DialogClose";
import { UserMark } from "../ui/UserMark";
import sakuraMark from "../assets/sakura-mark.png";
import type { SpaceSummary } from "@whiteboard/shared";
import { LIMITS, PUBLIC_BOARD_ID, PUBLIC_BOARD_TITLE } from "@whiteboard/shared";
import { fetchSpaces } from "./spaceApi";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { SpaceSettings } from "./SpaceSettings";

/**
 * 我的白板列表（视觉方案 §4.2）。
 *
 * - 登录用户：`GET /api/boards`（置顶优先，其次最近编辑倒序），按页拉全，不限数量；游客 401 → 展示本机"最近打开"。
 * - 背景 A：天空渐变前四档在 420px 内淡回 `--bg`，右上角一枝樱花；<700px 隐藏枝条。
 * - 卡片缩略图来自进板首帧快照（IndexedDB `wb-cache/thumbs`），没有快照时回退线稿图标。
 * - 骨架与真实卡片同盒模型（16:10 缩略图 / 22px 标题行 / 24px 元信息行）；
 *   加载超过 200ms 才显示骨架，数据到达时两者交叉淡出淡入，首屏不闪白、不位移。
 * - 登录账号不限量：`fetchAllBoards` 按页拉全，超过一屏时网格自然续行、页面可滚动；
 *   `BOARDS_CAPACITY` 只用于游客视图的「N / 12」计数。
 */

type ViewState =
  | { kind: "loading" }
  | { kind: "guest"; items: RecentBoard[] }
  | { kind: "user"; items: BoardListItem[]; user: { displayName: string; avatarUrl: string | null } }
  | { kind: "error"; message: string }
  /** `?space=` 指向的空间不存在 / 已不是成员：404 面板，不自动回退 */
  | { kind: "missing" }
  /**
   * 身份未知：`/api/auth/me` 网络失败 / 超时（不是 401）。
   * 既不能当登录用户，也不能当游客——不渲染游客视图，不写任何本机记录。
   */
  | { kind: "unknown" };

type CardModel = {
  id: string;
  title: string;
  lastEditedAt: string;
  pinned: boolean;
  badge: string;
  badgeTone: "role" | "readonly" | "guest" | "member";
  role: string;
  guest?: boolean;
  /** 公共临时板：唯一一张游客卡片，不能删除/置顶/改名，只能进入或用页头"清空" */
  publicBoard?: boolean;
  /** 团队空间：这块板是不是我创建的 */
  isOwn?: boolean;
  /** 服务端保存的缩略图地址（带内容哈希）；为空时回退到本机 IndexedDB 缩略图 */
  thumbnailUrl?: string | null;
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

/**
 * 游客视图只有一张卡：所有人共用的公共临时板。
 *
 * 不再读取 `localStorage` 的游客"最近打开"——临时板已经收敛成固定 id，
 * 本机不再累积多块板，也不会出现"卡片在但打不开"的旧条目。
 * 历史游客板仍留在服务端（可按认领流程转入账号），只是不在这里展示。
 */
function guestBoardItems(): RecentBoard[] {
  return [
    {
      id: PUBLIC_BOARD_ID,
      title: PUBLIC_BOARD_TITLE,
      lastEditedAt: new Date().toISOString(),
      pinned: false,
    },
  ];
}
/** 700 以下交给 CSS 单列滚动，不再按宽度均分 */
const MOBILE_BREAKPOINT = 700;
const SPACE_ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读",
};

/** 本页的建板失败文案：容量类复用 hook 的同一份口径，避免数字漂移 */
function boardsMessageFor({ kind, code }: { kind: CreateBoardFailureKind; code?: string }): string {
  if (kind === "quota" || kind === "capacity") return createBoardMessage(kind);
  if (kind === "offline") return "连不上服务器，恢复网络后再试。";
  return `没建成（${code}），再试一次。`;
}

export function BoardsPage() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  /**
   * 本机记录/缩略图的归属：`/api/auth/me` 成功切到该用户，401 切回游客。
   * 所有读写本机数据的调用都用它，退出登录后立刻改回游客，不会读到上一个账号的条目。
   */
  const [owner, setOwner] = useState<RecentOwner>(GUEST_OWNER);
  const ownerTagValue = ownerTag(owner);
  // 空间上下文：spaceId 为空表示尚未确定；个人空间在 URL 上不写 ?space=
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const spaceIdRef = useRef("");
  const [spaceRole, setSpaceRole] = useState<string>("owner");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 顶栏账号胶囊打开的账号设置弹窗；完整 user 用于回填邮箱/颜色与资料更新 */
  const [meUser, setMeUser] = useState<AuthUser | null>(null);
  /** 与 me 同步的登录方式，账号弹窗用它决定显示「绑定」还是「解绑」 */
  const [meMethods, setMeMethods] = useState<string[]>([]);
  /** GitHub 绑定回调带回的提示；打开账号弹窗时展示一次 */
  const [accountNotice, setAccountNotice] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [claimBarVisible, setClaimBarVisible] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [guestBannerVisible, setGuestBannerVisible] = useState(() => !readFlag(SAVE_BANNER_KEY));
  const [toast, setToast] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** thumbs 里那批 URL 属于哪个身份：身份切换后旧 URL 一律不再渲染，避免串图 */
  const [thumbOwner, setThumbOwner] = useState("");
  const [thumbsReady, setThumbsReady] = useState(false);
  /** 临时板转入后缩略图 owner 变了，但 ownerTag 不变，用这个计数强制重读一次 */
  const [thumbEpoch, setThumbEpoch] = useState(0);
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  // 右键菜单只允许一个实例：右键 / 长按 / 「更多」都写同一份 state
  const [menu, setMenu] = useState<{ board: CardModel; anchor: MenuAnchor; trigger: HTMLElement | null } | null>(null);
  // 就地改名：输入框替换标题行，同时最多只允许一块板处于编辑态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<{ id: string; value: string; original: string; cancelled: boolean } | null>(null);
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
  /** 清空公共临时板：破坏性且影响所有人，必须先二次确认 */
  const [publicResetOpen, setPublicResetOpen] = useState(false);
  const [publicResetBusy, setPublicResetBusy] = useState(false);
  const selectEntryRef = useRef<HTMLButtonElement>(null);
  // 拖拽排序：组内接管（方案 B），置顶组与普通组固定，不跨组
  const [sortMode, setSortModeState] = useState<BoardSortMode>("auto");
  // 板名搜索：query 是输入框即时值，debouncedQuery 是实际生效的查询词
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  /** 列表重新加载后递增，让当前搜索词重新生效 */
  const [searchEpoch, setSearchEpoch] = useState(0);
  /** 记录当前 view.items 对应哪个 q，避免重复请求 */
  const appliedQueryRef = useRef("");
  /** 已归档视图开关：只在登录列表出现，搜索词继续叠加生效 */
  const [showArchived, setShowArchived] = useState(false);
  // 供 useCallback 里的列表请求读取最新值，避免把开关放进依赖导致重渲染
  const showArchivedRef = useRef(false);
  /** effect 里要读最新的 view 状态，但不能把 view 放进依赖（否则每次列表变化都会重发搜索） */
  const viewRef = useRef(view);
  viewRef.current = view;
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  // 每 12 格展开一次：首屏 11 张 + 第 12 格占位，点一次再追加 11 张
  const [expandedRounds, setExpandedRounds] = useState(0);
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
  // 拖拽自动滚动：rAF 句柄 + 最后一次指针坐标（页面滚动时坐标不变，靠它续算落点）
  const autoScrollRafRef = useRef<number | null>(null);
  const autoScrollPointRef = useRef<{ x: number; y: number } | null>(null);
  const touchTimerRef = useRef<number | null>(null);
  const currentSpace = spaces.find((space) => space.id === spaceId) ?? null;
  const role = currentSpace?.role ?? spaceRole;
  const readOnly = role === "viewer";
  // 建板逻辑（含配额/离线/慢请求处理）统一走 useCreateBoard，与旧首页入口同一份实现
  const { busy, slow, error: createError, start } = useCreateBoard({
    messageFor: boardsMessageFor,
    spaceId: currentSpace?.kind === "team" ? currentSpace.id : undefined,
    owner,
  });

  const load = useCallback(async (targetSpace?: string, quiet = false) => {
    if (!quiet) setView({ kind: "loading" });
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
      if (me.status !== 401) {
        // 网络失败 / 超时 / 服务端不可达：身份未知。
        // 保留 owner、空间与本地最近记录（不清、不改成游客），只换成「身份未知」态；
        // 游客视图的建板、认领横幅等写操作在这个分支下一律不渲染。
        setClaimBarVisible(false);
        setMeUser(null);
        setMeMethods([]);
        setAccountOpen(false);
        setAccountNotice(null);
        setView({ kind: "unknown" });
        return;
      }
      // 401：确实未登录，列表完全来自本机临时板，不保留任何服务端列表/空间/计数状态
      setActiveOwner(GUEST_OWNER);
      setOwner(GUEST_OWNER);
      setSpaces([]);
      setSpaceId("");
      spaceIdRef.current = "";
      setTrashCount(0);
      setMeUser(null);
      setMeMethods([]);
      setAccountOpen(false);
      setAccountNotice(null);
      setView({ kind: "guest", items: guestBoardItems() });
      return;
    }
    const currentOwner = userOwner(me.data.user.id);
    setActiveOwner(currentOwner);
    setOwner(currentOwner);
    setMeUser(me.data.user);
    setMeMethods(me.data.methods);

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

    const list = await fetchAllBoards(candidate, undefined, showArchivedRef.current || undefined);
    if (!list.ok) {
      setView(list.status === 404 ? { kind: "missing" } : { kind: "error", message: "列表没刷新成功" });
      return;
    }
    setSpaceRole(list.data.spaceRole ?? "owner");
    setSortModeState(list.data.sortMode);
    setView({
      kind: "user",
      items: sortBoards(list.data.boards, list.data.sortMode),
      user: { displayName: me.data.user.displayName, avatarUrl: me.data.user.avatarUrl },
    });
    // 重新加载拿到的是全量列表：清掉已应用标记并触发一次，让当前搜索词继续生效
    appliedQueryRef.current = "";
    setSearchEpoch((epoch) => epoch + 1);

    if (!readFlag(CLAIM_DISMISSED_KEY)) {
      const p = await fetchClaimPreview();
      if (p.ok && p.data.count > 0 && p.data.guestActive !== false) {
        setPreview(p.data);
        setClaimBarVisible(true);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 第三方绑定回调落回列表页：`?account=1&github=linked` / `&githubError=...`，
   * Google 同理（`google` / `googleError`）。自动打开账号弹窗并提示一次，
   * 然后把参数从地址栏清掉，刷新不会重复弹。
   */
  useEffect(() => {
    if (!meUser) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("account") !== "1") return;
    const provider = params.has("google") || params.has("googleError") ? "google" : "github";
    const linked = params.get(provider);
    const error = params.get(`${provider}Error`);
    if (!linked && !error) return;
    const label = provider === "google" ? "Google" : "GitHub";

    setAccountNotice(
      error
        ? oauthBindErrorMessage(provider, error) ?? `${label} 绑定失败，请稍后重试`
        : linked === "already-linked"
          ? `这个 ${label} 账号已经绑定到当前账号`
          : `${label} 已绑定`,
    );
    setAccountOpen(true);

    params.delete("account");
    params.delete("github");
    params.delete("githubError");
    params.delete("google");
    params.delete("googleError");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, [meUser]);

  // 搜索输入防抖 250ms：trim 后比较，只敲空格不会触发请求
  useEffect(() => {
    const next = query.trim();
    const timer = window.setTimeout(() => setDebouncedQuery(next), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  // 登录用户的板名搜索：服务端按 q 过滤，空间与分页口径不变
  useEffect(() => {
    const current = viewRef.current;
    if (current.kind !== "user") return;
    if (debouncedQuery === appliedQueryRef.current) return;
    const wanted = debouncedQuery;
    let alive = true;
    void fetchAllBoards(
      spaceIdRef.current || undefined,
      wanted || undefined,
      showArchivedRef.current || undefined,
    ).then((res) => {
      if (!alive) return;
      if (!res.ok) {
        // 失败保留已有列表，只提示，避免搜索把页面打空
        setToast("搜索没成功，请重试");
        return;
      }
      setView((prev) =>
        prev.kind === "user" ? { ...prev, items: sortBoards(res.data.boards, res.data.sortMode) } : prev,
      );
      // 结果集变了：退出批量选择，避免对已经不可见的卡片继续操作
      setSelectMode(false);
      setSelected(new Set());
      setAllScope(false);
      appliedQueryRef.current = wanted;
    });
    return () => {
      alive = false;
    };
  }, [debouncedQuery, searchEpoch]);

  // 身份未知态自动重试：联网恢复立即试一次，服务端恢复靠 6s 轮询；
  // quiet 重试不切回骨架，面板原地变成正常登录视图。
  useEffect(() => {
    if (view.kind !== "unknown") return;
    let inflight = false;
    const retry = () => {
      if (inflight) return;
      inflight = true;
      void load(undefined, true).finally(() => {
        inflight = false;
      });
    };
    window.addEventListener("online", retry);
    const timer = window.setInterval(retry, 6_000);
    return () => {
      window.removeEventListener("online", retry);
      window.clearInterval(timer);
    };
  }, [view.kind, load]);

  // 前进 / 后退按地址栏重新加载；切空间用 pushState，刷新后仍停在同一个空间
  useEffect(() => {
    const onPop = () => void load();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [load]);

  // 回收站入口徽标：登录用户才取，401/网络失败都静默降级为不显示徽标
  useEffect(() => {
    if (owner.kind !== "user") {
      setTrashCount(0);
      return;
    }
    let alive = true;
    void fetchTrashCount().then((result) => {
      if (alive && result.ok) setTrashCount(result.data.count);
    });
    return () => {
      alive = false;
    };
  }, [owner]);

  // 缩略图与列表并行取：按身份读，列表先到也要等缩略图，避免卡片先显示线稿再换成图片
  useEffect(() => {
    let alive = true;
    let created: string[] = [];
    setThumbs({});
    setThumbsReady(false);
    void loadThumbUrls(ownerTagValue)
      .then((urls) => {
        created = Object.values(urls);
        if (!alive) {
          created.forEach((url) => URL.revokeObjectURL(url));
          return;
        }
        setThumbs(urls);
        setThumbOwner(ownerTagValue);
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
  }, [ownerTagValue, thumbEpoch]);

  /**
   * 切到游客视图：列表、容量计数、空间上下文、回收站计数、缩略图、
   * 选择/菜单/改名等账号维度状态一次性清空，账号的板子一帧都不留。
   * 广播收到与本页主动退出共用这一套。
   */
  const switchToGuest = useCallback(() => {
    setActiveOwner(GUEST_OWNER);
    setOwner(GUEST_OWNER);
    setView({ kind: "guest", items: guestBoardItems() });
    setSpaces([]);
    setSpaceId("");
    spaceIdRef.current = "";
    setSpaceRole("owner");
    setSettingsOpen(false);
    setAccountOpen(false);
    setMeUser(null);
    setPreview(null);
    setClaimBarVisible(false);
    setDialogOpen(false);
    setTrashCount(0);
    setThumbs({});
    setThumbsReady(false);
    setSelectMode(false);
    setSelected(new Set());
    setMenu(null);
    setEditingId(null);
    setUndoToast(null);
  }, []);

  // 其它标签页退出登录：首页广播后本页立刻切游客，不等下一次请求 401
  useEffect(() => subscribeLogout(switchToGuest), [switchToGuest]);

  const [loggingOut, setLoggingOut] = useState(false);
  const handleBoardsLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const result = await logout();
      if (!result.ok) {
        setToast("退出登录失败，请重试");
        return;
      }
      switchToGuest();
      publishLogout();
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut, switchToGuest]);

  /** 销号成功：服务端已清 cookie 并作废会话，这里广播登出并回首页（不再打 logout 接口）。 */
  const handleAccountDeleted = useCallback(() => {
    setAccountOpen(false);
    setAccountNotice(null);
    setMeMethods([]);
    publishLogout();
    window.location.assign("/");
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

  /** 重新拉一次转入预览：腾出名额 / 删除白板后，横幅上的用量与块数保持真实 */
  const refreshClaimPreview = async () => {
    if (!preview) return;
    const p = await fetchClaimPreview();
    if (!p.ok) return;
    if (p.data.count === 0 || p.data.guestActive === false) {
      setPreview(null);
      setClaimBarVisible(false);
      return;
    }
    setPreview(p.data);
    setClaimBarVisible(true);
  };

  /** 打开转入弹窗：先用服务端最新用量覆盖本地 preview，避免拿着旧容量做判断 */
  const openClaim = async () => {
    const p = await fetchClaimPreview();
    if (!p.ok) {
      setToast("读取临时板信息失败，请稍后重试。");
      return;
    }
    if (p.data.guestActive === false || p.data.count === 0) {
      setPreview(null);
      setClaimBarVisible(false);
      setDialogOpen(false);
      setToast(p.data.guestActive === false ? "游客身份已失效，无法再转入这些临时板。" : "没有待转入的临时板。");
      return;
    }
    setPreview(p.data);
    setClaimBarVisible(true);
    setDialogOpen(true);
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
  const searching = query.trim() !== "";
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
          thumbnailUrl: item.thumbnailUrl,
        }))
      // 游客列表在本机，搜索只能本地过滤（不改 view state，只影响渲染）
      : sortBoards(
          view.items.filter((item) => matchesBoardTitle(item.title, query)),
          sortMode,
        ).map((item) => ({
          id: item.id,
          title: item.title,
          lastEditedAt: item.lastEditedAt,
          pinned: false,
          badge: "公共板",
          badgeTone: "guest",
          role: "editor",
          guest: true,
          publicBoard: true,
        }));

  const cardsReady = listReady && thumbsReady;
  // 搜索无结果有专属空态，这里只在没搜索时展示原有空态；已归档视图用专属空态
  const showEmpty = listReady && cards.length === 0 && !searching && !showArchived;
  const skeletonActive = view.kind === "loading" || (listReady && cards.length > 0 && !thumbsReady);
  const skeletonPhase = useSkeletonPhase(skeletonActive);

  // 登录账号不限量，列表已按页拉全，不再截断
  const visible = previewIds
    ? (() => {
        const byId = new Map(cards.map((card) => [card.id, card]));
        const ordered = previewIds
          .map((id) => byId.get(id))
          .filter((card): card is CardModel => Boolean(card));
        const seen = new Set(ordered.map((card) => card.id));
        return [...ordered, ...cards.filter((card) => !seen.has(card.id))];
      })()
    : cards;

  // 占位格只在「总数超过 12」时出现：12 张及以内一律完整展示，末位就是那块白板。
  // 超过 12 时一屏 12 格 = 11 张卡 + 第 12 格占位；点一次补上第 12 块再追加 11 块，
  // 因此每轮显示数增加 12（11 → 23 → 35），占位落在 12 / 24 / 36 格，最后一批铺满即消失。
  const collapsed = visible.length <= BOARDS_CAPACITY;
  const shownCount = collapsed
    ? visible.length
    : BOARDS_CAPACITY - 1 + expandedRounds * BOARDS_CAPACITY;
  const shownCards = visible.slice(0, shownCount);
  const remainingCount = visible.length - shownCards.length;
  useEffect(() => {
    setExpandedRounds(0);
  }, [currentSpace?.id]);
  const selectedCount = cards.filter((card) => selected.has(card.id)).length;
  // 游客只有一块公共板，没有"删除/置顶/改名"这类单板操作，批量选择也关掉；
  // 已归档视图是列表整理视图，不提供批量操作
  const isSelectable = view.kind === "user" && !readOnly && !showArchived;
  // 搜索生效时禁止拖拽重排：不能在过滤后的子集上写 rank；已归档视图同样禁止排序
  const canSort = view.kind === "user" && !selectMode && !sortBusy && !readOnly && !searching && !showArchived;
  const groupsNow = splitGroups(shownCards);
  const groupIdsOf = (group: DragGroupKey): string[] =>
    (group === "pinned" ? groupsNow.pinned : groupsNow.others).map((card) => card.id);

  /**
   * 桌面端宽度优先：卡片宽度只由列宽决定，四列均分内容区并铺满，不因高度不足而缩小。
   * 顶栏按设计稿抬到 64px 给空间切换条留呼吸（见 pages.css），多出的 20px 从页头留白里回收：
   * 上下 8、网格上边距 4，正好抵消，一屏卡片数与改动前一致，不额外引出滚动条。
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
      container?.style.setProperty("padding-top", "8px");
      container?.style.setProperty("padding-bottom", "8px");
      wrapper?.style.setProperty("margin-top", "4px");
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
    const order = shownCards.map((card) => card.id);
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
      const order = shownCards.map((card) => card.id);
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
    const ids = shownCards.map((card) => card.id);
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
    setFocusedId(shownCards[0]?.id ?? null);
  };

  const invertVisible = () => {
    const ids = shownCards.map((card) => card.id);
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
      const order = shownCards.map((card) => card.id);
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
    const order = shownCards.map((card) => card.id);
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
    // 公共板没有单板操作（改名/置顶/删除都会破坏"所有人共用一块"的语义）
    if (board.publicBoard) return;
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

  /** 退出空间：从本地空间列表移除，回到个人空间，列表重新加载 */
  const handleSpaceLeft = (space: SpaceSummary) => {
    setSettingsOpen(false);
    setSpaces((current) => current.filter((entry) => entry.id !== space.id));
    window.history.pushState({}, "", "/boards");
    window.scrollTo({ top: 0, behavior: "auto" });
    void load().then(() => setToast(`已退出「${space.name}」`));
  };

  /** 解散空间：同退出落点，白板已由服务端移入所有者回收站 */
  const handleSpaceDissolved = (space: SpaceSummary) => {
    setSettingsOpen(false);
    setSpaces((current) => current.filter((entry) => entry.id !== space.id));
    window.history.pushState({}, "", "/boards");
    window.scrollTo({ top: 0, behavior: "auto" });
    void load().then(() => setToast(`「${space.name}」已解散，白板已移入回收站`));
  };

  /** 转让所有权：当前用户降为编辑者，设置面板保持打开以便继续退出 */
  const handleSpaceTransferred = (spaceId: string) => {
    setSpaces((current) =>
      current.map((entry) => (entry.id === spaceId ? { ...entry, role: "editor" as const } : entry)),
    );
    setSpaceRole("editor");
    setToast("已转让所有权，你现在是编辑者");
  };

  const backToPersonal = () => {
    window.history.pushState({}, "", "/boards");
    void load();
  };

  /** 立即清空搜索（输入框与生效词一起重置，不等防抖） */
  const clearSearch = () => {
    setQuery("");
    setDebouncedQuery("");
  };

  /** 切换「已归档 / 返回白板」：沿用当前空间与搜索词重新拉取 */
  const toggleArchived = () => {
    const next = !showArchivedRef.current;
    showArchivedRef.current = next;
    setShowArchived(next);
    // quiet 重试不切骨架；load 会清空 appliedQueryRef 并触发搜索 effect，搜索词继续生效
    void load(spaceIdRef.current, true);
  };

  const refreshList = useCallback(async () => {
    // 搜索生效时重拉也带上当前 q，避免刷新后列表与输入框不一致；已归档视图同理
    const list = await fetchAllBoards(
      spaceIdRef.current || undefined,
      appliedQueryRef.current || undefined,
      showArchivedRef.current || undefined,
    );
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
      // 腾出的名额反映到待转入横幅，避免容量判据还是删除前那份
      void refreshClaimPreview();
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

  /** 清空公共板：服务端按正常 delete op 落库并广播，在线/离线客户端都会收敛 */
  const confirmPublicReset = async () => {
    if (publicResetBusy) return;
    setPublicResetBusy(true);
    const result = await resetPublicBoard();
    setPublicResetBusy(false);
    if (!result.ok) {
      setToast("没清空成功，稍后再试。");
      return;
    }
    setPublicResetOpen(false);
    setThumbEpoch((epoch) => epoch + 1);
    setToast(result.data.cleared > 0 ? `已清空 ${result.data.cleared} 个元素` : "这本来就是一块空板");
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
    // 批量腾名额同样要刷新待转入横幅的容量判据
    void refreshClaimPreview();
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

  /**
   * 拖拽自动滚动。
   *
   * 指针贴住视口上下边缘时按「离边缘多近」加速滚动（64px 内线性加速，压到边缘 18px/帧
   * ≈ 1080px/s），这样用户不用先松手滚一轮，就能把卡片拖到首屏之外的行。
   * 只由拖拽驱动：`moveDrag` 负责起帧与续帧，松手 / 取消 / 指针离开窗口 / 组件卸载都会停。
   */
  const stopAutoScroll = useCallback(() => {
    autoScrollPointRef.current = null;
    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const autoScrollTick = useCallback(() => {
    autoScrollRafRef.current = null;
    const point = autoScrollPointRef.current;
    if (!point || !dragSessionRef.current) return;
    const step = edgeScrollStep(point.y, 0, window.innerHeight);
    if (step === 0) {
      stopAutoScroll();
      return;
    }
    const before = window.scrollY;
    window.scrollBy(0, step);
    // 已经到页面顶部 / 底部，滚不动了：停掉循环，下一次 pointermove 再判断
    if (window.scrollY === before) {
      stopAutoScroll();
      return;
    }
    // 滚动之后卡片几何全变了，用同一指针坐标重算落点（moveDrag 内部会续下一帧）
    dragApiRef.current?.move(point.x, point.y);
  }, [stopAutoScroll]);

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

    // 边缘区里按接近程度起帧滚动；离开边缘或指针出视口就立刻停
    autoScrollPointRef.current = { x, y };
    if (edgeScrollStep(y, 0, window.innerHeight) === 0) {
      stopAutoScroll();
    } else if (autoScrollRafRef.current === null) {
      autoScrollRafRef.current = window.requestAnimationFrame(autoScrollTick);
    }

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
    stopAutoScroll();
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
    // 指针移出窗口后收不到 pointermove，最后一帧的边缘坐标会一直滚下去，必须在这里停
    const onLeave = () => stopAutoScroll();
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onCancel);
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onCancel);
      document.removeEventListener("pointerleave", onLeave);
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

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

  /** 标题落到本地列表（游客同时写本机 recentBoards，刷新才不会回退） */
  const applyBoardTitle = (id: string, title: string) => {
    if (view.kind === "guest") renameRecentBoard(id, title);
    setView((current) => {
      if (current.kind === "user") {
        return { ...current, items: current.items.map((item) => (item.id === id ? { ...item, title } : item)) };
      }
      if (current.kind === "guest") {
        return { ...current, items: current.items.map((item) => (item.id === id ? { ...item, title } : item)) };
      }
      return current;
    });
  };

  const startRename = (board: CardModel) => {
    if (readOnly || board.publicBoard) return;
    editRef.current = { id: board.id, value: board.title, original: board.title, cancelled: false };
    setEditingId(board.id);
    setEditValue(board.title);
  };

  const changeRename = (value: string) => {
    if (editRef.current) editRef.current.value = value;
    setEditValue(value);
  };

  const cancelRename = () => {
    if (editRef.current) editRef.current.cancelled = true;
    editRef.current = null;
    setEditingId(null);
    setEditValue("");
  };

  /** Enter / 失焦 / 菜单都走这里：先本地乐观更新，服务端失败再回滚原名 */
  const submitRename = async () => {
    const edit = editRef.current;
    if (!edit || edit.cancelled) return;
    const title = edit.value.trim();
    if (!title) {
      cancelRename();
      setToast("标题不能为空，已保留原名");
      return;
    }
    if (title.length > LIMITS.boardTitleMax) {
      setToast(`标题最多 ${LIMITS.boardTitleMax} 个字符`);
      return;
    }
    editRef.current = null;
    setEditingId(null);
    setEditValue("");
    if (title === edit.original) return;

    applyBoardTitle(edit.id, title);
    const result = await renameBoard(edit.id, title);
    if (!result.ok) {
      applyBoardTitle(edit.id, edit.original);
      setToast("改名没成功，已恢复原名");
      return;
    }
    applyBoardTitle(edit.id, result.data.title);
    setToast("已重命名");
  };

  /** 归档 / 取消归档：成功后从当前列表移除（默认视图与归档视图都是"移出本视图"） */
  const archiveBoard = async (board: CardModel) => {
    const result = await setBoardArchived(board.id, !showArchived);
    if (!result.ok) {
      setToast("操作没成功，请重试");
      return;
    }
    setView((current) =>
      current.kind === "user"
        ? { ...current, items: current.items.filter((item) => item.id !== board.id) }
        : current,
    );
  };

  const handleMenuAction = (key: string) => {
    const target = menu;
    if (!target) return;
    const board = target.board;
    const trigger = target.trigger;
    setMenu(null);

    switch (key) {
      case "open":
        // 带上当前列表地址（团队空间会含 ?space=），返回按钮据此回到本层
        window.location.href = boardHref(board.id, currentListHref());
        return;
      case "rename":
        startRename(board);
        return;
      case "move-to":
        openPicker(board);
        return;
      case "pin":
        void togglePin(board.id, !board.pinned);
        return;
      case "archive":
        void archiveBoard(board);
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
      thumbUrl={board.thumbnailUrl ?? (ownerTagValue === thumbOwner ? thumbs[board.id] : undefined)}
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
      editing={editingId === board.id}
      editValue={editValue}
      onEditChange={changeRename}
      onEditCommit={() => void submitRename()}
      onEditCancel={cancelRename}
      onRename={startRename}
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
          {/* 装饰性图标：品牌文字紧随其后，不重复朗读 */}
          <img className="wb-brand__mark" src={sakuraMark} alt="" aria-hidden />
          Sakura
        </a>
        {view.kind === "user" && spaces.length > 0 ? (
          <SpaceSwitcher
            spaces={spaces}
            currentId={spaceId}
            avatarUrl={view.kind === "user" ? view.user.avatarUrl : null}
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
          <button
            className="wb-user-chip wb-user-chip--action"
            type="button"
            onClick={() => setAccountOpen(true)}
            title="账号设置"
            aria-haspopup="dialog"
          >
            {view.user.avatarUrl ? (
              <img className="wb-user-chip__avatar" src={view.user.avatarUrl} alt="" />
            ) : (
              <UserMark />
            )}
            <span className="wb-caption" data-testid="boards-user">
              {view.user.displayName}
            </span>
          </button>
        ) : null}
        {view.kind === "user" ? (
          <button
            className="wb-boards__logout"
            type="button"
            onClick={() => void handleBoardsLogout()}
            disabled={loggingOut}
            data-testid="boards-logout"
            title="退出登录"
            aria-label="退出登录"
          >
            <IconLogout size={16} />
            <span className="wb-boards__logout-text">{loggingOut ? "退出中" : "退出登录"}</span>
          </button>
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
        {view.kind === "unknown" ? null : selectMode && isSelectable ? (
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
                  ? "所有人共用的一块板"
                  : currentSpace?.kind === "team"
                    ? `团队空间 · ${currentSpace.memberCount} 位成员`
                    : "个人空间 · 只有你能看到"}
              </p>
              <div className="wb-boards__titleline">
                <h1 className="wb-display">
                  {isGuest ? "公共临时板" : currentSpace?.kind === "team" ? currentSpace.name : "我的白板"}
                </h1>
                {!isGuest && currentSpace ? (
                  <span className={`wb-space-role wb-space-role--${role}`} data-testid="space-role">
                    {SPACE_ROLE_LABEL[role] ?? role}
                  </span>
                ) : null}
                {listReady ? (
                  isGuest ? (
                    <span
                      className="wb-boards__count"
                      title="所有未登录访客打开的都是这一块板，任何人的清空都会影响所有人"
                    >
                      任何人可编辑
                    </span>
                  ) : (
                    <span className="wb-boards__count wb-nums" title="当前空间的白板总数">
                      {showArchived ? `${view.items.length} 块已归档` : `${view.items.length} 块`}
                    </span>
                  )
                ) : null}
              </div>
            </div>
            <div className="wb-boards__head-actions">
              {listReady ? (
                <>
                  <input
                    className="wb-input wb-boards__search"
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索白板名称"
                    aria-label="搜索白板名称"
                    data-testid="boards-search"
                  />
                  {query ? (
                    <button
                      className="wb-boards__search-clear"
                      type="button"
                      onClick={clearSearch}
                      aria-label="清除搜索"
                      title="清除搜索"
                      data-testid="boards-search-clear"
                    >
                      ×
                    </button>
                  ) : null}
                </>
              ) : null}
              {!isGuest && listReady ? (
                <button
                  className="wb-btn wb-btn--ghost"
                  type="button"
                  onClick={toggleArchived}
                  aria-pressed={showArchived}
                  data-testid="boards-archived-toggle"
                >
                  {showArchived ? "返回白板" : "已归档"}
                </button>
              ) : null}
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
                <>
                  {isGuest ? (
                    <button
                      className="wb-btn wb-btn--ghost"
                      type="button"
                      onClick={() => setPublicResetOpen(true)}
                      data-testid="boards-reset-public"
                    >
                      <IconTrash />
                      清空
                    </button>
                  ) : null}
                  <button
                    className="wb-btn wb-btn--primary wb-btn--pill"
                    type="button"
                    onClick={() => void start()}
                    disabled={busy}
                    data-testid="boards-new"
                  >
                    {busy ? <span className="wb-spinner" aria-hidden /> : <IconPlus />}
                    {busy
                      ? slow
                        ? "还在连接…"
                        : "正在打开…"
                      : isGuest
                        ? "打开公共板"
                        : "新建白板"}
                  </button>
                </>
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
          <div className="wb-banner wb-banner--info wb-boards__banner" role="status" data-testid="claim-banner">
            <span>
              {preview.count} 块临时板，要转入当前账号吗？不转入的话，登录状态下看不到它们。
            </span>
            <span className="wb-banner__spacer" />
            <button
              className="wb-btn wb-btn--ghost wb-btn--sm"
              type="button"
              data-testid="claim-banner-open"
              onClick={() => void openClaim()}
            >
              全部转入
            </button>
            <button className="wb-btn wb-btn--ghost wb-btn--sm" type="button" onClick={dismissClaimBar} data-testid="claim-banner-later">
              暂不
            </button>
          </div>
        ) : null}

        {view.kind === "unknown" ? (
          <div className="wb-panel--error" style={{ marginTop: "var(--space-6)" }} role="status" data-testid="boards-unknown">
            <h2 className="wb-subtitle">连不上服务器，暂时无法确认登录状态</h2>
            <p className="wb-caption">
              你的白板与最近记录都还在本地。恢复网络后会自动重试，也可以点下面的按钮立即重试。
            </p>
            <button
              className="wb-btn wb-btn--primary"
              type="button"
              onClick={() => void load()}
              data-testid="boards-unknown-retry"
            >
              重试
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

        {listReady && searching && cards.length === 0 && !showArchived ? (
          <div className="wb-empty" data-testid="boards-search-empty">
            <span className="wb-empty__icon" aria-hidden>
              <IconBoard size={24} />
            </span>
            <h2 className="wb-title">没有匹配的白板</h2>
            <p className="wb-caption">试试其他关键词，或清除搜索查看全部。</p>
            <button className="wb-btn wb-btn--primary" type="button" onClick={clearSearch}>
              清除搜索
            </button>
          </div>
        ) : null}

        {showArchived && listReady && cards.length === 0 ? (
          <div className="wb-empty" data-testid="boards-archived-empty">
            <span className="wb-empty__icon" aria-hidden>
              <IconBoard size={24} />
            </span>
            <h2 className="wb-title">还没有归档的白板</h2>
            <p className="wb-caption">归档后白板会从默认列表消失，随时可以取消归档。</p>
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
                  ? "这块浏览器还没记录任何临时板。新建一块立刻开始画，登录后还能把它带进账号。"
                  : currentSpace?.kind === "team"
                    ? "新建一块，空间里的成员都能看到。"
                    : "新建一块，立刻开始画。"
              }
              onNew={() => void start()}
              onLogin={isGuest ? () => (window.location.href = "/login?next=%2Fboards") : undefined}
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
                {remainingCount > 0 ? (
                  <button
                    className="wb-card wb-board-card wb-board-card--more"
                    type="button"
                    data-testid="boards-more"
                    aria-label={`展开剩余 ${remainingCount} 块白板`}
                    onClick={() => setExpandedRounds((round) => round + 1)}
                  >
                    <span className="wb-board-card__thumb wb-board-card__thumb--more" aria-hidden>
                      <span className="wb-board-card__more-count wb-nums">+{remainingCount}</span>
                    </span>
                    <span className="wb-board-card__title">还有 {remainingCount} 块白板</span>
                    <span className="wb-board-card__meta">
                      <span>点击展开</span>
                    </span>
                  </button>
                ) : null}
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
            <DialogClose onClose={() => setGuestTrash(null)} disabled={guestTrashBusy} />
            <h2 className="wb-dialog__title" id="wb-guest-trash-title" title={`删除临时板「${guestTrash.title}」？`}>
              <span>删除临时板「</span>
              <span className="wb-dialog__title-name">{guestTrash.title}</span>
              <span>」？</span>
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

      {publicResetOpen ? (
        <div
          className="wb-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !publicResetBusy) setPublicResetOpen(false);
          }}
        >
          <div
            className="wb-dialog wb-trash__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-public-reset-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !publicResetBusy) {
                event.preventDefault();
                setPublicResetOpen(false);
              }
            }}
          >
            <DialogClose onClose={() => setPublicResetOpen(false)} disabled={publicResetBusy} />
            <h2 className="wb-dialog__title" id="wb-public-reset-title" title="清空公共临时板？">
              <span>清空公共临时板？</span>
            </h2>
            <p className="wb-dialog__desc">
              这是所有人共用的一块板，清空会删掉所有人当前画布上的内容，且无法恢复；正在编辑的人会立刻看到画布被清空。
              历史游客板与账号里的白板不受影响。
            </p>
            <div className="wb-dialog__actions">
              <button
                className="wb-btn wb-btn--ghost"
                type="button"
                autoFocus
                disabled={publicResetBusy}
                onClick={() => setPublicResetOpen(false)}
              >
                取消
              </button>
              <button
                className="wb-btn wb-btn--danger"
                type="button"
                disabled={publicResetBusy}
                onClick={() => void confirmPublicReset()}
                data-testid="boards-reset-confirm"
              >
                {publicResetBusy ? "清空中…" : "确认清空"}
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
            archived: showArchived,
            anchor: menu.anchor,
            trigger: menu.trigger,
          }}
          onAction={handleMenuAction}
          onClose={closeMenu}
        />
      ) : null}

      {settingsOpen && currentSpace ? (
        <SpaceSettings
          space={currentSpace}
          onClose={() => setSettingsOpen(false)}
          onLeft={handleSpaceLeft}
          onDissolved={handleSpaceDissolved}
          onTransferred={handleSpaceTransferred}
        />
      ) : null}

      {accountOpen && meUser ? (
        <AccountSettingsDialog
          user={meUser}
          methods={meMethods}
          onMethodsChange={setMeMethods}
          initialNotice={accountNotice}
          onClose={() => {
            setAccountOpen(false);
            setAccountNotice(null);
          }}
          onUserChange={(user) => {
            setMeUser(user);
            setView((current) =>
              current.kind === "user"
                ? { ...current, user: { displayName: user.displayName, avatarUrl: user.avatarUrl } }
                : current,
            );
          }}
          onDeleted={handleAccountDeleted}
        />
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
            setPreview(null);
            if (result.transferred === 0) return;
            // 本机缩略图与「最近打开」跟着板搬到账号下，再重拉列表与缩略图
            void migrateGuestLocalData(result.userId, result.boards.map((board) => board.id)).finally(() => {
              setThumbEpoch((value) => value + 1);
              setToast(`已转入 ${result.transferred} 块临时板`);
              void load();
            });
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
  editing,
  editValue,
  onEditChange,
  onEditCommit,
  onEditCancel,
  onRename,
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
  /** 就地改名：输入框顶替标题行，高度与标题一致，网格不跳动 */
  editing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  /** 双击标题进入就地改名（鼠标入口；键盘仍走菜单 / F2） */
  onRename: (board: CardModel) => void;
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

  // 双击标题改名：标题在卡片的 <a> 里，原生链接会吃掉第一次 click 直接导航，
  // 所以单击先拦住默认行为、延时 250ms 判定；期间出现第二次点击就取消导航并进入改名。
  // 不依赖 dblclick 事件：部分自动化/触控环境只发两次 detail=1 的 click，这里按点击间隔判定。
  const openTimer = useRef<number | null>(null);
  const lastTitleClick = useRef(0);
  const cancelOpen = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  useEffect(() => cancelOpen, []);

  const canRename = !readOnly && !selectMode && !editing;

  const onTitleClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (!canRename || event.button !== 0) return;
    // 带修饰键是「新标签/新窗口打开」，保持原生行为，不延时
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const now = performance.now();
    const doubled = now - lastTitleClick.current < 300;
    lastTitleClick.current = now;
    cancelOpen();
    event.preventDefault();
    if (doubled) {
      onRename(board);
      return;
    }
    const href = event.currentTarget.closest("a")?.getAttribute("href");
    if (!href) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      window.location.href = href;
    }, 250);
  };

  const onTitleDoubleClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (!canRename) return;
    event.preventDefault();
    event.stopPropagation();
    cancelOpen();
    onRename(board);
  };

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
        href={boardHref(board.id, currentListHref())}
        // 链接默认可原生拖拽，会抢走 pointermove：排序必须关掉
        draggable={false}
        tabIndex={selectMode ? -1 : undefined}
        onClick={(event) => {
          // 改名时点标题不会跳进白板
          if (editing) {
            event.preventDefault();
            return;
          }
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
            // 离板时上传的服务端副本优先；没有则回退到本机 Blob 的 objectURL。
            // 加载失败时由 onError 隐藏，露出下面的线稿占位
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
        {editing ? (
          <input
            className="wb-board-card__title-input"
            value={editValue}
            autoFocus
            aria-label="白板名称"
            data-testid="rename-input"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onEditChange(event.target.value)}
            onBlur={onEditCommit}
            onKeyDown={(event) => {
              // 卡片上的键盘排序也监听 Enter / Esc，编辑时必须截住
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                onEditCommit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onEditCancel();
              }
            }}
          />
        ) : (
          <span
            className="wb-board-card__title"
            title={board.title}
            onClick={onTitleClick}
            onDoubleClick={onTitleDoubleClick}
          >
            {board.title}
          </span>
        )}
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
  onLogin,
}: {
  title?: string;
  hint?: string;
  onNew: () => void;
  /** 游客空态额外给一个登录入口：本机没有临时板时也有下一步 */
  onLogin?: () => void;
}) {
  return (
    <div className="wb-empty" data-testid="boards-empty">
      <span className="wb-empty__icon" aria-hidden>
        <IconBoard size={24} />
      </span>
      <h2 className="wb-title">{title}</h2>
      <p className="wb-caption">{hint}</p>
      <div className="wb-empty__actions">
        <button className="wb-btn wb-btn--primary wb-btn--pill" type="button" onClick={onNew}>
          新建第一块
        </button>
        {onLogin ? (
          <button
            className="wb-btn wb-btn--ghost"
            type="button"
            onClick={onLogin}
            data-testid="boards-empty-login"
          >
            登录 / 注册
          </button>
        ) : null}
      </div>
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
