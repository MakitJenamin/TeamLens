import { HttpException } from '@nestjs/common';

/** Dạng lỗi chuẩn của API: `{ error, message }`. */
export interface ApiErrorBody {
  error: string;
  message: string;
}

/** Lỗi có mã máy đọc được và thông báo tiếng Việt. */
export class ApiError extends HttpException {
  constructor(status: number, error: string, message: string) {
    super({ error, message } satisfies ApiErrorBody, status);
  }
}

export const unauthenticated = () =>
  new ApiError(401, 'unauthenticated', 'Bạn cần đăng nhập');

export const forbidden = () =>
  new ApiError(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');

export const notFound = (message = 'Không tìm thấy') =>
  new ApiError(404, 'not_found', message);

/** Kiểm tra mã lỗi Postgres vi phạm ràng buộc unique. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  // Drizzle bọc lỗi của driver trong `cause`.
  for (let depth = 0; depth < 3 && current; depth++) {
    if (
      typeof current === 'object' &&
      (current as { code?: string }).code === '23505'
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
