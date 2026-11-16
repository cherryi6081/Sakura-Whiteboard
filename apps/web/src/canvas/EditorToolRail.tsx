import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ExcalidrawImperativeAPI, ToolType } from "@excalidraw/excalidraw/types";

/**
 * 左侧竖向工具条（C′）。库自带的工具条是顶部横条且不支持竖排，这里只做「外观 + 入口」，
 * 真正的工具切换全部走公开 API `setActiveTool`，不改库内部结构、不复制绘制逻辑。
 * 快捷键与工具锁仍由库处理，本组件只负责显示状态与转交点击。
 */

/** image 不在竖条里：本项目的图片走顶栏上传，库工具中已禁用（UIOptions.tools.image=false） */
type RailToolType = Exclude<ToolType, "image">;

type RailTool = { type: RailToolType; label: string; shortcut: string };

const CORE_TOOLS: RailTool[] = [
  { type: "hand", label: "抓手", shortcut: "H" },
  { type: "selection", label: "选择", shortcut: "V" },
  { type: "rectangle", label: "矩形", shortcut: "R" },
  { type: "diamond", label: "菱形", shortcut: "D" },
  { type: "ellipse", label: "椭圆", shortcut: "O" },
  { type: "arrow", label: "箭头", shortcut: "A" },
  { type: "line", label: "直线", shortcut: "L" },
  { type: "freedraw", label: "画笔", shortcut: "P" },
  { type: "text", label: "文本", shortcut: "T" },
];

/** 对应库里「更多工具」菜单：保住框架、嵌入、激光与 AI 框架，不因隐藏横条而丢入口 */
const MORE_TOOLS: RailTool[] = [
  { type: "frame", label: "框架", shortcut: "F" },
  { type: "embeddable", label: "网页嵌入", shortcut: "" },
  { type: "laser", label: "激光笔", shortcut: "K" },
  { type: "magicframe", label: "AI 绘图", shortcut: "" },
];

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS: Record<RailToolType | "lock" | "more", ReactNode> = {
  lock: (
    <Icon>
      <rect x="5" y="10" width="14" height="9" rx="2" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </Icon>
  ),
  hand: (
    <Icon>
      <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5m0 0V4.5a1.5 1.5 0 0 1 3 0V11m0 0V6.5a1.5 1.5 0 0 1 3 0V13c0 4.4-2.4 7-6 7s-6-2.6-6-7v-1.5a1.5 1.5 0 0 1 3 0V13" />
    </Icon>
  ),
  selection: (
    <Icon>
      <path d="M5 3l13.5 8.2-6 1.3-2.4 5.9z" />
    </Icon>
  ),
  rectangle: (
    <Icon>
      <rect x="4" y="6" width="16" height="12" rx="2" />
    </Icon>
  ),
  diamond: (
    <Icon>
      <path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" />
    </Icon>
  ),
  ellipse: (
    <Icon>
      <ellipse cx="12" cy="12" rx="8" ry="6.5" />
    </Icon>
  ),
  arrow: (
    <Icon>
      <path d="M4 20L20 4M20 4h-6.5M20 4v6.5" />
    </Icon>
  ),
  line: (
    <Icon>
      <path d="M5 19L19 5" />
    </Icon>
  ),
  freedraw: (
    <Icon>
      <path d="M4 17c2.5-.8 3.2-5.5 6-5.5s2.2 4.6 4.8 3.6S18 9 20 7" />
    </Icon>
  ),
  text: (
    <Icon>
      <path d="M5 6h14M12 6v13M9.5 19h5" />
    </Icon>
  ),
  eraser: (
    <Icon>
      <path d="M9 17l-3.5-3.5a2 2 0 0 1 0-2.8l7-7a2 2 0 0 1 2.8 0l3.5 3.5a2 2 0 0 1 0 2.8L12 17H9z" />
      <path d="M4 20h16" />
    </Icon>
  ),
  frame: (
    <Icon>
      <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />
    </Icon>
  ),
  embeddable: (
    <Icon>
      <path d="M9.5 14.5l5-5" />
      <path d="M11 6.5l1.6-1.6a3.5 3.5 0 0 1 5 5L16 11.5" />
      <path d="M13 17.5l-1.6 1.6a3.5 3.5 0 0 1-5-5L8 12.5" />
    </Icon>
  ),
  laser: (
    <Icon>
      <circle cx="17.5" cy="6.5" r="2.5" />
      <path d="M15.6 8.4L6 18" />
    </Icon>
  ),
  magicframe: (
    <Icon>
      <path d="M11 4l1.7 4.3L17 10l-4.3 1.7L11 16l-1.7-4.3L5 10l4.3-1.7z" />
      <path d="M18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </Icon>
  ),
  more: (
    <Icon>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" />
    </Icon>
  ),
};

