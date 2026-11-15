import { IconUser } from "./icons";

type Props = {
  /** 与顶栏「回收站」(15) /「退出登录」(16) 同一套线稿口径，默认 16 */
  size?: number;
  className?: string;
};

/**
 * 导航/顶栏里的用户标识：与「回收站」「退出登录」同源的 1.5px 线稿图标，
 * 颜色随主题继承（白天 --neutral-800 / 夜间 --ink-strong），不再是彩色字母圆底。
 * 纯装饰：aria-hidden，可访问名由紧随其后的用户名承担。
 */
export function UserMark({ size = 16, className }: Props) {
  return (
    <span className={`wb-user-mark${className ? ` ${className}` : ""}`} aria-hidden="true" data-testid="user-mark">
      <IconUser size={size} />
    </span>
  );
}
