import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

/** Tạo kết nối Postgres (postgres.js) và Drizzle. Gọi `sql.end()` khi tắt. */
export function createDatabase(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    // Bỏ qua NOTICE (ví dụ "relation already exists, skipping") cho log gọn.
    onnotice: () => undefined,
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}
