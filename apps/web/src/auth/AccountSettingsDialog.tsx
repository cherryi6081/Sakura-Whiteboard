import { useState } from "react";
import { assessPassword } from "@whiteboard/shared";
import {
  changePassword,
  deleteAccount,
  updateProfile,
  type AuthUser,
} from "../auth/authApi";
import { DialogClose } from "../ui/DialogClose";

/**
 * 账号设置（开发文档 §7.1.2）。
 *
 * 三段式：资料（显示名）→ 密码（旧密码校验 + 强度校验，成功后其它会话失效）→
 * 危险区（销号，需当前密码二次确认）。视觉沿用空间设置的面板壳，
 * 不新增一套弹窗样式。
 */

type Props = {
  user: AuthUser;
  onClose: () => void;
  onUserChange: (user: AuthUser) => void;
  /** 销号成功：由调用方做本地会话清理与登出广播 */
  onDeleted: () => void;
};

function passwordMessage(code: string, status: number, message?: string): string {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return "当前密码不正确";
    case "PASSWORD_UNCHANGED":
      return "新密码不能与当前密码相同";
    case "INVALID_INPUT":
      return "新密码不符合要求，请换一个更复杂的密码";
    case "TOO_MANY_ATTEMPTS":
      return "尝试次数过多，请稍后再试";
    case "SPACE_OWNERSHIP_REQUIRED":
      return message ?? "你拥有的团队空间里还有其他成员，请先转让或解散";
    case "NETWORK_ERROR":
    case "TypeError":
      return "网络异常，请稍后重试";
    default:
      return status === 0 ? "网络异常，请稍后重试" : "操作失败，请重试";
  }
}

function profileMessage(code: string, status: number): string {
  if (code === "INVALID_INPUT" || code === "HTTP_400") return "昵称需为 2–24 个字";
  if (code === "NETWORK_ERROR" || status === 0) return "网络异常，请稍后重试";
  return "保存失败，请重试";
}

