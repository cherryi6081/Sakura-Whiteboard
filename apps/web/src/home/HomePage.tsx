import { useEffect, useState } from "react";
import { createBoard } from "../boards/boardsApi";
import { recordRecentBoard } from "../boards/recentBoards";
import { IconAlert } from "../ui/icons";
import { FujiScene } from "./FujiScene";

/**
 * 首页 / 入口：**免注册直接开板**是唯一主行动点（视觉方案 §4.1）。
 * 建板失败就地内联提示，不整页替换、不弹 alert；配额 429 引导去登录。
 */
export function HomePage() {
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<{ kind: "quota" | "error"; message: string } | null>(null);
  const [offline, setOffline] = useState(() => (typeof navigator === "undefined" ? false : !navigator.onLine));

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const start = async () => {
    if (busy || offline) return;
    setError(null);
    setBusy(true);
    const slowTimer = window.setTimeout(() => setSlow(true), 400);
    const result = await createBoard();
    window.clearTimeout(slowTimer);
    setSlow(false);
    setBusy(false);

    if (result.ok) {
      recordRecentBoard({ id: result.data.id, title: result.data.title });
      window.location.href = `/board/${result.data.id}`;
      return;
    }
    if (result.status === 429 && result.code === "QUOTA_EXCEEDED") {
      setError({ kind: "quota", message: "这个浏览器已建满 3 块临时板。登录后可以继续，临时板也能一起转入账号。" });
      return;
    }
    setError({ kind: "error", message: "没开成，再试一次。" });
  };

  const quotaFull = error?.kind === "quota";

  return (
    <div className="wb-home">
      <header className="wb-home__top">
        <a className="wb-brand" href="/">
          <span className="wb-brand__mark" aria-hidden>
            白
          </span>
          白板
        </a>
        <nav className="wb-home__nav" aria-label="账户入口">
          <a className="wb-home__nav-link" href="/boards">
            我的白板
          </a>
          <a className="wb-home__nav-link" href="/login">
            登录
          </a>
          <a className="wb-home__nav-link wb-home__nav-link--strong" href="/register">
            注册
          </a>
        </nav>
      </header>

      {offline ? (
        <div className="wb-banner wb-banner--warning" role="status">
          <IconAlert />
          <span>连不上服务器，恢复网络后就能继续。</span>
        </div>
      ) : null}

      <div className="wb-home__stage">
        <main className="wb-home__main">
          <p className="wb-home__eyebrow">
            <span className="wb-home__eyebrow-dot" aria-hidden />
            免注册 · 打开即画
          </p>
          <h1 className="wb-home__headline">打开就能画。</h1>
          <p className="wb-home__lead">不用注册。想留住它，再登录。</p>

          <div className="wb-home__action">
            {quotaFull ? (
              <a className="wb-btn wb-btn--primary wb-btn--lg" href="/login?next=%2Fboards">
                登录并继续
              </a>
            ) : (
              <button
                className="wb-btn wb-btn--primary wb-btn--lg"
                type="button"
                onClick={() => void start()}
                disabled={busy || offline}
                data-testid="home-create-board"
              >
                {busy ? <span className="wb-spinner" aria-hidden /> : null}
                {busy ? (slow ? "还在连接…" : "正在准备画布…") : "直接开一块板"}
              </button>
            )}

            {error ? (
              <div className={`wb-inline-note wb-inline-note--${error.kind === "quota" ? "warning" : "danger"}`} role="alert">
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

          <ul className="wb-home__points">
            <li className="wb-home__point">多人实时协作，改动即时可见</li>
            <li className="wb-home__point">多标签页各自独立，不会互相覆盖</li>
            <li className="wb-home__point">手机可直接触控绘制</li>
          </ul>
          {/* 移动端按 §4.1 收成一行文案，不换三行 */}
          <p className="wb-home__points-line">实时协作 · 多标签独立 · 手机可画</p>
        </main>

        <FujiScene />
      </div>

      <footer className="wb-home__foot">
        <span>白板 v0.3</span>
        <span aria-hidden>·</span>
        <span>画布渲染 Built on Excalidraw</span>
      </footer>
    </div>
  );
}
