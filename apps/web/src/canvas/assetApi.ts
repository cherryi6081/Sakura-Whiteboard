import { ASSET_MIME_TYPES, LIMITS } from "@whiteboard/shared";

/**
 * 图片资产客户端（v1.1）。
 *
 * 上传契约：`POST /api/boards/:id/assets`，body 是图片原始字节，`Content-Type` 为图片 mime。
 * 服务端会按魔数校验真实内容，这里先做一次本地预检，避免把明显不合法/超限的文件发出去。
 * 额外带 `x-wb-upload: 1`：强制跨站请求走预检，起到 CSRF 作用（比 Origin 判断更适配代理环境）。
 */

export type AssetInfo = {
  id: string;
  boardId: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
};

export class AssetApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AssetApiError";
  }

  /** 5xx / 429 / 网络中断值得重试；4xx 语义错误（格式、权限、配额）重试也不会成功。 */
  get retriable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408 || this.status === 0;
  }
}

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function isSupportedMime(mime: string): boolean {
  return (ASSET_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * 选一个"声明用"的 mime。`file.type` 在部分拖拽/剪贴板场景为空，
 * 这时用扩展名推断；真实内容仍由服务端魔数裁决，声明错了会被 415。
 */
export function mimeOfFile(file: File): string | null {
  if (isSupportedMime(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const guessed = EXT_TO_MIME[ext];
  return guessed && isSupportedMime(guessed) ? guessed : null;
}

/** 从剪贴板/拖拽里挑出图片文件（`File` 与 `DataTransferItem` 都会被归一成 `File`）。 */
export function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((file) => mimeOfFile(file) !== null);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorOf(payload: unknown): { code?: string; message?: string } {
  if (typeof payload !== "object" || payload === null) return {};
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return {};
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

/** 本地预检：超限或非白名单直接给出可读原因，不发请求。 */
export function precheckImageFile(file: File): { mime: string } | { error: string } {
  const mime = mimeOfFile(file);
  if (!mime) return { error: `不支持的图片格式：${file.type || file.name.split(".").pop() || "未知"}` };
  if (file.size <= 0) return { error: "文件为空" };
  if (file.size > LIMITS.assetMaxBytes) return { error: `单张图片上限 ${LIMITS.assetMaxBytes / 1024 / 1024}MB` };
  return { mime };
}

export async function uploadBoardAsset(params: {
  boardId: string;
  blob: Blob;
  mime: string;
  shareToken?: string | null;
}): Promise<{ asset: AssetInfo; deduped: boolean }> {
  let response: Response;
  try {
    response = await fetch(`/api/boards/${encodeURIComponent(params.boardId)}/assets`, {
      method: "POST",
      headers: {
        "Content-Type": params.mime,
        "x-wb-upload": "1",
        ...(params.shareToken ? { "x-share-token": params.shareToken } : {}),
      },
      body: params.blob,
      credentials: "include",
    });
  } catch {
    throw new AssetApiError("NETWORK_ERROR", "网络异常，图片上传失败", 0);
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const { code, message } = errorOf(payload);
    throw new AssetApiError(code ?? "UPLOAD_FAILED", message ?? `图片上传失败（HTTP ${response.status}）`, response.status);
  }

  const body = payload as { asset?: AssetInfo; deduped?: boolean } | null;
  if (!body?.asset) throw new AssetApiError("BAD_RESPONSE", "上传响应缺少资产信息", response.status);
  return { asset: body.asset, deduped: Boolean(body.deduped) };
}

async function fetchAssetDescriptor(
  assetId: string,
  shareToken?: string | null,
): Promise<{ url: string; mime: string; width: number; height: number }> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/url`, {
    headers: shareToken ? { "x-share-token": shareToken } : undefined,
    credentials: "include",
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const { code, message } = errorOf(payload);
    throw new AssetApiError(code ?? "ASSET_URL_FAILED", message ?? `图片地址获取失败（HTTP ${response.status}）`, response.status);
  }
  const body = payload as { url?: string; mime?: string; width?: number; height?: number } | null;
  if (!body?.url) throw new AssetApiError("BAD_RESPONSE", "图片地址响应缺少 url", response.status);
  return {
    url: body.url,
    mime: body.mime ?? "application/octet-stream",
    width: Number(body.width ?? 0),
    height: Number(body.height ?? 0),
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AssetApiError("READ_FAILED", "图片读取失败", 0));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

/** 取回图片并转成 Excalidraw 需要的 dataURL。 */
export async function fetchAssetAsDataUrl(
  assetId: string,
  shareToken?: string | null,
): Promise<{ dataUrl: string; mime: string }> {
  const descriptor = await fetchAssetDescriptor(assetId, shareToken);
  const response = await fetch(descriptor.url, { credentials: "include" });
  if (!response.ok) {
    throw new AssetApiError("ASSET_FETCH_FAILED", `图片下载失败（HTTP ${response.status}）`, response.status);
  }
  const blob = await response.blob();
  return { dataUrl: await blobToDataUrl(blob), mime: descriptor.mime };
}
