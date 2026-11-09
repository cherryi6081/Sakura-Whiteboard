import { useCreateBoard } from "../boards/useCreateBoard";
import { IconAlert } from "../ui/icons";
import { FujiScene } from "./FujiScene";

/** 左下工具岛的静态图标：只有形状，不绑定任何操作 */
type ToolId = "cursor" | "hand" | "rect" | "diamond" | "arrow" | "line" | "text" | "eraser";

const TOOL_PATHS: Record<ToolId, string[]> = {
  cursor: ["M5 3l10 7-4.8 1.2L7.6 16z"],
  hand: [
    "M7 12V6.2a1.2 1.2 0 0 1 2.4 0V11",
    "M9.4 11V4.8a1.2 1.2 0 0 1 2.4 0V11",
    "M11.8 11V6a1.2 1.2 0 0 1 2.4 0v6.2",
    "M14.2 9v4.4a4.6 4.6 0 0 1-4.6 4.6H9a4 4 0 0 1-3.2-1.6l-1.9-2.6a1.4 1.4 0 0 1 2.2-1.7L7 12",
  ],
  rect: ["M4.5 5.5h11v9h-11z"],
  diamond: ["M10 3.5l6.5 6.5L10 16.5 3.5 10z"],
  arrow: ["M4.5 15.5L15.5 4.5", "M15.5 4.5H10", "M15.5 4.5v5.5"],
  line: ["M4.5 15.5L15.5 4.5"],
  text: ["M4.5 5.5h11", "M10 5.5v10", "M7.8 15.5h4.4"],
  eraser: ["M6.4 15.5L3.9 13l7.3-7.3 4.9 4.9-5.5 5.5z", "M10.2 8.2l4.9 4.9"],
};

/** 图标分组：组内紧凑、组间用一条细分割线断开 */
const TOOL_GROUPS: ToolId[][] = [
  ["cursor", "hand"],
  ["rect", "diamond", "arrow", "line"],
  ["text", "eraser"],
];

function ToolIcon({ id }: { id: ToolId }) {
  return (
    <svg
      className="wb-home__tool-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {TOOL_PATHS[id].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * 首页：参考 Excalidraw 的布局骨架 —— 整页富士山场景上依次叠加
 * 顶栏（品牌 / 入口）、中央文案与主行动、左下工具岛、右下状态条。
 *
 * 只有"新建白板"与登录/注册可交互；工具岛与状态条是纯装饰
 * （aria-hidden，不渲染按钮、不进焦点序列）。建板逻辑沿用
 * `boards/useCreateBoard`，busy / slow / 配额 / 离线状态都不在首页重写。
 */
export function HomePage() {
  const { busy, slow, error, start } = useCreateBoard();
  const quotaFull = error?.kind === "quota";

  return (
    <div className="wb-home">
      {/* 场景铺满整页，位于所有浮层之下；aria-hidden + pointer-events: none */}
      <FujiScene />

      <header className="wb-home__top">
        <span className="wb-home__brand">
          <span className="wb-brand__mark" aria-hidden>
            白
          </span>
          白板
        </span>
        <nav className="wb-home__nav" aria-label="账户入口">
          <a className="wb-home__nav-link" href="/login">
            登录
          </a>
          <a className="wb-home__nav-link wb-home__nav-link--strong" href="/register">
            注册
          </a>
        </nav>
      </header>

      <div className="wb-home__stage">
        <main className="wb-home__main">
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
      </div>

      {/* 装饰：Excalidraw 风格工具岛，静态图标、无 hover、不进焦点序列 */}
      <div className="wb-home__dock" aria-hidden="true">
        {TOOL_GROUPS.map((group) => (
          <div className="wb-home__tool-group" key={group.join("-")}>
            {group.map((id) => (
              <span className="wb-home__tool" key={id}>
                <ToolIcon id={id} />
              </span>
            ))}
          </div>
        ))}
      </div>

      {/* 装饰：缩放 / 画布尺寸状态条，不做真实联动 */}
      <div className="wb-home__status" aria-hidden="true">
        <span>缩放 100%</span>
        <span className="wb-home__status-sep">·</span>
        <span>画布 1600 × 900</span>
      </div>

      <footer className="wb-home__foot">
        <span>白板 v0.3</span>
        <span aria-hidden>·</span>
        <span>画布渲染 Built on Excalidraw</span>
      </footer>
    </div>
  );
}