export function AccountSettingsDialog({ user, onClose, onUserChange, onDeleted }: Props) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [deletePassword, setDeletePassword] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const assessment = newPassword ? assessPassword(newPassword, { email: user.email ?? undefined }) : null;

  const saveProfile = async () => {
    if (profileBusy) return;
    const next = displayName.trim();
    if (next.length < 2 || next.length > 24) {
      setProfileNotice(null);
      setProfileError("昵称需为 2–24 个字");
      return;
    }
    if (next === user.displayName) {
      setProfileNotice("昵称没有变化");
      setProfileError(null);
      return;
    }
    setProfileBusy(true);
    setProfileNotice(null);
    setProfileError(null);
    const result = await updateProfile({ displayName: next });
    setProfileBusy(false);
    if (!result.ok) {
      setProfileError(profileMessage(result.code, result.status));
      return;
    }
    setDisplayName(result.data.user.displayName);
    onUserChange(result.data.user);
    setProfileNotice("已保存");
  };

  const savePassword = async () => {
    if (passwordBusy) return;
    setPasswordNotice(null);
    setPasswordError(null);
    if (!currentPassword || !newPassword) {
      setPasswordError("请填写当前密码与新密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("两次输入的新密码不一致");
      return;
    }
    if (assessment && assessment.blockers.length > 0) {
      setPasswordError(assessment.blockers[0] ?? "新密码不符合要求");
      return;
    }
    setPasswordBusy(true);
    const result = await changePassword({ currentPassword, newPassword });
    setPasswordBusy(false);
    if (!result.ok) {
      setPasswordError(passwordMessage(result.code, result.status));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordNotice("密码已更新，其它设备上的登录已失效");
  };

  const closeAccount = async () => {
    if (deleteBusy) return;
    setDeleteError(null);
    if (!deletePassword) {
      setDeleteError("请输入当前密码");
      return;
    }
    setDeleteBusy(true);
    const result = await deleteAccount({ currentPassword: deletePassword });
    setDeleteBusy(false);
    if (!result.ok) {
      setDeleteError(passwordMessage(result.code, result.status, result.message));
      return;
    }
    onDeleted();
  };

  return (
    <div
      className="wb-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="wb-dialog wb-space-settings wb-account"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-account-title"
        data-testid="account-dialog"
      >
        <div className="wb-space-settings__head">
          <div>
            <p className="wb-space-settings__eyebrow">账号</p>
            <h2 className="wb-dialog__title" id="wb-account-title">
              账号设置
            </h2>
            <p className="wb-caption">{user.email ?? "未绑定邮箱"}</p>
          </div>
          <DialogClose onClose={onClose} />
        </div>

        <section className="wb-space-settings__section" aria-labelledby="wb-account-profile-title">
          <h3 className="wb-space-settings__subtitle" id="wb-account-profile-title">
            个人资料
          </h3>
          <label className="wb-field">
            <span className="wb-field__label">显示名</span>
            <input
              className="wb-input"
              type="text"
              minLength={2}
              maxLength={24}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              data-testid="account-display-name"
              placeholder="2–24 个字"
            />
          </label>
          <div className="wb-account__actions">
            <button
              className="wb-btn wb-btn--primary"
              type="button"
              onClick={() => void saveProfile()}
              disabled={profileBusy}
              data-testid="account-save-profile"
            >
              {profileBusy ? "保存中…" : "保存资料"}
            </button>
            {profileNotice ? <span className="wb-space-lifecycle__notice">{profileNotice}</span> : null}
            {profileError ? (
              <p className="wb-rename__error" role="alert">
                {profileError}
              </p>
            ) : null}
          </div>
        </section>

        <section className="wb-space-settings__section" aria-labelledby="wb-account-password-title">
          <h3 className="wb-space-settings__subtitle" id="wb-account-password-title">
            修改密码
          </h3>
          <label className="wb-field">
            <span className="wb-field__label">当前密码</span>
            <input
              className="wb-input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              data-testid="account-current-password"
            />
          </label>
          <label className="wb-field">
            <span className="wb-field__label">新密码</span>
            <input
              className="wb-input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              data-testid="account-new-password"
            />
          </label>
          <label className="wb-field">
            <span className="wb-field__label">确认新密码</span>
            <input
              className="wb-input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              data-testid="account-confirm-password"
            />
          </label>
          {assessment && assessment.blockers.length > 0 ? (
            <p className="wb-caption">{assessment.blockers[0]}</p>
          ) : null}
          <div className="wb-account__actions">
            <button
              className="wb-btn wb-btn--primary"
              type="button"
              onClick={() => void savePassword()}
              disabled={passwordBusy}
              data-testid="account-save-password"
            >
              {passwordBusy ? "更新中…" : "更新密码"}
            </button>
            {passwordNotice ? <span className="wb-space-lifecycle__notice">{passwordNotice}</span> : null}
            {passwordError ? (
              <p className="wb-rename__error" role="alert">
                {passwordError}
              </p>
            ) : null}
          </div>
        </section>

        <section className="wb-space-settings__section" aria-labelledby="wb-account-danger-title">
          <h3 className="wb-space-settings__subtitle" id="wb-account-danger-title">
            注销账号
          </h3>
          <div className="wb-space-danger">
            <p className="wb-space-danger__title">注销后不可恢复</p>
            <p className="wb-space-danger__desc">
              你的白板、白板内容、图片与成员关系会被永久删除；你创建过的团队空间需要先转让或解散。
            </p>
            <label className="wb-field">
              <span className="wb-field__label">当前密码</span>
              <input
                className="wb-input"
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                onChange={(event) => setDeletePassword(event.target.value)}
                data-testid="account-delete-password"
              />
            </label>
            <button
              className="wb-btn wb-btn--danger wb-btn--sm"
              type="button"
              onClick={() => void closeAccount()}
              disabled={deleteBusy || !deletePassword}
              data-testid="account-delete"
            >
              {deleteBusy ? "正在注销…" : "永久注销账号"}
            </button>
            {deleteError ? (
              <p className="wb-rename__error" role="alert">
                {deleteError}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
