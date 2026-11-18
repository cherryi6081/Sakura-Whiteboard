import type { Request } from 'express';
import { sendMail } from '../infra/mail.js';
import {
  EMAIL_VERIFY_TTL_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  issueEmailToken,
} from './emailTokens.js';
import { webAppUrl } from './oauthShared.js';

/**
 * 两类账号邮件的组装与发送。链接指向前端来源（开发 5173 / 生产同源），
 * token 只出现在邮件正文里，接口响应永远不回显。
 */

type MailUser = {
  id: string;
  email: string;
  displayName: string;
};

export async function sendPasswordResetEmail(req: Request, user: MailUser): Promise<void> {
  const { token } = await issueEmailToken({
    userId: user.id,
    email: user.email,
    purpose: 'password_reset',
    ttlSeconds: PASSWORD_RESET_TTL_SECONDS,
  });
  const link = `${webAppUrl(req, '/reset-password')}?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: '重置你的桜花白板密码',
    text: [
      `${user.displayName}，你好：`,
      '',
      '我们收到了重置密码的请求。请在 30 分钟内打开下面的链接设置新密码：',
      link,
      '',
      '链接只能使用一次。如果不是你本人操作，请忽略这封邮件，密码不会改变。',
    ].join('\n'),
  });
}

export async function sendEmailVerificationEmail(req: Request, user: MailUser): Promise<void> {
  const { token } = await issueEmailToken({
    userId: user.id,
    email: user.email,
    purpose: 'email_verify',
    ttlSeconds: EMAIL_VERIFY_TTL_SECONDS,
  });
  const link = `${webAppUrl(req, '/verify-email')}?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: '验证你的桜花白板邮箱',
    text: [
      `${user.displayName}，你好：`,
      '',
      '请打开下面的链接验证邮箱（24 小时内有效）：',
      link,
      '',
      '未验证邮箱不影响你继续使用白板；验证只是让账号状态更完整。',
    ].join('\n'),
  });
}
