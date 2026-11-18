import { useCallback, useEffect, useState } from "react";
import { request } from "../auth/authApi";
import { IconAlert, IconCheck, IconCopy, IconShare } from "../ui/icons";
import { DialogClose } from "../ui/DialogClose";
import { ListSelect } from "../ui/ListSelect";
import {
  decideEditRequest,
  fetchEditRequests,
  type EditRequestSummary,
} from "./accessRequestApi";

/**
 * 分享抽屉（视觉方案 §4.3）：只读 / 可编辑链接、有效期、创建、复制、吊销。
 * 接口为 M5-2 已实现的 `/api/boards/:id/share-links`；这里只做表现层，不改服务端权限逻辑。
 * 只读（viewer）进入时不给邀请入口，只允许复制当前页链接。
 * 抽屉内的有效期下拉与空间设置「加入后角色」共用 `ListSelect`，按钮统一 32 高胶囊口径。
 */

/** 有效期取值与请求体 `expiresInDays` 保持一致（"forever" → null） */
const EXPIRY_OPTIONS = [
  { value: "7", title: "7 天（默认）" },
  { value: "30", title: "30 天" },
  { value: "forever", title: "永久" },
] as const;

type ShareExpiry = (typeof EXPIRY_OPTIONS)[number]["value"];

type ShareLink = {
  id: string;
  permission: "read" | "edit";
  expiresAt: string | null;
  revokedAt: string | null;
  useCount: number;
  createdAt: string;
  createdByType: string;
  active: boolean;
};

type CreateResult = {
  id: string;
  permission: "read" | "edit";
  token: string;
  url: string;
  expiresAt: string | null;
  createdAt: string;
};

