/**
 * Excalidraw 0.18.1 内置的 zh-CN 语言包缺少 0.18 新增的一批词条（右键菜单分组、
 * 箭头类型、字体选择、帮助弹窗、命令面板等），库在缺词条时会回退英文。
 *
 * 这里按「缺什么补什么」的原则做一份精确文本兜底：只替换与英文原文完全一致的
 * 文本节点 / title / aria-label / placeholder，已经由 zh-CN 翻译过的文案不会命中。
 * 等上游语言包补齐后，整个文件可以直接删除。
 *
 * 观察范围限定在 Excalidraw 容器内；素材库条目（用户自己命名）与输入框内容不碰。
 */
const ZH: Record<string, string> = {
  // labels
  "Change stroke color": "更改描边颜色",
  "Change background color": "更改背景颜色",
  "Crow's foot (many)": "鸦爪（多）",
  "Crow's foot (one)": "鸦爪（单）",
  "Crow's foot (one or many)": "鸦爪（单或多）",
  "More options": "更多选项",
  "Arrow type": "箭头类型",
  "Sharp arrow": "尖角箭头",
  "Curved arrow": "曲线箭头",
  "Elbow arrow": "折线箭头",
  "Clear canvas": "清空画布",
  "Toggle grid": "显示/隐藏网格",
  "Load scene from file": "从文件载入场景",
  "Show font picker": "选择字体",
  Theme: "主题",
  "Type or paste your link here": "在此输入或粘贴链接",
  "Go to target element": "跳转到目标图形",
  "Edit arrow": "编辑箭头",
  "Follow us": "关注我们",
  "Discord chat": "Discord 聊天",
  "Zoom to fit in viewport": "缩放至适合视口",
  "Zoom to fit selection": "缩放至适合选区",
  "Zoom to fit all elements": "缩放至适合全部图形",
  "Install Excalidraw locally (PWA)": "本地安装 Excalidraw（PWA）",
  "Enable text auto-resizing": "启用文本自动调整大小",
  "Image cropping": "图片裁剪",
  "Uncropped dimension": "未裁剪尺寸",
  "Copy link to object": "复制图形链接",
  "Link to object": "链接到图形",
  "Wrap selection in frame": "将选区放入画框",

  // element（统计、命令面板里的元素类型名）
  Rectangle: "矩形",
  Diamond: "菱形",
  Ellipse: "椭圆",
  Arrow: "箭头",
  Line: "线条",
  Freedraw: "自由书写",
  Text: "文字",
  Image: "图片",
  Group: "编组",
  Frame: "画框",
  "Wireframe to code": "线框图转代码",
  "Web Embed": "网页嵌入",
  Selection: "选区",
  IFrame: "内嵌网页",

  // elementLink
  "Click on a shape on canvas or paste a link.": "点击画布上的图形，或粘贴链接。",
  "Linked object wasn't found on canvas.": "画布上未找到链接的对象。",

  // search
  "Find on canvas": "在画布中查找",
  "No matches found...": "未找到匹配项…",
  "Find text on canvas...": "在画布中查找文本…",

  // buttons
  "Copy link": "复制链接",
  "System mode": "跟随系统",

  // errors
  "Couldn't save library to storage. Please save your library to a file locally to make sure you don't lose changes.":
    "无法把素材库保存到本地存储，请先将素材库导出为文件，以免丢失改动。",

  // hints
  "Escape to dismiss search": "按 Esc 关闭查找",
  "Hold CtrlOrCmd and Arrow key to create a flowchart": "按住 Ctrl/Cmd 和方向键创建流程图",
  "Double click the image or press ENTER to crop the image": "双击图片或按回车键裁剪图片",
  "Click outside the image or press ENTER or ESCAPE to finish cropping": "点击图片外部，或按回车 / Esc 完成裁剪",

  // helpDialog
  "Create a flowchart from a generic element": "用通用元素创建流程图",
  "Navigate a flowchart": "在流程图中导航",
  "Crop image": "裁剪图片",
  "Finish image cropping": "完成图片裁剪",

  // stats
  Shapes: "图形",
  "Canvas & Shape properties": "画布与图形属性",
  General: "常规",
  "Shape properties": "图形属性",

  // toast
  "Link copied to clipboard": "链接已复制到剪贴板",

  // quickSearch
  "Quick search": "快速搜索",

  // fontList
  "In this scene": "此场景中",
  "Available fonts": "可用字体",
  "No fonts found": "未找到字体",
  old: "旧版",

  // userList
  "No users found": "未找到用户",
  "Click on user to follow": "点击用户以跟随",
  "You're currently following this user": "你正在跟随该用户",
  "User is in a voice call": "用户正在语音通话中",
  "User's microphone is muted": "用户已静音",
  "User is speaking": "用户正在发言",

  // commandPalette
  "Command palette": "命令面板",
  Select: "选择",
  Confirm: "确认",
  Close: "关闭",
  "Recently used": "最近使用",
  "Search menus, commands, and discover hidden gems": "搜索菜单、命令，发现隐藏功能",
  "No matching commands...": "无匹配命令…",
  "Command is not available...": "该命令当前不可用…",

  // 字体族按钮的 title（库内写死，不走 i18n）
  "Hand-drawn": "手绘",
  Normal: "标准",
  Code: "代码",

  // 帮助弹窗里的方向键名称
  "Arrow Key": "方向键",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  "PgUp/PgDn": "上翻页/下翻页",
};

