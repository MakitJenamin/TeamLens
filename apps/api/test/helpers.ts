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

/**
 * Tạo user thẳng trong DB (member thật vào bằng `tl join`; ở đây kèm email + mật khẩu
 * để test đăng nhập dashboard). Trả id.
 */
export async function insertUser(input: {
  email: string | null;
  name: string;
  role?: 'leader' | 'member';
  password?: string;
}): Promise<string> {
  const { hashPassword } = await import('../src/common/passwords.js');
  const hash = input.password ? await hashPassword(input.password) : null;
  const [row] = await querySql<{ id: string }>(
    'INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [input.email, input.name, input.role ?? 'member', hash],
  );
  return row.id;
}

/** Ghi bản đồng ý còn hiệu lực (phiên bản hiện tại) cho thiết bị của device token. */
export async function grantConsent(deviceToken: string): Promise<void> {
  const { sha256 } = await import('../src/common/crypto.js');
  const { CONSENT_TEXT_VERSION } =
    await import('../src/modules/consent/consent-text.js');
  await querySql(
    `INSERT INTO consents (user_id, device_id, text_version, backfill)
     SELECT user_id, id, $2, false FROM devices WHERE token_hash = $1`,
    [sha256(deviceToken), CONSENT_TEXT_VERSION],
  );
}
