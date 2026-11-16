import { IconClose } from "./icons";

/**
 * 全站弹窗统一的圆形关闭键：32 圆 / 1px 描边 / 白纸底。
 *
 * 库自带弹窗的同类按钮由 BoardPage 注入（同样用 `.wb-dialog-close`），
 * 两边共用一套尺寸、悬停与聚焦表现，日夜跟随主题 token。
 * 放在 `.wb-dialog` 的直接子级时会自动吸附右上角（见 pages.css）。
 */
export function DialogClose({
  onClose,
  disabled,
  label = "关闭",
  testId,
}: {
  onClose: () => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
}) {
  return (
    <button
      className="wb-dialog-close"
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClose}
    >
      <IconClose size={16} />
    </button>
  );
}
