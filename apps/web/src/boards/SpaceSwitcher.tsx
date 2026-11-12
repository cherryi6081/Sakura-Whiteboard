import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SpaceRole, SpaceSummary } from "@whiteboard/shared";
import { createSpace } from "./spaceApi";
import { IconCheck, IconPlus } from "../ui/icons";

/**
 * 空间切换器（设计稿「我的白板 · 团队空间切换」§03/§08）。
 *
 * - 1440 / 1024：顶栏胶囊 + 下拉（360px，最多 5 行可见，超出内部滚动）；
 * - 390：顶栏下独立空间条，点击从底部升起床单（80vh）；
 * - 当前空间用 rose-50 底 + 对勾，不靠加粗或颜色单一信号；
 * - 键盘：↑ ↓ 移动、Enter 切换、Home / End 跳首尾，分组标签不可聚焦。
 */

const ROLE_TEXT: Record<SpaceRole, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读",
};

const MOBILE_QUERY = "(max-width: 639px)";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1) : "空";
}

type Props = {
  spaces: SpaceSummary[];
  currentId: string;
  onSelect: (id: string) => void;
  onCreated: (space: SpaceSummary) => void;
  onOpenSettings: () => void;
};

export function SpaceSwitcher({ spaces, currentId, onSelect, onCreated, onOpenSettings }: Props) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const current = spaces.find((space) => space.id === currentId) ?? spaces[0];
  const teams = useMemo(() => spaces.filter((space) => space.kind === "team"), [spaces]);
  const personal = spaces.find((space) => space.kind === "personal");

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  // 打开期间点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const items = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-space-item]");
      const active = listRef.current?.querySelector<HTMLButtonElement>('[data-space-item][aria-current="true"]');
      (active ?? items?.[0])?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const spaceLabel = (space: SpaceSummary) =>
    space.kind === "personal"
      ? `${space.name} · ${space.boardCount} 块白板`
      : `${space.memberCount} 位成员 · ${ROLE_TEXT[space.role]}`;

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-space-item]") ?? [],
    );
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      list[event.key === "Home" ? 0 : list.length - 1]?.focus({ preventScroll: true });
    }
  };

  const submitCreate = async () => {
    const title = name.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    const result = await createSpace(title);
    setBusy(false);
    if (!result.ok) {
      setError("没建成，再试一次。");
      return;
    }
    setCreateOpen(false);
    setName("");
    setOpen(false);
    onCreated(result.data);
  };

  const renderItem = (space: SpaceSummary) => {
    const active = space.id === current?.id;
    return (
      <button
        key={space.id}
        className={`wb-space-menu__item${active ? " is-active" : ""}`}
        type="button"
        role="menuitemradio"
        aria-checked={active}
        aria-current={active ? "true" : undefined}
        data-space-item={space.id}
        onClick={() => {
          close(false);
          if (!active) onSelect(space.id);
        }}
      >
        <span className={`wb-space-avatar wb-space-avatar--${space.kind}`} aria-hidden>
          {initials(space.name)}
        </span>
        <span className="wb-space-menu__text">
          <span className="wb-space-menu__title">{space.name}</span>
          <span className="wb-space-menu__meta">{spaceLabel(space)}</span>
        </span>
        {active ? <IconCheck size={14} /> : null}
      </button>
    );
  };

  const panel = (
    <div
      className={isMobile ? "wb-space-sheet" : "wb-space-menu"}
      role={isMobile ? "dialog" : "menu"}
      aria-label="切换空间"
      onKeyDown={onListKeyDown}
    >
      {isMobile ? (
        <>
          <div className="wb-space-sheet__head">
            <span className="wb-space-sheet__title">切换空间</span>
            <span className="wb-space-sheet__current">
              当前：{current?.name} · {current ? ROLE_TEXT[current.role] : ""}
            </span>
          </div>
          <button className="wb-space-sheet__done" type="button" onClick={() => close()}>
            完成
          </button>
        </>
      ) : null}

      <div className="wb-space-menu__scroll" ref={listRef}>
        {personal ? (
          <div className="wb-space-menu__group">
            <span className="wb-space-menu__label">个人空间</span>
            {renderItem(personal)}
          </div>
        ) : null}

        <div className="wb-space-menu__group">
          <span className="wb-space-menu__label">
            团队空间
            <button
              className="wb-space-menu__new"
              type="button"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              <IconPlus size={12} /> 新建
            </button>
          </span>
          {teams.length > 0 ? (
            teams.map(renderItem)
          ) : (
            <button
              className="wb-space-menu__empty"
              type="button"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              还没有团队空间 · 新建
            </button>
          )}
        </div>
      </div>

      <div className="wb-space-menu__sep" role="separator" />
      <div className="wb-space-menu__foot">
        <button
          className="wb-space-menu__footlink"
          type="button"
          onClick={() => {
            close(false);
            onOpenSettings();
          }}
        >
          空间设置
        </button>
        <span className="wb-space-menu__footnote">空间与权限说明</span>
      </div>
    </div>
  );

  return (
    <div className="wb-space" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`wb-space-pill${isMobile ? " wb-space-pill--mobile" : ""}`}
        type="button"
        aria-haspopup={isMobile ? "dialog" : "menu"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="space-switcher"
      >
        <span className={`wb-space-avatar wb-space-avatar--${current?.kind ?? "personal"}`} aria-hidden>
          {initials(current?.name ?? "")}
        </span>
        <span className="wb-space-pill__text">
          <span className="wb-space-pill__name">{current?.name ?? "空间"}</span>
          <span className="wb-space-pill__meta">
            {current?.kind === "personal"
              ? "个人空间"
              : `团队空间 · ${current ? ROLE_TEXT[current.role] : ""}`}
          </span>
        </span>
        <span className="wb-space-pill__chevron" aria-hidden />
      </button>

      {open ? (
        isMobile ? (
          <div
            className="wb-sheet-layer"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            {panel}
          </div>
        ) : (
          panel
        )
      ) : null}

      {createOpen ? (
        <div
          className="wb-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setCreateOpen(false);
              setError(null);
            }
          }}
        >
          <form
            className="wb-space-create"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-space-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setCreateOpen(false);
                setError(null);
              }
            }}
          >
            <h2 className="wb-dialog__title" id="wb-space-create-title">
              新建团队空间
            </h2>
            <p className="wb-caption">创建后可邀请成员加入，白板会跟着空间走。</p>
            <label className="wb-field">
              <span className="wb-field__label">空间名称</span>
              <input
                className="wb-input"
                value={name}
                maxLength={40}
                autoFocus
                onChange={(event) => {
                  setName(event.target.value);
                  if (error) setError(null);
                }}
                data-testid="space-name-input"
              />
            </label>
            {error ? (
              <p className="wb-rename__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="wb-dialog__actions">
              <button
                className="wb-btn wb-btn--ghost"
                type="button"
                onClick={() => {
                  setCreateOpen(false);
                  setError(null);
                }}
              >
                取消
              </button>
              <button className="wb-btn wb-btn--primary" type="submit" disabled={busy || !name.trim()}>
                {busy ? "创建中…" : "创建"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
