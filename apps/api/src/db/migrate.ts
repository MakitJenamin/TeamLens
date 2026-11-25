// Script `pnpm db:migrate`: chạy migration trong thư mục `drizzle/`.
import { readEnv } from '../config/env.js';
import { runMigrations } from './migrator.js';

try {
  await runMigrations(readEnv().DATABASE_URL);
  console.log('Đã chạy xong migration.');
} catch (error) {
  console.error('Migration thất bại:', error);
  process.exitCode = 1;
}
