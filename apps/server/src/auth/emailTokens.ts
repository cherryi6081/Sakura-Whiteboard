import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../infra/db.js';

/**
 * 邮件一次性令牌（找回密码 / 邮箱验证）。
 *
 * - 明文只存在于发出去的链接里，库里只存 SHA-256；
 * - `consumed_at` 由消费语句原子设置，同一 token 并发消费只有一次成功；
 * - 签发新 token 时把同用户同用途的旧 token 全部标记为已消费，始终只有最新链接可用。
 */

export type EmailTokenPurpose = 'password_reset' | 'email_verify';

export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;
export const EMAIL_VERIFY_TTL_SECONDS = 24 * 60 * 60;

export function hashEmailToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function newEmailToken(): string {
  return randomBytes(32).toString('base64url');
}

export type IssuedEmailToken = {
  token: string;
  expiresAt: Date;
};

/** 签发一枚新令牌，并作废该用户同用途的旧令牌。 */
export async function issueEmailToken(input: {
  userId: string;
  email: string;
  purpose: EmailTokenPurpose;
  ttlSeconds: number;
}): Promise<IssuedEmailToken> {
  const token = newEmailToken();
  const tokenHash = hashEmailToken(token);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  const client = await pool.connect();
  try {
    await client.query('begin');
    // 同一用户同一用途串行签发，避免并发请求留下两枚可用 token
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `${input.userId}:${input.purpose}`,
    ]);
    await client.query(
      `update email_tokens
          set consumed_at = now()
        where user_id = $1 and purpose = $2 and consumed_at is null`,
      [input.userId, input.purpose],
    );
    await client.query(
      `insert into email_tokens (user_id, purpose, email, token_hash, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [input.userId, input.purpose, input.email, tokenHash, expiresAt],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { token, expiresAt };
}

export type ConsumedEmailToken = {
  id: string;
  userId: string;
  email: string;
};

/**
 * 原子消费：只有「未消费且未过期」的令牌能成功，返回归属用户；
 * 其它情况统一返回 null，不区分原因。
 */
export async function consumeEmailToken(
  rawToken: string,
  purpose: EmailTokenPurpose,
): Promise<ConsumedEmailToken | null> {
  const tokenHash = hashEmailToken(rawToken);
  const { rows } = await pool.query<{ id: string; user_id: string; email: string }>(
    `update email_tokens
        set consumed_at = now()
      where token_hash = $1
        and purpose = $2
        and consumed_at is null
        and expires_at > now()
      returning id, user_id, email`,
    [tokenHash, purpose],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, userId: row.user_id, email: row.email };
}
