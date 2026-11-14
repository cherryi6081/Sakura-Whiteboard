import { useEffect, useState, type ReactNode } from "react";
import { fetchMe } from "./authApi";
import { sanitizeReturnTo } from "./returnTo";

/**
 * 受限页守卫：必须登录才能进入的页面包一层。
 *
 * - 身份判断复用现有的 `/api/auth/me`（与各页面同一份结果），不另起状态源；
 * - 检查期渲染 `null`，**先等身份确定**，避免首帧闪一下页面再跳走；
 * - 401（游客或匿名）→ `location.replace('/login?returnTo=<当前路径含 query>')`，
 *   用 `replace` 而不是 `push`，登录后按 `returnTo` 回跳时不会把登录页留在历史里；
 * - 其它失败（网络 / 5xx）→ 直接渲染页面，由页面按原有方式报错，不误跳登录。
 *
 * 登录后仍缺额外权限（如非空间成员）的页面**不要**用这个守卫，保持原有错误呈现。
 */
export function RequireLogin({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ready">("checking");

  useEffect(() => {
    let alive = true;
    void fetchMe().then((result) => {
      if (!alive) return;
      if (!result.ok && result.status === 401) {
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const returnTo = sanitizeReturnTo(here);
        const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
        window.location.replace(`/login${query}`);
        return;
      }
      setState("ready");
    });
    return () => {
      alive = false;
    };
  }, []);

  return state === "ready" ? <>{children}</> : null;
}
