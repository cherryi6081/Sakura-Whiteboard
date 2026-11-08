import argon2 from 'argon2';

/**
 * 密码哈希：argon2id（开发文档 §7.1.1）。
 * 参数按 OWASP 建议的 19 MiB / t=2 / p=1；盐由库自动生成并编码进 PHC 字符串。
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** 校验失败（含哈希格式损坏）统一返回 false，不向调用方泄漏原因。 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
