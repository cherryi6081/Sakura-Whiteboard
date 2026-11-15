import { useEffect, useState } from "react";
import { AuthPage } from "./AuthPage";
import { ClaimDialog } from "./ClaimDialog";
import { migrateGuestLocalData } from "./claimLocalData";
import { fetchClaimPreview, type ClaimPreview } from "./authApi";

/**
 * 登录/注册完整流程（M5，开发文档 §8.6.3）：
 * 表单 → 成功后拉 `claim-preview` → `count > 0` 时弹「全部转入 / 暂不」
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
    const res = await fetchClaimPreview();
    if (res.ok && res.data.count > 0 && res.data.guestActive !== false) {
      setPreview(res.data);
      return;
    }
    gotoNext();
  };

  return (
    <>
      <AuthPage mode={currentMode} next={next} onDone={() => void afterAuth()} onModeChange={setCurrentMode} />
      {preview ? (
        <ClaimDialog
          preview={preview}
          onClose={() => {
            setPreview(null);
            setDone(true);
          }}
          onOrganize={() => {
            // 登录流程里没有列表可整理，直接去「我的白板」腾名额；
            // 那边打开时会重新拉一次 claim-preview，转入入口还在。
            setPreview(null);
            window.location.href = "/boards";
          }}
          onClaimed={(result) => {
            setPreview(null);
            if (result.transferred > 0) {
              // 先把本机缩略图/最近打开搬到账号下，再跳转，避免列表首帧没有图
              void migrateGuestLocalData(result.userId, result.boards.map((board) => board.id)).finally(() => {
                window.location.href = next ?? "/";
              });
              return;
            }
            setDone(true);
          }}
        />
      ) : null}
    </>
  );
}
