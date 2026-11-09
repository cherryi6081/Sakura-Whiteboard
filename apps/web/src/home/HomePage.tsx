import { useCreateBoard } from "../boards/useCreateBoard";
import { IconAlert } from "../ui/icons";
import { FujiScene } from "./FujiScene";

/** 顶部工具条的 12 个图标，顺序与截图逐一对应 */
type ToolId =
  | "lock"
  | "hand"
  | "cursor"
  | "rect"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "draw"
  | "text"
  | "image"
  | "eraser";

const TOOL_PATHS: Record<ToolId, string[]> = {
  lock: ["M5.5 9.5h9v7.2h-9z", "M7.6 9.5V7.2a2.4 2.4 0 0 1 4.8 0v2.3"],
  hand: [
    "M7 12V6.2a1.2 1.2 0 0 1 2.4 0V11",
    "M9.4 11V4.8a1.2 1.2 0 0 1 2.4 0V11",
    "M11.8 11V6a1.2 1.2 0 0 1 2.4 0v6.2",
    "M14.2 9v4.4a4.6 4.6 0 0 1-4.6 4.6H9a4 4 0 0 1-3.2-1.6l-1.9-2.6a1.4 1.4 0 0 1 2.2-1.7L7 12",
  ],
  cursor: ["M5 3l10 7-4.8 1.2L7.6 16z"],
  rect: ["M4.5 5.5h11v9h-11z"],
  diamond: ["M10 3.8l6.2 6.2L10 16.2 3.8 10z"],
  ellipse: ["M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0"],
  arrow: ["M4.5 15.5L15 5", "M15 5H9.8", "M15 5v5.2"],
  line: ["M4.5 15.5L15.5 4.5"],
  draw: ["M4.6 15.4l1-3.6 7.6-7.6 2.6 2.6-7.6 7.6z", "M12 5.4l2.6 2.6"],
  text: ["M4.5 5.5h11", "M10 5.5v10", "M7.6 15.5h4.8"],
  image: [
    "M4.5 5.5h11v9h-11z",
    "M7.7 9.4a1 1 0 1 0 0-2 1 1 0 0 0 0 2",
    "M4.8 13.2l3.4-3.4 2.4 2.4 1.6-1.6 2.9 2.9",
  ],
  eraser: ["M6.4 15.5L3.9 13l7.3-7.3 4.9 4.9-5.5 5.5z", "M10.2 8.2l4.9 4.9"],
};

/** 截图里的工具顺序：锁定 → 抓手 → 选择（选中）→ 矩形 → 菱形 → 椭圆 → 箭头 → 直线 → 画笔 → 文字 → 图片 → 橡皮 */
const TOOLBAR_TOOLS: ToolId[] = [
  "lock",
  "hand",
  "cursor",
  "rect",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "draw",
  "text",
  "image",
  "eraser",
];

const MENU_PATHS = ["M4 6.5h12", "M4 10h12", "M4 13.5h12"];
const SIDEBAR_PATHS = ["M4.5 5.5h11v9h-11z", "M12.4 5.5v9"];
const PERSON_PATHS = [
  "M10 10.3a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5",
  "M5.3 15.8a4.7 4.7 0 0 1 9.4 0",
];
const UNDO_PATHS = ["M7.4 6.1L4.5 9l2.9 2.9", "M4.7 9h6.4a4 4 0 0 1 0 8H8.2"];
const REDO_PATHS = ["M12.6 6.1L15.5 9l-2.9 2.9", "M15.3 9H8.9a4 4 0 0 0 0 8h2.9"];
const SHIELD_PATHS = [
  "M10 3.6l5 1.8v4.2c0 3.1-2 5.4-5 6.7-3-1.3-5-3.6-5-6.7V5.4z",
  "M7.6 10l1.7 1.7 3.2-3.3",
];

