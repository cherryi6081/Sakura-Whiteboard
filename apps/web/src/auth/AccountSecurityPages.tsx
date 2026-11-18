import { useEffect, useRef, useState, type ReactNode } from "react";
import { assessPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@whiteboard/shared";
import { forgotPassword, resetPassword, verifyEmail } from "./authApi";
import { IconAlert, IconBack } from "../ui/icons";
import { FujiScene } from "../home/FujiScene";
import { useThemePeriod } from "../theme/ThemeClock";

/**
 * 账号安全的三个独立落地页：找回密码、重置密码、邮箱验证。
 *
 * 三者都沿用登录页的富士山 + 和纸卡视觉，只把表单换掉；
 * token 只从邮件链接的 query 读取，不写 localStorage，也不在页面间传递。
 */

function SecurityShell({
  title,
  caption,
  children,
}: {
  title: string;
  caption: ReactNode;
  children: ReactNode;
}) {
  const period = useThemePeriod();
  return (
    <div className="wb-auth" data-period={period}>
      <FujiScene period={period} />
      <div className="wb-home__tint" aria-hidden />
      <div className="wb-home__grain" aria-hidden />
      <span className="wb-home__inscription wb-home__inscription--left" aria-hidden>
        富士山下　桜落つ
      </span>
      <span className="wb-home__inscription wb-home__inscription--right" aria-hidden>
        アカウント
      </span>

      <a className="wb-auth__back" href="/login" aria-label="返回登录">
        <IconBack size={14} />
        返回登录
      </a>

      <div className="wb-auth__panel">
        <div className="wb-auth__card" data-testid="security-card">
          <a className="wb-auth__brand" href="/" aria-label="桜花白板">
            <span className="wb-auth__brand-mark" aria-hidden>
              桜
            </span>
            桜花白板
          </a>
          <h1 className="wb-auth__title">{title}</h1>
          <p className="wb-auth__caption">{caption}</p>
          {children}
        </div>
        <span className="wb-auth__seal" aria-hidden>
          <span>白</span>
          <span>板</span>
        </span>
      </div>
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="wb-inline-note wb-inline-note--danger" role="alert">
      <IconAlert />
      <span>{message}</span>
    </div>
  );
}

function networkMessage(status: number): string {
  return status === 0 ? "网络异常，请检查网络后重试" : "服务暂时不可用，请稍后重试";
}

/** 找回密码：无论邮箱是否存在，成功路径都展示同一句提示。 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const result = await forgotPassword({ email: email.trim() });
    setBusy(false);

    if (!result.ok) {
      if (result.code === "TOO_MANY_ATTEMPTS") {
        setError("发送太频繁，请稍后再试");
        return;
      }
      if (result.status === 0) {
        setError(networkMessage(result.status));
        return;
      }
    }
    // 其余情况一律按已发送处理，避免通过页面差异判断邮箱是否注册
    setSent(true);
  };

  return (
    <SecurityShell
      title="找回密码"
      caption="输入注册邮箱，我们会发送一封带有重置链接的邮件。链接 30 分钟内有效，且只能使用一次。"
    >
      {sent ? (
        <>
          <div className="wb-inline-note wb-inline-note--info" role="status">
            <span>如果该邮箱已注册，重置邮件已经发出，请查收（也请检查垃圾邮件箱）。</span>
          </div>
          <a className="wb-btn wb-btn--full" href="/login">
            返回登录
          </a>
        </>
      ) : (
        <form className="wb-auth__form" onSubmit={submit}>
          <div className="wb-auth__fields">
            <label className="wb-field">
              <span className="wb-field__label">注册邮箱</span>
              <input
                className="wb-input"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                data-testid="forgot-email"
              />
            </label>
          </div>
          {error ? <ErrorNote message={error} /> : null}
          <button
            className="wb-btn wb-btn--primary wb-btn--full wb-btn--lg"
            type="submit"
            disabled={busy}
            data-testid="forgot-submit"
          >
            {busy ? "发送中…" : "发送重置邮件"}
          </button>
        </form>
      )}
    </SecurityShell>
  );
}

function resetMessage(code: string, status: number, message?: string): string {
  switch (code) {
    case "INVALID_TOKEN":
      return "重置链接无效或已过期，请重新申请";
    case "PASSWORD_UNCHANGED":
      return "新密码不能与当前密码相同";
    case "INVALID_INPUT":
      return message ?? "新密码不符合要求，请换一个更复杂的密码";
    case "TOO_MANY_ATTEMPTS":
      return "尝试次数过多，请稍后再试";
    default:
      return networkMessage(status);
  }
}

/** 重置密码：token 一次性，成功后该账号其它会话全部失效。 */
export function ResetPasswordPage({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assessment = password ? assessPassword(password) : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !token) return;
    setError(null);
    if (password !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (assessment && assessment.blockers.length > 0) {
      setError(assessment.blockers[0] ?? "新密码不符合要求");
      return;
    }
    setBusy(true);
    const result = await resetPassword({ token, newPassword: password });
    setBusy(false);
    if (!result.ok) {
      setError(resetMessage(result.code, result.status, result.message));
      return;
    }
    setDone(true);
  };

  return (
    <SecurityShell
      title="设置新密码"
      caption="设置成功后，其它设备上的登录会立刻失效，需要用新密码重新登录。"
    >
      {!token ? (
        <>
          <ErrorNote message="重置链接不完整或格式不正确，请从邮件里重新打开。" />
          <a className="wb-link" href="/forgot-password">
            重新申请重置邮件 →
          </a>
        </>
      ) : done ? (
        <>
          <div className="wb-inline-note wb-inline-note--info" role="status">
            <span>密码已更新，其它设备上的登录已失效。</span>
          </div>
          <a className="wb-btn wb-btn--primary wb-btn--full" href="/login">
            去登录
          </a>
        </>
      ) : (
        <form className="wb-auth__form" onSubmit={submit}>
          <div className="wb-auth__fields">
            <label className="wb-field">
              <span className="wb-field__label">新密码</span>
              <input
                className="wb-input"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={`${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位`}
                data-testid="reset-password"
              />
            </label>
            <label className="wb-field">
              <span className="wb-field__label">确认新密码</span>
              <input
                className="wb-input"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                data-testid="reset-confirm"
              />
            </label>
            {assessment && assessment.blockers.length > 0 ? (
              <span className="wb-help">{assessment.blockers[0]}</span>
            ) : null}
          </div>
          {error ? <ErrorNote message={error} /> : null}
          <button
            className="wb-btn wb-btn--primary wb-btn--full wb-btn--lg"
            type="submit"
            disabled={busy}
            data-testid="reset-submit"
          >
            {busy ? "提交中…" : "更新密码"}
          </button>
        </form>
      )}
    </SecurityShell>
  );
}

/**
 * 邮箱验证落地页：进页面即消费 token。
 * StrictMode 会重跑 effect，但 token 是一次性的，必须用 ref 保证只发一次请求。
 */
export function VerifyEmailPage({ token }: { token: string | null }) {
  const startedRef = useRef(false);
  const [state, setState] = useState<"checking" | "done" | "error">(token ? "checking" : "error");

  useEffect(() => {
    if (!token || startedRef.current) return;
    startedRef.current = true;
    void verifyEmail(token).then((result) => {
      setState(result.ok ? "done" : "error");
    });
  }, [token]);

  return (
    <SecurityShell
      title="验证邮箱"
      caption="验证只用于完善账号状态，未验证同样可以正常登录和使用白板。"
    >
      {state === "checking" ? (
        <p className="wb-help" role="status">
          正在验证邮箱…
        </p>
      ) : state === "done" ? (
        <>
          <div className="wb-inline-note wb-inline-note--info" role="status">
            <span>邮箱已验证，感谢确认。</span>
          </div>
          <a className="wb-btn wb-btn--primary wb-btn--full" href="/boards">
            去我的白板
          </a>
        </>
      ) : (
        <>
          <ErrorNote message="验证链接无效、已过期或已被使用。" />
          <p className="wb-help">请回到账号设置重新发送验证邮件，或在登录后再次打开邮件里的新链接。</p>
          <a className="wb-btn wb-btn--full" href="/boards">
            返回白板列表
          </a>
        </>
      )}
    </SecurityShell>
  );
}