const ATTRS = ["title", "aria-label", "placeholder", "alt"] as const;

/** 精确整句替换 + 少量带计数的动态文案 */
function translateValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const exact = ZH[trimmed];
  if (exact) return value.replace(trimmed, exact);

  const results = trimmed.match(/^(\d+)\s+results?$/);
  if (results) return value.replace(trimmed, `${results[1]} 条结果`);

  const svgToast = trimmed.match(/^Copied (.+) to clipboard as SVG\n\((Light|Dark)\)$/s);
  if (svgToast) {
    const scheme = svgToast[2] === "Light" ? "浅色" : "深色";
    return value.replace(trimmed, `已将${svgToast[1]}复制为 SVG 到剪贴板（${scheme}）`);
  }
  if (trimmed === "(Light)") return value.replace(trimmed, "（浅色）");
  if (trimmed === "(Dark)") return value.replace(trimmed, "（深色）");

  const paletteHint = trimmed.match(/^For Command palette, use (.+)$/);
  if (paletteHint) return value.replace(trimmed, `命令面板快捷键：${paletteHint[1]}`);
  return null;
}

/**
 * 弹窗（帮助、导出、画布背景等）是 Excalidraw 用 portal 挂到 body 上的
 * `.excalidraw-modal-container`，不在画布 DOM 里，所以观察 body、按容器白名单过滤。
 */
const SCOPE = ".wb-canvas, .excalidraw-modal-container";

function inScope(el: Element | null): boolean {
  return Boolean(el?.closest(SCOPE));
}

function skipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  if (!inScope(parent)) return true;
  // 素材库条目是用户自己命名的内容，输入框/可编辑区也不碰
  return Boolean(parent.closest(".library-unit, textarea, input, [contenteditable='true']"));
}

function translateText(node: Text): void {
  if (skipTextNode(node)) return;
  const value = node.nodeValue;
  if (!value) return;
  const next = translateValue(value);
  if (next !== null && next !== value) node.nodeValue = next;
}

function translateAttributes(el: Element): void {
  if (!inScope(el)) return;
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const next = translateValue(value);
    if (next !== null && next !== value) el.setAttribute(name, next);
  }
}

function translateTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  translateAttributes(el);
  for (const child of el.querySelectorAll("*")) translateAttributes(child);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    translateText(node as Text);
    node = walker.nextNode();
  }
}

/**
 * 在 Excalidraw 容器上安装兜底翻译，返回清理函数。
 * 菜单/弹窗是库动态挂载的，用 MutationObserver 跟上新增节点、文案变化与属性变化。
 */
export function installExcalidrawZhFallback(): () => void {
  const pending = new Set<Node>();
  let frame = 0;

  const flush = () => {
    frame = 0;
    for (const node of pending) {
      pending.delete(node);
      translateTree(node);
    }
  };
  const enqueue = (node: Node) => {
    pending.add(node);
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") enqueue(record.target);
      else if (record.type === "characterData") enqueue(record.target);
      else record.addedNodes.forEach(enqueue);
    }
  });

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
  translateTree(document.body);

  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
