/**
 * M5：账号与游客认领的 REST 客户端（开发文档 §7.1.1 / §7.1.7）。
 *
 * 会话是 HttpOnly cookie，前端只负责发请求（`credentials: 'same-origin'`）与展示
 * `/api/auth/me` 的结果；**不读 cookie，也不保存任何 token 到 localStorage**。
 */

export type AuthUser = { id: string; email: string | null; displayName: string; color: string };

export type MePayload = {
  user: AuthUser;
  methods: string[];
  loginMethod: 'password' | 'oauth:github' | null;
};

export type ClaimPreview = {
  count: number;
  boards: { id: string; title: string; lastEditedAt: string }[];
  /** 当前浏览器是否仍持有效游客 cookie；false 时前端不弹提示 */
  guestActive: boolean;
};

export type ClaimResult = {
  /** 本次实际转入的块数；重复提交时为 0 */
  transferred: number;
  boards: { id: string; title: string }[];
  userId: string;
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

export async function request<T>(url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
      ...init,
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as (T & { error?: { code?: string } }) | null) : null;
    if (!res.ok) {
      return { ok: false, status: res.status, code: body?.error?.code ?? `HTTP_${res.status}` };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, status: 0, code: err instanceof Error ? err.name : 'NETWORK_ERROR' };
  }
}

export function register(input: { email: string; password: string; displayName: string }): Promise<ApiResult<MePayload>> {
  return request<MePayload>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
}

export function login(input: { email: string; password: string }): Promise<ApiResult<MePayload>> {
  return request<MePayload>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
}

export async function logout(): Promise<ApiResult<null>> {
  const res = await request<null>('/api/auth/logout', { method: 'POST' });
  return res;
}

export function fetchMe(): Promise<ApiResult<MePayload>> {
  return request<MePayload>('/api/auth/me');
}

export function fetchClaimPreview(): Promise<ApiResult<ClaimPreview>> {
  return request<ClaimPreview>('/api/guest/claim-preview');
}

/** 全转或整体拒绝：不传 id，服务端只认当前 cookie 里的游客身份。 */
export function claimGuestBoards(): Promise<ApiResult<ClaimResult>> {
  return request<ClaimResult>('/api/guest/claim', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
