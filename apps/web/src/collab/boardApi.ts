import type { ElementOp } from '@whiteboard/shared';

/**
 * M2-C5 的 REST 客户：补拉（`GET /api/boards/:id/ops`）与整板快照。
 * 同源请求：开发期由 Vite 代理 `/api`，生产由反向代理转发。
 */

export type PulledOp = {
  seq: number;
  opId: string;
  clientId: string;
  kind: string;
  elementId: string;
  op: ElementOp;
};

export type OpsPage = {
  boardId: string;
  since: number;
  lastSeq: number;
  resync: boolean;
  hasMore: boolean;
  nextSince: number;
  ops: PulledOp[];
};

export type SnapshotPayload = {
  boardId: string;
  seq: number;
  elements: Record<string, unknown>[];
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

async function requestJson<T>(
  url: string,
  shareToken?: string | null,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      signal,
      headers: { accept: 'application/json', ...(shareToken ? { 'x-share-token': shareToken } : {}) },
    });
    const body = (await res.json().catch(() => null)) as
      | (T & { error?: { code?: string } })
      | null;
    if (!res.ok) {
      return { ok: false, status: res.status, code: body?.error?.code ?? `HTTP_${res.status}` };
    }
    if (!body) return { ok: false, status: res.status, code: 'EMPTY_BODY' };
    return { ok: true, data: body };
  } catch (err) {
    return { ok: false, status: 0, code: err instanceof Error ? err.name : 'NETWORK_ERROR' };
  }
}

export function fetchOpsPage(
  boardId: string,
  since: number,
  limit: number,
  shareToken?: string | null,
): Promise<ApiResult<OpsPage>> {
  const query = new URLSearchParams({ since: String(since), limit: String(limit) });
  return requestJson<OpsPage>(`/api/boards/${encodeURIComponent(boardId)}/ops?${query.toString()}`, shareToken);
}

export function fetchSnapshot(boardId: string, shareToken?: string | null): Promise<ApiResult<SnapshotPayload>> {
  return requestJson<SnapshotPayload>(`/api/boards/${encodeURIComponent(boardId)}/snapshot`, shareToken);
}

export type WatermarkPayload = {
  boardId: string;
  /** 服务端权威水位（boards.last_seq） */
  lastSeq: number;
  /** 最近一份快照的 seq；落后 lastSeq 时服务端会在 /snapshot 里现算 */
  snapshotSeq: number;
};

/**
 * 开板前的轻量水位校验：只读 `last_seq` + 快照 seq 两列，不读元素表。
 *
 * 超时只用来兜住"请求挂死"（离线/半开连接），不用来掩盖一致性：
 * 正常情况下必须拿到水位才决定首帧画什么。
 */
export function fetchWatermark(
  boardId: string,
  shareToken?: string | null,
  timeoutMs = 3000,
): Promise<ApiResult<WatermarkPayload>> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  return requestJson<WatermarkPayload>(
    `/api/boards/${encodeURIComponent(boardId)}/watermark`,
    shareToken,
    controller?.signal,
  ).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
