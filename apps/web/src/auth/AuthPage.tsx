import { useState } from "react";
import {
  assessPassword,
  levelBars,
  levelLabel,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@whiteboard/shared";
import { login, register, type MePayload } from "./authApi";
import { IconAlert, IconBack, IconEye, IconEyeOff } from "../ui/icons";
import { FujiScene } from "../home/FujiScene";
import { usePeriod } from "../home/usePeriod";

/**
 * 登录 / 注册页（M5，开发文档 §8.6.3；视觉方案 §4.4）。
 *
 * 版式沿用首页：整幅富士山场景铺底，表单落在中央「障子」和纸卡上，朱印斜盖在卡片
 * 右下角。邮箱 + 密码（argon2id，服务端哈希）；注册多一个昵称字段，所以卡片高度
 * 直接按三字段排布，不再压缩字段间距。
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
  const [showPassword, setShowPassword] = useState(false);
  const period = usePeriod();

  // 注册时实时评估强度：只在输入非空时计算，避免空态就显示"弱"
  const assessment = mode === "register" && password ? assessPassword(password, { email: email.trim() }) : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (mode === "register" && assessment && assessment.blockers.length > 0) {
      setError(assessment.blockers[0] ?? "密码不符合要求");
      return;
    }
    setError(null);
    setBusy(true);
    const result =
      mode === "login"
        ? await login({ email: email.trim(), password })
        : await register({ email: email.trim(), password, displayName: displayName.trim() });
    setBusy(false);

    if (!result.ok) {
      setError(messageOf(result.code, result.status));
      return;
    }
    onDone(result.data);
  };

  const guestHref = next ?? "/";

  return (
    <div className="wb-auth" data-period={period}>
      <FujiScene period={period} />
      <div className="wb-auth__fog" aria-hidden>
        <span className="wb-auth__fog-band" />
        <span className="wb-auth__fog-band wb-auth__fog-band--slow" />
      </div>
      <div className="wb-home__tint" aria-hidden />
      <div className="wb-home__grain" aria-hidden />

      <span className="wb-home__inscription wb-home__inscription--left" aria-hidden>富士山下　桜落つ</span>
      <span className="wb-home__inscription wb-home__inscription--right" aria-hidden>ログイン</span>

      <a className="wb-auth__back" href="/" aria-label="返回首页">
        <IconBack size={14} />
        返回
      </a>

      <div className="wb-auth__panel">
        <form onSubmit={submit} className="wb-auth__card" data-testid="auth-card">
          <a className="wb-auth__brand" href="/" aria-label="桜花白板">
            <span className="wb-auth__brand-mark" aria-hidden>
              桜
            </span>
            桜花白板
          </a>

          <h1 className="wb-auth__title">{mode === "login" ? "登录" : "注册账号"}</h1>
          <p className="wb-auth__caption">
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

              <div className="wb-field">
                <label className="wb-field__label" htmlFor="wb-auth-password">
                  密码
                </label>
                <div className="wb-auth__password">
                  <input
                    id="wb-auth-password"
                    className="wb-input"
                    data-testid="auth-password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    placeholder={mode === "login" ? "请输入密码" : `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位`}
                    aria-invalid={error ? "true" : undefined}
                    aria-describedby={assessment ? "wb-auth-password-note" : undefined}
                  />
                  <button
                    type="button"
                    className="wb-auth__eye"
                    onClick={() => setShowPassword((show) => !show)}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <IconEyeOff /> : <IconEye />}
                  </button>
                </div>

                {assessment ? (
                  <div className="wb-auth__strength" data-level={assessment.level}>
                    <div className="wb-auth__strength-bars" aria-hidden>
                      {[1, 2, 3, 4].map((index) => (
                        <span key={index} data-on={index <= levelBars(assessment.level) ? "true" : undefined} />
                      ))}
                    </div>
                    <p className="wb-auth__strength-note" id="wb-auth-password-note">
                      <span className="wb-auth__strength-help" tabIndex={0} aria-describedby="wb-auth-strength-tip">
                        <span className="wb-auth__strength-level">{levelLabel(assessment.level)}</span>
                        <span className="wb-auth__strength-mark" aria-hidden>
                          ?
                        </span>
                        <span className="wb-auth__strength-tip" id="wb-auth-strength-tip" role="tooltip">
                          强度按「有效搜索空间」估算：小写、大写、数字、符号带来的候选字符越多越强；
                          同字符连写（aaa）、重复片段（abcabc）、递增递减（1234 / abcd）与键盘顺序（qwerty）
                          会先被扣掉，纯数字和只用一类字符不给顶档；常见密码与品牌词先做
                          @→a、0→o、1→l、$→s 归一化再匹配，所以 Passw0rd! 也算弱。
                          只有少于 10 位、常见密码、与邮箱前缀相同会被拒绝，弱密码仍可注册。
                          <br />
                          当前依据：{assessment.reasons.length > 0 ? assessment.reasons.join("、") : "没有明显硬伤"}
                          {assessment.hint ? `；建议：${assessment.hint}` : ""}
                        </span>
                      </span>
                      <span> · {assessment.blockers[0] ?? assessment.reasons[0] ?? assessment.hint ?? `${assessment.length} 位`}</span>
                    </p>
                  </div>
                ) : (
                  <span className="wb-help">
                    {mode === "login"
                      ? "输入注册时设置的密码。"
                      : `密码 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位；可用小写、大写、数字、符号与汉字。`}
                  </span>
                )}
              </div>
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
              className="wb-auth__switch"
              onClick={() => onModeChange(mode === "login" ? "register" : "login")}
            >
              {mode === "login" ? "还没有账号？去注册" : "已有账号？去登录"}
            </button>
          </div>
        </form>

        <span className="wb-auth__seal" aria-hidden>
          <span>白</span>
          <span>板</span>
        </span>
      </div>

      <div className="wb-auth__aside">
        <a className="wb-link" href={guestHref} data-testid="auth-guest">
          继续以游客身份 →
        </a>
      </div>
    </div>
  );
}

/**
 * 把接口错误翻成用户能据此行动的文案。
 * 密码规则与 `@whiteboard/shared` 的 `assessPassword` 保持一致，
 * 服务端阻塞项（过短/过长/常见密码/邮箱前缀）都会落到 `INVALID_INPUT`。
 */
function messageOf(code: string, status: number): string {
  switch (code) {
    case "INVALID_CREDENTIALS":
      return "邮箱或密码不正确";
    case "EMAIL_TAKEN":
      return "该邮箱已注册，可直接登录";
    case "INVALID_INPUT":
      return `请检查昵称（2–24 字）、邮箱格式与密码（${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位，不能是常见密码或与邮箱前缀相同）`;
    case "UNAUTHENTICATED":
      return "登录已失效，请重新登录";
    case "FORBIDDEN":
      return "请求被拒绝：页面来源与接口不一致，请刷新页面后重试";
    case "MALFORMED_JSON":
      return "提交内容格式有误，请刷新页面后重试";
    default:
      if (status === 0) return "网络异常，请检查网络后重试";
      if (status >= 500 || code === "INTERNAL") return `服务异常（${status || code}），请稍后再试`;
      return `请求失败（${code}）`;
  }
}
