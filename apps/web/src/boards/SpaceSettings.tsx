import { useEffect, useState } from "react";
import { can, type SpaceRole, type SpaceSummary } from "@whiteboard/shared";
import {
  createSpaceInvite,
  dissolveSpace,
  fetchSpaceMembers,
  leaveSpace,
  removeSpaceMember,
  revokeSpaceInvite,
  transferSpaceOwner,
  updateSpaceMemberRole,
  type SpaceInvite,
  type SpaceMember,
} from "./spaceApi";
import { DialogClose } from "../ui/DialogClose";
import { ListSelect } from "../ui/ListSelect";

/**
 * 空间设置（设计稿 §07）。
 *
 * 成员列表与成员管理（所有者可把成员在编辑者/只读之间调整、可移除成员）
 * + 邀请链接（7 天、可撤销）+ 生命周期（退出 / 转让 / 解散）。
 *
 * 权限口径与后端一致：owner 不在行内调整，只能走「转让」；个人空间不提供成员管理。
 */

const ROLE_TEXT: Record<SpaceRole, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读",
};

type Props = {
  space: SpaceSummary;
  onClose: () => void;
  /** 退出成功：父级移除该空间并回到个人空间 */
  onLeft: (space: SpaceSummary) => void;
  /** 解散成功：父级移除该空间、回到个人空间并提示回收站 */
  onDissolved: (space: SpaceSummary) => void;
  /** 转让成功：父级把当前用户角色改为 editor */
  onTransferred: (spaceId: string, newOwnerId: string) => void;
};

type ConfirmKind = "leave" | "dissolve" | "transfer" | "remove-member";

/** 邀请链接的两种角色；取值与后端 createSpaceInvite 保持一致 */
const INVITE_ROLE_OPTIONS = [
  { value: "editor", title: "编辑者", description: "可创建、编辑和删除白板" },
  { value: "viewer", title: "只读", description: "只能查看，不能修改" },
] as const;

type InviteRole = (typeof INVITE_ROLE_OPTIONS)[number]["value"];

function actionErrorText(code: string): string {
  switch (code) {
    case "OWNER_MUST_TRANSFER":
      return "你是所有者，请先把所有权转让给其他成员，再退出空间。";
    case "LAST_OWNER_USE_DISSOLVE":
      return "你是唯一成员，请使用「解散空间」。";
    case "CANNOT_LEAVE_PERSONAL":
      return "个人空间不能退出。";
    case "CANNOT_DELETE_PERSONAL":
      return "个人空间不能解散。";
    case "CANNOT_TRANSFER_PERSONAL":
      return "个人空间不能转让。";
    case "ALREADY_OWNER":
      return "你已经是这个空间的所有者。";
    case "CANNOT_MANAGE_PERSONAL":
      return "个人空间不能管理成员。";
    case "CANNOT_CHANGE_OWNER":
      return "所有者的身份只能通过「转让所有权」变更。";
    case "INVALID_INPUT":
      return "不能对自己执行这个操作，请换个成员。";
    case "FORBIDDEN":
      return "当前角色没有权限执行这个操作。";
    case "NOT_FOUND":
      return "空间或成员已不存在，请刷新后再试。";
    default:
      return "操作没成功，请稍后再试。";
  }
}

