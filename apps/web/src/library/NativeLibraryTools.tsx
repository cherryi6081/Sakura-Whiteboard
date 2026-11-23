/**
 * 原生 Library 上方的「类别条 + 搜索 + 两级工程模板」注入层。
 *
 * 为什么注入而不是自建侧栏：原生 `.library-unit` 的缩略图、点击插入、拖拽、
 * 多选、删除、底部「加入素材库」都是库内部实现；自建一套会把同一批元素再
 * 展示一遍，也容易和原生行为漂移。这里只接管「展示哪些条目」：
 *
 * - 类别条不设「全部」（和各类别重复展示同一批元素），默认落在工程模板；
 * - 工程模板是两级：一级只列 13 张整图模板，点一张进二级，只显示
 *   `map.ts` 里该模板用到的 1–7 个元件；
 * - 搜索跨全部类别与层级，结果渲染成列表（模板「打开」进二级、元件「插入」
 *   并标注所属模板），此时原生网格整体隐藏；
 * - 我的素材保持一级平铺。
 *
 * DOM 与条目的对应关系：个人素材网格（unpublished，可能带「加入素材库」磁贴）
 * 在前，种子网格（published）在后；两个网格里的 `.library-unit` 顺序与库条目
 * 一致，所以按索引就能把过滤结果贴回原生卡片。条目数据来自 persist 最近一次
 * load/save（`getKnownLibraryItems`），用户新增/删除后由订阅与轮询刷新。
 *
 * 插入后侧栏保持打开：Excalidraw 的 `addElementsFromPasteOrLibrary` 会主动把
 * `openSidebar` 置空，只有侧栏「docked 且 canFitSidebar」才保留（见 App.ts 的注释）。
 * docked 由公开的 appState 字段 `defaultSidebarDockedPreference` 控制，这里钉成
 * true；`canFitSidebar` 由 BoardCanvas 的 `UIOptions.dockedSidebarBreakpoint` 决定，
 * 那里把它钉成 1（属性面板停靠会让 `.excalidraw` 收窄 272px，任何按宽度算的断点
 * 都会在窄窗口下把插入判定成「放不下」，插入即关库）。
 * 这样插入时面板根本不会被卸载，类别、层级、滚动位置都不会丢，也不会出现
 * 「关一下再重开」。按产品口径，素材库除用户主动关闭（顶栏按钮、关闭键、Esc）
 * 外一直存在：点画布元素 / 空白 / 框选 / 拖拽 / 双击编辑都不关，docked 侧栏本来
 * 就跳过「点外面关闭」，这里只需在下方补回 Esc。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  CAT_LABEL,
  CATALOG,
  categoryOfItem,
  catalogEntryOfItem,
  DEFAULT_CATEGORY,
  LIBRARY_CATEGORIES,
} from "./catalog";
import { componentSlugsOfTemplate, templateNamesOfComponent } from "./map";
import { seedItemId, type LibraryItem } from "./libraryItems";
import { getKnownLibraryItems, subscribeLibrary } from "./persist";
import { restoreDefaultTemplates } from "./useSeedLibrary";
import "./library.css";

/** 数据未就绪时的兜底列表：只用于名称搜索与计数，不参与 DOM 映射 */
let fallbackItems: LibraryItem[] | null = null;

function currentItems(): readonly LibraryItem[] {
  const known = getKnownLibraryItems() as readonly LibraryItem[];
  if (known.length) return known;
  if (!fallbackItems) {
    fallbackItems = CATALOG.map((entry) => ({
      id: seedItemId(entry, "light"),
      status: "published" as const,
      created: 0,
      elements: [],
    })) as LibraryItem[];
  }
  return fallbackItems;
}

function textOf(item: LibraryItem): string {
  const parts: string[] = [];
  for (const element of item.elements) {
    const el = element as { type?: string; text?: string };
    if (el.type === "text" && el.text) parts.push(el.text);
  }
  return parts.join("\n");
}

