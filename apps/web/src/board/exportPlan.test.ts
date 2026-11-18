import { describe, expect, it } from "vitest";
import {
  buildExportFileName,
  exportAppStateOf,
  exportStamp,
  imageFileIds,
  liveSceneElements,
  missingImageFileIds,
  sanitizeExportTitle,
} from "./exportPlan";

describe("sanitizeExportTitle", () => {
  it("把文件系统非法字符换成 -", () => {
    expect(sanitizeExportTitle('季度/复盘\\v2: "最终"')).toBe("季度-复盘-v2- -最终-");
    expect(sanitizeExportTitle("*?<>|")).toBe("-----");
  });

  it("压缩空白并去掉开头连续的点", () => {
    expect(sanitizeExportTitle("  ..  三 月   规划  ")).toBe("三 月 规划");
  });

  it("超长标题截到 60 字", () => {
    expect(sanitizeExportTitle("板".repeat(80))).toHaveLength(60);
  });

  it("空标题与只含非法字符的标题回退成「白板」", () => {
    expect(sanitizeExportTitle("   ")).toBe("白板");
    expect(sanitizeExportTitle("///")).toBe("---");
    expect(sanitizeExportTitle("..")).toBe("白板");
  });
});

describe("exportStamp / buildExportFileName", () => {
  const date = new Date(2026, 2, 4, 9, 5);

  it("时间戳是本地时间 yyyyMMdd-HHmm", () => {
    expect(exportStamp(date)).toBe("20260304-0905");
  });

  it("文件名 = 安全板名 + 时间戳 + 扩展名", () => {
    expect(buildExportFileName("路线图", "png", date)).toBe("路线图-20260304-0905.png");
    expect(buildExportFileName("路线图", "svg", date)).toBe("路线图-20260304-0905.svg");
  });

  it("空标题用「白板」兜底", () => {
    expect(buildExportFileName("", "png", date)).toBe("白板-20260304-0905.png");
  });
});

describe("liveSceneElements / imageFileIds / missingImageFileIds", () => {
  const elements = [
    { id: "r1", type: "rectangle" },
    { id: "i1", type: "image", fileId: "asset-a" },
    { id: "dead", type: "image", fileId: "asset-b", isDeleted: true },
    { id: "i2", type: "image", fileId: "asset-a" },
    { id: "i3", type: "image" },
  ];

  it("导出只保留未删除元素", () => {
    expect(liveSceneElements(elements).map((item) => item.id)).toEqual(["r1", "i1", "i2", "i3"]);
  });

  it("图片 fileId 去重且忽略非图片元素", () => {
    expect(imageFileIds(liveSceneElements(elements))).toEqual(["asset-a"]);
  });

  it("missingImageFileIds 只返回还没有字节的图", () => {
    expect(missingImageFileIds(liveSceneElements(elements), {})).toEqual(["asset-a"]);
    expect(missingImageFileIds(liveSceneElements(elements), { "asset-a": {} })).toEqual([]);
    expect(missingImageFileIds(liveSceneElements(elements), null)).toEqual(["asset-a"]);
  });
});

describe("exportAppStateOf", () => {
  it("强制白底、不暗色、不嵌入场景", () => {
    const state = exportAppStateOf({ viewBackgroundColor: "#121212", exportScale: 2, theme: "dark" });
    expect(state.exportBackground).toBe(true);
    expect(state.viewBackgroundColor).toBe("#ffffff");
    expect(state.exportWithDarkMode).toBe(false);
    expect(state.exportEmbedScene).toBe(false);
    expect(state.exportScale).toBe(2);
    expect(state.theme).toBe("dark");
  });

  it("未设置导出倍率时按 1 倍", () => {
    expect(exportAppStateOf({}).exportScale).toBe(1);
  });
});
