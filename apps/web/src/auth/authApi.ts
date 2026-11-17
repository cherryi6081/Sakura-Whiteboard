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

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message?: string };

export async function request<T>(url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
      ...init,
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as (T & { error?: { code?: string; message?: string } }) | null) : null;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: body?.error?.code ?? `HTTP_${res.status}`,
        message: body?.error?.message,
      };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, status: 0, code: err instanceof Error ? err.name : 'NETWORK_ERROR' };
  }
}

export function register(input: { email: string; password: string; displayName: string }): Promise<ApiResult<MePayload>> {
  return request<MePayload>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
}

/** 登录页用：哪些第三方登录已配置。失败按未启用处理，绝不因此卡住表单。 */
export async function fetchProviders(): Promise<{ github: boolean }> {
  const result = await request<{ github?: boolean }>('/api/auth/providers', { method: 'GET' });
  return { github: result.ok ? Boolean(result.data.github) : false };
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

/** 改显示名；返回体与 GET /auth/me 的 user 同构，可直接替换本地账号状态。 */
export function updateProfile(input: { displayName: string }): Promise<ApiResult<{ user: AuthUser }>> {
  return request<{ user: AuthUser }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(input) });
}

/** 登录态改密；成功后服务端会作废其它会话，但当前标签页会拿到新 cookie。 */
export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<ApiResult<{ ok: true }>> {
  return request<{ ok: true }>('/api/auth/password', { method: 'POST', body: JSON.stringify(input) });
}

/** 销号（不可恢复）：用户行保留为停用，业务数据物理删除。 */
export function deleteAccount(input: { currentPassword: string }): Promise<ApiResult<{ ok: true }>> {
  return request<{ ok: true }>('/api/auth/me', { method: 'DELETE', body: JSON.stringify(input) });
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
