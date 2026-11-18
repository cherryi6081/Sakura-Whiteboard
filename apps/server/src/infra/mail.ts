import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * 邮件通道（账号安全：找回密码 / 邮箱验证）。
 *
 * - `MAIL_DRIVER=auto`（默认）：配置了 `SMTP_HOST` 走 SMTP，否则落到日志通道；
 * - `MAIL_DRIVER=log`：只写日志，本地开发与测试不需要任何真实凭据；
 * - `MAIL_DRIVER=smtp`：强制 SMTP；仍然缺 SMTP_HOST 时降级到日志并在启动后首次发信时告警。
 *
 * 发信失败由调用方决定如何提示；找回密码接口会吞掉失败并返回通用成功（防邮箱枚举），
 * 邮箱验证接口则会把失败明确返回给已登录用户。
 */

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type MailChannel = 'smtp' | 'log';

const DEFAULT_FROM = '"桜花白板" <no-reply@localhost>';

let transporter: Transporter | null = null;
let warnedMissingHost = false;

export function mailChannel(): MailChannel {
  if (config.MAIL_DRIVER === 'log') return 'log';
  if (config.SMTP_HOST) return 'smtp';
  return 'log';
}

function smtpTransporter(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth:
      config.SMTP_USER || config.SMTP_PASS
        ? { user: config.SMTP_USER ?? '', pass: config.SMTP_PASS ?? '' }
        : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

/** 发送一封纯文本邮件，返回实际使用的通道。SMTP 失败会抛错，调用方自行兜底。 */
export async function sendMail(message: MailMessage): Promise<MailChannel> {
  if (config.MAIL_DRIVER === 'smtp' && !config.SMTP_HOST && !warnedMissingHost) {
    warnedMissingHost = true;
    logger.warn('MAIL_DRIVER=smtp 但未配置 SMTP_HOST，邮件将写入日志通道');
  }

  if (mailChannel() === 'log') {
    if (config.NODE_ENV === 'production') {
      // 生产没有配置 SMTP 时绝不把一次性链接写进日志，只告警并丢弃，
      // 保证接口链路不崩，但也不会泄露重置 token。
      logger.error(
        { to: message.to, subject: message.subject },
        'mail log channel used in production: message dropped, configure SMTP_*',
      );
    } else {
      // 本地开发通道：完整正文（含一次性链接）只在这里出现，方便直接点开
      logger.info({ mail: message }, 'mail delivered to log channel (dev)');
    }
    return 'log';
  }

  await smtpTransporter().sendMail({
    from: config.MAIL_FROM ?? DEFAULT_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
  return 'smtp';
}
