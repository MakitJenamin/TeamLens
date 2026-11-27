import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

function keyFromSecret(secretBase64: string): Buffer {
  const key = Buffer.from(secretBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('TEAMLENS_SECRET_KEY phải là 32 byte mã hóa base64');
  }
  return key;
}

/**
 * Mã hóa API key bằng AES-256-GCM với `TEAMLENS_SECRET_KEY`, IV 12 byte ngẫu nhiên.
 * Định dạng lưu ở `user_llm_keys.key_encrypted`: `v1.<iv>.<ciphertext>.<tag>` (mỗi phần base64).
 */
export function encryptSecret(plain: string, secretBase64: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secretBase64), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
  ].join('.');
}

/** Giải mã chuỗi do `encryptSecret` tạo. Sai khóa, sai IV hoặc dữ liệu bị sửa thì ném lỗi. */
export function decryptSecret(encoded: string, secretBase64: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Định dạng key đã mã hóa không hợp lệ');
  }
  const [iv, ciphertext, tag] = parts
    .slice(1)
    .map((part) => Buffer.from(part, 'base64'));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Định dạng key đã mã hóa không hợp lệ');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFromSecret(secretBase64),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
