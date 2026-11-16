import { API, PASSWORD } from "./config.mjs";

/**
 * 极简 cookie-jar HTTP 客户端：只用 Node 内置 fetch，不引第三方。
 * 每个 Api 实例代表一个独立身份（登录用户或游客）。
 */
export class Api {
  constructor(label = "api") {
    this.label = label;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** 浏览器注入用：只取会话 cookie（wb_sess / wb_gid） */
  get sessionCookie() {
    const sid = this.cookies.get("wb_sess") ?? this.cookies.get("wb_gid");
    const name = this.cookies.has("wb_sess") ? "wb_sess" : "wb_gid";
    return sid ? `${name}=${sid}` : "";
  }

  async request(method, path, { body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (this.cookies.size > 0) init.headers.cookie = this.cookieHeader();

    const response = await fetch(`${API}${path}`, init);
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: response.status, json, headers: response.headers };
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body) {
    return this.request("POST", path, { body: body ?? {} });
  }

  patch(path, body) {
    return this.request("PATCH", path, { body: body ?? {} });
  }

  put(path, body) {
    return this.request("PUT", path, { body: body ?? {} });
  }

  delete(path) {
    return this.request("DELETE", path);
  }

  async register(email, displayName = "e2e") {
    const res = await this.post("/api/auth/register", { email, password: PASSWORD, displayName });
    if (res.status !== 201) throw new Error(`注册失败 ${res.status}: ${JSON.stringify(res.json)}`);
    return res.json;
  }

  async login(email) {
    const res = await this.post("/api/auth/login", { email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`登录失败 ${res.status}: ${JSON.stringify(res.json)}`);
    return res.json;
  }

  async createBoard({ title, spaceId, pinnedIds } = {}) {
    return this.post("/api/boards", { title, spaceId, pinnedIds });
  }

  async list(spaceId, limit = 30) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (spaceId) query.set("space", spaceId);
    return this.get(`/api/boards?${query.toString()}`);
  }

  async opened(boardId) {
    return this.post(`/api/boards/${boardId}/opened`);
  }

  async pin(boardId, pinned) {
    return this.patch(`/api/boards/${boardId}/pin`, { pinned });
  }

  async order(boardId, body) {
    return this.patch(`/api/boards/${boardId}/order`, body);
  }

  async sortMode(mode) {
    return this.put("/api/boards/sort-mode", { mode });
  }

  async trash() {
    return this.get("/api/boards/trash");
  }

  async removeBoard(boardId) {
    return this.delete(`/api/boards/${boardId}`);
  }

  async restore(boardId) {
    return this.post(`/api/boards/${boardId}/restore`);
  }

  async createShare(boardId, permission = "read", expiresInDays = 7) {
    return this.post(`/api/boards/${boardId}/share-links`, { permission, expiresInDays });
  }

  async revokeShare(boardId, linkId) {
    return this.delete(`/api/boards/${boardId}/share-links/${linkId}`);
  }

  async createSpace(name) {
    return this.post("/api/spaces", { name });
  }

  async invite(spaceId, role = "viewer") {
    return this.post(`/api/spaces/${spaceId}/invites`, { role });
  }

  async acceptInvite(token) {
    return this.post(`/api/invites/${token}/accept`);
  }
}

export function uniqueEmail(tag) {
  return `e2e.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/** 建一个已登录用户并返回 { api, email, user } */
export async function registerUser(tag) {
  const api = new Api(tag);
  const email = uniqueEmail(tag);
  const user = await api.register(email, `e2e ${tag}`);
  return { api, email, user };
}

/** 建一个游客会话（第一次建板时服务端签发 wb_gid） */
export async function registerGuest() {
  const api = new Api("guest");
  const first = await api.createBoard({ title: "游客第一块" });
  if (first.status !== 201) throw new Error(`游客建板失败 ${first.status}: ${JSON.stringify(first.json)}`);
  return { api, firstBoard: first.json };
}
