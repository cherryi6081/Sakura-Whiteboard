import { useHandleLibrary } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { makeLibraryItems, SEED_PREFIX } from "./libraryItems";
import { getKnownLibraryItems, libraryAdapter } from "./persist";

/** 挂载后接管素材库的加载/保存；api 就绪前传 null 即可 */
export function useSeedLibrary(api: ExcalidrawImperativeAPI | null) {
  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter });
}

/**
 * 命令级入口「恢复默认模板」：用「用户自建条目 + 当前版本默认条目」整体替换。
 *
 * 不能走 `merge: true`：库内部会先 `restoreElements` 重建元素（versionNonce 变随机），
 * 判重必然失败，每点一次就把 56 条再叠一份。整体替换既幂等，也不会丢用户自建条目。
 */
export function restoreDefaultTemplates(api: ExcalidrawImperativeAPI) {
  const userItems = getKnownLibraryItems().filter((item) => !item.id.startsWith(SEED_PREFIX));
  void api.updateLibrary({
    libraryItems: [...userItems, ...makeLibraryItems("light")],
  });
}
