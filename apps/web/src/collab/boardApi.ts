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

async function requestJson<T>(url: string, shareToken?: string | null): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
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
