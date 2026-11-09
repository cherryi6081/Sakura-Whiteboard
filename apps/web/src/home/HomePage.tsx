import { FujiScene } from "./FujiScene";

/**
 * 首页 / 纯展示页：只呈现品牌、文案与场景。
 *
 * 这里没有任何可交互控件，也不发起任何网络请求；登录与白板入口只能靠直接访问
 * `/login`、`/boards`（以及 `/board/:id`）到达。顶栏里的三个词条是纯文本标注，
 * 不带链接、hover 与焦点行为。
 */
export function HomePage() {
  return (
    <div className="wb-home">
      {/* 场景铺满整个视口，绝对定位在内容之下；aria-hidden + pointer-events: none */}
      <FujiScene />

      <header className="wb-home__top">
        <span className="wb-brand">
          <span className="wb-brand__mark" aria-hidden>
            白
          </span>
          白板
        </span>
        <p className="wb-home__nav">
          <span className="wb-home__nav-item">我的白板</span>
          <span className="wb-home__nav-item">登录</span>
          <span className="wb-home__nav-item wb-home__nav-item--strong">注册</span>
        </p>
      </header>

      <div className="wb-home__stage">
        <main className="wb-home__main">
          <p className="wb-home__eyebrow">
            <span className="wb-home__eyebrow-dot" aria-hidden />
            免注册 · 打开即画
          </p>
          <h1 className="wb-home__headline">打开就能画。</h1>
          <p className="wb-home__lead">不用注册。想留住它，再登录。</p>

          <ul className="wb-home__points">
            <li className="wb-home__point">多人实时协作，改动即时可见</li>
            <li className="wb-home__point">多标签页各自独立，不会互相覆盖</li>
            <li className="wb-home__point">手机可直接触控绘制</li>
          </ul>
          {/* 移动端按 §4.1 收成一行文案，不换三行 */}
          <p className="wb-home__points-line">实时协作 · 多标签独立 · 手机可画</p>
        </main>
      </div>

      <footer className="wb-home__foot">
        <span>白板 v0.3</span>
        <span aria-hidden>·</span>
        <span>画布渲染 Built on Excalidraw</span>
      </footer>
    </div>
  );
}
