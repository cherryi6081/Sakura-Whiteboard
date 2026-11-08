import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BoardPage } from "./board/BoardPage";
import { SpikeApp } from "./spike/SpikeApp";

const boardMatch = /^\/board\/([A-Za-z0-9_-]{12})\/?$/.exec(window.location.pathname);
const isSpikeRoute = /^\/spike\/?$/.test(window.location.pathname);

function IndexPage() {
  return (
    <div style={{ maxWidth: 560, margin: "80px auto", fontFamily: "system-ui, sans-serif", color: "#6B5A60", lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 22, color: "#A85C7C" }}>实时协作白板</h1>
      <p>当前为 M2-C1：画布接入与场景加载。选择一块白板进入（boardId 为 12 位字符）：</p>
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
    {boardMatch ? <BoardPage boardId={boardMatch[1]} /> : isSpikeRoute ? <SpikeApp /> : <IndexPage />}
  </StrictMode>,
);
