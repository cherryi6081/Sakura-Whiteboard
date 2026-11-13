import { useCallback, useEffect, useRef, useState } from "react";
import { createBoard } from "./boardsApi";
import { listRecentBoards, recordRecentBoard } from "./recentBoards";

/**
 * 「新建一块白板」的共用逻辑：调 `POST /api/boards` → 写入本机最近列表 → 整页跳到
 * `/board/:id`，并处理配额 429、离线与慢请求三种状态。
 *
 * 这段逻辑原来长在首页入口里。首页已收成纯展示页（不渲染任何交互、也不发请求），
 * 功能本身没有消失，统一挪到这里，由需要建板入口的页面调用（当前是 `/boards`）；
 * 将来若某个页面重新出现入口，直接复用该 hook 即可，不必再写一遍。
 */
export type CreateBoardFailureKind = "quota" | "offline" | "error";

type CreateBoardFailure = {
  kind: CreateBoardFailureKind;
  /** 服务端/网络错误码；离线时没有该字段 */
  code?: string;
  message: string;
};

type UseCreateBoardOptions = {
  /** 覆盖失败文案；不传则用首页旧入口那套默认文案 */
  messageFor?: (failure: { kind: CreateBoardFailureKind; code?: string }) => string;
  /** 建到哪个空间；不传 = 服务端落到个人空间 */
  spaceId?: string;
};

const DEFAULT_MESSAGES: Record<CreateBoardFailureKind, string> = {
  quota: "这个浏览器已建满 3 块临时板。登录后可以继续，临时板也能一起转入账号。",
  offline: "连不上服务器，恢复网络后再试。",
  error: "没开成，再试一次。",
};

/** 超过这个时长仍未返回，就把 `slow` 置真，供调用方把文案从"正在…"换成"还在连接…" */
const SLOW_AFTER_MS = 400;

function readOffline(): boolean {
  return typeof navigator === "undefined" ? false : !navigator.onLine;
}

export function useCreateBoard(options: UseCreateBoardOptions = {}) {
  const { messageFor, spaceId } = options;
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<CreateBoardFailure | null>(null);
  const [offline, setOffline] = useState(readOffline);
  const busyRef = useRef(false);
  const slowTimer = useRef<number | null>(null);

  // 在线 / 离线：离线时 `start` 直接给可读提示，不发出注定失败的请求
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(
    () => () => {
      if (slowTimer.current !== null) window.clearTimeout(slowTimer.current);
    },
    [],
  );

  const buildFailure = useCallback(
    (kind: CreateBoardFailureKind, code?: string): CreateBoardFailure => ({
      kind,
      code,
      message: messageFor ? messageFor({ kind, code }) : DEFAULT_MESSAGES[kind],
    }),
    [messageFor],
  );

  const start = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);

    if (readOffline()) {
      setOffline(true);
      setError(buildFailure("offline"));
      return;
    }

    busyRef.current = true;
    setBusy(true);
    slowTimer.current = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);

    // 游客的置顶只存在本机；满 15 块淘汰时把本机置顶的板排除掉（登录用户由服务端忽略该字段）
    const pinnedIds = listRecentBoards()
      .filter((item) => item.pinned)
      .map((item) => item.id);
    const result = await createBoard(undefined, spaceId, pinnedIds);

    if (slowTimer.current !== null) {
      window.clearTimeout(slowTimer.current);
      slowTimer.current = null;
    }
    setSlow(false);
    busyRef.current = false;
    setBusy(false);

    if (result.ok) {
      recordRecentBoard({ id: result.data.id, title: result.data.title });
      window.location.href = `/board/${result.data.id}`;
      return;
    }
    if (result.status === 429 && result.code === "QUOTA_EXCEEDED") {
      setError(buildFailure("quota", result.code));
      return;
    }
    setError(buildFailure("error", result.code));
  }, [buildFailure, spaceId]);

  return { busy, slow, error, start };
}
