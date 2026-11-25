import { randomInt } from 'node:crypto';

/** Bảng chữ của user code: chỉ phụ âm, tránh ký tự dễ nhầm và tránh tạo thành từ. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_RE = new RegExp(
  `^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`,
);

/** Sinh user code 8 ký tự dạng `XXXX-XXXX`. */
export function generateUserCode(
  random: (max: number) => number = randomInt,
): string {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += USER_CODE_ALPHABET[random(USER_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Chuẩn hóa mã người dùng nhập: chữ hoa, bỏ khoảng trắng/gạch ngang, thêm lại gạch ngang.
 * Trả `null` nếu không đúng định dạng.
 */
export function normalizeUserCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== 8) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}
