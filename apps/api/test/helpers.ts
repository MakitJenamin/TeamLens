import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import postgres from 'postgres';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup-app.js';

/** Xóa sạch dữ liệu app trong DB test (giữ schema, migration, partition). */
export async function resetDatabase(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await sql`TRUNCATE users, projects, device_codes, settings, audit_log, rules CASCADE`;
  } finally {
    await sql.end();
  }
}

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = setupApp(
    moduleRef.createNestApplication({ logger: ['error', 'warn'] }),
  );
  await app.init();
  return app;
}

export async function querySql<T extends Record<string, unknown>>(
  text: string,
  params: (string | number | null)[] = [],
): Promise<T[]> {
  const sql = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    return (await sql.unsafe(text, params)) as unknown as T[];
  } finally {
    await sql.end();
  }
}
