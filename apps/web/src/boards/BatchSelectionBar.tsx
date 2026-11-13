import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { placeFloatingMenu } from "./boardMenu";
import {
  allPinned as allSelectedPinned,
  pinTargets,
  selectionState,
  trashTargets,
  type SelectableCard,
  type SelectionState,
} from "./selection";
import { IconBoard, IconCheck, IconClose, IconMore, IconPin, IconPinOff, IconTrash } from "../ui/icons";

type Props = {
  cards: readonly SelectableCard[];
  visible: readonly SelectableCard[];
  selected: ReadonlySet<string>;
  allScope: boolean;
  busy: boolean;
  /** 游客模式：临时板只能物理删除，隐藏置顶/移动等登录后能力 */
  guest?: boolean;
  contextLabel?: string;
  onToggleAll: () => void;
  onSelectAllLoaded: () => void;
  onClearAll: () => void;
  onInvert: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onTrash: () => void;
  onExit: () => void;
};

type MoreItem = {
  key: string;
  label: string;
  icon: ReactNode;
  disabledReason?: string;
  danger?: boolean;
  onSelect: () => void;
};

function ariaChecked(state: SelectionState): boolean | "mixed" {
  if (state === "all") return true;
  if (state === "some") return "mixed";
  return false;
}

function CheckBox({ state, label, onClick }: { state: SelectionState; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={ariaChecked(state)}
      aria-label={label}
      className="wb-checkhit"
      onClick={onClick}
    >
      <span
        className={`wb-check${state === "all" ? " is-checked" : state === "some" ? " is-mixed" : ""}`}
        aria-hidden
      >
        {state === "all" ? <IconCheck size={12} /> : null}
      </span>
    </button>
  );
}

/**
 * 批量选择工具条（设计稿 boards-bulk-select §02/§04/§06）。
 *
 * - ≥701：56px 工具条替换标题行；≥1200 直出「移动到空间」，1024–1199 收进「更多」。
 * - ≤700：标题行保留「我的白板 · N 块 · 完成」，操作贴底（删除 / 更多）。
 * - 0 选时动作 disabled 但保留；全选框三态；「选择全部」是快照，后续加载更多不回填。
 */
