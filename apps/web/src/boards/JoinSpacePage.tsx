import { useEffect, useState } from "react";
import { acceptSpaceInvite, type AcceptInviteResult } from "./spaceApi";
import { IconFlower } from "../ui/icons";

/**
 * `/join/<token>`（设计稿 §06）。
 *
 * 链接本身不需要登录就能打开，但加入必须登录：401 时给出登录入口并带上回跳地址，
 * 登录完成后回到这里自动再接受一次。失效 / 撤销统一文案，不区分具体原因。
 */

type State =
  | { kind: "joining" }
  | { kind: "needLogin" }
  | { kind: "ok"; result: AcceptInviteResult }
  | { kind: "expired" }
  | { kind: "error" };

export function JoinSpacePage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "joining" });

  useEffect(() => {
    let alive = true;
    void acceptSpaceInvite(token).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setState({ kind: "ok", result: result.data });
        return;
      }
      if (result.status === 401) {
        setState({ kind: "needLogin" });
        return;
      }
      if (result.status === 410) {
        setState({ kind: "expired" });
        return;
      }
      setState({ kind: "error" });
    });
    return () => {
      alive = false;
    };
  }, [token]);

  const toLogin = () => {
    window.location.assign(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
  };

  return (
    <main className="wb-join">
      <div className="wb-join__card">
        <span className="wb-join__icon" aria-hidden>
          <IconFlower size={28} />
        </span>
        {state.kind === "joining" ? (
          <>
            <h1 className="wb-join__title">正在加入空间…</h1>
            <p className="wb-caption">马上就好。</p>
          </>
        ) : state.kind === "needLogin" ? (
          <>
            <h1 className="wb-join__title">登录后加入空间</h1>
            <p className="wb-caption">邀请链接已打开，登录或注册后会直接加入。</p>
            <button className="wb-btn wb-btn--primary" type="button" onClick={toLogin}>
              去登录
            </button>
          </>
        ) : state.kind === "ok" ? (
          <>
            <h1 className="wb-join__title">已加入「{state.result.spaceName}」</h1>
            <p className="wb-caption">
              你的角色：{state.result.role === "editor" ? "编辑者" : "只读"}
              {state.result.alreadyMember ? "（你本来就在这个空间里）" : ""}
            </p>
            <a
              className="wb-btn wb-btn--primary"
              href={`/boards?space=${encodeURIComponent(state.result.spaceId)}`}
            >
              进入空间
            </a>
          </>
        ) : state.kind === "expired" ? (
          <>
            <h1 className="wb-join__title">链接已失效</h1>
            <p className="wb-caption">邀请链接可能已过期或被撤销，请让空间所有者重新生成。</p>
            <a className="wb-btn wb-btn--ghost" href="/boards">
              回到我的白板
            </a>
          </>
        ) : (
          <>
            <h1 className="wb-join__title">没能加入</h1>
            <p className="wb-caption">网络似乎不太稳定，稍后再试一次。</p>
            <button className="wb-btn wb-btn--ghost" type="button" onClick={() => window.location.reload()}>
              重试
            </button>
          </>
        )}
      </div>
    </main>
  );
}
