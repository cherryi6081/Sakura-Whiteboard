import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ROLE_LABEL } from "./boardsApi";
import {
  buildBoardMenu,
  placeFloatingMenu,
  type BoardMenuItem,
  type MenuAnchor,
  type MenuPlacement,
} from "./boardMenu";
import {
  IconBoard,
  IconArrowRight,
  IconCopy,
  IconPin,
  IconPinOff,
  IconRename,
  IconShare,
  IconTrash,
  IconUser,
} from "../ui/icons";

/**
 * 卡片右键菜单（设计稿 v1）。
 *
 * - 单例：右键 / 长按 / 「更多」共用同一个组件实例，项集与权限判定只有 `buildBoardMenu` 一份。
 * - 桌面浮动菜单 232px 宽、行高 36；<640 一律底部弹层（行高 52）。
 * - 键盘走 roving tabindex；禁用项保留在方向键序列里，`aria-disabled` 而不是 `disabled`。
 */

export type BoardMenuTarget = {
  boardId: string;
  title: string;
  role: string;
  pinned: boolean;
  guest?: boolean;
  anchor: MenuAnchor;
  trigger: HTMLElement | null;
};

type Props = {
  target: BoardMenuTarget;
  onAction: (key: string) => void;
  onClose: (restoreFocus?: boolean) => void;
};

const ICONS = {
  open: IconBoard,
  rename: IconRename,
  pin: IconPin,
  pinOff: IconPinOff,
  link: IconShare,
  copy: IconCopy,
  users: IconUser,
  trash: IconTrash,
};

const SHEET_QUERY = "(max-width: 639px)";

