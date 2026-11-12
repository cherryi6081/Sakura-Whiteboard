import { useEffect, useState } from "react";
import { can, type SpaceRole, type SpaceSummary } from "@whiteboard/shared";
import {
  createSpaceInvite,
  fetchSpaceMembers,
  revokeSpaceInvite,
  type SpaceInvite,
  type SpaceMember,
} from "./spaceApi";

/**
 * 空间设置（设计稿 §07 最小版）。
 *
 * 本期只做：成员列表 + 邀请链接（7 天、可撤销）。
 * 角色修改 / 移除成员 / 转让空间是 P1，这里的按钮不出现，也不留假入口。
 */

const ROLE_TEXT: Record<SpaceRole, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读",
};

type Props = {
  space: SpaceSummary;
  onClose: () => void;
};

export function SpaceSettings({ space, onClose }: Props) {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("viewer");
  const [invite, setInvite] = useState<SpaceInvite | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const owner = can(space.role, "invite");

  useEffect(() => {
    let alive = true;
    void fetchSpaceMembers(space.id).then((result) => {
      if (!alive) return;
      setLoading(false);
      if (!result.ok) {
        setError("成员列表没加载出来，再试一次。");
        return;
      }
      setMembers(result.data.members);
    });
    return () => {
      alive = false;
    };
  }, [space.id]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const generate = async () => {
    if (inviteBusy) return;
    setInviteBusy(true);
    setError(null);
    const result = await createSpaceInvite(space.id, inviteRole);
    setInviteBusy(false);
    if (!result.ok) {
      setError("邀请链接没生成成功，再试一次。");
      return;
    }
    setInvite(result.data);
    await copy(inviteUrl(result.data.url));
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("复制失败，请手动选中链接复制。");
    }
  };

  const revoke = async () => {
    if (!invite) return;
    const result = await revokeSpaceInvite(space.id, invite.token);
    if (!result.ok) {
      setError("撤销没成功，再试一次。");
      return;
    }
    setInvite(null);
  };

  return (
    <div
      className="wb-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="wb-dialog wb-space-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-space-settings-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="wb-space-settings__head">
          <div>
            <p className="wb-space-settings__eyebrow">空间设置</p>
            <h2 className="wb-dialog__title" id="wb-space-settings-title">
              {space.name}
            </h2>
            <p className="wb-caption">
              {space.memberCount} 位成员 · 你的角色：{ROLE_TEXT[space.role]}
            </p>
          </div>
          <button className="wb-btn wb-btn--ghost" type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        <section className="wb-space-settings__section" aria-labelledby="wb-space-members-title">
          <h3 className="wb-space-settings__subtitle" id="wb-space-members-title">
            成员
          </h3>
          {loading ? (
            <p className="wb-caption">正在加载成员…</p>
          ) : (
            <ul className="wb-space-members">
              {members.map((member) => (
                <li className="wb-space-members__row" key={member.userId}>
                  <span
                    className="wb-space-members__avatar"
                    style={{ background: member.color }}
                    aria-hidden
                  >
                    {member.displayName.slice(0, 1)}
                  </span>
                  <span className="wb-space-members__text">
                    <span className="wb-space-members__name">{member.displayName}</span>
                    <span className="wb-space-members__meta">{member.email ?? "未填写邮箱"}</span>
                  </span>
                  <span className={`wb-space-role wb-space-role--${member.role}`}>
                    {ROLE_TEXT[member.role]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="wb-space-settings__section" aria-labelledby="wb-space-invite-title">
          <h3 className="wb-space-settings__subtitle" id="wb-space-invite-title">
            邀请成员
          </h3>
          {owner ? (
            <>
              <div className="wb-space-invite">
                <label className="wb-field wb-space-invite__role">
                  <span className="wb-field__label">加入后角色</span>
                  <select
                    className="wb-input"
                    value={inviteRole}
                    onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}
                  >
                    <option value="viewer">只读</option>
                    <option value="editor">编辑者</option>
                  </select>
                </label>
                <button className="wb-btn wb-btn--primary" type="button" onClick={() => void generate()} disabled={inviteBusy}>
                  {inviteBusy ? "生成中…" : invite ? "重新生成" : "生成并复制链接"}
                </button>
              </div>
              {invite ? (
                <div className="wb-space-invite__link">
                  <code>{window.location.origin + invite.url}</code>
                  {copied ? (
                    <span className="wb-space-invite__copied" role="status">
                      已复制
                    </span>
                  ) : (
                    <button
                      className="wb-btn wb-btn--ghost"
                      type="button"
                      onClick={() => void copy(window.location.origin + invite.url)}
                    >
                      复制
                    </button>
                  )}
                  <button className="wb-btn wb-btn--ghost" type="button" onClick={() => void revoke()}>
                    撤销
                  </button>
                </div>
              ) : null}
              <p className="wb-caption">
                链接 7 天后失效；拿到链接的人登录后即可加入。撤销后立即无法加入。
              </p>
            </>
          ) : (
            <p className="wb-caption">只有所有者能邀请成员。需要编辑权限可以联系所有者。</p>
          )}
        </section>

        <section className="wb-space-settings__section wb-space-settings__section--last">
          <h3 className="wb-space-settings__subtitle">空间与权限</h3>
          <p className="wb-caption">
            所有者管理空间与邀请；编辑者可新建、编辑与置顶；只读成员只能浏览、搜索并复制到个人空间。
          </p>
        </section>

        {error ? (
          <p className="wb-rename__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** `/join/<token>` 拼成可直接分享的绝对地址；Base URL 由浏览器决定，不硬编码域名。 */
export function inviteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${window.location.origin}${path.startsWith("/") ? "" : "/"}${path}`;
}
