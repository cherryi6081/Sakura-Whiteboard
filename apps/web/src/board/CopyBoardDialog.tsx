import { useCallback, useEffect, useState } from "react";
import type { SpaceSummary } from "@whiteboard/shared";
import { can } from "@whiteboard/shared";
import { fetchSpaces } from "../boards/spaceApi";
import { DialogClose } from "../ui/DialogClose";
import { ListSelect } from "../ui/ListSelect";
import { IconAlert } from "../ui/icons";
import { copyBoardToSpace } from "./copyBoardApi";

/**
 * 「复制到我的空间」弹窗。
 *
 * 目标空间：默认个人空间，也可以选自己可建板的团队空间（owner / editor）。
 * 复制只带画布内容与图片资产；源板的权限、分享链接、成员不会跟过来。
 */

const ROLE_TEXT = { owner: "所有者", editor: "编辑者", viewer: "只读" } as const;

export function CopyBoardDialog({
  boardId,
  shareToken,
  sourceTitle,
  onClose,
}: {
  boardId: string;
  shareToken?: string | null;
  sourceTitle: string;
  onClose: () => void;
}) {
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [spaceId, setSpaceId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSpaces = useCallback(async () => {
    const res = await fetchSpaces();
    if (!res.ok) {
      setSpaces([]);
      return;
    }
    const writable = res.data.spaces.filter((space) => can(space.role, "createBoard"));
    setSpaces(writable);
    const personal = writable.find((space) => space.kind === "personal");
    setSpaceId(personal?.id ?? writable[0]?.id ?? "");
  }, []);

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await copyBoardToSpace(boardId, {
      shareToken,
      title: title.trim() || undefined,
      spaceId: spaceId || undefined,
    });
    if (!res.ok) {
      setBusy(false);
      setError(
        res.status === 401
          ? "登录后才能复制到自己的空间。"
          : res.status === 403
            ? "你在这个空间里没有建板权限。"
            : res.status === 404
              ? "源白板或目标空间已不可用。"
              : res.code === "STORAGE_UNAVAILABLE"
                ? "图片存储暂不可用，请稍后重试。"
                : `复制失败（${res.code}）。`,
      );
      return;
    }
    // 复制成功后直接打开新板；个人空间/团队空间都可从列表再回去
    window.location.href = `/board/${res.data.id}`;
  };

  return (
    <div
      className="wb-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="wb-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-copy-board-title">
        <DialogClose onClose={onClose} disabled={busy} />

        <header>
          <p className="wb-space-settings__eyebrow">复制白板</p>
          <h2 className="wb-dialog__title" id="wb-copy-board-title">
            复制到我的空间
          </h2>
          <p className="wb-caption">
            会复制画布内容与图片；源板的权限、分享链接和成员不会带过来。
          </p>
        </header>

        <div className="wb-field">
          <label className="wb-field__label" htmlFor="wb-copy-title">
            新白板名称
          </label>
          <input
            className="wb-input"
            id="wb-copy-title"
            data-testid="copy-board-title"
            value={title}
            maxLength={80}
            placeholder={`${sourceTitle} 的副本`}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="wb-field">
          <span className="wb-field__label" id="wb-copy-space-label">
            放到
          </span>
          {spaces === null ? (
            <div className="wb-skeleton" style={{ height: 36 }} />
          ) : spaces.length === 0 ? (
            <p className="wb-caption" role="alert">
              没有可写入的空间，请先登录或创建空间。
            </p>
          ) : (
            <ListSelect
              value={spaceId}
              options={spaces.map((space) => ({
                value: space.id,
                title: space.kind === "personal" ? `${space.name}（个人空间）` : space.name,
                description: space.kind === "personal" ? undefined : ROLE_TEXT[space.role],
              }))}
              onChange={setSpaceId}
              labelledBy="wb-copy-space-label"
              testId="copy-board-space"
              fullWidth
              compact
              disabled={busy}
            />
          )}
        </div>

        {error ? (
          <p className="wb-inline-note wb-inline-note--danger" role="alert">
            <IconAlert />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="wb-dialog__actions">
          <button type="button" className="wb-btn wb-btn--ghost wb-btn--pill" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="wb-btn wb-btn--primary wb-btn--pill"
            data-testid="copy-board-confirm"
            disabled={busy || spaces === null || spaces.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "复制中…" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
}
