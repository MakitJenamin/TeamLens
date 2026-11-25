import postgres from 'postgres';
import { runMigrations } from '../src/db/migrator.js';
import { testDatabaseUrl } from './test-db.js';

/** Tạo DB test (nếu chưa có) và chạy migration một lần trước mọi file e2e. */
export default async function globalSetup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const dbName = url.pathname.replace(/^\//, '');
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    const exists =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  await runMigrations(url.toString());
}
