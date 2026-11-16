import { useEffect, useState } from "react";
import { claimGuestBoards, type ClaimPreview, type ClaimResult } from "./authApi";
import { IconAlert } from "../ui/icons";
import { DialogClose } from "../ui/DialogClose";

/**
 * 临时板转入账号（全转，不做容量判定）。
 *
 * - 没有逐块勾选：要么「全部转入」，要么「暂不」；
 * - 登录账号不限白板数量，转入不会因为「空间满」被拒，也不会淘汰/替换已有白板；
 * - 「暂不」不删 `wb_gid`，但这些板在登录状态下不可见，只有退出登录回到游客视图才会再出现。
 */

const ERROR_TEXT: Record<string, string> = {
  GUEST_COOKIE_INVALID: "游客身份已失效，无法确认哪些临时板属于这台浏览器。请退出后以游客身份打开一次，再重新登录转入。",
  UNAUTHENTICATED: "登录状态已失效，请重新登录后再转入。",
};

export function ClaimDialog({
  preview,
  onClose,
  onClaimed,
}: {
  preview: ClaimPreview;
  onClose: () => void;
  onClaimed: (result: ClaimResult) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    const res = await claimGuestBoards();
    setBusy(false);
    if (res.ok) {
      onClaimed(res.data);
      return;
    }
    setError(ERROR_TEXT[res.code] ?? `转入失败（${res.code}），本次没有转移任何白板。`);
  };

  return (
    <div className="wb-overlay" data-testid="claim-dialog" role="dialog" aria-modal="true" aria-labelledby="claim-title">
      <div className="wb-dialog">
        <DialogClose onClose={onClose} disabled={busy} />
        <div className="wb-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="wb-title" id="claim-title">
              这 <span className="wb-nums">{preview.count}</span> 块临时板，要转入当前账号吗？
            </h2>
            <p className="wb-caption" style={{ marginTop: "var(--space-2)" }}>
              临时板目前只存在这台浏览器，换设备或清缓存会丢失。全部转入后可在任何设备登录查看。
            </p>
          </div>
        </div>

        <p className="wb-caption" data-testid="claim-later-hint">
          选择「暂不」后，登录状态下看不到这些临时板，退出登录才会回来。
        </p>

        <p className="wb-caption" data-testid="claim-policy">
          登录账号不限白板数量，全部转入不会替换或删除已有白板。
        </p>

        {error ? (
          <div className="wb-inline-note wb-inline-note--danger" role="alert">
            <IconAlert />
            <span className="wb-inline-note__text" data-testid="claim-error">
              {error}
            </span>
          </div>
        ) : null}

        <div className="wb-dialog__actions">
          <span className="wb-banner__spacer" />
          <button data-testid="claim-later" type="button" className="wb-btn wb-btn--secondary" onClick={onClose} disabled={busy}>
            暂不
          </button>
          <button
            data-testid="claim-submit"
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="wb-btn wb-btn--primary"
          >
            {busy ? <span className="wb-spinner" aria-hidden /> : null}
            {busy ? "正在转入…" : `全部转入（${preview.count}）`}
          </button>
        </div>
      </div>
    </div>
  );
}
