/**
 * 卡片右键菜单的纯逻辑：项集（权限 / 禁用原因）与浮动菜单定位。
 *
 * 设计稿：7 项 3 组，禁用不隐藏；定位顺序固定为「优先右下 → 反向翻转 → 夹到 8px 安全边距」。
 * 这两块都不碰 DOM，便于单测覆盖所有角色与贴边组合。
 */

export type BoardMenuIcon =
  | "open"
  | "rename"
  | "move"
  | "pin"
  | "pinOff"
  | "link"
  | "copy"
  | "users"
  | "trash";

export type BoardMenuItem = {
  key: string;
  label: string;
  icon: BoardMenuIcon;
  /** 行尾快捷键，如 `↵` / `F2` / `P` */
  shortcut?: string;
  /** 行尾原因或提示；与 `disabledReason` 同时存在时只渲染禁用原因 */
  tail?: string;
  /** 有值即禁用（aria-disabled），原因写在行尾 */
  disabledReason?: string;
  danger?: boolean;
  submenu?: BoardMenuItem[];
};

export type BoardMenuGroup = { items: BoardMenuItem[]; danger?: boolean };

export type BoardMenuRole = "owner" | "editor" | "viewer" | string;

export function buildBoardMenu(options: { role: BoardMenuRole; pinned: boolean; guest?: boolean }): BoardMenuGroup[] {
  const canEdit = options.role === "owner" || options.role === "editor";
  // 游客没有服务端回收站（删除即物理删除），「移到回收站」对它禁用
  const isOwner = options.role === "owner" && !options.guest;

  const members: BoardMenuItem = {
    key: "members",
    label: "协作者",
    icon: "users",
    submenu: [
      { key: "invite", label: "邀请协作者", icon: "users" },
      {
        key: "remove-member",
        label: "移除协作者",
        icon: "trash",
        danger: true,
        disabledReason: "暂无成员管理",
      },
    ],
  };

  const groups: BoardMenuGroup[] = [
    {
      items: [
        { key: "open", label: "打开白板", icon: "open", shortcut: "↵" },
        {
          key: "rename",
          label: "重命名",
          icon: "rename",
          shortcut: "F2",
          // 游客列表的标题只存本机，改名后刷新会回退，因此只对登录用户开放
          disabledReason: options.guest ? "登录后可用" : canEdit ? undefined : "只读",
        },
        {
          // 单列（≤700）下横向拖拽失效，这里是精确与读屏用户的兜底入口
          key: "move-to",
          label: "移动到…",
          icon: "move",
          disabledReason: options.guest ? "登录后可用" : undefined,
        },
        {
          key: "pin",
          label: options.pinned ? "取消置顶" : "置顶",
          icon: options.pinned ? "pinOff" : "pin",
          shortcut: "P",
          disabledReason: canEdit ? undefined : "只读",
        },
      ],
    },
    {
      items: [
        { key: "copy-link", label: "复制链接", icon: "link" },
        // 本期不做元素复制：含图片元素会牵出资产引用与 GC 的连带风险
        { key: "duplicate", label: "创建副本", icon: "copy", disabledReason: "暂不支持" },
        ...(isOwner ? [members] : []),
      ],
    },
    {
      danger: true,
      items: [
        {
          key: "trash",
          label: "移到回收站",
          icon: "trash",
          danger: true,
          disabledReason: isOwner ? undefined : options.guest ? "登录后可用" : "仅所有者",
        },
      ],
    },
  ];

  return groups;
}

/* ---------------- 定位 ---------------- */

export type MenuAnchor =
  | { type: "pointer"; x: number; y: number }
  | { type: "button"; left: number; right: number; top: number; bottom: number };

export type MenuPlacement = { left: number; top: number; maxHeight: number };

/** 设计稿的视口安全边距：桌面 8，触屏由调用方传 12。 */
export const MENU_VIEWPORT_MARGIN = 8;

/**
 * 四步定位：默认向下展开 → 放不下反向翻转 → 仍越界则夹到安全边距 →
 * 高度上限为视口减两侧边距（超出的部分由菜单内部滚动）。
 */
export function placeFloatingMenu(
  anchor: MenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number = MENU_VIEWPORT_MARGIN,
): MenuPlacement {
  let left: number;
  let top: number;

  if (anchor.type === "pointer") {
    left = anchor.x + 4;
    top = anchor.y + 4;
    if (left + size.width + margin > viewport.width) left = anchor.x - size.width - 4;
    if (top + size.height + margin > viewport.height) top = anchor.y - size.height - 4;
  } else {
    // 按钮锚点：菜单右缘对齐按钮右缘，向下 6；左/上放不下再换边
    left = anchor.right - size.width;
    top = anchor.bottom + 6;
    if (left < margin) left = anchor.left;
    if (top + size.height + margin > viewport.height) {
      const above = anchor.top - size.height - 6;
      top = above >= margin ? above : Math.max(margin, viewport.height - size.height - margin);
    }
  }

  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  return {
    left: Math.min(Math.max(left, margin), maxLeft),
    top: Math.min(Math.max(top, margin), maxTop),
    maxHeight: Math.max(0, viewport.height - margin * 2),
  };
}
