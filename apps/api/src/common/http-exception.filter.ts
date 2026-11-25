import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorBody } from './api-error.js';

const DEFAULT_ERRORS: Record<number, ApiErrorBody> = {
  400: { error: 'bad_request', message: 'Yêu cầu không hợp lệ' },
  401: { error: 'unauthenticated', message: 'Bạn cần đăng nhập' },
  403: {
    error: 'forbidden',
    message: 'Bạn không có quyền thực hiện thao tác này',
  },
  404: { error: 'not_found', message: 'Không tìm thấy' },
  405: {
    error: 'method_not_allowed',
    message: 'Phương thức không được hỗ trợ',
  },
  409: { error: 'conflict', message: 'Dữ liệu bị xung đột' },
  413: { error: 'payload_too_large', message: 'Dữ liệu gửi lên quá lớn' },
  415: {
    error: 'unsupported_media_type',
    message: 'Định dạng dữ liệu không được hỗ trợ',
  },
  429: {
    error: 'too_many_requests',
    message: 'Quá nhiều yêu cầu, hãy thử lại sau',
  },
};

const INTERNAL: ApiErrorBody = {
  error: 'internal_error',
  message: 'Lỗi máy chủ, hãy thử lại sau',
};

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiErrorBody).error === 'string' &&
    typeof (value as ApiErrorBody).message === 'string' &&
    // Lỗi mặc định của Nest có dạng { statusCode, error: 'Not Found', message }: không dùng.
    !('statusCode' in value)
  );
}

/** Đưa mọi lỗi về dạng `{ error, message }`. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (isApiErrorBody(body)) {
        res.status(status).json({ error: body.error, message: body.message });
        return;
      }
      const fallback =
        DEFAULT_ERRORS[status] ??
        (status >= 500 ? INTERNAL : DEFAULT_ERRORS[400]);
      res.status(status).json(fallback);
      return;
    }
    // Không log nội dung request (có thể chứa prompt, token, mật khẩu).
    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(500).json(INTERNAL);
  }
}
