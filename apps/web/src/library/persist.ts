/**
 * 素材库持久化：localStorage 适配器。
 *
 * 0.18.1 的 `<Excalidraw>` 不会自己调用 useHandleLibrary，宿主必须接管加载/保存，
 * 否则素材库只是内存态（刷新即清空）。
 *
 * 播种语义：
 * - 首次 load 返回首批 13 条浅色模板；Excalidraw 会把它当作「已保存」基线，
 *   用户删掉的条目不会被刷新回填；
 * - 只有检测到旧版本种子条目（模板升级）时才合并当前版本默认项；
 * - save 前清掉旧版本种子条目，避免升级后堆叠同名副本。
 */
import { makeLibraryItems, pruneStale, TEMPLATE_VERSION, withDefaults, type LibraryItems } from "./libraryItems";

const STORAGE_KEY = "sakura.library.v2";

type Persisted = { libraryItems: LibraryItems };

function readStored(): LibraryItems | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LibraryItems) : null;
  } catch (err) {
    console.warn("[library] 读取本地素材库失败，回退到默认模板", err);
    return null;
  }
}

export const libraryAdapter = {
  async load(): Promise<Persisted | null> {
    const stored = readStored();
    if (!stored) return { libraryItems: makeLibraryItems("light") };

    // 只有存在旧版本种子条目（模板升级）时才补当前版本，避免复活用户删掉的条目
    const hasStale = stored.some(
      (item) => item.id.startsWith("sakura.") && !item.id.includes(`@${TEMPLATE_VERSION}-`),
    );
    return { libraryItems: hasStale ? withDefaults(stored, "light") : stored };
  },

  async save({ libraryItems }: Persisted): Promise<void> {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneStale(libraryItems)));
  },
};
