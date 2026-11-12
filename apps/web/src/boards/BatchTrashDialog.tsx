import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ROLE_LABEL } from "./boardsApi";
import type { SelectableCard } from "./selection";
import { IconLock } from "../ui/icons";

type Props = {
  /** 勾选顺序（视觉顺序），用于列表预览 */
  rows: readonly SelectableCard[];
  targets: readonly SelectableCard[];
  skipped: readonly SelectableCard[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * 批量删除确认（设计稿 boards-bulk-select §05.2）。
 * - 标题说数量，正文说后果，列表说对象，按钮说结果；
 * - 只读 / 非 owner 的卡在列表里标「跳过」，并在下方单独说明；
 * - 全部无权限时退化为说明弹窗，不放危险按钮。
 */
export function BatchTrashDialog({ rows, targets, skipped, busy, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const allBlocked = targets.length === 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onCancel]);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const nodes = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const title = allBlocked
    ? `这 ${rows.length} 块都没有删除权限`
    : targets.length === 1
      ? `将「${targets[0]?.title ?? ""}」移入回收站？`
      : `将 ${targets.length} 块白板移入回收站？`;

  const desc = allBlocked
    ? "只有白板所有者可以移入回收站，协作者和只读白板会保留在原处。"
    : "回收站保留 30 天，期间可随时恢复。协作者会立即失去访问权限。";

  return (
    <div className="wb-overlay wb-batch-confirm">
      <div
        ref={dialogRef}
        className="wb-dialog wb-batch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={trapTab}
      >
        <h2 id={titleId} className="wb-dialog__title">
          {title}
        </h2>
        <p id={descId} className="wb-dialog__desc">
          {desc}
        </p>

        <ul className="wb-batch-dialog__list">
          {rows.slice(0, 3).map((card) => {
            const isSkipped = !targets.some((target) => target.id === card.id);
            return (
              <li key={card.id} className={isSkipped ? "is-skipped" : undefined}>
                <span className="wb-batch-dialog__name">{card.title}</span>
                {isSkipped ? (
                  <span className="wb-batch-dialog__tail">
                    <IconLock size={12} />
                    {ROLE_LABEL[card.role] ?? card.role} · 跳过
                  </span>
                ) : null}
              </li>
            );
          })}
          {rows.length > 3 ? <li className="wb-batch-dialog__more">另有 {rows.length - 3} 块</li> : null}
        </ul>

        {skipped.length > 0 && !allBlocked ? (
          <p className="wb-batch-dialog__note">
            <IconLock size={12} />
            {skipped.length} 块无删除权限的白板不会删除，协作者权限保持不变。
          </p>
        ) : null}

        <div className="wb-dialog__actions">
          <button type="button" className="wb-btn wb-btn--ghost" autoFocus disabled={busy} onClick={onCancel}>
            取消
          </button>
          {allBlocked ? (
            <button type="button" className="wb-btn wb-btn--primary" onClick={onCancel}>
              知道了
            </button>
          ) : (
            <button type="button" className="wb-btn wb-btn--danger" disabled={busy} onClick={onConfirm}>
              {busy ? "处理中…" : "移入回收站"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