type Props = {
  api: ExcalidrawImperativeAPI | null;
  /** 来自画布 appState.activeTool.type，键盘快捷键切换时也会跟着变 */
  activeTool: string;
  /** 来自画布 appState.activeTool.locked */
  locked: boolean;
  /** 只读/游客只读时整条置灰禁用 */
  disabled?: boolean;
};

export function EditorToolRail({ api, activeTool, locked, disabled = false }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 「更多」浮层的视口坐标：fixed 定位，不参与文档流，也不会被竖条的 overflow 裁掉 */
  const [morePos, setMorePos] = useState<{ left: number; top: number } | null>(null);
  /** 点击后先本地高亮，不用等 150ms 的 appState 轮询回来 */
  const [pendingTool, setPendingTool] = useState<string | null>(null);
  const [pendingLocked, setPendingLocked] = useState<boolean | null>(null);

  useEffect(() => setPendingTool(null), [activeTool]);
  useEffect(() => setPendingLocked(null), [locked]);

  const shownTool = pendingTool ?? activeTool;
  const shownLocked = pendingLocked ?? locked;

  const activate = useCallback(
    (type: RailToolType) => {
      if (!api || disabled) return;
      api.setActiveTool({ type, locked: shownLocked });
      setPendingTool(type);
      setMoreOpen(false);
    },
    [api, disabled, shownLocked],
  );

  const toggleLock = useCallback(() => {
    if (!api || disabled) return;
    const nextLocked = !shownLocked;
    api.setActiveTool({ type: shownTool as RailToolType, locked: nextLocked });
    setPendingLocked(nextLocked);
  }, [api, disabled, shownLocked, shownTool]);

  // 点穿：不让鼠标点击把焦点从画布抢走，否则点完工具快捷键就失效了
  const keepCanvasFocus = (event: React.PointerEvent<HTMLElement>) => event.preventDefault();

  const MENU_WIDTH = 184;
  const MENU_GAP = 8;
  const VIEWPORT_PAD = 8;

  /** 按触发按钮的视口位置定位浮层：右侧放不下就翻到左边，底部放不下就整体上移 */
  const placeMenu = useCallback(() => {
    const trigger = moreTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const height = moreMenuRef.current?.offsetHeight ?? MORE_TOOLS.length * 34 + 8;
    let left = rect.right + MENU_GAP;
    if (left + MENU_WIDTH > window.innerWidth - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, rect.left - MENU_WIDTH - MENU_GAP);
    }
    let top = rect.top;
    if (top + height > window.innerHeight - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, window.innerHeight - VIEWPORT_PAD - height);
    }
    setMorePos((prev) =>
      prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5
        ? prev
        : { left, top },
    );
  }, []);

  // 打开后先量高度再落位（在 paint 前完成，不会闪），随后跟随视口/竖条滚动重新定位
  useLayoutEffect(() => {
    if (!moreOpen) {
      setMorePos(null);
      return;
    }
    placeMenu();
    const rail = rootRef.current;
    const focusedByKeyboard = document.activeElement === moreTriggerRef.current;
    if (focusedByKeyboard) {
      moreMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
        ?.focus();
    }
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    rail?.addEventListener("scroll", placeMenu);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
      rail?.removeEventListener("scroll", placeMenu);
    };
  }, [moreOpen, placeMenu]);

  useEffect(() => {
    if (!moreOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || moreMenuRef.current?.contains(target)) return;
      setMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (moreMenuRef.current?.contains(document.activeElement)) moreTriggerRef.current?.focus();
      setMoreOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreOpen]);

  // 浮层是 portal，方向键/Home/End 在菜单内部游走；Esc 关闭并把焦点还给触发按钮
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (moreMenuRef.current?.contains(document.activeElement)) moreTriggerRef.current?.focus();
      setMoreOpen(false);
      event.stopPropagation();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      moreMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items[items.length - 1]?.focus();
    else {
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(current + step + items.length) % items.length]?.focus();
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // 竖条内的上下键/Home/End 走焦点，符合 toolbar 的键盘惯例
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-rail-btn]") ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") buttons[0]?.focus();
    else if (event.key === "End") buttons[buttons.length - 1]?.focus();
    else {
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(current + step + buttons.length) % buttons.length]?.focus();
    }
    event.preventDefault();
  };

  const moreActive = MORE_TOOLS.some((tool) => tool.type === shownTool);

  return (
    <div
      ref={rootRef}
      className="wb-toolrail"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="绘图工具"
      data-testid="tool-rail"
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        data-rail-btn=""
        data-testid="tool-lock"
        className="wb-toolrail__btn"
        aria-pressed={shownLocked}
        aria-label={shownLocked ? "工具锁定：已开启" : "工具锁定：已关闭"}
        title="工具锁定 · 连续使用当前工具"
        disabled={disabled}
        onPointerDown={keepCanvasFocus}
        onClick={toggleLock}
      >
        {ICONS.lock}
      </button>

      <span className="wb-toolrail__sep" aria-hidden="true" />

      {CORE_TOOLS.map((tool) => (
        <button
          key={tool.type}
          type="button"
          data-rail-btn=""
          data-testid={`tool-${tool.type}`}
          className="wb-toolrail__btn"
          aria-pressed={shownTool === tool.type}
          aria-label={`${tool.label}（快捷键 ${tool.shortcut}）`}
          title={`${tool.label} · ${tool.shortcut}`}
          disabled={disabled}
          onPointerDown={keepCanvasFocus}
          onClick={() => activate(tool.type)}
        >
          {ICONS[tool.type]}
        </button>
      ))}

      <span className="wb-toolrail__sep" aria-hidden="true" />

      <button
        type="button"
        data-rail-btn=""
        data-testid="tool-eraser"
        className="wb-toolrail__btn"
        aria-pressed={shownTool === "eraser"}
        aria-label="橡皮（快捷键 E）"
        title="橡皮 · E"
        disabled={disabled}
        onPointerDown={keepCanvasFocus}
        onClick={() => activate("eraser")}
      >
        {ICONS.eraser}
      </button>

      <div className="wb-toolrail__more-wrap">
        <button
          ref={moreTriggerRef}
          type="button"
          data-rail-btn=""
          data-testid="tool-more"
          className="wb-toolrail__btn"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-pressed={moreActive}
          aria-label="更多工具"
          title="更多工具"
          disabled={disabled}
          onPointerDown={keepCanvasFocus}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {ICONS.more}
        </button>

        {moreOpen
          ? createPortal(
              <div
                ref={moreMenuRef}
                className="wb-toolrail__more"
                role="menu"
                aria-label="更多工具"
                style={{
                  left: morePos?.left ?? 0,
                  top: morePos?.top ?? 0,
                  visibility: morePos ? "visible" : "hidden",
                }}
                onKeyDown={handleMenuKeyDown}
              >
                {MORE_TOOLS.map((tool) => (
                  <button
                    key={tool.type}
                    type="button"
                    role="menuitemradio"
                    aria-checked={shownTool === tool.type}
                    aria-pressed={shownTool === tool.type}
                    data-testid={`tool-${tool.type}`}
                    className="wb-toolrail__item"
                    disabled={disabled}
                    onPointerDown={keepCanvasFocus}
                    onClick={() => activate(tool.type)}
                  >
                    {ICONS[tool.type]}
                    <span>{tool.label}</span>
                    {tool.shortcut ? (
                      <span className="wb-toolrail__kbd">{tool.shortcut}</span>
                    ) : null}
                  </button>
                ))}
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}