/** 搜索口径：种子条目按目录中文名 / 类别 / 所属模板 / 文本，用户条目按「自建素材」+ 文本 */
function haystackOf(item: LibraryItem): string {
  const entry = catalogEntryOfItem(item.id);
  const owners =
    entry?.kind === "component" ? templateNamesOfComponent(entry.slug).join(" ") : "";
  return [
    item.id,
    entry ? entry.name : "自建素材",
    entry ? CAT_LABEL[entry.cat] : "",
    entry ? (entry.kind === "template" ? "整图模板" : "元件") : "",
    owners,
    textOf(item),
  ]
    .join("\n")
    .toLowerCase();
}

type FilterState = {
  category: string;
  /** 工程模板的二级：模板 slug；null = 一级 */
  templateSlug: string | null;
  query: string;
};

/**
 * 把类别 / 层级 / 搜索条件贴回原生 DOM。
 * 只切 class、隐藏网格，不动条目数据、不动卡片自身结构。
 * 同时把「条目 id → 原生卡片」记进 map，供搜索列表和「插入此模板」触发原生插入。
 */
/**
 * 过滤状态写到 `data-*` 而不是 class：原生卡片 hover 时 React 会重写 className
 * （`library-unit--hover`），把我们加的 class 一并抹掉，宽卡会瞬间缩回 55px、
 * 隐藏卡会闪回，等下一个 rAF 才补回来——表现就是悬停闪烁。dataset 不经 React，
 * 不会被覆盖。
 */
function setFlag(unit: HTMLElement, key: "wbOff" | "wbWide", on: boolean) {
  const next = on ? "1" : undefined;
  if (unit.dataset[key] !== next) {
    if (next) unit.dataset[key] = next;
    else delete unit.dataset[key];
  }
}

function applyPanel(host: HTMLElement, state: FilterState, unitMap: Map<string, HTMLElement>) {
  const panel = host.parentElement;
  if (!panel) return;
  panel.classList.add("wb-libbar-on");

  // 侧栏根节点由库渲染，React 会重写 className；夜间配色作用域改用 dataset 标记，
  // 只翻这一块岛（画布/外壳不继承）。
  const sidebar = panel.closest<HTMLElement>(".excalidraw .sidebar");
  if (sidebar && sidebar.dataset.wbIsland !== "1") sidebar.dataset.wbIsland = "1";

  const wrap = panel.querySelector<HTMLElement>(".library-menu-items-container__items");
  if (!wrap) return;

  const grids = Array.from(
    wrap.querySelectorAll<HTMLElement>(":scope > .library-menu-items-container__grid"),
  );
  const publishedGrid =
    grids.find((grid) =>
      grid.previousElementSibling?.classList.contains(
        "library-menu-items-container__header--excal",
      ),
    ) ?? null;

  const items = currentItems();
  const published = items.filter((item) => item.status === "published");
  const personal = items.filter((item) => item.status !== "published");

  const q = state.query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (item: LibraryItem) => haystackOf(item).includes(q);
  const templateComponents = state.templateSlug
    ? new Set(componentSlugsOfTemplate(state.templateSlug))
    : null;

  unitMap.clear();
  wrap.classList.toggle("wb-lib-units--hidden", searching);

  // 种子网格：索引一一对应 published 数组
  let publishedIndex = 0;
  if (publishedGrid) {
    for (const unit of Array.from(
      publishedGrid.querySelectorAll<HTMLElement>(":scope > .library-unit"),
    )) {
      const item = published[publishedIndex];
      publishedIndex += 1;
      if (item) unitMap.set(item.id, unit);

      const entry = item ? catalogEntryOfItem(item.id) : null;
      let visible: boolean;
      if (!item) {
        visible = false;
      } else if (searching) {
        visible = matches(item);
      } else if (state.category !== "eng" || !entry) {
        visible = false;
      } else if (!state.templateSlug) {
        visible = entry.kind === "template";
      } else {
        visible = entry.kind === "component" && Boolean(templateComponents?.has(entry.slug));
      }

      setFlag(unit, "wbOff", !visible);
      setFlag(
        unit,
        "wbWide",
        visible && !searching && state.category === "eng" && !state.templateSlug && entry?.kind === "template",
      );
      // 一级点模板卡 = 进二级，不是插入；把归属写到 dataset 供点击拦截读取
      unit.dataset.wbKind = entry?.kind ?? "personal";
      unit.dataset.wbSlug = entry?.slug ?? "";
    }
  }

  // 个人素材网格：可能只有「待定磁贴」、也可能拆成多个网格；逐个按 DOM 顺序对齐，
  // 「加入素材库」磁贴不对应库条目，直接跳过。
  let personalIndex = 0;
  for (const grid of grids) {
    if (grid === publishedGrid) continue;
    for (const unit of Array.from(
      grid.querySelectorAll<HTMLElement>(":scope > .library-unit"),
    )) {
      setFlag(unit, "wbWide", false);
      // 「加入素材库」待定磁贴在这个版本里是 `.library-unit__pulse`，不对应库条目
      if (unit.querySelector(".library-unit__pulse, .library-unit__adder")) {
        setFlag(unit, "wbOff", searching || state.category !== "mine");
        continue;
      }
      const item = personal[personalIndex];
      personalIndex += 1;
      if (item) unitMap.set(item.id, unit);
      const visible = Boolean(item) && !searching && state.category === "mine";
      setFlag(unit, "wbOff", !visible);
    }
  }
}