export function ShareDrawer({
  boardId,
  readonly,
  role,
  onClose,
  onPendingCountChange,
}: {
  boardId: string;
  readonly: boolean;
  /** 当前协作角色；只有 owner 能看到并处理编辑申请 */
  role: string;
  onClose: () => void;
  /** 待处理申请数变化时通知外壳（顶栏分享按钮的角标） */
  onPendingCountChange?: (count: number) => void;
}) {
  const [permission, setPermission] = useState<"read" | "edit">("read");
  const [expiry, setExpiry] = useState<ShareExpiry>("7");
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 编辑权限申请：仅 owner 加载；pending 列表就是待处理队列 */
  const [requests, setRequests] = useState<EditRequestSummary[] | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const isOwner = role === "owner" && !readonly;

  const load = useCallback(async () => {
    const res = await request<{ links: ShareLink[] }>(`/api/boards/${boardId}/share-links`);
    if (!res.ok) {
      setError("链接列表没取到，请重试。");
      setLinks([]);
      return;
    }
    setError(null);
    setLinks(res.data.links);
  }, [boardId]);

  const loadRequests = useCallback(async () => {
    if (!isOwner) return;
    const res = await fetchEditRequests(boardId);
    if (!res.ok) {
      setRequests([]);
      return;
    }
    setRequests(res.data.requests);
    onPendingCountChange?.(res.data.requests.length);
  }, [boardId, isOwner, onPendingCountChange]);

  useEffect(() => {
    if (readonly) return;
    void load();
    void loadRequests();
  }, [load, loadRequests, readonly]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const expiresInDays = expiry === "forever" ? null : Number(expiry);
    const res = await request<CreateResult>(`/api/boards/${boardId}/share-links`, {
      method: "POST",
      body: JSON.stringify({ permission, expiresInDays }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 429 ? "创建太频繁，稍后再试。" : `没创建成功（${res.code}）。`);
      return;
    }
    setCreated(res.data);
    setCopied(false);
    void load();
  };

  const revoke = async (linkId: string) => {
    const res = await request<null>(`/api/boards/${boardId}/share-links/${linkId}`, { method: "DELETE" });
    setConfirming(null);
    if (!res.ok) {
      setError(`吊销失败（${res.code}）。`);
      return;
    }
    if (created?.id === linkId) setCreated(null);
    void load();
  };

  /** 改权限：read ↔ edit 互换；服务端会同步清掉该 token 的权限缓存 */
  const changePermission = async (link: ShareLink) => {
    const permission = link.permission === "read" ? "edit" : "read";
    const res = await request<{ permission: string }>(`/api/boards/${boardId}/share-links/${link.id}`, {
      method: "PATCH",
      body: JSON.stringify({ permission }),
    });
    if (!res.ok) {
      setError(`改权限失败（${res.code}）。`);
      return;
    }
    void load();
  };

  /** 批准 / 拒绝编辑申请：批准后申请人立即获得 board_members(editor) */
  const decide = async (requestId: string, status: "approved" | "rejected") => {
    if (deciding) return;
    setDeciding(requestId);
    setError(null);
    const res = await decideEditRequest(boardId, requestId, status);
    setDeciding(null);
    if (!res.ok) {
      setError(
        res.code === "SPACE_ROLE_GOVERNS"
          ? "申请人是空间只读成员，请到空间设置里调整其角色。"
          : `处理失败（${res.code}）。`,
      );
      return;
    }
    await loadRequests();
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("浏览器不允许自动复制，请手动选中链接。");
    }
  };

  return (
    <>
      <div className="wb-scrim" onClick={onClose} />
      <aside className="wb-drawer" role="dialog" aria-modal="true" aria-label="分享这块白板">
        <div className="wb-drawer__head">
          <div>
            <h2 className="wb-title">分享这块白板</h2>
            <p className="wb-caption" style={{ marginTop: "var(--space-1)" }}>
              {readonly ? "你以只读身份进入，无法邀请他人。" : "拿到链接的人可以进入这块板。"}
            </p>
          </div>
          <DialogClose onClose={onClose} />
        </div>

        {readonly ? (
          <div className="wb-inline-note wb-inline-note--warning">
            <IconAlert />
            <span>只读身份只能查看与复制当前链接，不能创建新的邀请链接。</span>
          </div>
        ) : (
          <>
            <div className="wb-field">
              <span className="wb-field__label">权限</span>
              <div className="wb-segmented" role="group" aria-label="链接权限">
                <button
                  type="button"
                  className="wb-segmented__item"
                  aria-pressed={permission === "read"}
                  onClick={() => setPermission("read")}
                >
                  只读
                </button>
                <button
                  type="button"
                  className="wb-segmented__item"
                  aria-pressed={permission === "edit"}
                  onClick={() => setPermission("edit")}
                >
                  可编辑
                </button>
              </div>
            </div>

            <div className="wb-field">
              <span className="wb-field__label" id="wb-share-expiry-label">
                有效期
              </span>
              <ListSelect
                value={expiry}
                options={EXPIRY_OPTIONS}
                onChange={setExpiry}
                labelledBy="wb-share-expiry-label"
                testId="share-expiry-trigger"
                fullWidth
                compact
              />
            </div>

            <button
              className="wb-btn wb-btn--primary wb-btn--pill wb-btn--full"
              type="button"
              onClick={() => void create()}
              disabled={busy}
            >
              {busy ? <span className="wb-spinner" aria-hidden /> : <IconShare size={14} />}
              {busy ? "正在创建…" : "创建链接"}
            </button>

            <p className="wb-caption" style={{ color: "var(--text-secondary)" }}>
              链接可见者即可进入，请谨慎转发。
            </p>
          </>
        )}

        {error ? (
          <div className="wb-inline-note wb-inline-note--danger" role="alert">
            <IconAlert />
            <span>{error}</span>
            {!readonly ? (
              <>
                <span className="wb-banner__spacer" />
                <button className="wb-btn wb-btn--ghost wb-btn--pill wb-btn--danger-text" type="button" onClick={() => void load()}>
                  重试
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {created ? (
          <div className="wb-field">
            <span className="wb-field__label">新链接（只显示这一次）</span>
            <div className="wb-linkbox">
              <span className="wb-linkbox__value" data-testid="share-link-value">
                {window.location.origin + created.url}
              </span>
              <button
                className="wb-btn wb-btn--ghost wb-btn--pill"
                type="button"
                onClick={() => void copy(window.location.origin + created.url)}
              >
                <IconCopy />
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
        ) : null}

        {isOwner ? (
          <div>
            <h3 className="wb-subtitle" style={{ fontSize: "var(--text-body)" }}>
              编辑申请
              {requests && requests.length > 0 ? (
                <span className="wb-badge wb-badge--role" style={{ marginLeft: "var(--space-2)" }}>
                  {requests.length} 待处理
                </span>
              ) : null}
            </h3>
            {requests === null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <div className="wb-skeleton" style={{ height: 48 }} />
              </div>
            ) : requests.length === 0 ? (
              <p className="wb-caption" style={{ marginTop: "var(--space-2)" }}>
                暂无待处理的编辑申请。
              </p>
            ) : (
              <div style={{ marginTop: "var(--space-2)" }} data-testid="edit-request-list">
                {requests.map((item) => (
                  <div key={item.id} className="wb-share-row" data-testid="edit-request-row" data-request-id={item.id}>
                    {item.avatarUrl ? (
                      <img
                        src={item.avatarUrl}
                        alt=""
                        style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover" }}
                      />
                    ) : (
                      <span className="wb-badge wb-badge--neutral" aria-hidden>
                        {item.displayName.slice(0, 1)}
                      </span>
                    )}
                    <div className="wb-share-row__meta">
                      <span className="wb-share-row__time">{item.displayName}</span>
                      <span className="wb-caption" style={{ display: "block" }}>
                        {item.note ? item.note : "希望获得编辑权限"}
                      </span>
                    </div>
                    <button
                      className="wb-btn wb-btn--ghost wb-btn--pill"
                      type="button"
                      data-testid="edit-request-approve"
                      disabled={deciding === item.id}
                      onClick={() => void decide(item.id, "approved")}
                    >
                      <IconCheck />
                      批准
                    </button>
                    <button
                      className="wb-btn wb-btn--ghost wb-btn--pill wb-btn--danger-text"
                      type="button"
                      data-testid="edit-request-reject"
                      disabled={deciding === item.id}
                      onClick={() => void decide(item.id, "rejected")}
                    >
                      拒绝
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {!readonly ? (
          <div>
            <h3 className="wb-subtitle" style={{ fontSize: "var(--text-body)" }}>
              已有链接
            </h3>
            {links === null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <div className="wb-skeleton" style={{ height: 48 }} />
                <div className="wb-skeleton" style={{ height: 48 }} />
                <div className="wb-skeleton" style={{ height: 48 }} />
              </div>
            ) : links.length === 0 ? (
              <p className="wb-caption" style={{ marginTop: "var(--space-2)" }}>
                还没有链接。
              </p>
            ) : (
              <div style={{ marginTop: "var(--space-2)" }}>
                {links.map((link) => (
                  <div
                    key={link.id}
                    className={`wb-share-row${link.revokedAt ? " wb-share-row--revoked" : ""}`}
                    data-testid="share-link-row"
                  >
                    <span className={`wb-badge ${link.permission === "read" ? "wb-badge--neutral" : "wb-badge--role"}`}>
                      {link.permission === "read" ? "只读" : "可编辑"}
                    </span>
                    <div className="wb-share-row__meta">
                      <span className="wb-share-row__time wb-nums">
                        {link.revokedAt ? "已吊销" : link.expiresAt ? `${formatDay(link.expiresAt)} 到期` : "永久有效"} · 使用 {link.useCount} 次
                      </span>
                    </div>
                    {link.revokedAt ? null : confirming === link.id ? (
                      <button
                        className="wb-btn wb-btn--ghost wb-btn--pill wb-btn--danger-text"
                        type="button"
                        onClick={() => void revoke(link.id)}
                      >
                        确认吊销？
                      </button>
                    ) : (
                      <>
                        <button
                          className="wb-btn wb-btn--ghost wb-btn--pill"
                          type="button"
                          data-testid="share-link-permission-toggle"
                          onClick={() => void changePermission(link)}
                        >
                          改为{link.permission === "read" ? "可编辑" : "只读"}
                        </button>
                        <button
                          className="wb-btn wb-btn--ghost wb-btn--pill wb-btn--danger-text"
                          type="button"
                          onClick={() => setConfirming(link.id)}
                        >
                          吊销
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </aside>
    </>
  );
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
