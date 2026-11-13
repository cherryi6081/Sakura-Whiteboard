import { useEffect, useRef, useState } from "react";
import { fetchMe, logout, type AuthUser } from "../auth/authApi";
import { useCreateBoard } from "../boards/useCreateBoard";
import { FujiScene } from "./FujiScene";
import { useThemePeriod } from "../theme/ThemeClock";

/**
 * 导航账号区。`pending` 是 `/api/auth/me` 返回前的唯一状态：
 * 只占位、不写字，避免先闪「登录」再跳用户名（或反过来）。
 */
type AccountState =
  | { status: "pending" }
  | { status: "anon" }
  | { status: "authed"; user: AuthUser };

/** 首页：富士山场景中的实时协作入口。 */
export function HomePage() {
  const { busy, slow, error, start } = useCreateBoard();
  const [menuOpen, setMenuOpen] = useState(false);
  const [account, setAccount] = useState<AccountState>({ status: "pending" });
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const userButtonRef = useRef<HTMLButtonElement | null>(null);
  const period = useThemePeriod();

  // 会话是 HttpOnly cookie，只能问服务端；判定就是 GET /api/auth/me
  useEffect(() => {
    let alive = true;
    void fetchMe().then((result) => {
      if (!alive) return;
      setAccount(result.ok ? { status: "authed", user: result.data.user } : { status: "anon" });
    });
    return () => {
      alive = false;
    };
  }, []);

  // 菜单打开期间的全局退出路径：点外部或 Esc；Esc 只把焦点还给按钮，不抢别处的焦点
  useEffect(() => {
    if (!userMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const hadFocusInside = accountRef.current?.contains(document.activeElement) ?? false;
      setUserMenuOpen(false);
      if (hadFocusInside) userButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenuOpen]);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    const result = await logout();
    setLoggingOut(false);
    if (result.ok) {
      setAccount({ status: "anon" });
      setUserMenuOpen(false);
    }
  };

  return (
    <div className="wb-home" data-period={period}>
      <FujiScene period={period} />
      <div className="wb-home__tint" aria-hidden />
      <div className="wb-home__grain" aria-hidden />

      <span className="wb-home__inscription wb-home__inscription--left" aria-hidden>富士山下　桜落つ</span>
      <span className="wb-home__inscription wb-home__inscription--right" aria-hidden>白板に　心を描く</span>

      <header className="wb-home__nav">
        <a className="wb-home__wordmark" href="/" aria-label="SakuraWhiteboard 首页">
          <span className="wb-home__wordmark-mark" aria-hidden>白</span>
          <span>SakuraWhiteboard</span>
        </a>
        <nav className={`wb-home__links${menuOpen ? " is-open" : ""}`} aria-label="主导航">
          <a href="#concept">产品理念</a>
          <a href="#how-to">使用方式</a>
          <a href="/boards">我的白板</a>
          {account.status === "authed" ? (
            <div
              className="wb-home__account"
              ref={accountRef}
              onPointerEnter={(event) => {
                // 触屏 tap 结束会补发 mouseleave，会把刚打开的菜单立刻关掉；只认真鼠标
                if (event.pointerType === "mouse") setUserMenuOpen(true);
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setUserMenuOpen(false);
              }}
              onFocus={() => setUserMenuOpen(true)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setUserMenuOpen(false);
              }}
            >
              <button
                ref={userButtonRef}
                type="button"
                className="wb-home__user"
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                title={account.user.displayName}
                data-testid="home-user"
                onClick={() => setUserMenuOpen(true)}
              >
                {account.user.displayName}
              </button>
              {userMenuOpen ? (
                <div className="wb-home__user-menu" role="menu" aria-label="账号">
                  <button
                    type="button"
                    role="menuitem"
                    className="wb-home__user-menu-item"
                    onClick={() => void handleLogout()}
                    disabled={loggingOut}
                    data-testid="home-logout"
                  >
                    {loggingOut ? "正在退出…" : "退出登录"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : account.status === "anon" ? (
            <a href="/login?next=%2Fboards" data-testid="home-login">登录</a>
          ) : (
            <span className="wb-home__account-pending" aria-hidden data-testid="home-auth-pending" />
          )}
        </nav>
        <button className="wb-home__menu" type="button" aria-label="打开菜单" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <span /><span /><span />
        </button>
      </header>

      <main className="wb-home__content">
        <div className="wb-home__brand" aria-label="SakuraWhiteboard SHIRO">
          <span className="wb-home__brand-name">桜花白板</span>
          <span className="wb-home__brand-en">SHIRO</span>
          <span className="wb-home__brand-eyebrow">REAL-TIME COLLABORATIVE CANVAS</span>
        </div>

        <section className="wb-home__hero" id="concept">
          <h1>让想法，<em>一起发生。</em></h1>
          <p className="wb-home__intro">一张为团队而生的白板。随手记录、自由发散，<br />让每一次灵感都能被看见、被接住。</p>
          <div className="wb-home__actions">
            <button className="wb-home__cta" type="button" onClick={() => void start()} disabled={busy}>
              {busy ? (slow ? "还在连接…" : "正在准备…") : "开始一块新白板"}<span aria-hidden>↗</span>
            </button>
            <a className="wb-home__secondary" href="/boards">浏览我的白板 <span aria-hidden>→</span></a>
          </div>
          {error ? <p className="wb-home__error" role="alert">{error.message}</p> : null}
        </section>

        <section className="wb-home__features" id="how-to" aria-label="产品特点">
          <article><span>01</span><strong>随时共创</strong><p>同一张画布，同步思考。</p></article>
          <article><span>02</span><strong>自由表达</strong><p>想到就画，灵感不掉线。</p></article>
          <article><span>03</span><strong>安心保存</strong><p>每一次改变都被记住。</p></article>
        </section>
      </main>

      <footer className="wb-home__foot">
        <span className="wb-home__seal" aria-label="白板之印"><span>白</span><span>板</span></span>
        <span aria-hidden>·</span><span>画布渲染 Built on Excalidraw</span>
        <span className="wb-home__foot-note">富士山下，樱花落时。</span>
      </footer>
    </div>
  );
}
