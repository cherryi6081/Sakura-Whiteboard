import { useEffect, useRef, useState } from "react";
import { assessPassword, LIMITS } from "@whiteboard/shared";
import {
  changePassword,
  deleteAccount,
  fetchProviders,
  sendEmailVerification,
  unbindGithub,
  updateProfile,
  uploadAvatar,
  type AuthUser,
} from "../auth/authApi";
import { DialogClose } from "../ui/DialogClose";
import { UserMark } from "../ui/UserMark";

/**
 * 账号设置（开发文档 §7.1.2）。
 *
 * 三段式：资料（显示名）→ 密码（旧密码校验 + 强度校验，成功后其它会话失效）→
 * 危险区（销号，需当前密码二次确认）。视觉沿用空间设置的面板壳，
 * 不新增一套弹窗样式。
 */

type Props = {
  user: AuthUser;
  /** `/auth/me` 返回的登录方式：password / github */
  methods: string[];
  onMethodsChange: (methods: string[]) => void;
  /** 从 GitHub 绑定回调带回来的结果提示（账号弹窗自动打开时展示） */
  initialNotice?: string | null;
  onClose: () => void;
  onUserChange: (user: AuthUser) => void;
  /** 销号成功：由调用方做本地会话清理与登出广播 */
  onDeleted: () => void;
};

/**
 * GitHub 绑定回调失败码 → 中文提示。服务端只回码，不在 URL 里带第三方原文。
 * 同时供账号弹窗与列表页读取 query 时使用。
 */
export function githubBindErrorMessage(code: string | null): string | null {
  switch (code) {
    case "not_configured":
      return "GitHub 登录尚未启用，暂时无法绑定";
    case "github_already_linked":
      return "该 GitHub 账号已绑定到另一个桜花白板账号，请先在那边解绑或换一个 GitHub 账号";
    case "bind_session_mismatch":
      return "绑定会话不匹配，请重新登录后再试";
    case "forbidden":
      return "绑定请求来源不可信，请从账号设置重新发起";
    case "state_mismatch":
    case "state_expired":
    case "code_expired":
      return "绑定请求已失效，请重新点击绑定";
    case "account_disabled":
      return "账号不存在或已停用，无法绑定";
    case "access_denied":
      return "已取消 GitHub 授权";
    case "github_unreachable":
      return "无法连接 GitHub（网络或代理异常），请检查网络后重试";
    case "temporarily_unavailable":
      return "服务暂时不可用，请稍后重试";
    case "github_error":
      return "GitHub 授权失败，请稍后重试";
    default:
      return null;
  }
}

function bindingMessage(code: string, status: number, message?: string): string {
  switch (code) {
    case "LAST_LOGIN_METHOD":
      return message ?? "这是当前唯一的登录方式，解绑后将无法登录，因此已拒绝";
    case "NOT_LINKED":
      return "尚未绑定 GitHub";
    case "UNAUTHENTICATED":
      return "登录已失效，请重新登录";
    case "FORBIDDEN":
      return "请求被拒绝，请刷新页面后重试";
    default:
      return status === 0 ? "网络异常，请稍后重试" : "操作失败，请重试";
  }
}

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

const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const AVATAR_MIME_TYPES = AVATAR_ACCEPT.split(",");

function avatarMessage(code: string, status: number): string {
  switch (code) {
    case "UNSUPPORTED_MEDIA_TYPE":
      return "图片格式不支持，请换 PNG / JPG / WebP / GIF";
    case "FILE_TOO_LARGE":
      return "图片不能超过 2MB";
    case "UNAUTHENTICATED":
      return "登录已失效，请重新登录";
    case "STORAGE_UNAVAILABLE":
      return "头像存储暂不可用，请稍后重试";
    case "NETWORK_ERROR":
    case "TypeError":
      return "网络异常，请稍后重试";
    default:
      return status === 0 ? "网络异常，请稍后重试" : "上传失败，请重试";
  }
}

