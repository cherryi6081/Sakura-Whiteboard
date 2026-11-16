import { useCallback, useEffect, useState } from "react";
import { sortBoards } from "../boards/boardList";
import { fetchAllBoards, type BoardListItem } from "../boards/boardsApi";
import { fetchSnapshot } from "../collab/boardApi";
import { DialogClose } from "../ui/DialogClose";
import { IconAlert, IconArrowRight, IconBoard } from "../ui/icons";

/**
 * 云端载入（与库主菜单的「打开…」并列）：
 * - 列出当前空间里还在使用的白板（回收站/归档不在列表接口里）；
 * - 选中一块后先做覆盖确认，再拉整板快照替换当前画布；
 * - 游客没有服务端列表，入口本身就不渲染，这里不需要再处理游客分支。
 */
export function CloudLoadDialog({
  boardId,
  spaceId,
  onClose,
  onLoaded,
}: {
  boardId: string;
  /** 团队空间 id；个人空间为 undefined，由接口缺省处理 */
  spaceId?: string;
  onClose: () => void;
  onLoaded: (title: string, elements: readonly Record<string, unknown>[]) => void;
}) {
  const [boards, setBoards] = useState<BoardListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BoardListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setListError(null);
    setBoards(null);
    const res = await fetchAllBoards(spaceId);
    if (!res.ok) {
      setBoards([]);
      setListError(res.status === 401 ? "登录后才能读取云端白板。" : "白板列表没取到，请重试。");
      return;
    }
    // 当前板不能作为来源（自己覆盖自己没有意义），其余按置顶/最近编辑排
    setBoards(sortBoards(res.data.boards.filter((item) => item.id !== boardId)));
  }, [boardId, spaceId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const confirmLoad = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setLoadError(null);
    const snapshot = await fetchSnapshot(selected.id);
    if (!snapshot.ok) {
      setBusy(false);
      setLoadError(
        snapshot.status === 404
          ? "这块白板已不可用（可能被删除或你没有权限）。"
          : `载入失败（${snapshot.code}），请稍后重试。`,
      );
      return;
    }
    onLoaded(selected.title, snapshot.data.elements);
  };

  return (
    <div
      className="wb-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="wb-dialog wb-cloud-load"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-cloud-load-title"
      >
        <DialogClose onClose={onClose} disabled={busy} />

        <header className="wb-cloud-load__head">
          <p className="wb-space-settings__eyebrow">云端载入</p>
          <h2 className="wb-dialog__title" id="wb-cloud-load-title">
            {selected ? "覆盖当前画布？" : "从当前空间载入"}
          </h2>
          <p className="wb-caption">
            {selected
              ? "载入后当前画布会被这块白板的内容替换。"
              : "当前空间里还在使用的白板，按置顶与最近编辑排序。"}
          </p>
        </header>

        {selected ? (
          <div className="wb-cloud-load__confirm">
            <div className="wb-inline-note wb-inline-note--warning">
              <IconAlert />
              <span>
                载入「{selected.title}」会覆盖当前画布内容；如果画布上已有内容或协作者正在编辑，请先确认。
              </span>
            </div>
            {loadError ? (
              <p className="wb-inline-note wb-inline-note--danger" role="alert">
                <IconAlert />
                <span>{loadError}</span>
              </p>
            ) : null}
            <div className="wb-dialog__actions">
              <button
                type="button"
                className="wb-btn wb-btn--ghost wb-btn--pill"
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  setLoadError(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="wb-btn wb-btn--primary wb-btn--pill"
                data-testid="cloud-load-confirm"
                disabled={busy}
                onClick={() => void confirmLoad()}
              >
                {busy ? "载入中…" : "覆盖载入"}
              </button>
            </div>
          </div>
        ) : (
          <div className="wb-cloud-load__body">
            {listError ? (
              <div className="wb-cloud-load__state" role="alert">
                <p>{listError}</p>
                <button type="button" className="wb-btn wb-btn--ghost wb-btn--pill" onClick={() => void loadList()}>
                  重试
                </button>
              </div>
            ) : boards === null ? (
              <div className="wb-cloud-load__state" role="status">
                <span className="wb-spinner wb-spinner--dark wb-spinner--sm" aria-hidden />
                <p>正在加载白板…</p>
              </div>
            ) : boards.length === 0 ? (
              <div className="wb-cloud-load__state">
                <p>当前空间还没有其他活跃白板。</p>
              </div>
            ) : (
              <ul className="wb-cloud-load__list">
                {boards.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="wb-cloud-load__row"
                      data-testid="cloud-load-item"
                      data-board-id={item.id}
                      onClick={() => {
                        setSelected(item);
                        setLoadError(null);
                      }}
                    >
                      <span className="wb-cloud-load__icon" aria-hidden>
                        <IconBoard size={16} />
                      </span>
                      <span className="wb-cloud-load__text">
                        <span className="wb-cloud-load__name">{item.title}</span>
                        <span className="wb-cloud-load__meta">
                          {formatRelative(item.lastEditedAt)}
                          {item.ownerName ? ` · ${item.ownerName}` : ""}
                        </span>
                      </span>
                      <span className="wb-cloud-load__arrow" aria-hidden>
                        <IconArrowRight size={14} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "时间未知";
  const diff = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(time);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
