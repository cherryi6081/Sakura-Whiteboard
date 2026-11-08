import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BoardPage } from "./board/BoardPage";
import { parseBoardRoute } from "./board/route";
import { SpikeApp } from "./spike/SpikeApp";
import { purgeExpiredCache } from "./store/cacheDb";

// M2-C5：启动时清掉 7 天未访问的本地缓存，避免 IndexedDB 永久泄漏
void purgeExpiredCache().catch((err) => console.warn("[cache] 过期清理失败", err));

// M3：白板身份**只从地址栏**取；这里不读 localStorage/"上次白板"，避免多标签互相抢板。
const route = parseBoardRoute(window.location.pathname, window.location.search);

function IndexPage() {
  return (
    <div style={{ maxWidth: 560, margin: "80px auto", fontFamily: "system-ui, sans-serif", color: "#6B5A60", lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 22, color: "#A85C7C" }}>实时协作白板</h1>
      <p>当前为 M3：多标签隔离。选择一块白板进入（boardId 为 12 位字符）：</p>
      <ul>
        <li><a href="/board/demo_board01">/board/demo_board01</a></li>
        <li><a href="/board/demo_board02">/board/demo_board02</a></li>
        <li><a href="/spike">/spike（M2 前置验证页，保留）</a></li>
      </ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {route.kind === "board" ? (
      <BoardPage boardId={route.boardId} />
    ) : route.kind === "spike" ? (
      <SpikeApp />
    ) : (
      <IndexPage />
    )}
  </StrictMode>,
);
