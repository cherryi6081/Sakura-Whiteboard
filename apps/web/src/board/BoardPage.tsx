import { useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { loadBoardScene, type BoardScene } from "./loadScene";

type BoardWindow = {
  boardId: string;
  sceneIds: () => string[];
  ready: boolean;
};

declare global {
  interface Window {
    __board?: BoardWindow;
  }
}

export function BoardPage({ boardId }: { boardId: string }) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [scene, setScene] = useState<BoardScene | null>(null);

  useEffect(() => {
    let alive = true;
    setScene(null);
    void loadBoardScene(boardId).then((loaded) => {
      if (alive) setScene(loaded);
    });
    return () => {
      alive = false;
    };
  }, [boardId]);

  useEffect(() => {
    window.__board = {
      boardId,
      ready: false,
      sceneIds: () => apiRef.current?.getSceneElements().map((el) => el.id) ?? [],
    };
    return () => {
      delete window.__board;
    };
  }, [boardId]);

  if (!scene) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh", fontFamily: "system-ui, sans-serif", color: "#6B5A60" }}>
        正在加载白板 {boardId}…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid #EADDE2",
          background: "#FFF9FB",
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          color: "#6B5A60",
        }}
      >
        <strong style={{ color: "#A85C7C" }}>白板</strong>
        <code data-testid="board-id" style={{ color: "#8E4568" }}>{boardId}</code>
        <span style={{ marginLeft: "auto", fontSize: 12 }}>
          {scene.source === "placeholder" ? "空场景（C1 占位，快照接口待 C3）" : `快照 seq=${scene.seq}`}
        </span>
      </header>
      <div style={{ position: "relative", flex: 1 }}>
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api;
            if (window.__board) window.__board.ready = true;
          }}
          initialData={{ elements: scene.elements }}
        />
      </div>
    </div>
  );
}
