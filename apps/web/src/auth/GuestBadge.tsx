import { IconClose } from "../ui/icons";

/**
 * 游客态展示组件（M5，开发文档 §8.6.2；视觉方案 §4.3）。
 *
 * - `GuestBadge`：顶栏「临时板 · 游客」灰玫瑰胶囊，悬停说明"属于当前浏览器"。
 * - `SaveToAccountBanner`：游客在板内看到的一次性横幅，登录后可认领该临时板。
 *
 * 两者都只做展示，不参与权限判定（身份在服务端）。
 */

export function GuestBadge({ title = "这块板属于当前浏览器，清 cookie / 换设备会失去临时板" }: { title?: string }) {
  return (
    <span className="wb-badge wb-badge--guest" data-testid="guest-badge" title={title}>
      临时板 · 游客
    </span>
  );
}

export function SaveToAccountBanner({ onLogin, onDismiss }: { onLogin: () => void; onDismiss: () => void }) {
  return (
    <div className="wb-banner wb-banner--info" data-testid="save-to-account-banner" role="status">
      <span>你正在以游客身份编辑，临时板 30 天无编辑会被清理。</span>
      <span className="wb-banner__spacer" />
      <button className="wb-btn wb-btn--primary wb-btn--sm" data-testid="banner-login" type="button" onClick={onLogin}>
        登录并保存到账号
      </button>
      <button
        className="wb-drawer__close"
        data-testid="banner-dismiss"
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
