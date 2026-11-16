import { useEffect, useId, useRef, useState } from "react";

/**
 * 自绘下拉（listbox）：空间设置「加入后角色」与分享抽屉「有效期」共用同一套。
 *
 * 焦点始终留在触发器上：↑↓ 移动高亮、Enter/Space 选中、Esc 关闭并归还焦点；
 * 点外部关闭。菜单打开时 Esc 只关菜单，不再冒泡给外层弹窗/抽屉的 Esc 关闭。
 * 外观全部走 `.wb-role-select*`（pages.css），日间/夜间随主题 token 自动切换。
 */

export type ListSelectOption<T extends string> = {
  value: T;
  title: string;
  /** 第二行说明；不传就是单行选项 */
  description?: string;
};

type ListSelectProps<T extends string> = {
  value: T;
  options: readonly ListSelectOption<T>[];
  onChange: (value: T) => void;
  /** 外部 label 的 id，作为触发器与列表的可访问名称 */
  labelledBy: string;
  disabled?: boolean;
  testId?: string;
  /** 占满所在列（抽屉里的表单行） */
  fullWidth?: boolean;
  /** 单行选项用更矮的行高，避免三项短文案撑出过高的菜单 */
  compact?: boolean;
};

export function ListSelect<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  disabled = false,
  testId,
  fullWidth = false,
  compact = false,
}: ListSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const openMenu = () => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    onChange(options[index].value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`wb-role-select${open ? " is-open" : ""}${fullWidth ? " wb-role-select--full" : ""}${
        compact ? " wb-role-select--compact" : ""
      }`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Escape") {
          if (!open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) {
            openMenu();
            return;
          }
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setActiveIndex((current) => (current + delta + options.length) % options.length);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!open) {
            openMenu();
            return;
          }
          choose(activeIndex);
        }
      }}
    >
      <button
        ref={buttonRef}
        className="wb-role-select__btn"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy}
        data-testid={testId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span>{selected.title}</span>
        <span className="wb-role-select__caret" aria-hidden />
      </button>
      {open ? (
        <ul className="wb-role-select__menu" role="listbox" id={listId} aria-labelledby={labelledBy}>
          {options.map((option, index) => (
            <li
              key={option.value}
              className={`wb-role-select__option${option.value === value ? " is-selected" : ""}${
                index === activeIndex ? " is-active" : ""
              }`}
              role="option"
              aria-selected={option.value === value}
              data-value={option.value}
              onPointerDown={(event) => event.preventDefault()}
              onPointerEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="wb-role-select__main">
                <span className="wb-role-select__title">{option.title}</span>
                {option.description ? <span className="wb-role-select__desc">{option.description}</span> : null}
              </span>
              <span className="wb-role-select__check" aria-hidden>
                ✓
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
