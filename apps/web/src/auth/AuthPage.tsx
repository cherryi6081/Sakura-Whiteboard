import { useState } from "react";
import { login, register, type MePayload } from "./authApi";
import { IconAlert, IconBack } from "../ui/icons";

/**
 * 登录 / 注册页（M5，开发文档 §8.6.3；视觉方案 §4.4）。
 *
 * 邮箱 + 密码（argon2id，服务端哈希）；成功后立即触发一次认领预览，`count > 0` 时由
 * `ClaimDialog` 接续（默认勾选，可取消）。
 * 「继续以游客身份」是产品主张的一部分，必须能看到并可用。
 */

type Mode = "login" | "register";

export function AuthPage({
  mode,
  next,
  onDone,
  onModeChange,
}: {
  mode: Mode;
  next: string | null;
  onDone: (me: MePayload) => void;
  onModeChange: (mode: Mode) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const result =
      mode === "login"
        ? await login({ email: email.trim(), password })
        : await register({ email: email.trim(), password, displayName: displayName.trim() });
    setBusy(false);

    if (!result.ok) {
      setError(messageOf(result.code));
      return;
    }
    onDone(result.data);
  };

  const guestHref = next ?? "/";

  return (
    <div className="wb-auth">
      <a className="wb-auth__back" href={guestHref}>
        <IconBack size={14} />
        返回
      </a>

      <div style={{ width: 400, maxWidth: "100%" }}>
        <form onSubmit={submit} className="wb-auth__card" data-testid="auth-card">
          <a className="wb-brand" href="/">
            <span className="wb-brand__mark" aria-hidden>
              白
            </span>
            白板
          </a>

          <h1 className="wb-title" style={{ marginTop: "var(--space-6)" }}>
            {mode === "login" ? "登录" : "注册账号"}
          </h1>
          <p className="wb-caption" style={{ marginTop: "var(--space-2)" }}>
            {mode === "login"
              ? "登录后白板会保存到账号，可跨设备继续编辑。"
              : "注册后可以跨设备保存白板，并顺手把本机临时板转入账号。"}
          </p>

          <div className="wb-auth__form">
            <div className="wb-auth__fields">
              {mode === "register" ? (
                <label className="wb-field">
                  <span className="wb-field__label">昵称</span>
                  <input
                    className="wb-input"
                    data-testid="auth-display-name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={24}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="nickname"
                    placeholder="2–24 个字"
                  />
                </label>
              ) : null}

              <label className="wb-field">
                <span className="wb-field__label">邮箱</span>
                <input
                  className="wb-input"
                  data-testid="auth-email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                  aria-invalid={error ? "true" : undefined}
                />
              </label>

              <label className="wb-field">
                <span className="wb-field__label">密码</span>
                <input
                  className="wb-input"
                  data-testid="auth-password"
                  type="password"
                  required
                  minLength={8}
                  maxLength={72}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  placeholder="8–72 位"
                  aria-invalid={error ? "true" : undefined}
                />
                <span className="wb-help">密码 8–72 位，建议包含数字与字母。</span>
              </label>
            </div>

            {error ? (
              <div className="wb-inline-note wb-inline-note--danger" role="alert">
                <IconAlert />
                <span data-testid="auth-error">{error}</span>
              </div>
            ) : null}

            <button className="wb-btn wb-btn--primary wb-btn--full wb-btn--lg" data-testid="auth-submit" type="submit" disabled={busy}>
              {busy ? <span className="wb-spinner" aria-hidden /> : null}
              {busy ? (mode === "login" ? "登录中…" : "注册中…") : mode === "login" ? "登录" : "注册"}
            </button>

            <button
              type="button"
              className="wb-link"
              onClick={() => onModeChange(mode === "login" ? "register" : "login")}
              style={{ textAlign: "left" }}
            >
              {mode === "login" ? "还没有账号？去注册" : "已有账号？去登录"}
            </button>
          </div>
        </form>

        <div className="wb-auth__aside">
          <a className="wb-link" href={guestHref} data-testid="auth-guest">
            继续以游客身份
          </a>
        </div>
      </div>
    </div>
  );
}

function messageOf(code: string): string {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return "邮箱或密码不正确";
    case "EMAIL_TAKEN":
      return "该邮箱已注册，可直接登录";
    case "INVALID_INPUT":
      return "请检查邮箱格式与密码长度（8–72 位）";
    default:
      return `请求失败（${code}）`;
  }
}
