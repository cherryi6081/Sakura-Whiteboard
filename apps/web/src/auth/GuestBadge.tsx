/**
 * 游客态展示组件（M5，开发文档 §8.6.2）。
 *
 * - `GuestBadge`：顶栏「临时板」灰底小标签，悬停说明"属于当前浏览器"。
 * - `SaveToAccountBanner`：游客在板内看到的一次性横幅，登录后可认领该临时板。
 *
 * 两者都只做展示，不参与权限判定（身份在服务端）。
 */

export function GuestBadge({ title = "这块板属于当前浏览器，清 cookie / 换设备会失去临时板" }: { title?: string }) {
  return (
    <span
      data-testid="guest-badge"
      title={title}
      style={{
        fontSize: 11,
        color: "#6B5A61",
        background: "#EFE9EC",
        border: "1px solid #E3D8DD",
        borderRadius: 999,
        padding: "1px 8px",
      }}
    >
      临时板 · 游客
    </span>
  );
}

export function SaveToAccountBanner({
  onLogin,
  onDismiss,
}: {
  onLogin: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="save-to-account-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 16px",
        background: "#F4E3E9",
        borderBottom: "1px solid #E7BFCE",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        color: "#6B5A61",
      }}
    >
      <span>你正在以游客身份编辑，临时板 30 天无编辑会被清理。</span>
      <button
        data-testid="banner-login"
        type="button"
        onClick={onLogin}
        style={{
          padding: "3px 10px",
          fontSize: 12,
          color: "#fff",
          background: "#A85C7C",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        登录并保存到账号
      </button>
      <button
        data-testid="banner-dismiss"
        type="button"
        onClick={onDismiss}
        style={{ marginLeft: "auto", padding: 0, fontSize: 12, color: "#9A8A90", background: "transparent", border: "none", cursor: "pointer" }}
      >
        知道了
      </button>
    </div>
  );
}
