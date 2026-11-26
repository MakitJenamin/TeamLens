import {
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { ApiError } from './common/api-error.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { INGEST_PATH, ingestBodyReader } from './modules/agent/ingest-body.js';

/** Cấu hình chung cho app (dùng cả ở main.ts và e2e test). Không đặt global prefix. */
export function setupApp(app: INestApplication): INestApplication {
  // API chạy sau proxy (Next rewrite khi dev, Caddy khi production) trên mạng nội bộ:
  // tin `X-Forwarded-For` từ các địa chỉ đó để `req.ip` là IP thật (rate limit theo IP).
  (app as NestExpressApplication).set(
    'trust proxy',
    'loopback, linklocal, uniquelocal',
  );
  app.use(cookieParser());
  // Ingest của CLI: body tới 10 MB sau giải nén gzip. Phải đăng ký trước parser JSON mặc định
  // của Nest (100 KB, chạy lúc app.init()), xem modules/agent/ingest-body.ts.
  app.use(INGEST_PATH, ingestBodyReader);
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) => {
        const details = issues
          .slice(0, 5)
          .map((issue) => {
            const path = (issue.path ?? [])
              .map((p) => (typeof p === 'object' ? String(p.key) : String(p)))
              .join('.');
            return path ? `${path}: ${issue.message}` : issue.message;
          })
          .join('; ');
        return new ApiError(
          400,
          'validation_error',
          `Dữ liệu không hợp lệ: ${details}`,
        );
      },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
