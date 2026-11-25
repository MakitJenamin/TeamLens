import { createHash, randomBytes } from 'node:crypto';

/** Chuỗi ngẫu nhiên (mặc định 32 byte), mã hóa base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 dạng hex, dùng để lưu token trong DB thay cho token gốc. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
