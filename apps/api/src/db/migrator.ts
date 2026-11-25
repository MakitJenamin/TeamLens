import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './client.js';

/** Thư mục migration SQL (`apps/api/drizzle`), đúng cả khi chạy từ `src/` lẫn `dist/`. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

/** Chạy mọi migration còn thiếu rồi đảm bảo có partition `turns` cho 3 tháng tới. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const { sql, db } = createDatabase(databaseUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await sql`SELECT ensure_turns_partitions()`;
  } finally {
    await sql.end();
  }
}
