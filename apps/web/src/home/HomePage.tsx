import { FujiScene } from "./FujiScene";

/**
 * 首页 / 展示页：整页富士山场景 + 页脚。
 *
 * 顶栏（品牌、导航词条）与主文案区（眉标、主标题、副文、能力点）已从首页移除，
 * 页内没有任何可聚焦控件，也不发起网络请求。"新建白板"那套逻辑没有删除，
 * 已抽到 `boards/useCreateBoard`，由 `/boards` 继续使用。
 */
export function HomePage() {
  return (
    <div className="wb-home">
      {/* 场景铺满整个视口，绝对定位在内容之下；aria-hidden + pointer-events: none */}
      <FujiScene />

      <footer className="wb-home__foot">
        <span>白板 v0.3</span>
        <span aria-hidden>·</span>
        <span>画布渲染 Built on Excalidraw</span>
      </footer>
    </div>
  );
}
