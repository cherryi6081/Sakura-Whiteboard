import { useEffect, useState } from "react";
import { AuthPage } from "./AuthPage";
import { ClaimDialog, claimSnoozed } from "./ClaimDialog";
import { fetchClaimPreview, type ClaimPreview } from "./authApi";

/**
 * 登录/注册完整流程（M5，开发文档 §8.6.3）：
 * 表单 → 成功后拉 `claim-preview` → `count > 0` 且未 snooze 时弹认领框（默认全选、可取消）
 * → 关闭/完成后跳回 `next`（仅站内路径）或首页。
 */
export function AuthFlow({ mode, next }: { mode: "login" | "register"; next: string | null }) {
  const [currentMode, setCurrentMode] = useState(mode);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [done, setDone] = useState(false);

  const gotoNext = () => {
    window.location.href = next ?? "/";
  };

  useEffect(() => {
    if (!done) return;
    if (preview && preview.count > 0) return;
    gotoNext();
    // next/preview 变化时不应重复跳转，这里只关心一次完成事件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, preview]);

  const afterAuth = async () => {
    if (claimSnoozed()) {
      gotoNext();
      return;
    }
    const res = await fetchClaimPreview();
    if (res.ok && res.data.count > 0) {
      setPreview(res.data);
      return;
    }
    gotoNext();
  };

  return (
    <>
      <AuthPage mode={currentMode} onDone={() => void afterAuth()} onModeChange={setCurrentMode} />
      {preview ? (
        <ClaimDialog
          preview={preview}
          onClose={() => {
            setPreview(null);
            setDone(true);
          }}
          onClaimed={(result) => {
            setPreview(null);
            setDone(true);
            if (result.transferred > 0) {
              // 认领后回到目标板，让服务端用新身份重新解析权限
              window.location.href = next ?? "/";
            }
          }}
        />
      ) : null}
    </>
  );
}