/** 搜索列表的缩略图：直接复用原生卡片里已经渲染好的 SVG，避免再跑一遍 exportToSvg */
function harvestThumbs(host: HTMLElement, unitMap: Map<string, HTMLElement>) {
  host.querySelectorAll<HTMLElement>("[data-wb-thumb-for]").forEach((slot) => {
    if (slot.firstElementChild) return;
    const unit = unitMap.get(slot.dataset.wbThumbFor ?? "");
    const svg = unit?.querySelector("svg");
    if (svg) slot.innerHTML = svg.outerHTML;
  });
}

/**
 * 把素材库侧栏钉成常驻 docked。
 *
 * `App.addElementsFromPasteOrLibrary` 只在「侧栏 docked 且放得下」时保留
 * `openSidebar`，否则置空（见库里的注释；拖拽落点这条路还是 async 的，关得更晚）。
 * docked 没有独立开关，但 `DefaultSidebar` 直接读这个公开的 appState 字段；写成
 * true 后插入时侧栏根本不会卸载，类别 / 层级 / 滚动位置自然保留。
 *
 * 不能在 api 刚就绪时只写一次：库随后初始化场景会用 `restore()` 的整份 appState
 * 覆盖掉它。所以放在面板观察循环里，侧栏每次打开都核对一次（值已经对了就不写）。
 */
function ensureSidebarDocked(api: ExcalidrawImperativeAPI | null) {
  if (!api) return;
  if (api.getAppState().defaultSidebarDockedPreference === true) return;
  api.updateScene({ appState: { defaultSidebarDockedPreference: true } });
}

type Props = {
  api: ExcalidrawImperativeAPI | null;
  rootRef: RefObject<HTMLDivElement | null>;
};