export function BatchSelectionBar({
  cards,
  visible,
  selected,
  allScope,
  busy,
  guest = false,
  contextLabel = "我的白板",
  onToggleAll,
  onSelectAllLoaded,
  onClearAll,
  onInvert,
  onPin,
  onUnpin,
  onTrash,
  onExit,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches,
  );
  const [placement, setPlacement] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const visibleIds = visible.map((card) => card.id);
  const state = selectionState(visibleIds, selected);
  const selectedCount = cards.filter((card) => selected.has(card.id)).length;
  const trash = trashTargets(cards, selected);
  const pinnable = pinTargets(cards, selected);
  const pinnedAll = allSelectedPinned(cards, selected);
  const showSelectAll = state === "all" && !allScope && cards.length > visible.length;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const onChange = () => {
      setCompact(query.matches);
      setMenuOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen || compact || !anchor) return;
    const size = menuRef.current?.getBoundingClientRect();
    setPlacement(
      placeFloatingMenu(
        { type: "button", ...anchor },
        { width: size?.width ?? 240, height: size?.height ?? 180 },
        { width: window.innerWidth, height: window.innerHeight },
        8,
      ),
    );
  }, [menuOpen, compact, anchor, selectedCount, allScope]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen]);

  const openMenu = (trigger: HTMLElement) => {
    triggerRef.current = trigger;
    const rect = trigger.getBoundingClientRect();
    setAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    setMenuOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };

  const pinDisabledReason =
    selectedCount === 0 ? "先勾选白板" : pinnable.targets.length === 0 ? "只读不可置顶" : undefined;

  const items: MoreItem[] = [];
  if (compact && !guest) {
    items.push({
      key: "pin",
      label: pinnedAll ? "取消置顶" : "批量置顶",
      icon: pinnedAll ? <IconPinOff size={16} /> : <IconPin size={16} />,
      disabledReason: pinDisabledReason,
      onSelect: pinnedAll ? onUnpin : onPin,
    });
  }
  if (!guest) {
    items.push({
      key: "move",
      label: "移动到空间",
      icon: <IconBoard size={16} />,
      disabledReason: "暂无团队空间",
      onSelect: () => {},
    });
  }
  items.push({ key: "invert", label: "反选本页", icon: <IconCheck size={16} />, onSelect: onInvert });
  if (showSelectAll) {
    items.push({
      key: "select-all",
      label: `选择全部 ${cards.length} 块`,
      icon: <IconCheck size={16} />,
      onSelect: onSelectAllLoaded,
    });
  }
  if (allScope) {
    items.push({ key: "clear-all", label: "取消全部", icon: <IconClose size={16} />, onSelect: onClearAll });
  }
  if (compact) {
    items.push({ key: "exit", label: "取消选择", icon: <IconClose size={16} />, onSelect: onExit });
  }

  const runItem = (item: MoreItem) => {
    if (item.disabledReason) return;
    closeMenu();
    item.onSelect();
  };

  const renderMenuItem = (item: MoreItem, sheet: boolean) => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      className={[
        sheet ? "wb-sheet__item" : "wb-board-menu__item",
        item.danger ? (sheet ? "wb-sheet__item--danger" : "wb-board-menu__item--danger") : "",
        item.disabledReason ? "is-disabled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-disabled={item.disabledReason ? "true" : undefined}
      tabIndex={-1}
      onClick={() => runItem(item)}
    >
      {item.icon}
      <span className="wb-board-menu__label">{item.label}</span>
      {item.disabledReason ? (
        <span className="wb-board-menu__tail is-reason">{item.disabledReason}</span>
      ) : null}
    </button>
  );

  const pinTitle = pinDisabledReason ?? (pinnedAll ? "取消置顶所选白板" : "置顶所选白板");

  return (
    <>
      <div className="wb-boards__head wb-selection-bar" role="toolbar" aria-label="批量操作">
        <div className="wb-selection-bar__lead">
          <CheckBox state={state} label="全选本页" onClick={onToggleAll} />
          <span className="wb-selection-bar__ctx">{contextLabel}</span>
          <span className="wb-selection-bar__div" aria-hidden />
          <span className="wb-selection-bar__count" aria-live="polite">
            <b>已选 {selectedCount}</b>
            <span> / {cards.length}</span>
          </span>
          <span className={`wb-selection-bar__scope${allScope ? " is-all" : ""}`}>
            {allScope ? `全部 ${cards.length}` : `本页 ${visible.length}`}
          </span>
          {showSelectAll ? (
            <button type="button" className="wb-selection-bar__link" onClick={onSelectAllLoaded}>
              选择全部 {cards.length} 块
            </button>
          ) : null}
          {allScope ? (
            <button type="button" className="wb-selection-bar__link" onClick={onClearAll}>
              取消全部
            </button>
          ) : null}
          {selectedCount === 0 ? <span className="wb-selection-bar__hint">勾选卡片开始</span> : null}
        </div>
        <div className="wb-selection-bar__actions">
          {!guest ? (
            <button
              type="button"
              className="wb-selbtn wb-selbar__pin"
              disabled={busy || Boolean(pinDisabledReason)}
              title={pinTitle}
              onClick={pinnedAll ? onUnpin : onPin}
            >
              {pinnedAll ? <IconPinOff size={16} /> : <IconPin size={16} />}
              <span className="wb-selbar__label">{pinnedAll ? "取消置顶" : "批量置顶"}</span>
            </button>
          ) : null}
          {!guest ? (
            <button type="button" className="wb-selbtn wb-selbar__move" disabled title="暂无团队空间">
              <IconBoard size={16} />
              <span>移动到空间</span>
            </button>
          ) : null}
          <button
            type="button"
            className="wb-selbtn wb-selbtn--danger"
            disabled={busy || selectedCount === 0 || trash.targets.length + trash.skipped.length === 0}
            title={
              guest
                ? "删除本机临时板（不可恢复）"
                : trash.targets.length === 0 && trash.skipped.length > 0
                  ? "所选白板都没有删除权限"
                  : "移入回收站"
            }
            onClick={onTrash}
          >
            <IconTrash size={16} />
            <span className="wb-selbar__label-long">{guest ? "删除临时板" : "移入回收站"}</span>
            <span className="wb-selbar__label-short">删除</span>
          </button>
          <button
            type="button"
            className="wb-selbtn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => (menuOpen ? closeMenu() : openMenu(event.currentTarget))}
          >
            <IconMore size={16} />
            <span>更多</span>
          </button>
          <span className="wb-selection-bar__div" aria-hidden />
          <button type="button" className="wb-selbtn wb-selbtn--done" onClick={onExit}>
            完成
          </button>
        </div>
      </div>

      <div className="wb-boards__head wb-selection-mobile-head">
        <div className="wb-boards__headline">
          <h1 className="wb-display">{contextLabel}</h1>
          <span className="wb-boards__count">{cards.length} 块</span>
        </div>
        <button type="button" className="wb-selbtn wb-selbtn--done" onClick={onExit}>
          完成
        </button>
      </div>

      <div className="wb-selection-mobile" role="toolbar" aria-label="批量操作">
        <CheckBox state={state} label="全选本页" onClick={onToggleAll} />
        <span className="wb-selection-mobile__count" aria-live="polite">
          <b>已选 {selectedCount}</b>
          <span> / {cards.length}</span>
        </span>
        <button
          type="button"
          className="wb-selbtn wb-selbtn--danger"
          disabled={busy || selectedCount === 0}
          onClick={onTrash}
        >
          <IconTrash size={16} />
          <span>删除</span>
        </button>
        <button
          type="button"
          className="wb-selbtn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => (menuOpen ? closeMenu() : openMenu(event.currentTarget))}
        >
          <IconMore size={16} />
          <span>更多</span>
        </button>
      </div>

      {menuOpen && !compact && placement ? (
        <div
          ref={menuRef}
          className="wb-board-menu wb-batch-menu"
          role="menu"
          aria-label="更多操作"
          style={{ left: placement.left, top: placement.top, maxHeight: placement.maxHeight }}
          onKeyDown={onMenuKeyDown}
        >
          <div className="wb-board-menu__head">
            <span className="wb-board-menu__title">更多操作</span>
          </div>
          {items.map((item) => renderMenuItem(item, false))}
        </div>
      ) : null}

      {menuOpen && compact ? (
        <div
          className="wb-sheet-layer"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeMenu();
          }}
        >
          <div
            ref={menuRef}
            className="wb-sheet wb-board-sheet wb-batch-sheet"
            role="menu"
            aria-label="更多操作"
            onKeyDown={onMenuKeyDown}
          >
            <span className="wb-sheet__grip" aria-hidden />
            <div className="wb-board-sheet__head">
              <span className="wb-board-menu__title">更多操作</span>
            </div>
            {items.map((item) => renderMenuItem(item, true))}
          </div>
        </div>
      ) : null}
    </>
  );
}
