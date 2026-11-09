import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetInfo } from "../canvas/assetApi";
import { AssetApiError, imageFilesOf, precheckImageFile, uploadBoardAsset } from "../canvas/assetApi";

/**
 * 图片上传的入口与状态（v1.1）。
 *
 * 三条入口统一收口到 `start`：
 * 1. window 捕获阶段拦截 `paste`（图片剪贴板）；
 * 2. window 捕获阶段拦截 `dragover` / `drop`（拖入画布）；
 * 3. 工具栏按钮触发隐藏的 file input。
 *
 * 上传期间只显示占位条目，**不往画布放半截元素**：只有服务端 201 后才插入图片元素。
 * 失败保留可重试的条目；4xx 语义错误（格式/配额/权限）也留在托盘里给出原因。
 */

export type UploadItem = {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "error";
  message?: string;
  file: File;
  point: { clientX: number; clientY: number } | null;
};

type UploadOptions = {
  boardId: string;
  shareToken: string | null;
  canUpload: boolean;
  blockedMessage: string;
  onBlocked: (message: string) => void;
  onUploaded: (asset: AssetInfo, dataUrl: string, point: { clientX: number; clientY: number } | null) => void;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AssetApiError("READ_FAILED", "图片读取失败", 0));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function hasFileItems(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.items ?? []).some((item) => item.kind === "file");
}

let uploadSeq = 0;
const nextKey = () => `upload_${++uploadSeq}_${Date.now()}`;

export function useImageUpload(options: UploadOptions) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const patch = useCallback((key: string, updater: (item: UploadItem) => UploadItem) => {
    setItems((prev) => prev.map((item) => (item.key === key ? updater(item) : item)));
  }, []);

  const remove = useCallback((key: string) => {
    setItems((prev) => prev.filter((item) => item.key !== key));
  }, []);

  /** 上传单条；成功后移除条目并交给画布插入。 */
  const upload = useCallback(
    async (item: UploadItem) => {
      const { boardId, shareToken, onUploaded } = optionsRef.current;
      const pre = precheckImageFile(item.file);
      if ("error" in pre) {
        patch(item.key, (entry) => ({ ...entry, state: "error", message: pre.error }));
        return;
      }

      try {
        const dataUrl = await fileToDataUrl(item.file);
        const { asset } = await uploadBoardAsset({ boardId, blob: item.file, mime: pre.mime, shareToken });
        onUploaded(asset, dataUrl, item.point);
        remove(item.key);
      } catch (err) {
        const message =
          err instanceof AssetApiError
            ? err.status === 401
              ? "登录后才能上传图片"
              : err.message
            : "图片上传失败，请重试";
        patch(item.key, (entry) => ({ ...entry, state: "error", message }));
      }
    },
    [patch, remove],
  );

  const start = useCallback(
    (files: File[], point: { clientX: number; clientY: number } | null) => {
      const { canUpload, blockedMessage, onBlocked } = optionsRef.current;
      if (files.length === 0) return;
      if (!canUpload) {
        onBlocked(blockedMessage);
        return;
      }

      const created: UploadItem[] = [];
      for (const file of files.slice(0, 5)) {
        const pre = precheckImageFile(file);
        created.push({
          key: nextKey(),
          name: file.name || "粘贴的图片",
          size: file.size,
          state: "error",
          message: "error" in pre ? pre.error : undefined,
          file,
          point,
        });
      }

      setItems((prev) => [...prev, ...created]);

      // 本地预检失败的留在错误态；其余立刻置为 uploading 并开始上传
      for (const item of created) {
        if (item.message) continue;
        patch(item.key, (entry) => ({ ...entry, state: "uploading" }));
        void upload(item);
      }
    },
    [patch, upload],
  );

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((entry) => entry.key === key);
      if (!item) return;
      patch(key, (entry) => ({ ...entry, state: "uploading", message: undefined }));
      void upload(item);
    },
    [patch, upload],
  );

  /** 粘贴：捕获阶段截住，避免 Excalidraw 自己把图片做成"本地 base64 元素" */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = imageFilesOf(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      start(files, null);
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFileItems(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget !== null) return;
      setDragActive(false);
    };

    const onDrop = (event: DragEvent) => {
      const files = imageFilesOf(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);
      start(files, { clientX: event.clientX, clientY: event.clientY });
    };

    window.addEventListener("paste", onPaste, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("paste", onPaste, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [start]);

  return {
    items,
    dragActive,
    start,
    retry,
    remove,
  };
}