export function AccountSettingsDialog({
  user,
  methods,
  onMethodsChange,
  initialNotice,
  onClose,
  onUserChange,
  onDeleted,
}: Props) {
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

  /** 已落库的头像 URL；上传成功后由服务端返回值覆盖，展示始终以它为准 */
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  /** 本地预览（objectURL）：选择后立刻展示，失败或成功后释放 */
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const avatarPreviewRef = useRef<string | null>(null);

  const [deletePassword, setDeletePassword] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** 第三方入口由服务端配置决定：没配置时只显示状态，不给无效按钮 */
  const [providers, setProviders] = useState<{ github: boolean } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubNotice, setGithubNotice] = useState<string | null>(initialNotice ?? null);
  const [githubError, setGithubError] = useState<string | null>(null);

  const githubBound = methods.includes("github");
  const assessment = newPassword ? assessPassword(newPassword, { email: user.email ?? undefined }) : null;

  useEffect(() => {
    let alive = true;
    void fetchProviders().then((value) => {
      if (alive) setProviders(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 预览用的是 blob: URL，离开弹窗时统一释放
  useEffect(() => {
    return () => {
      if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
    };
  }, []);

  const clearAvatarPreview = () => {
    if (avatarPreviewRef.current) {
      URL.revokeObjectURL(avatarPreviewRef.current);
      avatarPreviewRef.current = null;
    }
    setAvatarPreview(null);
  };

  const pickAvatar = async (file: File) => {
    if (avatarBusy) return;
    // 客户端先做一次同类校验；服务端还会按魔数再验，不只看扩展名
    if (file.type && !AVATAR_MIME_TYPES.includes(file.type)) {
      setAvatarNotice(null);
      setAvatarError("图片格式不支持，请换 PNG / JPG / WebP / GIF");
      return;
    }
    if (file.size > LIMITS.avatarMaxBytes) {
      setAvatarNotice(null);
      setAvatarError("图片不能超过 2MB");
      return;
    }

    clearAvatarPreview();
    const preview = URL.createObjectURL(file);
    avatarPreviewRef.current = preview;
    setAvatarPreview(preview);
    setAvatarNotice(null);
    setAvatarError(null);
    setAvatarBusy(true);

    const result = await uploadAvatar(file);
    setAvatarBusy(false);
    if (!result.ok) {
      // 失败回退到已保存的头像，避免预览看起来像已经换好了
      clearAvatarPreview();
      setAvatarError(avatarMessage(result.code, result.status));
      return;
    }
    // 服务端返回的同一份 avatarUrl 写回本地状态并向上通知：
    // 空间 chip、编辑页顶栏、在线头像栈都读这一个字段
    setAvatarUrl(result.data.user.avatarUrl);
    onUserChange(result.data.user);
    setAvatarNotice("头像已更新");
  };

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

  const requestEmailVerification = async () => {
    if (verifyBusy) return;
    setVerifyBusy(true);
    setVerifyNotice(null);
    setVerifyError(null);
    const result = await sendEmailVerification();
    setVerifyBusy(false);
    if (!result.ok) {
      setVerifyError(
        result.code === "TOO_MANY_ATTEMPTS"
          ? "发送太频繁，请稍后再试"
          : result.status === 0
            ? "网络异常，请稍后重试"
            : result.message ?? "验证邮件发送失败，请稍后重试",
      );
      return;
    }
    setVerifyNotice(
      result.data.alreadyVerified
        ? "这个邮箱已经验证过了"
        : "验证邮件已发送，请查收；未验证不影响继续使用白板",
    );
  };

  const removeGithubBinding = async () => {
    if (githubBusy) return;
    setGithubBusy(true);
    setGithubNotice(null);
    setGithubError(null);
    const result = await unbindGithub();
    setGithubBusy(false);
    if (!result.ok) {
      setGithubError(bindingMessage(result.code, result.status, result.message));
      return;
    }
    onMethodsChange(result.data.methods);
    setGithubNotice("已解绑 GitHub");
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
          <div className="wb-account__identity">
            <button
              className="wb-account__avatar"
              type="button"
              aria-label="更换头像"
              title="更换头像"
              aria-busy={avatarBusy}
              disabled={avatarBusy}
              onClick={() => avatarInputRef.current?.click()}
              data-testid="account-avatar"
            >
              {avatarPreview || avatarUrl ? (
                <img src={avatarPreview ?? avatarUrl ?? undefined} alt="" />
              ) : (
                <UserMark size={20} />
              )}
              <span className="wb-account__avatar-badge">{avatarBusy ? "上传中" : "更换"}</span>
            </button>
            <input
              ref={avatarInputRef}
              type="file"
              accept={AVATAR_ACCEPT}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                // 清空 value，保证连续选同一个文件也能触发 change
                event.target.value = "";
                if (file) void pickAvatar(file);
              }}
              data-testid="account-avatar-file"
            />
            <div className="wb-account__identity-text">
              <p className="wb-space-settings__eyebrow">账号</p>
              <h2 className="wb-dialog__title" id="wb-account-title">
                账号设置
              </h2>
              <p className="wb-caption">{user.email ?? "未绑定邮箱"}</p>
              {avatarError ? (
                <p className="wb-account__avatar-note is-error" role="alert">
                  {avatarError}
                </p>
              ) : avatarNotice ? (
                <p className="wb-account__avatar-note" role="status">
                  {avatarNotice}
                </p>
              ) : null}
            </div>
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

        <section className="wb-space-settings__section" aria-labelledby="wb-account-security-title">
          <h3 className="wb-space-settings__subtitle" id="wb-account-security-title">
            邮箱与登录方式
          </h3>

          <div className="wb-account__security-row">
            <div className="wb-account__security-text">
              <p className="wb-account__security-name">邮箱</p>
              <p className="wb-caption">{user.email ?? "未绑定邮箱"}</p>
              <p className="wb-help">
                {user.emailVerified ? "已验证" : "未验证；不影响登录与白板使用"}
              </p>
            </div>
            {user.email && !user.emailVerified ? (
              <button
                className="wb-btn wb-btn--sm"
                type="button"
                onClick={() => void requestEmailVerification()}
                disabled={verifyBusy}
                data-testid="account-send-verification"
              >
                {verifyBusy ? "发送中…" : "发送验证邮件"}
              </button>
            ) : null}
          </div>
          {verifyNotice ? (
            <p className="wb-space-lifecycle__notice" role="status">
              {verifyNotice}
            </p>
          ) : null}
          {verifyError ? (
            <p className="wb-rename__error" role="alert">
              {verifyError}
            </p>
          ) : null}

          <div className="wb-account__security-row">
            <div className="wb-account__security-text">
              <p className="wb-account__security-name">GitHub</p>
              <p className="wb-help">
                {githubBound ? "已绑定" : providers?.github ? "未绑定" : "当前未启用"}
              </p>
            </div>
            {githubBound ? (
              <button
                className="wb-btn wb-btn--sm"
                type="button"
                onClick={() => void removeGithubBinding()}
                disabled={githubBusy}
                data-testid="account-unbind-github"
              >
                {githubBusy ? "解绑中…" : "解绑"}
              </button>
            ) : providers?.github ? (
              <a
                className="wb-btn wb-btn--sm"
                href="/api/auth/github/bind/start?next=%2Fboards"
                data-testid="account-bind-github"
              >
                绑定 GitHub
              </a>
            ) : null}
          </div>
          <p className="wb-help">
            解绑前会检查是否还有密码或其它登录方式；这是唯一登录方式时会被拒绝，避免把自己锁在门外。
          </p>
          {githubNotice ? (
            <p className="wb-space-lifecycle__notice" role="status">
              {githubNotice}
            </p>
          ) : null}
          {githubError ? (
            <p className="wb-rename__error" role="alert">
              {githubError}
            </p>
          ) : null}
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
