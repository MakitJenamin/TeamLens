import { hash, verify } from '@node-rs/argon2';

// Mặc định của @node-rs/argon2 là argon2id (không truyền `algorithm` vì đó là const enum,
// không dùng được với `isolatedModules`). Test trong passwords.spec.ts kiểm tra tiền tố.

/** Hash mật khẩu bằng argon2id. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** So mật khẩu với hash; hash hỏng thì coi như sai. */
export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