export function SpaceSettings({ space, onClose, onLeft, onDissolved, onTransferred }: Props) {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<InviteRole>("viewer");
  const [invite, setInvite] = useState<SpaceInvite | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  /** 成员行内操作：正在提交的成员 id（同一时刻只允许一个） */
  const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SpaceMember | null>(null);
  const [memberNotice, setMemberNotice] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const owner = can(space.role, "invite");
  const isOwner = can(space.role, "transferSpace");
  const isPersonal = space.kind === "personal";
  /** 只有所有者能管理成员；个人空间没有成员管理 */
  const canManageMembers = isOwner && !isPersonal;
  const otherMembers = members.filter((member) => member.role !== "owner");
  const transferTarget = members.find((member) => member.userId === transferTo) ?? null;

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

  // 成员列表到达后默认选中第一位可转让成员，省掉一次「请选择」
  useEffect(() => {
    setTransferTo(
      (current) => current || members.find((member) => member.role !== "owner")?.userId || "",
    );
  }, [members]);

  const openConfirm = (kind: ConfirmKind) => {
    setConfirm(kind);
    setActionError(null);
  };

  const runLeave = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    const result = await leaveSpace(space.id);
    setActionBusy(false);
    if (!result.ok) {
      setActionError(actionErrorText(result.code));
      return;
    }
    setConfirm(null);
    onLeft(space);
  };

  const runDissolve = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    const result = await dissolveSpace(space.id);
    setActionBusy(false);
    if (!result.ok) {
      setActionError(actionErrorText(result.code));
      return;
    }
    setConfirm(null);
    onDissolved(space);
  };

  /** 行内改角色：editor ↔ viewer，就地生效（后端会实时更新该成员连接上的 role） */
  const changeMemberRole = async (member: SpaceMember, role: "editor" | "viewer") => {
    if (memberBusyId || member.role === role) return;
    setMemberBusyId(member.userId);
    setMemberError(null);
    setMemberNotice(null);
    const result = await updateSpaceMemberRole(space.id, member.userId, role);
    setMemberBusyId(null);
    if (!result.ok) {
      setMemberError(actionErrorText(result.code));
      return;
    }
    setMembers((current) =>
      current.map((item) => (item.userId === member.userId ? { ...item, role } : item)),
    );
    setMemberNotice(
      result.data.changed
        ? `已把 ${member.displayName} 的角色改为${ROLE_TEXT[role]}。`
        : `${member.displayName} 已经是${ROLE_TEXT[role]}。`,
    );
  };

  /** 成员行「移除」：先弹二次确认，确认后才真正调用 DELETE */
  const openRemoveMember = (member: SpaceMember) => {
    setRemoveTarget(member);
    setActionError(null);
    setConfirm("remove-member");
  };

  const runRemoveMember = async () => {
    if (actionBusy || !removeTarget) return;
    setActionBusy(true);
    setActionError(null);
    setMemberError(null);
    setMemberNotice(null);
    const target = removeTarget;
    const result = await removeSpaceMember(space.id, target.userId);
    setActionBusy(false);
    if (!result.ok) {
      setActionError(actionErrorText(result.code));
      return;
    }
    setMembers((current) => current.filter((item) => item.userId !== target.userId));
    // 被移除者若占着「转让给」的选中项，交给既有的默认选中逻辑重新挑一位
    setTransferTo((current) => (current === target.userId ? "" : current));
    setConfirm(null);
    setRemoveTarget(null);
    setMemberNotice(
      result.data.boardsKept > 0
        ? `已把 ${target.displayName} 移出空间；其创建的 ${result.data.boardsKept} 个白板保留在空间里。`
        : `已把 ${target.displayName} 移出空间。`,
    );
  };

  const runTransfer = async () => {
    if (actionBusy || !transferTarget) return;
    setActionBusy(true);
    setActionError(null);
    const result = await transferSpaceOwner(space.id, transferTarget.userId);
    setActionBusy(false);
    if (!result.ok) {
      setActionError(actionErrorText(result.code));
      return;
    }
    setMembers((current) =>
      current.map((member) =>
        member.userId === result.data.ownerId
          ? { ...member, role: "owner" as SpaceRole }
          : member.userId === result.data.previousOwnerId
            ? { ...member, role: "editor" as SpaceRole }
            : member,
      ),
    );
    setConfirm(null);
    setActionNotice(`已把所有权转给 ${transferTarget.displayName}，你现在是编辑者，可以退出空间。`);
    onTransferred(space.id, result.data.ownerId);
  };

  return (
    <>
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
        </div>
        <DialogClose onClose={onClose} />

        <section className="wb-space-settings__section" aria-labelledby="wb-space-members-title">
          <h3 className="wb-space-settings__subtitle" id="wb-space-members-title">
            成员
          </h3>
          {loading ? (
            <p className="wb-caption">正在加载成员…</p>
          ) : (
            <ul className="wb-space-members">
              {members.map((member) => {
                // owner 不可在行内降级：只能走「转让所有权」
                const manageable = canManageMembers && member.role !== "owner";
                return (
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
                    {manageable ? (
                      <span className="wb-space-members__actions">
                        <span className="wb-select-wrap">
                          <select
                            className="wb-select wb-space-members__role-select"
                            aria-label={`${member.displayName} 的角色`}
                            value={member.role}
                            disabled={memberBusyId === member.userId}
                            onChange={(event) =>
                              void changeMemberRole(member, event.target.value as "editor" | "viewer")
                            }
                            data-testid={`space-member-role-${member.userId}`}
                          >
                            <option value="editor">编辑者</option>
                            <option value="viewer">只读</option>
                          </select>
                        </span>
                        <button
                          className="wb-btn wb-btn--ghost wb-space-members__remove"
                          type="button"
                          disabled={memberBusyId === member.userId}
                          onClick={() => openRemoveMember(member)}
                          data-testid={`space-member-remove-${member.userId}`}
                        >
                          移除
                        </button>
                      </span>
                    ) : (
                      <span className={`wb-space-role wb-space-role--${member.role}`}>
                        {ROLE_TEXT[member.role]}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {memberNotice ? (
            <p className="wb-space-lifecycle__notice" role="status">
              {memberNotice}
            </p>
          ) : null}
          {memberError ? (
            <p className="wb-rename__error" role="alert">
              {memberError}
            </p>
          ) : null}
        </section>

        <section className="wb-space-settings__section" aria-labelledby="wb-space-invite-title">
          <h3 className="wb-space-settings__subtitle" id="wb-space-invite-title">
            邀请成员
          </h3>
          {owner ? (
            <>
              <div className="wb-space-invite">
                <div className="wb-field wb-space-invite__role">
                  <span className="wb-field__label" id="wb-space-invite-role-label">
                    加入后角色
                  </span>
                  <ListSelect
                    value={inviteRole}
                    options={INVITE_ROLE_OPTIONS}
                    onChange={setInviteRole}
                    labelledBy="wb-space-invite-role-label"
                    disabled={inviteBusy}
                    testId="invite-role-trigger"
                  />
                </div>
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

        <section className="wb-space-settings__section">
          <h3 className="wb-space-settings__subtitle">空间与权限</h3>
          <p className="wb-caption">
            所有者管理空间与邀请；编辑者可新建、编辑与置顶；只读成员只能浏览、搜索并复制到个人空间。
          </p>
        </section>

        <section
          className="wb-space-settings__section wb-space-settings__section--last"
          aria-labelledby="wb-space-lifecycle-title"
        >
          <h3 className="wb-space-settings__subtitle" id="wb-space-lifecycle-title">
            空间生命周期
          </h3>
          {isPersonal ? (
            <p className="wb-caption">个人空间是你的私人空间，不能被退出或解散。</p>
          ) : (
            <>
              {isOwner ? (
                otherMembers.length > 0 ? (
                  <div className="wb-space-transfer">
                    <p className="wb-caption">你是所有者。离开前需要先把所有权转给一位成员。</p>
                    <div className="wb-space-transfer__row">
                      <label className="wb-field">
                        <span className="wb-field__label">转让给</span>
                        <span className="wb-select-wrap">
                          <select
                            className="wb-select wb-select--lg"
                            value={transferTo}
                            onChange={(event) => setTransferTo(event.target.value)}
                            data-testid="space-transfer-target"
                          >
                            <option value="" disabled>
                              选择成员
                            </option>
                            {otherMembers.map((member) => (
                              <option key={member.userId} value={member.userId}>
                                {member.displayName} · {ROLE_TEXT[member.role]}
                              </option>
                            ))}
                          </select>
                        </span>
                      </label>
                      <button
                        className="wb-btn wb-btn--ghost"
                        type="button"
                        disabled={!transferTarget}
                        onClick={() => openConfirm("transfer")}
                        data-testid="space-transfer-open"
                      >
                        转让所有权
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="wb-caption">
                    你是这个空间唯一的成员。退出会解散空间，请使用下方「解散空间」。
                  </p>
                )
              ) : (
                <p className="wb-caption">
                  退出后你将无法访问这个空间；你在空间里创建的白板会保留，其他成员仍可使用。
                </p>
              )}

              <div className="wb-space-danger">
                <p className="wb-space-danger__title">{isOwner ? "解散空间" : "退出空间"}</p>
                <p className="wb-space-danger__desc">
                  {isOwner
                    ? "所有白板会移到你的个人空间并进入回收站，30 天内可恢复；其他成员会立即失去访问权限。"
                    : "空间本身和其中的白板不会受影响。"}
                </p>
                <button
                  className="wb-btn wb-btn--danger-outline"
                  type="button"
                  onClick={() => openConfirm(isOwner ? "dissolve" : "leave")}
                  data-testid={isOwner ? "space-dissolve-open" : "space-leave-open"}
                >
                  {isOwner ? "解散空间" : "退出空间"}
                </button>
              </div>

              {actionNotice ? (
                <p className="wb-space-lifecycle__notice" role="status">
                  {actionNotice}
                </p>
              ) : null}
            </>
          )}
        </section>

        {error ? (
          <p className="wb-rename__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>

    {confirm ? (
      <div
        className="wb-overlay wb-overlay--confirm"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && !actionBusy) setConfirm(null);
        }}
      >
        <div
          className="wb-dialog wb-space-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wb-space-confirm-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !actionBusy) {
              event.preventDefault();
              setConfirm(null);
            }
          }}
        >
          <DialogClose onClose={() => setConfirm(null)} disabled={actionBusy} />
          {confirm === "leave" ? (
            <>
              <h2 className="wb-dialog__title" id="wb-space-confirm-title">
                退出「{space.name}」？
              </h2>
              <p className="wb-dialog__desc">
                退出后你将无法再访问这个空间，也不再收到它的白板更新。你在空间里创建的白板会保留，其他成员仍可继续使用。
              </p>
              <div className="wb-dialog__actions">
                <button
                  className="wb-btn wb-btn--ghost"
                  type="button"
                  onClick={() => setConfirm(null)}
                  disabled={actionBusy}
                >
                  取消
                </button>
                <button
                  className="wb-btn wb-btn--danger"
                  type="button"
                  onClick={() => void runLeave()}
                  disabled={actionBusy}
                  data-testid="space-leave-confirm"
                >
                  {actionBusy ? "退出中…" : "退出空间"}
                </button>
              </div>
            </>
          ) : null}

          {confirm === "dissolve" ? (
            <>
              <h2 className="wb-dialog__title" id="wb-space-confirm-title">
                解散「{space.name}」？
              </h2>
              <p className="wb-dialog__desc">
                空间本身无法恢复。所有白板会移到你的个人空间并进入回收站，30 天内可恢复；其他成员会立即失去访问权限。
              </p>
              <div className="wb-dialog__actions">
                <button
                  className="wb-btn wb-btn--ghost"
                  type="button"
                  autoFocus
                  onClick={() => setConfirm(null)}
                  disabled={actionBusy}
                >
                  取消
                </button>
                <button
                  className="wb-btn wb-btn--danger"
                  type="button"
                  onClick={() => void runDissolve()}
                  disabled={actionBusy}
                  data-testid="space-dissolve-confirm"
                >
                  {actionBusy ? "解散中…" : "确认解散"}
                </button>
              </div>
            </>
          ) : null}

          {confirm === "transfer" ? (
            <>
              <h2 className="wb-dialog__title" id="wb-space-confirm-title">
                转让所有权？
              </h2>
              <p className="wb-dialog__desc">
                转让后 {transferTarget?.displayName ?? "对方"} 将成为空间所有者，你降为编辑者；随后你可以选择退出空间。
              </p>
              <div className="wb-dialog__actions">
                <button
                  className="wb-btn wb-btn--ghost"
                  type="button"
                  onClick={() => setConfirm(null)}
                  disabled={actionBusy}
                >
                  取消
                </button>
                <button
                  className="wb-btn wb-btn--primary"
                  type="button"
                  onClick={() => void runTransfer()}
                  disabled={actionBusy || !transferTarget}
                  data-testid="space-transfer-confirm"
                >
                  {actionBusy ? "转让中…" : "确认转让"}
                </button>
              </div>
            </>
          ) : null}

          {confirm === "remove-member" ? (
            <>
              <h2 className="wb-dialog__title" id="wb-space-confirm-title">
                把 {removeTarget?.displayName ?? "该成员"} 移出「{space.name}」？
              </h2>
              <p className="wb-dialog__desc">
                移出后对方会立即失去这个空间所有白板的访问权限。其创建的白板会保留在空间里，不会迁走或删除；其创建的有效邀请链接会一并失效。
              </p>
              <div className="wb-dialog__actions">
                <button
                  className="wb-btn wb-btn--ghost"
                  type="button"
                  onClick={() => setConfirm(null)}
                  disabled={actionBusy}
                >
                  取消
                </button>
                <button
                  className="wb-btn wb-btn--danger"
                  type="button"
                  onClick={() => void runRemoveMember()}
                  disabled={actionBusy || !removeTarget}
                  data-testid="space-member-remove-confirm"
                >
                  {actionBusy ? "移出中…" : "确认移出"}
                </button>
              </div>
            </>
          ) : null}

          {actionError ? (
            <p className="wb-rename__error" role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
      </div>
    ) : null}
    </>
  );
}

/** `/join/<token>` 拼成可直接分享的绝对地址；Base URL 由浏览器决定，不硬编码域名。 */
export function inviteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${window.location.origin}${path.startsWith("/") ? "" : "/"}${path}`;
}
