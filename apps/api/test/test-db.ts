import { loadEnvFile } from '../src/config/env.js';

/**
 * e2e dùng DB riêng `<tên DB dev>_test` trên cùng Postgres dev, để không đụng dữ liệu seed.
 * Ưu tiên biến `TEST_DATABASE_URL` nếu có.
 */
export function testDatabaseUrl(): string {
  loadEnvFile('.env');
  loadEnvFile('.env.example');
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.pathname = `${url.pathname.replace(/^\//, '') || 'teamlens'}_test`;
  return url.toString();
}
