/**
 * 「查找文本」页签的空态目录（设计稿 design/page-density 方案 B）。
 *
 * 只接管「查询为空」时空白的结果区，不改原生搜索：
 * - 输入框、结果计数、结果列表、Enter/↑↓/Esc/Ctrl+F 全部留在 Excalidraw 内部；
 * - 查询非空时目录整块淡出，原生结果照常渲染与滚动；
 * - 无结果态直接沿用原生的「未找到匹配项…」。
 *
 * 数据只读：`getSceneElements()` 轮询指纹后按画框分组，点击行用
 * `scrollToContent` 定位，不写入画布、不改选区、不产生 op。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "./search-index.css";

/** 目录最多渲染多少行（大板降级），超出的部分在列表底部提示。 */
const ROW_LIMIT = 200;
/** 场景指纹轮询间隔：目录是只读概览，不需要逐帧跟进。 */
const SCENE_POLL = 800;

type El = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  name?: string | null;
  frameId?: string | null;
  link?: string | null;
  isDeleted?: boolean;
};

type Props = {
  api: ExcalidrawImperativeAPI | null;
  rootRef: RefObject<HTMLDivElement | null>;
};

type Scope = "all" | "text" | "frame" | "media";

const SCOPE_LABEL: Record<Scope, string> = {
  all: "全部",
  text: "文字",
  frame: "画框",
  media: "图片",
};

function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.4" />
      <path d="m15.4 15.4 5.1 5.1" strokeLinecap="round" />
    </svg>
  );
}

function IconText() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M5 6h14M12 6v13M8.5 19h7" strokeLinecap="round" />
    </svg>
  );
}

function IconFrame() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M8 3v18M16 3v18M3 8h18M3 16h18" strokeLinecap="round" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="m4 15 4-4 4 4 3-3 5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconLink() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M10 13a4 4 0 0 0 5.7 0l2-2a4 4 0 0 0-5.7-5.7l-1 1" strokeLinecap="round" />
      <path d="M14 11a4 4 0 0 0-5.7 0l-2 2a4 4 0 0 0 5.7 5.7l1-1" strokeLinecap="round" />
    </svg>
  );
}

