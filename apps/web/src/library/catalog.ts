/**
 * 素材库目录（唯一真源）：13 条整图模板 + 83 个可复用元件。
 *
 * 侧栏显示顺序 = `CATALOG` 数组顺序（模板在前、元件在后，按 5 个类别分区）。
 * 条目 id 统一为 `sakura.<cat>.<slug>`，加上版本与主题后才是 library item id。
 */
import type { Skeleton } from "./draw";
import type { Palette } from "./spec";
import type { TemplateCat } from "./templates";
import { TEMPLATES } from "./templates";
import { COMPONENTS } from "./components";

export type CatalogKind = "template" | "component";

export type CatalogEntry = {
  /** 不带版本/主题的条目 id：`sakura.<cat>.<slug>` */
  id: string;
  cat: TemplateCat;
  kind: CatalogKind;
  name: string;
  slug: string;
  build: (p: Palette) => Skeleton[];
};

/**
 * 素材库类别条（唯一真源）。
 *
 * 不设「全部」：它和各类别展示同一批元素，属于重复展示。默认落在第一项。
 * `prefixes` 按 library item id 前缀归档；省略 prefixes 的类别是兜底（我的素材）。
 * 以后导入手账 / 表情包，只需在这里追加一条 `{ id, label, prefixes: ["sakura.journal."] }`。
 */
export type LibraryCategory = { id: string; label: string; prefixes?: string[] };

export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  { id: "eng", label: "工程模板", prefixes: ["sakura."] },
  { id: "mine", label: "我的素材" },
];

export const DEFAULT_CATEGORY = LIBRARY_CATEGORIES[0].id;

/** library item id → 类别 id；没有命中前缀的一律归「我的素材」 */
export function categoryOfItem(itemId: string): string {
  const hit = LIBRARY_CATEGORIES.find((category) =>
    category.prefixes?.some((prefix) => itemId.startsWith(prefix)),
  );
  return hit?.id ?? "mine";
}

export const CAT_LABEL: Record<TemplateCat, string> = {
  se: "软件工程",
  arch: "系统架构",
  flowx: "流程与体验",
  pm: "项目管理",
  ops: "工程运维",
};

export const CATALOG: CatalogEntry[] = [
  ...TEMPLATES.map<CatalogEntry>((template) => ({
    id: `sakura.${template.cat}.${template.slug}`,
    cat: template.cat,
    kind: "template",
    name: template.name,
    slug: template.slug,
    build: template.build,
  })),
  ...COMPONENTS.map<CatalogEntry>((component) => ({
    id: `sakura.${component.cat}.${component.slug}`,
    cat: component.cat,
    kind: "component",
    name: component.name,
    slug: component.slug,
    build: component.build,
  })),
];

const CATALOG_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

/** 种子条目 id（`sakura.<cat>.<slug>@版本-主题`）→ 目录项；用户自建条目返回 null */
export function catalogEntryOfItem(itemId: string): CatalogEntry | null {
  return CATALOG_BY_ID.get(itemId.split("@")[0]) ?? null;
}