function LineIcon({
  paths,
  className,
  strokeWidth = 1.5,
}: {
  paths: string[];
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * 首页：几何按 Excalidraw 截图量取（2550×1267 原图，按 1440/2550 换算）。
 *
 * - 左上 10,10 菜单按钮 28×28（截图里只有菜单按钮，品牌标识在 Excalidraw 里
 *   位于画面中央，这里同样把「白板」品牌放进中央文案块顶部）；
 * - 顶部居中工具条 y10、403×38，12 个工具 + 分割线 + 更多；
 * - 右上 登录(103) + 注册(34) + 装饰方块(28)，右 8、间距 6/9；
 * - 左下 − / 100% / +（96×27）与撤销重做（54×27），底 10；
 * - 右下 盾牌 + 帮助「?」，右 8、底 10；
 * - 中央标题 / 副文案 / 主按钮压在峰顶之上的天空带，水平居中。
 *
 * 只有「新建白板」和登录/注册是真功能；其余浮层是装饰件（aria-hidden、
 * 不进焦点序列、无 hover）。建板逻辑沿用 `boards/useCreateBoard`。
 */
export function HomePage() {
  const { busy, slow, error, start } = useCreateBoard();
  const quotaFull = error?.kind === "quota";

  return (
    <div className="wb-home">
      {/* 场景铺满整页，位于所有浮层之下；aria-hidden + pointer-events: none */}
      <FujiScene />

      {/* 左上装饰：菜单按钮（截图为 28×28，left/top 10） */}
      <div className="wb-home__menu" aria-hidden="true">
        <span className="wb-home__icon-btn">
          <LineIcon paths={MENU_PATHS} className="wb-home__icon" />
        </span>
      </div>

      {/* 顶部居中装饰：Excalidraw 工具条（12 工具 + 分割线 + 更多） */}
      <div className="wb-home__toolbar" aria-hidden="true">
        {TOOLBAR_TOOLS.map((id) => (
          <span
            key={id}
            className={`wb-home__tool${id === "cursor" ? " wb-home__tool--active" : ""}${
              id === "hand" ? " wb-home__tool--gap" : ""
            }`}
          >
            <LineIcon paths={TOOL_PATHS[id]} className="wb-home__tool-icon" />
          </span>
        ))}
        <span className="wb-home__divider" />
        <span className="wb-home__tool">
          <LineIcon
            paths={["M10 5.8v.01", "M10 10v.01", "M10 14.2v.01"]}
            className="wb-home__tool-icon"
            strokeWidth={2.2}
          />
        </span>
      </div>

      {/* 右上：登录 / 注册为真入口，方块图标是装饰 */}
      <div className="wb-home__account">
        <a className="wb-home__login" href="/login">
          <LineIcon paths={PERSON_PATHS} className="wb-home__icon" />
          登录
        </a>
        <a className="wb-home__register" href="/register">
          注册
        </a>
        <span className="wb-home__icon-btn wb-home__icon-btn--square" aria-hidden="true">
          <LineIcon paths={SIDEBAR_PATHS} className="wb-home__icon" />
        </span>
      </div>

      {/* 中央文案块：底部锚在峰顶上方 12px，错误提示出现时向上长，不压雪顶 */}
      <main className="wb-home__main">
        <span className="wb-home__logo">
          <span className="wb-brand__mark" aria-hidden>
            白
          </span>
          白板
        </span>
        <h1 className="wb-home__headline">打开就能画。</h1>
        <p className="wb-home__lead">不用注册。想留住它，再登录。</p>

        <div className="wb-home__action">
          {quotaFull ? (
            <a className="wb-btn wb-btn--primary wb-btn--lg" href="/login?next=%2Fboards">
              登录并继续
            </a>
          ) : (
            <button
              className="wb-btn wb-btn--primary wb-btn--lg wb-home__cta"
              type="button"
              onClick={() => void start()}
              disabled={busy}
              data-testid="home-create-board"
            >
              {busy ? <span className="wb-spinner" aria-hidden /> : null}
              {busy ? (slow ? "还在连接…" : "正在准备画布…") : "新建白板"}
            </button>
          )}

          {error ? (
            <div
              className={`wb-inline-note wb-inline-note--${error.kind === "quota" ? "warning" : "danger"}`}
              role="alert"
            >
              <IconAlert />
              <span>{error.message}</span>
              {error.kind === "error" ? (
                <button
                  className="wb-btn wb-btn--ghost wb-btn--sm wb-btn--danger-text"
                  type="button"
                  onClick={() => void start()}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </main>

      {/* 左下装饰：缩放条 − / 100% / + */}
      <div className="wb-home__zoombar" aria-hidden="true">
        <span className="wb-home__zoom-btn">−</span>
        <span className="wb-home__zoom-value">100%</span>
        <span className="wb-home__zoom-btn">+</span>
      </div>

      {/* 左下装饰：撤销 / 重做 */}
      <div className="wb-home__history" aria-hidden="true">
        <span className="wb-home__history-btn">
          <LineIcon paths={UNDO_PATHS} className="wb-home__icon" />
        </span>
        <span className="wb-home__history-btn">
          <LineIcon paths={REDO_PATHS} className="wb-home__icon" />
        </span>
      </div>

      {/* 右下装饰：存储盾牌 + 帮助「?」 */}
      <div className="wb-home__corner" aria-hidden="true">
        <span className="wb-home__shield">
          <LineIcon paths={SHIELD_PATHS} className="wb-home__icon" />
        </span>
        <span className="wb-home__icon-btn wb-home__help">?</span>
      </div>
    </div>
  );
}
