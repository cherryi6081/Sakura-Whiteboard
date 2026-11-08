import { useEffect, useState } from "react";
import { claimGuestBoards, fetchClaimPreview, type ClaimPreview, type ClaimResult } from "./authApi";

/**
 * 注册/登录后的认领对话框（M5，开发文档 §8.6.3）。
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
    const res = await fetchClaimPreview();
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
        ? "有临时板已被其他账号认领，本次一块都没有转移。请刷新后重试。"
        : `转移失败（${res.code}），没有产生部分转移`,
    );
  };

  if (current.count === 0) {
    return (
      <Dialog>
        <p style={{ margin: 0, fontSize: 13 }}>当前没有可转移的临时白板。</p>
        <button data-testid="claim-close" type="button" onClick={onClose} style={primaryButtonStyle}>
          知道了
        </button>
      </Dialog>
    );
  }

  return (
    <Dialog>
      <strong style={{ fontSize: 15, color: "#A85C7C" }}>把 {current.count} 块临时白板转到你的账号？</strong>
      <p style={{ margin: 0, fontSize: 12, color: "#6B5A61" }}>
        转移后可在任何设备登录查看；不转移的临时板 30 天无编辑会被清理。
      </p>

      <ul data-testid="claim-board-list" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
        {current.boards.map((board) => (
          <li key={board.id}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                data-testid="claim-board-checkbox"
                type="checkbox"
                checked={selected.has(board.id)}
                onChange={() => toggle(board.id)}
              />
              <span>{board.title}</span>
              <code style={{ fontSize: 11, color: "#9A8A90" }}>{board.id}</code>
            </label>
          </li>
        ))}
      </ul>

      {error ? (
        <div data-testid="claim-error" style={{ fontSize: 12, color: "#B4485F" }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          data-testid="claim-submit"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={submit}
          style={primaryButtonStyle}
        >
          {busy ? "转移中…" : `转移到账号（${selected.size}）`}
        </button>
        <button data-testid="claim-later" type="button" onClick={onClose} style={secondaryButtonStyle}>
          稍后再说
        </button>
        {error ? (
          <button type="button" onClick={refresh} style={secondaryButtonStyle}>
            重新拉取预览
          </button>
        ) : null}
        <button
          data-testid="claim-snooze"
          type="button"
          onClick={() => {
            snoozeClaimPrompt();
            onClose();
          }}
          style={linkButtonStyle}
        >
          不再提示（7 天）
        </button>
      </div>
    </Dialog>
  );
}

function Dialog({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.stopPropagation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      data-testid="claim-dialog"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(58,46,51,.28)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: 380,
          maxWidth: "92vw",
          padding: 20,
          background: "#fff",
          border: "1px solid #EFE4E8",
          borderRadius: 12,
          fontFamily: "system-ui, sans-serif",
          color: "#3A2E33",
        }}
      >
        {children}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "7px 12px",
  fontSize: 13,
  color: "#fff",
  background: "#A85C7C",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "7px 12px",
  fontSize: 13,
  color: "#8E4568",
  background: "#F4E3E9",
  border: "1px solid #E7BFCE",
  borderRadius: 8,
  cursor: "pointer",
};

const linkButtonStyle: React.CSSProperties = {
  alignSelf: "center",
  padding: 0,
  fontSize: 12,
  color: "#9A8A90",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};
