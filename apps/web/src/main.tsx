import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles/tokens.css";
import "./styles/ui.css";
import "./styles/pages.css";
import "./styles/excalidraw-theme.css";
import { AuthFlow } from "./auth/AuthFlow";
import { RequireLogin } from "./auth/RequireLogin";
import { BoardPage } from "./board/BoardPage";
import { parseBoardRoute } from "./board/route";
import { BoardsPage } from "./boards/BoardsPage";
import { TrashPage } from "./boards/TrashPage";
import { JoinSpacePage } from "./boards/JoinSpacePage";
import { HomePage } from "./home/HomePage";
import { SpikeApp } from "./spike/SpikeApp";
import { ThemeClock } from "./theme/ThemeClock";
import { purgeExpiredCache } from "./store/cacheDb";

// M2-C5：启动时清掉 7 天未访问的本地缓存，避免 IndexedDB 永久泄漏
void purgeExpiredCache().catch((err) => console.warn("[cache] 过期清理失败", err));

// M3：白板身份**只从地址栏**取；这里不读 localStorage/"上次白板"，避免多标签互相抢板。
const route = parseBoardRoute(window.location.pathname, window.location.search);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeClock>
      {route.kind === "board" ? (
        <BoardPage boardId={route.boardId} />
      ) : route.kind === "auth" ? (
        <AuthFlow mode={route.mode} next={route.next} />
      ) : route.kind === "boards" ? (
        <BoardsPage />
      ) : route.kind === "trash" ? (
        // 回收站是受限页：未登录跳到 /login 并带 returnTo；/boards 仍对游客开放
        <RequireLogin>
          <TrashPage />
        </RequireLogin>
      ) : route.kind === "join" ? (
        <JoinSpacePage token={route.token} />
      ) : route.kind === "spike" ? (
        <SpikeApp />
      ) : (
        <HomePage />
      )}
    </ThemeClock>
  </StrictMode>,
);