function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M5 12h13M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`wb-search__chev${open ? " is-open" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconMedia() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  if (!line) return "（空白文本）";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/**
 * 未归入画框的文字按画布象限标注（设计稿 B 的「画布左上 / 中部 / 右上」）。
 * 只在有实际范围时计算，单元素或零尺寸退回中部，避免出现「画布左下」这种噪声。
 */
function whereOf(el: El, bounds: { minX: number; minY: number; w: number; h: number }): string {
  if (bounds.w <= 0 || bounds.h <= 0) return "画布中部";
  const rx = (el.x + el.width / 2 - bounds.minX) / bounds.w;
  const ry = (el.y + el.height / 2 - bounds.minY) / bounds.h;
  const col = rx < 0.34 ? "左" : rx > 0.66 ? "右" : "";
  const row = ry < 0.34 ? "上" : ry > 0.66 ? "下" : "";
  if (!col && !row) return "画布中部";
  return `画布${row}${col}`;
}

/** 原生搜索的匹配口径：非删除、非空文字、不区分大小写的包含 */
function matchesQuery(text: string | undefined, query: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(query.toLowerCase());
}

type TextRow = { kind: "text"; el: El; title: string; meta: string };
type FrameRow = { kind: "frame"; el: El; title: string; meta: string };
type ImageRow = { kind: "image"; el: El; title: string; meta: string };
type LinkRow = { kind: "link"; el: El; title: string; meta: string };
type Row = TextRow | FrameRow | ImageRow | LinkRow;

type Group = {
  id: string;
  title: string;
  count: number;
  rows: Row[];
};

type Directory = {
  groups: Group[];
  frameRows: FrameRow[];
  imageRows: ImageRow[];
  linkRows: LinkRow[];
  textCount: number;
  frameCount: number;
  totalRows: number;
};

function buildDirectory(elements: readonly El[]): Directory {
  const live = elements.filter((el) => !el.isDeleted);
  const frames = live.filter((el) => el.type === "frame");
  const texts = live.filter((el) => el.type === "text" && (el.text ?? "").trim().length > 0);
  const images = live.filter((el) => el.type === "image");
  const links = live.filter(
    (el) => el.type !== "frame" && el.type !== "image" && typeof el.link === "string" && el.link.trim().length > 0,
  );

  const byPos = (a: El, b: El) => a.y - b.y || a.x - b.x;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of live) {
    if (el.type === "frame") continue;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }
  const bounds = {
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    w: Number.isFinite(minX) ? maxX - minX : 0,
    h: Number.isFinite(minY) ? maxY - minY : 0,
  };

  const frameIds = new Set(frames.map((el) => el.id));
  const groups: Group[] = [];

  for (const frame of [...frames].sort(byPos)) {
    const children = texts
      .filter((el) => el.frameId && el.frameId === frame.id)
      .sort(byPos)
      .map<TextRow>((el) => ({
        kind: "text",
        el,
        title: firstLine(el.text ?? ""),
        meta: `文字 · ${(el.text ?? "").split("\n").length} 行 · 画框内`,
      }));
    if (!children.length) continue;
    groups.push({
      id: `frame:${frame.id}`,
      title: frame.name?.trim() || "未命名画框",
      count: children.length,
      rows: children,
    });
  }

  const orphans = texts.filter((el) => !el.frameId || !frameIds.has(el.frameId)).sort(byPos);
  if (orphans.length) {
    groups.push({
      id: "orphan",
      title: "未归入画框",
      count: orphans.length,
      rows: orphans.map((el) => ({
        kind: "text" as const,
        el,
        title: firstLine(el.text ?? ""),
        meta: `文字 · ${(el.text ?? "").split("\n").length} 行 · ${whereOf(el, bounds)}`,
      })),
    });
  }

  const frameRows = [...frames].sort(byPos).map<FrameRow>((el) => {
    const count = texts.filter((t) => t.frameId === el.id).length;
    return {
      kind: "frame",
      el,
      title: el.name?.trim() || "未命名画框",
      meta: `画框 · ${count} 段文字`,
    };
  });

  const imageRows = [...images].sort(byPos).map<ImageRow>((el) => ({
    kind: "image",
    el,
    title: `图片 ${Math.round(el.width)} × ${Math.round(el.height)}`,
    meta: `图片 · ${el.frameId && frameIds.has(el.frameId) ? "画框内" : whereOf(el, bounds)}`,
  }));

  const linkRows = [...links].sort(byPos).map<LinkRow>((el) => {
    let host = el.link ?? "";
    try {
      host = new URL(el.link ?? "").host;
    } catch {
      /* 不是合法 URL 时直接显示原文 */
    }
    return {
      kind: "link",
      el,
      title: host || el.link || "链接",
      meta: `链接 · ${el.frameId && frameIds.has(el.frameId) ? "画框内" : whereOf(el, bounds)}`,
    };
  });

  const totalRows =
    groups.reduce((sum, group) => sum + group.rows.length, 0) +
    frameRows.length +
    imageRows.length +
    linkRows.length;

  return {
    groups,
    frameRows,
    imageRows,
    linkRows,
    textCount: texts.length,
    frameCount: frames.length,
    totalRows,
  };
}

/**
 * 场景指纹：只做「有没有变」的判断，不要求逐字段一致。
 * 用滚动哈希而不是拼整串，避免万级元素每 800ms 生成一个大字符串。
 */
function sceneFingerprint(elements: readonly El[]): string {
  let hash = 0;
  let updated = 0;
  for (const el of elements) {
    hash = (hash * 31 + el.x * 7 + el.y * 13 + el.width + el.height + (el.isDeleted ? 1 : 0)) | 0;
    hash = (hash * 31 + (el.id.length ?? 0)) | 0;
    const version = (el as { version?: number }).version ?? 0;
    hash = (hash * 31 + version) | 0;
    updated = Math.max(updated, version);
  }
  return `${elements.length}:${hash}:${updated}`;
}

export function CanvasSearchIndex({ api, rootRef }: Props) {
  const dirHostRef = useRef<HTMLDivElement | null>(null);
  if (!dirHostRef.current && typeof document !== "undefined") {
    const host = document.createElement("div");
    host.setAttribute("data-wb-search", "1");
    dirHostRef.current = host;
  }
  const footHostRef = useRef<HTMLDivElement | null>(null);
  if (!footHostRef.current && typeof document !== "undefined") {
    const host = document.createElement("div");
    host.setAttribute("data-wb-search-foot", "1");
    footHostRef.current = host;
  }
  const dirHost = dirHostRef.current;
  const footHost = footHostRef.current;

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [mediaOpen, setMediaOpen] = useState(false);
  const [elements, setElements] = useState<readonly El[]>([]);
  const containerRef = useRef<HTMLElement | null>(null);
  const hasQuery = query.trim().length > 0;
  const hasQueryRef = useRef(hasQuery);
  hasQueryRef.current = hasQuery;

  // 场景轮询：只在指纹变化时 setState，避免每 800ms 触发一次无意义重渲染
  useEffect(() => {
    if (!api) return;
    let last = "";
    const tick = () => {
      const scene = api.getSceneElements() as unknown as El[];
      const key = sceneFingerprint(scene);
      if (key !== last) {
        last = key;
        setElements(scene);
      }
    };
    tick();
    const timer = window.setInterval(tick, SCENE_POLL);
    return () => window.clearInterval(timer);
  }, [api]);

  // 查询同步：捕获阶段监听原生输入框，输入即切态；轮询兜底程序化清空
  useEffect(() => {
    const sync = () => {
      const input = rootRef.current?.querySelector<HTMLInputElement>(
        '.sidebar.default-sidebar .layer-ui__search input',
      );
      if (!input) return;
      setQuery((prev) => (prev === input.value ? prev : input.value));
    };
    const onInput = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.tagName !== "INPUT") return;
      if (!target.closest(".layer-ui__search")) return;
      setQuery((target as HTMLInputElement).value);
    };
    sync();
    document.addEventListener("input", onInput, true);
    const timer = window.setInterval(sync, SCENE_POLL);
    return () => {
      document.removeEventListener("input", onInput, true);
      window.clearInterval(timer);
    };
  }, [rootRef]);

  // 宿主注入：与素材库注入同一套 ensure 策略（MutationObserver + rAF + 180ms 兜底）
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !dirHost || !footHost) return;
    let scheduled = false;

    /**
     * 只写「确实要变」的 class / data：MutationObserver 也在观察自己注入的宿主，
     * 重复写同一个值会触发新的 mutation，容易变成自激循环。
     */
    const ensure = () => {
      const panel = root.querySelector<HTMLElement>(
        '.sidebar.default-sidebar .layer-ui__search',
      );
      const container = panel?.querySelector<HTMLElement>(".layer-ui__search-result-container");
      if (!panel || !container) return;
      containerRef.current = container;

      const wantOverlay = !hasQueryRef.current;
      // 定位锚点始终保留：切到原生结果时容器会恢复滚动，如果此时失去定位上下文，
      // 正在淡出的目录会瞬间从结果区顶部跳到侧栏顶部（实测跳约 130px）。
      if (!container.classList.contains("wb-search-anchor")) {
        container.classList.add("wb-search-anchor");
      }
      if (container.classList.contains("wb-search-overlay") !== wantOverlay) {
        container.classList.toggle("wb-search-overlay", wantOverlay);
      }
      if (!container.contains(dirHost)) container.insertBefore(dirHost, container.firstChild);
      if (!panel.contains(footHost)) panel.appendChild(footHost);
      const hidden = hasQueryRef.current ? "true" : "false";
      if (dirHost.dataset.hidden !== hidden) dirHost.dataset.hidden = hidden;
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        ensure();
      });
    };

    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    ensure();
    const timer = window.setInterval(ensure, 180);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
      dirHost.remove();
      footHost.remove();
      containerRef.current?.classList.remove("wb-search-overlay");
      containerRef.current?.classList.remove("wb-search-anchor");
    };
  }, [rootRef, dirHost, footHost]);

  // 切态是 CSS 过渡：这里只同步 class / data，保证同一帧内原生结果就能滚动
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.add("wb-search-anchor");
    container.classList.toggle("wb-search-overlay", !hasQuery);
    if (dirHost) dirHost.dataset.hidden = hasQuery ? "true" : "false";
  }, [hasQuery, dirHost]);

  const directory = useMemo(() => buildDirectory(elements), [elements]);
  const matchCount = useMemo(
    () =>
      elements.filter(
        (el) => !el.isDeleted && el.type === "text" && matchesQuery(el.text, query.trim()),
      ).length,
    [elements, query],
  );

  const seek = (el: El) => {
    api?.scrollToContent(el as never, {
      animate: true,
      duration: 300,
      fitToContent: true,
      maxZoom: 1.4,
    });
  };

  const renderRow = (row: Row) => {
    const icon =
      row.kind === "text" ? (
        <IconText />
      ) : row.kind === "frame" ? (
        <IconFrame />
      ) : row.kind === "image" ? (
        <IconImage />
      ) : (
        <IconLink />
      );
    const badge = row.kind === "text" ? "T" : row.kind === "frame" ? "F" : row.kind === "image" ? "图" : "链";
    return (
      <button
        key={`${row.kind}:${row.el.id}`}
        type="button"
        className="wb-search__row"
        onClick={() => seek(row.el)}
        title={`${row.title}\n${row.meta}`}
      >
        <span className="wb-search__ico" aria-hidden>
          {badge}
        </span>
        <span className="wb-search__b">
          <span className="wb-search__t">{row.title}</span>
          <span className="wb-search__m">{row.meta}</span>
        </span>
        <span className="wb-search__go" aria-hidden>
          <IconArrow />
        </span>
      </button>
    );
  };

  const totalShown = directory.totalRows;
  const truncated = totalShown > ROW_LIMIT;
  let budget = ROW_LIMIT;

  const renderRows = (rows: Row[]) => {
    if (budget <= 0) return null;
    const slice = rows.slice(0, budget);
    budget -= slice.length;
    return slice.map(renderRow);
  };

  const body = (() => {
    if (!directory.textCount && !directory.frameCount && !directory.imageRows.length && !directory.linkRows.length) {
      return (
        <div className="wb-search__empty">
          <span className="wb-search__empty-ico" aria-hidden>
            <IconSearch />
          </span>
          <p className="wb-search__empty-t">画布还没有可索引的内容</p>
          <p className="wb-search__empty-d">添加文字、画框或图片后，这里会按位置列出画布目录。</p>
        </div>
      );
    }

    if (scope === "frame") {
      return directory.frameRows.length ? (
        <div className="wb-search__group">
          <div className="wb-search__group-h">
            画框 <span className="n">{directory.frameRows.length}</span>
          </div>
          {renderRows(directory.frameRows)}
        </div>
      ) : (
        <ScopeEmpty onReset={() => setScope("all")} />
      );
    }

    if (scope === "media") {
      const rows: Row[] = [...directory.imageRows, ...directory.linkRows];
      return rows.length ? (
        <>
          {directory.imageRows.length ? (
            <div className="wb-search__group">
              <div className="wb-search__group-h">
                图片 <span className="n">{directory.imageRows.length}</span>
              </div>
              {renderRows(directory.imageRows)}
            </div>
          ) : null}
          {directory.linkRows.length ? (
            <div className="wb-search__group">
              <div className="wb-search__group-h">
                链接 <span className="n">{directory.linkRows.length}</span>
              </div>
              {renderRows(directory.linkRows)}
            </div>
          ) : null}
        </>
      ) : (
        <ScopeEmpty onReset={() => setScope("all")} />
      );
    }

    if (scope === "text" && !directory.groups.length) {
      return <ScopeEmpty onReset={() => setScope("all")} />;
    }

    return (
      <>
        {directory.groups.map((group) => (
          <div className="wb-search__group" key={group.id}>
            <div className="wb-search__group-h">
              {group.title} <span className="n">{group.count}</span>
            </div>
            {renderRows(group.rows)}
          </div>
        ))}

        {scope === "all" && (directory.imageRows.length > 0 || directory.linkRows.length > 0) ? (
          <div className="wb-search__group wb-search__group--media">
            <button
              type="button"
              className="wb-search__row wb-search__row--media"
              aria-expanded={mediaOpen}
              onClick={() => setMediaOpen((open) => !open)}
            >
              <span className="wb-search__ico" aria-hidden>
                <IconMedia />
              </span>
              <span className="wb-search__b">
                <span className="wb-search__t">图片与链接</span>
                <span className="wb-search__m">
                  {directory.imageRows.length} 张图片 · {directory.linkRows.length} 个链接
                </span>
              </span>
              <span className="wb-search__go" aria-hidden>
                <IconChevron open={mediaOpen} />
              </span>
            </button>
            {mediaOpen ? (
              <div className="wb-search__media">
                {renderRows([...directory.imageRows, ...directory.linkRows])}
              </div>
            ) : null}
          </div>
        ) : null}

        {truncated ? (
          <p className="wb-search__more">
            仅显示前 {ROW_LIMIT} 项，共 {totalShown} 项。缩小范围或直接用上方查找。
          </p>
        ) : null}
      </>
    );
  })();

  const footCount = hasQuery
    ? `${matchCount} 条结果`
    : `${directory.textCount} 段文字 · ${directory.frameCount} 个画框`;

  return (
    <>
      {dirHost
        ? createPortal(
            <div className="wb-search" aria-hidden={hasQuery}>
              <div className="wb-search__body">
                <div className="wb-search__scope" role="group" aria-label="索引范围">
                  {(Object.keys(SCOPE_LABEL) as Scope[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={`wb-search__chip${scope === key ? " is-on" : ""}`}
                      aria-pressed={scope === key}
                      onClick={() => {
                        setScope(key);
                        if (key !== "all") setMediaOpen(false);
                      }}
                    >
                      {SCOPE_LABEL[key]}
                    </button>
                  ))}
                </div>
                <div className="wb-search__head">
                  <span className="wb-search__sec">画布目录</span>
                  <span className="wb-search__head-n">按位置</span>
                </div>
                {body}
              </div>
            </div>,
            dirHost,
          )
        : null}
      {footHost
        ? createPortal(
            <div className="wb-search-foot">
              <span className="wb-search-foot__t">{footCount}</span>
              <span className="wb-search-foot__spacer" />
              <kbd className="wb-search-foot__kbd">Enter</kbd>
              <span className="wb-search-foot__t">定位</span>
            </div>,
            footHost,
          )
        : null}
    </>
  );
}

function ScopeEmpty({ onReset }: { onReset: () => void }) {
  return (
    <div className="wb-search__empty wb-search__empty--scope">
      <p className="wb-search__empty-t">这个范围没有内容</p>
      <button type="button" className="wb-search__reset" onClick={onReset}>
        查看全部
      </button>
    </div>
  );
}
