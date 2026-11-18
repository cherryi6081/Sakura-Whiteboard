import { useEffect, useState } from "react";
import {
  assessPassword,
  levelBars,
  levelLabel,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@whiteboard/shared";
import { fetchProviders, login, register, type MePayload } from "./authApi";
import { isRestrictedPath } from "../board/route";
import { IconAlert, IconBack, IconEye, IconEyeOff } from "../ui/icons";
import { FujiScene } from "../home/FujiScene";
import { useThemePeriod } from "../theme/ThemeClock";

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
  const [error, setError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return oauthMessageOf(params.get("oauthError"), params.get("oauth"));
  });
  const [busy, setBusy] = useState(false);
  // 第三方入口的防连点：点哪个就锁哪个，避免短时间发起两条授权流程
  const [oauthBusy, setOauthBusy] = useState<"github" | "google" | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [providers, setProviders] = useState<{ github: boolean; google: boolean } | null>(null);
  const period = useThemePeriod();

  // 第三方入口由服务端配置决定：缺配置时不渲染按钮；错误码从回跳 URL 读一次后清掉
  useEffect(() => {
    let alive = true;
    void fetchProviders().then((value) => {
      if (alive) setProviders(value);
    });
    const url = new URL(window.location.href);
    if (url.searchParams.has("oauthError") || url.searchParams.has("oauth")) {
      url.searchParams.delete("oauthError");
      url.searchParams.delete("oauth");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return () => {
      alive = false;
    };
  }, []);

  // 从第三方返回（含 bfcache 恢复）或重新回到标签页时解除处理中，避免入口永久禁用
  useEffect(() => {
    const restore = () => setOauthBusy(null);
    window.addEventListener("pageshow", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("visibilitychange", restore);
    };
  }, []);

  // 注册时实时评估强度：只在输入非空时计算，避免空态就显示"弱"
  const assessment = mode === "register" && password ? assessPassword(password, { email: email.trim() }) : null;

  // 首次点击放行默认跳转；处理中再点直接拦掉，不会发起第二次授权
  const startOAuth =
    (provider: "github" | "google") => (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (oauthBusy) {
        event.preventDefault();
        return;
      }
      setOauthBusy(provider);
      // 兜底：跳转被拦截、或用户在第三方页停留很久，15 秒后恢复可点
      window.setTimeout(() => setOauthBusy(null), 15_000);
    };

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

  // 受限页的 returnTo 不回给游客：否则点「继续以游客身份」会立刻被守卫弹回登录页
  const guestHref = next && !isRestrictedPath(next) ? next : "/";
  const oauthNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

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

            {mode === "login" ? (
              <p className="wb-auth__forgot">
                <a className="wb-link" href="/forgot-password" data-testid="auth-forgot">
                  忘记密码？
                </a>
              </p>
            ) : null}

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

            {providers?.github || providers?.google ? (
              <div className="wb-auth__oauth">
                <span className="wb-auth__divider" aria-hidden>
                  或
                </span>
                {providers.github ? (
                  <a
                    className={`wb-btn wb-btn--full wb-auth__github${oauthBusy === "github" ? " wb-auth__github--busy" : ""}`}
                    data-testid="auth-github"
                    href={`/api/auth/github/start?next=${encodeURIComponent(oauthNext)}`}
                    aria-busy={oauthBusy === "github" || undefined}
                    aria-disabled={oauthBusy === "github" || undefined}
                    onClick={startOAuth("github")}
                  >
                    {oauthBusy === "github"
                      ? "正在前往 GitHub…"
                      : mode === "login"
                        ? "使用 GitHub 登录"
                        : "使用 GitHub 注册 / 登录"}
                  </a>
                ) : null}
                {providers.google ? (
                  <a
                    className={`wb-btn wb-btn--full wb-auth__google${oauthBusy === "google" ? " wb-auth__google--busy" : ""}`}
                    data-testid="auth-google"
                    href={`/api/auth/google/start?next=${encodeURIComponent(oauthNext)}`}
                    aria-busy={oauthBusy === "google" || undefined}
                    aria-disabled={oauthBusy === "google" || undefined}
                    onClick={startOAuth("google")}
                  >
                    {oauthBusy === "google"
                      ? "正在前往 Google…"
                      : mode === "login"
                        ? "使用 Google 登录"
                        : "使用 Google 注册 / 登录"}
                  </a>
                ) : null}
                <p className="wb-auth__github-hint">将打开账号选择页，可切换其他账号</p>
              </div>
            ) : null}

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
 * 第三方 OAuth 回调失败码 → 可读文案。服务端只回码，不在 URL 里回显第三方原文；
 * `oauth` 参数区分 provider，同一个错误码在两家文案不同。
 */
function oauthMessageOf(code: string | null, provider: string | null): string | null {
  const label = provider === "google" ? "Google" : "GitHub";
  switch (code) {
    case "not_configured":
      return `${label} 登录尚未启用`;
    case "state_mismatch":
      return `登录请求已失效或来源不明，请重新点击 ${label} 登录`;
    case "state_expired":
      return `登录请求已过期或已被使用，请重新点击 ${label} 登录`;
    case "code_expired":
      return `${label} 授权码已过期，请重新登录`;
    case "email_unverified":
      return provider === "google"
        ? "该 Google 账号没有已验证的邮箱，请先在 Google 验证邮箱后重试"
        : "该 GitHub 账号没有已验证的邮箱，请先在 GitHub 验证邮箱后重试";
    case "account_disabled":
      return "该账号已注销，无法登录";
    case "access_denied":
      return `已取消 ${label} 授权`;
    case "github_unreachable":
      return "无法连接 GitHub（网络或代理异常），请检查网络后重试";
    case "google_unreachable":
      return "无法连接 Google（网络或代理异常），请检查网络后重试";
    case "temporarily_unavailable":
      return "登录服务暂时不可用，请稍后重试";
    case "github_error":
      return "GitHub 授权失败，请稍后重试";
    case "google_error":
      return "Google 授权失败，请稍后重试";
    default:
      return null;
  }
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
