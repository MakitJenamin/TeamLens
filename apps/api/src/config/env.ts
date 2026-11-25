import { existsSync } from 'node:fs';
import { z } from 'zod';

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
