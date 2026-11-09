import { useEffect, useState } from "react";
import { claimGuestBoards, fetchClaimPreview, type ClaimPreview, type ClaimResult } from "./authApi";
import { IconAlert, IconClose } from "../ui/icons";

/**
 * 注册/登录后的认领对话框（M5，开发文档 §8.6.3；视觉方案 §4.4）。
 *
 * - 默认**全选**，可逐块取消；
 * - 「转移」失败（409：有板已被其他账号认领）时**整笔回滚**，保持打开并支持重新拉预览；
 * - 「稍后再说」保留 guest 归属，不删 `wb_gid`；
 * - 「不再提示」只写前端 7 天标记，不改服务端状态。
 */

const SNOOZE_KEY = "wb:claimSnoozeUntil";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function claimSnoozed(): boolean {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

export function snoozeClaimPrompt(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    /* localStorage 不可用时仅本次生效 */
  }
}

export function ClaimDialog({
  preview,
  onClose,
  onClaimed,
}: {
  preview: ClaimPreview;
  onClose: () => void;
  onClaimed: (result: ClaimResult) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preview.boards.map((board) => board.id)));
  const [current, setCurrent] = useState(preview);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const refresh = async () => {
    setError(null);
    setRefreshing(true);
    const res = await fetchClaimPreview();
    setRefreshing(false);
    if (res.ok) {
      setCurrent(res.data);
      setSelected(new Set(res.data.boards.map((board) => board.id)));
    }
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    const res = await claimGuestBoards([...selected]);
    setBusy(false);
    if (res.ok) {
      onClaimed(res.data);
      return;
    }
    setError(
      res.code === "CLAIM_CONFLICT"
        ? "有临时板已被其他账号认领，本次一块都没有转移。请重新拉取预览后重试。"
        : `转移失败（${res.code}），没有产生部分转移。`,
    );
  };

  return (
    <div className="wb-overlay" data-testid="claim-dialog" role="dialog" aria-modal="true" aria-labelledby="claim-title">
      <div className="wb-dialog">
        {current.count === 0 ? (
          <>
            <h2 className="wb-title" id="claim-title">
              当前没有可转移的临时白板
            </h2>
            <p className="wb-caption">你可以继续使用账号里的白板。</p>
            <div className="wb-dialog__actions wb-dialog__actions--end">
              <button data-testid="claim-close" className="wb-btn wb-btn--primary" type="button" onClick={onClose}>
                知道了
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="wb-dialog__head">
              <div style={{ flex: 1 }}>
                <h2 className="wb-title" id="claim-title">
                  把这 <span className="wb-nums">{current.count}</span> 块临时白板转到你的账号？
                </h2>
                <p className="wb-caption" style={{ marginTop: "var(--space-2)" }}>
                  这些板目前只存在这台浏览器，换设备或清缓存会丢失。转移后可在任何设备登录查看。
                </p>
              </div>
              <button className="wb-drawer__close" type="button" onClick={onClose} aria-label="关闭" disabled={busy}>
                <IconClose size={16} />
              </button>
            </div>

            <ul
              data-testid="claim-board-list"
              className="wb-claim-list"
              style={busy ? { opacity: 0.6, pointerEvents: "none" } : undefined}
            >
              {current.boards.map((board) => (
                <li key={board.id}>
                  <label className="wb-claim-item">
                    <input
                      data-testid="claim-board-checkbox"
                      type="checkbox"
                      checked={selected.has(board.id)}
                      onChange={() => toggle(board.id)}
                      disabled={busy}
                    />
                    <span className="wb-claim-item__title" title={board.title}>
                      {board.title}
                    </span>
                    <time className="wb-claim-item__time wb-nums" dateTime={board.lastEditedAt}>
                      {formatDay(board.lastEditedAt)}
                    </time>
                  </label>
                </li>
              ))}
            </ul>

            {error ? (
              <div className="wb-inline-note wb-inline-note--danger" role="alert">
                <IconAlert />
                <span data-testid="claim-error">{error}</span>
                <span className="wb-banner__spacer" />
                <button
                  type="button"
                  className="wb-btn wb-btn--ghost wb-btn--sm wb-btn--danger-text"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                >
                  {refreshing ? "重新拉取中…" : "重新拉取预览"}
                </button>
              </div>
            ) : null}

            <div className="wb-dialog__actions">
              <button
                data-testid="claim-snooze"
                type="button"
                className="wb-btn wb-btn--ghost wb-btn--sm"
                style={{ color: "var(--text-secondary)" }}
                onClick={() => {
                  snoozeClaimPrompt();
                  onClose();
                }}
                disabled={busy}
              >
                7 天内不再提示
              </button>
              <span className="wb-banner__spacer" />
              <button data-testid="claim-later" type="button" className="wb-btn wb-btn--secondary" onClick={onClose} disabled={busy}>
                稍后再说
              </button>
              <button
                data-testid="claim-submit"
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => void submit()}
                className="wb-btn wb-btn--primary"
              >
                {busy ? <span className="wb-spinner" aria-hidden /> : null}
                {busy ? "正在转入…" : `转到账号（${selected.size}）`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
