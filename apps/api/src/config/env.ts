import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  DEFAULT_CLI_RELEASE_URL,
  normalizeReleaseUrl,
} from '../modules/invites/install-script.js';

/** Schema biến môi trường của API. Sai hoặc thiếu thì dừng ngay khi khởi động. */
export const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(
      /^postgres(ql)?:\/\//,
      'DATABASE_URL phải là chuỗi kết nối Postgres',
    ),
  TEAMLENS_PUBLIC_URL: z
    .url('TEAMLENS_PUBLIC_URL phải là URL đầy đủ, ví dụ http://localhost:3000')
    .transform((url) => url.replace(/\/+$/, '')),
  TEAMLENS_SECRET_KEY: z
    .string()
    .refine(
      (value) => Buffer.from(value, 'base64').length === 32,
      'TEAMLENS_SECRET_KEY phải là 32 byte mã hóa base64',
    ),
  PORT: z.coerce.number().int().positive().default(3001),
  /** Phiên bản `tl` tối thiểu trả trong `GET /agent/v1/config`; CLI cũ hơn ngừng gửi. */
  MIN_CLI_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'MIN_CLI_VERSION phải có dạng x.y.z, ví dụ 0.1.0')
    .default('0.1.0'),
  /**
   * Base URL release của `tl.exe` cho `GET /install.ps1` (M5.2): script tải
   * `<url>/SHA256SUMS` và `<url>/tl-x86_64-pc-windows-msvc.zip`. Phải là `https:`
   * (`http:` chỉ cho localhost/127.0.0.1 khi dev).
   */
  TEAMLENS_CLI_RELEASE_URL: z
    .string()
    .default(DEFAULT_CLI_RELEASE_URL)
    .transform((value, ctx) => {
      const url = normalizeReleaseUrl(value.trim());
      if (!url) {
        ctx.addIssue({
          code: 'custom',
          message:
            'TEAMLENS_CLI_RELEASE_URL phải là URL https:// (http:// chỉ cho localhost/127.0.0.1), không có query',
        });
        return z.NEVER;
      }
      return url;
    }),
});

export type Env = z.infer<typeof envSchema>;

/** Dùng cho `ConfigModule.forRoot({ validate })`. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Cấu hình môi trường không hợp lệ:\n${details}`);
  }
  return result.data;
}

/**
 * Nạp file env (nếu có) vào `process.env` cho script chạy ngoài Nest (migrate, seed, test).
 * Không ghi đè biến đã có sẵn trong môi trường.
 */
export function loadEnvFile(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Đọc và kiểm tra env cho script chạy ngoài Nest. */
export function readEnv(): Env {
  loadEnvFile();
  return validateEnv(process.env);
}
