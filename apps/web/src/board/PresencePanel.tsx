import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import type { RemoteCursor } from "../collab/BoardCollab";
import type { PresenceUserPayload } from "../collab/socketClient";
import { IconClose, IconLock } from "../ui/icons";
import "./presence-panel.css";

/**
 * 在线协作者面板（设计稿方案 C 的「在线协作者」段）。
 *
 * 数据全部来自实时协作层：`presence.users` 给出人、角色、昵称与最早加入时间，
 * `cursors` 给出每个连接最近一次光标时间。这里不新增存储，也不参与权限判定。
 *
 * 状态口径：
 * - 在线：最近一次光标活动（没有光标时用 joinedAt 基线）在 60s 内；
 * - 空闲：超过 60s 没有光标活动，但连接仍在（presence 心跳 25s / TTL 60s 保证名单真实）；
 * - 离线：不在 presence 名单里，不渲染。
 * 自己的标签页切到后台时直接显示空闲。
 *
 * 形态沿用设计稿 C：24px 头像 / 38px 行 / 角色胶囊 / 6px 状态点；
 * 面板从顶栏头像栈下方展开，头像栈本身仍是在线概览与入口。
 */

/** 60s 无光标活动即视为空闲：与 presence 的 60s TTL 同一量级。 */
const IDLE_AFTER_MS = 60_000;
/** 空闲状态靠定时重算，不需要每次光标帧都重渲染整块面板。 */
const IDLE_TICK_MS = 15_000;

const ROLE_TEXT: Record<string, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "只读",
};

const ROLE_RANK: Record<string, number> = {
  owner: 0,
  editor: 1,
  viewer: 2,
};

const shortId = (identity: string) => {
  const plain = identity.includes(":") ? identity.split(":").pop() ?? identity : identity;
  return plain.length <= 8 ? plain : plain.slice(-8);
};

type PresencePanelProps = {
  open: boolean;
  users: PresenceUserPayload[];
  cursors: RemoteCursor[];
  selfIdentity: string | null;
  /** 头像栈按钮：面板以它为锚点，点击它不算「点在外面」。 */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 所有者右键头像时的成员管理菜单（复用顶栏头像原来的入口）。 */
  onMemberContextMenu?: (event: ReactMouseEvent, identity: string, displayName: string) => void;
};

export function PresencePanel({
  open,
  users,
  cursors,
  selfIdentity,
  anchorRef,
  onClose,
  onMemberContextMenu,
}: PresencePanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 面板打开期间定时重算「在线 / 空闲」；切回前台也立刻重算。
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), IDLE_TICK_MS);
    const onVisibility = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open]);

  // 贴在头像栈下方，右对齐；窗口变化时重算并夹在视口内。
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = panelRef.current?.offsetWidth ?? 292;
      const left = Math.min(
        Math.max(8, rect.right - width),
        Math.max(8, window.innerWidth - width - 8),
      );
      setPos({ top: rect.bottom + 8, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchorRef, users.length]);

  // Esc 只关面板，并把事件挡住，避免同时触发画布 / 原生侧栏的关闭。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  // 点面板与头像栈以外的地方收起；点头像栈交给按钮自己的开合逻辑。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, anchorRef, onClose]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const rows = useMemo(() => {
    if (!open) return [];
    const cursorAt = new Map<string, number>();
    for (const cursor of cursors) {
      cursorAt.set(cursor.identity, Math.max(cursorAt.get(cursor.identity) ?? 0, cursor.at));
    }

    const rowsWithState = users.map((member) => {
      const isSelf = member.identity === selfIdentity;
      const baseline =
        Number.isFinite(member.joinedAt) && member.joinedAt > 0 ? member.joinedAt : now;
      const lastActive = Math.max(baseline, cursorAt.get(member.identity) ?? 0);
      // 自己只要标签页可见就算在线：面板开着时用户显然在场，不该因为
      // 只是阅读、没动鼠标就把自己标成空闲；切到后台才显示空闲。
      const hiddenSelf = isSelf && typeof document !== "undefined" && document.visibilityState === "hidden";
      return {
        member,
        isSelf,
        idle: isSelf ? hiddenSelf : now - lastActive > IDLE_AFTER_MS,
      };
    });

    return rowsWithState.sort((a, b) => {
      const rankA = ROLE_RANK[a.member.role] ?? 9;
      const rankB = ROLE_RANK[b.member.role] ?? 9;
      return (
        rankA - rankB ||
        Number(b.isSelf) - Number(a.isSelf) ||
        (a.member.joinedAt ?? 0) - (b.member.joinedAt ?? 0)
      );
    });
  }, [open, users, cursors, selfIdentity, now]);

  if (!open || users.length === 0) return null;

  const onlySelf = users.length === 1;

  return createPortal(
    <div
      ref={panelRef}
      className="wb-presence"
      role="dialog"
      aria-label="在线协作者"
      tabIndex={-1}
      data-testid="presence-panel"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
    >
      <div className="wb-presence__head">
        <span className="wb-presence__title">在线协作者</span>
        <span className="wb-presence__count" data-testid="presence-count">
          {users.length}
        </span>
        <button
          className="wb-presence__close"
          type="button"
          aria-label="收起在线协作者"
          title="收起"
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="wb-presence__list" data-testid="presence-list">
        {rows.map(({ member, isSelf, idle }) => {
          const roleText = ROLE_TEXT[member.role] ?? member.role;
          const statusText = idle ? "空闲" : "在线";
          const isGuest = member.identity.startsWith("guest:");
          const avatarText = member.avatarUrl
            ? null
            : isSelf
              ? "我"
              : member.displayName.trim().slice(0, 1) || shortId(member.identity).slice(-2);
          return (
            <div
              key={member.identity}
              className="wb-presence__person"
              data-testid="presence-person"
              data-identity={member.identity}
              data-role={member.role}
              data-status={idle ? "idle" : "online"}
              data-self={isSelf ? "true" : undefined}
            >
              <span
                className="wb-presence__avatar"
                style={{ background: member.color }}
                onContextMenu={(event) =>
                  onMemberContextMenu?.(event, member.identity, member.displayName)
                }
              >
                {member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : avatarText}
              </span>
              <span className="wb-presence__name" title={member.displayName}>
                {member.displayName}
                {isSelf ? <em>（我）</em> : null}
              </span>
              {isGuest ? <span className="wb-presence__tag">#{shortId(member.identity).slice(-2)}</span> : null}
              <span className={`wb-presence__role wb-presence__role--${member.role}`} title={roleText}>
                {member.role === "viewer" ? <IconLock size={9} /> : null}
                {roleText}
              </span>
              <span
                className="wb-presence__dot"
                aria-hidden
              />
              <span className="wb-presence__state" title={idle ? "60 秒内没有光标活动" : "最近有活动"}>
                {statusText}
              </span>
            </div>
          );
        })}

        {onlySelf ? (
          <div className="wb-presence__empty" data-testid="presence-empty">
            <b>只有你在线</b>
            <span>把白板链接分享给同伴后，他们会出现在这里。</span>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