export function NativeLibraryTools({ api, rootRef }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  if (!hostRef.current && typeof document !== "undefined") {
    const host = document.createElement("div");
    host.setAttribute("data-wb-libbar", "1");
    hostRef.current = host;
  }
  const host = hostRef.current;

  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [templateSlug, setTemplateSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const wasOpenRef = useRef(false);
  const lastItemsRef = useRef<readonly LibraryItem[] | null>(null);
  const unitMapRef = useRef(new Map<string, HTMLElement>());
  /** 供 DOM 观察器调用最新的过滤参数，避免每次输入都重建 observer */
  const applyRef = useRef<() => void>(() => {});
  applyRef.current = () => {
    if (!host?.parentElement) return;
    applyPanel(host, { category, templateSlug, query }, unitMapRef.current);
    harvestThumbs(host, unitMapRef.current);
  };
  const stateRef = useRef<FilterState>({ category, templateSlug, query });
  stateRef.current = { category, templateSlug, query };

  /**
   * 一级的模板卡默认是「点击插入」；这里把「点击卡片」改成进二级，
   * 插入整张模板的入口挪到二级顶部（和设计稿一致）。拖拽仍然走原生插入。
   * 只在「工程模板一级、未搜索」时拦截，且只拦卡片主体（删除/复选框不动）。
   */
  useEffect(() => {
    const intercept = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-testid="library"]')) return;
      const unit = target.closest<HTMLElement>(".library-unit");
      if (!unit || unit.dataset.wbKind !== "template") return;
      if (!target.closest(".library-unit__dragger")) return;
      const state = stateRef.current;
      if (state.query.trim() || state.category !== "eng" || state.templateSlug) return;
      event.preventDefault();
      event.stopPropagation();
      setCategory("eng");
      setQuery("");
      setTemplateSlug(unit.dataset.wbSlug ?? null);
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, []);

  // 用户新增/删除/恢复默认后重算（save 会广播）
  useEffect(() => subscribeLibrary(() => setRevision((value) => value + 1)), []);

  /**
   * 补回 docked 侧栏丢掉的 Esc 入口。
   *
   * `SidebarInner` 对 docked 侧栏会主动跳过 `useOutsideClick` 与 Esc，开合由顶栏
   * 「素材库」、侧栏关闭键和这里负责。按产品口径，素材库除用户主动关闭外一直存在：
   * 点画布（元素、空白、框选、拖拽、双击编辑）都不再关闭，所以这里只留 Esc。
   *
   * Esc 的守卫：
   * - 有弹窗 / 右键菜单 / 下拉菜单时留给它们先处理；
   * - 正在输入/文本编辑时先退出编辑（Excalidraw 的文本编辑器是 textarea），
   *   不能把"取消编辑"变成"关掉素材库"。
   *
   * 监听必须挂在 **capture** 阶段：焦点在画布容器里时，库自己的 keydown 会
   * `stopPropagation`，冒泡到 document 的监听收不到事件（实测点画布后按 Esc
   * 一条 keydown 都到不了 document）。capture 在库的处理器之前触发，才能稳定接管。
   */
  useEffect(() => {
    if (!api) return;
    const blockingOverlay = () =>
      document.querySelector(
        ".Dialog, .excalidraw-modal-container, .context-menu, [role='dialog'], [role='menu']",
      );
    const closeLibrary = () => {
      if (blockingOverlay()) return;
      const open = api.getAppState().openSidebar;
      if (open?.name !== "default" || open.tab !== "library") return;
      api.updateScene({ appState: { openSidebar: null } });
    };
    // 文本编辑时 Esc 要先退出编辑，不能顺手关库。光看 activeElement 不够：
    // 库自身的 keydown 可能已经把 textarea 卸掉，此时 activeElement 已经落回 body，
    // 但事件 target 仍是那个 textarea。两边都查。
    const isEditing = (node: EventTarget | Element | null) => {
      const el = node as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isEditing(event.target as Element | null)) return;
      if (isEditing(document.activeElement)) return;
      closeLibrary();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [api]);

  // 只负责挂载与观察：把类别条插到 library 面板顶部，并在原生重渲染后重贴过滤
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !host) return;
    let panel: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    let frame = 0;

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyRef.current();
      });
    };

    const ensure = () => {
      const next = root.querySelector<HTMLElement>(
        '.sidebar.default-sidebar [data-testid="library"]',
      );
      if (next !== panel) {
        observer?.disconnect();
        observer = null;
        panel = next;
        if (panel) {
          observer = new MutationObserver(schedule);
          observer.observe(panel, { childList: true, subtree: true });
        }
        const open = Boolean(panel);
        if (open !== wasOpenRef.current) {
          wasOpenRef.current = open;
          // 收起后下次打开回到默认类别（插入不再触发关闭，见 ensureSidebarDocked）
          if (!open) {
            setCategory(DEFAULT_CATEGORY);
            setTemplateSlug(null);
            setQuery("");
          }
        }
      }
      if (!panel) return;
      ensureSidebarDocked(api);
      if (!panel.contains(host)) panel.insertBefore(host, panel.firstChild);

      // load() 在挂载后才完成时，这里把条目数据补进来（数组身份变化即刷新）
      const items = currentItems();
      if (items !== lastItemsRef.current) {
        lastItemsRef.current = items;
        setRevision((value) => value + 1);
      }
      schedule();
    };

    ensure();
    const timer = window.setInterval(ensure, 180);
    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      host.remove();
      panel?.classList.remove("wb-libbar-on");
    };
  }, [rootRef, host, api]);

  // 类别 / 层级 / 搜索 / 条目数据变化时立即重贴，等不到下一个轮询
  useEffect(() => {
    if (!host?.parentElement) return;
    applyPanel(host, { category, templateSlug, query }, unitMapRef.current);
    harvestThumbs(host, unitMapRef.current);
  }, [host, category, templateSlug, query, revision]);

  const catalog = useMemo(() => {
    const items = currentItems();
    const published = items.filter((item) => item.status === "published");
    const personal = items.filter((item) => item.status !== "published");
    const templates = published.filter(
      (item) => catalogEntryOfItem(item.id)?.kind === "template",
    );
    const components = published.filter(
      (item) => catalogEntryOfItem(item.id)?.kind === "component",
    );
    const q = query.trim().toLowerCase();
    const hits = q
      ? [...published, ...personal]
          .filter((item) => haystackOf(item).includes(q))
          .map((item) => {
            const entry = catalogEntryOfItem(item.id);
            return {
              item,
              entry,
              kind: entry?.kind ?? ("personal" as const),
              name: entry?.name ?? "自建素材",
              owners: entry?.kind === "component" ? templateNamesOfComponent(entry.slug) : [],
            };
          })
      : [];
    return { items, published, personal, templates, components, hits };
  }, [revision, query]);

  const activeTemplate = templateSlug
    ? catalog.templates.find((item) => catalogEntryOfItem(item.id)?.slug === templateSlug)
    : null;
  const activeName = activeTemplate ? (catalogEntryOfItem(activeTemplate.id)?.name ?? "") : "";
  const activeComponents = templateSlug
    ? catalog.components.filter((item) =>
        componentSlugsOfTemplate(templateSlug).includes(catalogEntryOfItem(item.id)?.slug ?? ""),
      )
    : [];

  if (!host) return null;

  const searching = query.trim().length > 0;
  const empty = searching
    ? catalog.hits.length === 0
    : category === "eng"
      ? Boolean(templateSlug) && activeComponents.length === 0
      : catalog.personal.length === 0;

  const insertItem = (itemId: string) => {
    const unit = unitMapRef.current.get(itemId);
    const trigger = unit?.querySelector<HTMLElement>(".library-unit__dragger") ?? unit;
    trigger?.click();
  };

  const openTemplate = (slug: string) => {
    setQuery("");
    setCategory("eng");
    setTemplateSlug(slug);
  };

  const backToLevelOne = () => {
    setQuery("");
    setCategory("eng");
    setTemplateSlug(null);
  };

  const bar = (
    <div className="wb-libbar">
      <div className="wb-libbar__cats" role="group" aria-label="素材类别">
        {searching ? (
          <span className="wb-libbar__cat is-on is-search">
            搜索「{query.trim()}」
            <span className="n">{catalog.hits.length}</span>
          </span>
        ) : null}
        {LIBRARY_CATEGORIES.map((item) => {
          const count = item.id === "eng" ? catalog.templates.length : catalog.personal.length;
          const on = !searching && category === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`wb-libbar__cat${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => {
                setQuery("");
                setCategory(item.id);
                setTemplateSlug(null);
              }}
            >
              {item.label}
              <span className="n">{count}</span>
            </button>
          );
        })}
      </div>

      <label
        className="wb-libbar__search"
        // Chrome 对文本输入框的 :focus-visible 恒为真，鼠标点入也会命中键盘焦点样式。
        // 这里记一次"最近一次是用指针聚焦"，鼠标态不画焦点环，键盘 Tab 进来才画。
        onPointerDown={(event) => {
          event.currentTarget.dataset.pointerFocus = "1";
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab") delete event.currentTarget.dataset.pointerFocus;
        }}
        onBlur={(event) => {
          delete event.currentTarget.dataset.pointerFocus;
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5L21 21" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder="搜索素材…"
          aria-label="搜索素材"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="wb-libbar__clear"
            aria-label="清空搜索"
            title="清空搜索"
            onClick={() => setQuery("")}
          >
            ×
          </button>
        ) : null}
      </label>

      {searching ? (
        <div className="wb-libbar__hits" role="list" aria-label="搜索结果">
          <div className="wb-libbar__hits-head">
            「{query.trim()}」· {catalog.hits.length} 条 · 全部类别
          </div>
          {catalog.hits.map((hit) => {
            const meta =
              hit.kind === "template"
                ? "整图模板 · 点开查看元件"
                : hit.kind === "component"
                  ? `元件 · 属于 ${hit.owners.join("、")}`
                  : "自建素材 · 点击插入";
            return (
              <div className="wb-lib-hit" role="listitem" key={hit.item.id}>
                <span className="wb-lib-hit__thumb" data-wb-thumb-for={hit.item.id} aria-hidden />
                <span className="wb-lib-hit__body">
                  <span className="wb-lib-hit__name">{hit.name}</span>
                  <span className="wb-lib-hit__meta">{meta}</span>
                </span>
                <button
                  type="button"
                  className="wb-lib-hit__act"
                  onClick={() => {
                    if (hit.kind === "template" && hit.entry) {
                      openTemplate(hit.entry.slug);
                    } else {
                      insertItem(hit.item.id);
                    }
                  }}
                >
                  {hit.kind === "template" ? "打开" : "插入"}
                </button>
              </div>
            );
          })}
        </div>
      ) : category === "eng" ? (
        templateSlug ? (
          <>
            <div className="wb-libbar__crumb">
              <button
                type="button"
                className="wb-libbar__back"
                aria-label="返回工程模板"
                title="返回工程模板"
                onClick={backToLevelOne}
              >
                ‹
              </button>
              <button type="button" className="wb-libbar__crumb-path" onClick={backToLevelOne}>
                工程模板<span className="sep">/</span>
                <b>{activeName}</b>
              </button>
              <button
                type="button"
                className="wb-libbar__insert"
                onClick={() => {
                  if (activeTemplate) insertItem(activeTemplate.id);
                }}
              >
                插入此模板
              </button>
            </div>
            <div className="wb-libbar__meta">
              <span>{activeComponents.length} 个元件 · 点击元件插入</span>
            </div>
          </>
        ) : (
          <div className="wb-libbar__meta">
            <span>共 {catalog.templates.length} 张模板 · 点一张查看元件</span>
            <button
              type="button"
              className="wb-libbar__restore"
              onClick={() => {
                if (api) restoreDefaultTemplates(api);
              }}
            >
              恢复默认模板
            </button>
          </div>
        )
      ) : (
        <div className="wb-libbar__meta">
          <span>{catalog.personal.length} 条自建素材</span>
          <button
            type="button"
            className="wb-libbar__restore"
            onClick={() => {
              if (api) restoreDefaultTemplates(api);
            }}
          >
            恢复默认工程模板
          </button>
        </div>
      )}

      {empty ? (
        <div className="wb-libbar__empty">
          {searching ? (
            <>
              <strong>没有找到「{query.trim()}」</strong>
              <p>换个关键词，或清空搜索回到刚才的类别。</p>
              <button type="button" className="wb-libbar__restore" onClick={() => setQuery("")}>
                清除搜索
              </button>
            </>
          ) : category === "eng" ? (
            <>
              <strong>这个模板还没有拆出元件</strong>
              <p>可以先插入整张模板，或返回一级换一张。</p>
              <div className="wb-libbar__empty-actions">
                <button
                  type="button"
                  className="wb-libbar__insert"
                  onClick={() => {
                    if (activeTemplate) insertItem(activeTemplate.id);
                  }}
                >
                  插入此模板
                </button>
                <button type="button" className="wb-libbar__restore" onClick={backToLevelOne}>
                  返回工程模板
                </button>
              </div>
            </>
          ) : (
            <>
              <strong>还没有自建素材</strong>
              <p>在画布上选中元素，点上方出现的「加入素材库」格子保存到这里。</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );

  return createPortal(bar, host);
}
