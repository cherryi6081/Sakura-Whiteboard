import { useState } from "react";
import { login, register, type MePayload } from "./authApi";

/**
 * 登录 / 注册页（M5，开发文档 §8.6.3）。
 *
 * 邮箱 + 密码（argon2id，服务端哈希）；成功后立即触发一次认领预览，`count > 0` 时由
 * `ClaimDialog` 接续（默认勾选，可取消）。
 */

type Mode = "login" | "register";

export function AuthPage({
  mode,
  onDone,
  onModeChange,
}: {
  mode: Mode;
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

  return (
    <div style={wrapStyle}>
      <form onSubmit={submit} style={cardStyle}>
        <h1 style={{ fontSize: 20, margin: 0, color: "#A85C7C" }}>
          {mode === "login" ? "登录" : "注册账号"}
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: "#6B5A61" }}>
          {mode === "login" ? "登录后白板会保存到账号，可跨设备继续编辑" : "注册后会提示是否把本机临时板转入账号"}
        </p>

        <label style={labelStyle}>
          邮箱
          <input
            data-testid="auth-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={inputStyle}
            autoComplete="email"
          />
        </label>

        {mode === "register" ? (
          <label style={labelStyle}>
            昵称
            <input
              data-testid="auth-display-name"
              type="text"
              required
              minLength={2}
              maxLength={24}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              style={inputStyle}
              autoComplete="nickname"
            />
          </label>
        ) : null}

        <label style={labelStyle}>
          密码
          <input
            data-testid="auth-password"
            type="password"
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={inputStyle}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>

        {error ? (
          <div data-testid="auth-error" style={{ fontSize: 12, color: "#B4485F" }}>
            {error}
          </div>
        ) : null}

        <button data-testid="auth-submit" type="submit" disabled={busy} style={primaryButtonStyle}>
          {busy ? "处理中…" : mode === "login" ? "登录" : "注册"}
        </button>

        <button
          type="button"
          onClick={() => onModeChange(mode === "login" ? "register" : "login")}
          style={linkButtonStyle}
        >
          {mode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
        </button>
      </form>
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

const wrapStyle: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  minHeight: "100vh",
  background: "#FBF7F9",
  fontFamily: "system-ui, sans-serif",
  color: "#3A2E33",
};

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  width: 320,
  padding: 24,
  background: "#fff",
  border: "1px solid #EFE4E8",
  borderRadius: 12,
  boxShadow: "0 8px 24px rgba(58,46,51,.06)",
};

const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6B5A61" };

const inputStyle: React.CSSProperties = {
  padding: "7px 9px",
  fontSize: 13,
  border: "1px solid #E7DBE0",
  borderRadius: 8,
  outlineColor: "#A85C7C",
};

const primaryButtonStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "8px 12px",
  fontSize: 13,
  color: "#fff",
  background: "#A85C7C",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

const linkButtonStyle: React.CSSProperties = {
  padding: 0,
  fontSize: 12,
  color: "#8E4568",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};
