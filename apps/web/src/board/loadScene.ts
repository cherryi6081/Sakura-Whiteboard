import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type BoardScene = {
  elements: readonly ExcalidrawElement[];
  /** 场景来源：C1 只有占位空场景；后续由服务端快照替换 */
  source: "placeholder" | "snapshot";
  seq: number;
};

/**
 * 加载一块白板的初始场景。
 *
 * M2-C1 只接通"按 boardId 加载"这条链路：服务端 `GET /api/boards/:id/snapshot`
 * 要到 C3 才落地，因此这里返回**每次新建的空场景**（不缓存、不落盘）。
 * 这样两个不同 boardId 的标签页天然各持一份内存场景，不会共享。
 */
export async function loadBoardScene(boardId: string): Promise<BoardScene> {
  void boardId;
  return { elements: [], source: "placeholder", seq: 0 };
}
