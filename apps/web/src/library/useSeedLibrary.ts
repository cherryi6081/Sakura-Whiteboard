import { useHandleLibrary } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { makeLibraryItems } from "./libraryItems";
import { libraryAdapter } from "./persist";

/** 挂载后接管素材库的加载/保存；api 就绪前传 null 即可 */
export function useSeedLibrary(api: ExcalidrawImperativeAPI | null) {
  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter });
}

/**
 * 命令级入口「恢复默认模板」：只补回缺失的默认条目，
 * 不覆盖用户自建条目，也不在启动时自动执行（避免删掉后反复复活）。
 */
export function restoreDefaultTemplates(api: ExcalidrawImperativeAPI) {
  void api.updateLibrary({
    libraryItems: makeLibraryItems("light"),
    merge: true,
    openLibraryMenu: true,
  });
}
