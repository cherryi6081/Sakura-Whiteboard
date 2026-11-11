import { useState } from "react";
import { useCreateBoard } from "../boards/useCreateBoard";
import { FujiScene } from "./FujiScene";
import { usePeriod } from "./usePeriod";

/** 首页：富士山场景中的实时协作入口。 */
export function HomePage() {
  const { busy, slow, error, start } = useCreateBoard();
  const [menuOpen, setMenuOpen] = useState(false);
  const period = usePeriod();

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
          <a href="/login?next=%2Fboards">登录</a>
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