function useIsSheet(): boolean {
  const [isSheet, setIsSheet] = useState(() => window.matchMedia(SHEET_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(SHEET_QUERY);
    const onChange = () => setIsSheet(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return isSheet;
}

export function BoardCardMenu({ target, onAction, onClose }: Props) {
  const isSheet = useIsSheet();
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [submenu, setSubmenu] = useState<{ key: string; left: number; top: number } | null>(null);
  const groups = buildBoardMenu({ role: target.role, pinned: target.pinned, guest: target.guest });
  const roleLabel = target.guest ? "临时板" : (ROLE_LABEL[target.role] ?? target.role);

  const topLevel = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-level="0"]') ?? []),
    [],
  );
  const subItems = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-level="1"]') ?? []),
    [],
  );

  const reposition = useCallback(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = window.matchMedia("(pointer: coarse)").matches ? 12 : 8;
    setPlacement(
      placeFloatingMenu(
        target.anchor,
        { width: 232, height: rect.height || 325 },
        { width: window.innerWidth, height: window.innerHeight },
        margin,
      ),
    );
  }, [target.anchor]);

  useLayoutEffect(() => {
    if (isSheet) return;
    reposition();
  }, [isSheet, reposition]);

  // 打开期间只在 resize / 滚动结束后重算一次，不逐帧跟随
  useEffect(() => {
    if (isSheet) return;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reposition, 120);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [isSheet, reposition]);

  // 打开即聚焦首项：焦点留在卡片上方向键会没反应
  useEffect(() => {
    const timer = window.setTimeout(() => {
      topLevel()[0]?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [topLevel]);

  // 点击外部 / 窗口失焦关闭
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const el = menuRef.current;
      if (!el) return;
      const node = event.target as Node;
      if (el.contains(node)) return;
      if (target.trigger && target.trigger.contains(node)) return;
      onClose(false);
    };
    const onBlur = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose, target.trigger]);

  const openSubmenu = (key: string) => {
    const el = menuRef.current;
    const parent = el?.querySelector<HTMLElement>(`[data-menu-key="${key}"]`);
    if (!el || !parent) return;
    const itemRect = parent.getBoundingClientRect();
    // 子菜单用 fixed 定位，避免被主菜单的 overflow 裁掉；与父项垂直居中，越界则夹回 8px
    const width = 208;
    const height = 86;
    const left =
      itemRect.right + width + 8 > window.innerWidth ? itemRect.left - width + 4 : itemRect.right - 4;
    const top = Math.min(
      Math.max(itemRect.top + itemRect.height / 2 - height / 2, 8),
      Math.max(8, window.innerHeight - height - 8),
    );
    setSubmenu({ key, left: Math.max(8, left), top });
  };

  const closeSubmenu = (focusParent: boolean) => {
    setSubmenu((current) => {
      if (focusParent && current) {
        menuRef.current
          ?.querySelector<HTMLButtonElement>(`[data-menu-key="${current.key}"]`)
          ?.focus({ preventScroll: true });
      }
      return null;
    });
  };

  const activate = (item: BoardMenuItem) => {
    if (item.disabledReason) return;
    if (item.submenu) {
      openSubmenu(item.key);
      return;
    }
    onAction(item.key);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      if (submenu) closeSubmenu(true);
      else onClose(true);
      return;
    }
    if (key === "Tab") {
      // 关闭后焦点交给触发元素，浏览器默认 Tab 继续往后走
      onClose(true);
      return;
    }
    const list = submenu ? subItems() : topLevel();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (list.length === 0) return;
      const step = key === "ArrowDown" ? 1 : -1;
      const next = index < 0 ? 0 : (index + step + list.length) % list.length;
      list[next]?.focus({ preventScroll: true });
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      list[key === "Home" ? 0 : list.length - 1]?.focus({ preventScroll: true });
      return;
    }
    if (key === "ArrowRight" && !submenu) {
      const item = groups.flatMap((group) => group.items).find((entry) => entry.submenu);
      if (item && document.activeElement === menuRef.current?.querySelector(`[data-menu-key="${item.key}"]`)) {
        event.preventDefault();
        openSubmenu(item.key);
        window.setTimeout(() => subItems()[0]?.focus({ preventScroll: true }), 0);
      }
      return;
    }
    if (key === "ArrowLeft" && submenu) {
      event.preventDefault();
      closeSubmenu(true);
      return;
    }
    // 加速键只在菜单打开时生效
    if (key === "F2") {
      event.preventDefault();
      onAction("rename");
      return;
    }
    if ((key === "p" || key === "P") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      onAction("pin");
    }
  };

  const itemClass = (item: BoardMenuItem) =>
    [
      isSheet ? "wb-sheet__item" : "wb-board-menu__item",
      item.danger ? (isSheet ? "wb-sheet__item--danger" : "wb-board-menu__item--danger") : "",
      item.disabledReason ? "is-disabled" : "",
    ]
      .filter(Boolean)
      .join(" ");

  const renderItem = (item: BoardMenuItem, level: 0 | 1) => {
    const Icon = ICONS[item.icon];
    const tail = item.disabledReason ?? item.tail ?? item.shortcut;
    return (
      <button
        key={item.key}
        type="button"
        role="menuitem"
        data-menu-level={level}
        data-menu-key={item.key}
        className={itemClass(item)}
        aria-disabled={item.disabledReason ? "true" : undefined}
        aria-haspopup={item.submenu ? "menu" : undefined}
        aria-expanded={item.submenu ? submenu?.key === item.key : undefined}
        tabIndex={-1}
        onClick={() => activate(item)}
        onMouseEnter={() => {
          if (item.submenu && !isSheet) openSubmenu(item.key);
          else if (!item.submenu && submenu) closeSubmenu(false);
        }}
        onFocus={(event) => {
          const el = event.currentTarget;
          const root = menuRef.current;
          if (!root) return;
          root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]').forEach((node) => {
            node.tabIndex = node === el ? 0 : -1;
          });
        }}
      >
        <Icon size={isSheet ? 18 : 16} />
        <span className="wb-board-menu__label">{item.label}</span>
        {tail ? (
          <span className={`wb-board-menu__tail${item.disabledReason ? " is-reason" : ""}`}>
            {tail}
            {item.submenu ? <IconArrowRight size={12} /> : null}
          </span>
        ) : null}
        {item.submenu && !tail ? (
          <span className="wb-board-menu__tail">
            <IconArrowRight size={12} />
          </span>
        ) : null}
      </button>
    );
  };

  const head = (
    <div className={isSheet ? "wb-board-sheet__head" : "wb-board-menu__head"}>
      <span className="wb-board-menu__title">{target.title}</span>
      <span className="wb-board-menu__role">{roleLabel}</span>
    </div>
  );

  if (isSheet) {
    return (
      <div
        className="wb-sheet-layer"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose(true);
        }}
      >
        <div className="wb-sheet wb-board-sheet" role="menu" aria-label={`${target.title} 操作`} ref={menuRef} onKeyDown={onKeyDown}>
          <span className="wb-sheet__grip" aria-hidden />
          {head}
          {groups.map((group, groupIndex) => (
            <div className="wb-board-sheet__group" key={groupIndex}>
              {groupIndex > 0 ? <div className={`wb-board-menu__sep${group.danger ? " wb-board-menu__sep--danger" : ""}`} role="separator" /> : null}
              {group.items.map((item) => (
                <div key={item.key}>
                  {renderItem(item, 0)}
                  {item.submenu && submenu?.key === item.key
                    ? item.submenu.map((sub) => renderItem(sub, 1))
                    : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="wb-board-menu"
      role="menu"
      aria-label={`${target.title} 操作`}
      ref={menuRef}
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        maxHeight: placement?.maxHeight,
        visibility: placement ? "visible" : "hidden",
      }}
      onKeyDown={onKeyDown}
    >
      {head}
      {groups.map((group, groupIndex) => (
        <div className="wb-board-menu__group" key={groupIndex}>
          {groupIndex > 0 ? <div className={`wb-board-menu__sep${group.danger ? " wb-board-menu__sep--danger" : ""}`} role="separator" /> : null}
          {group.items.map((item) => (
            <div className="wb-board-menu__slot" key={item.key}>
              {renderItem(item, 0)}
              {item.submenu && submenu?.key === item.key ? (
                <div
                  className="wb-board-menu wb-board-menu--sub"
                  role="menu"
                  style={{ top: submenu.top, left: submenu.left }}
                >
                  {item.submenu.map((sub) => renderItem(sub, 1))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
