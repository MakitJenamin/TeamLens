import {
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ApiError } from './common/api-error.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';

/** Cấu hình chung cho app (dùng cả ở main.ts và e2e test). Không đặt global prefix. */
export function setupApp(app: INestApplication): INestApplication {
  app.use(cookieParser());
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
