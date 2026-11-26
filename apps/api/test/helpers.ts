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
    await sql`TRUNCATE users, projects, settings, audit_log, rules CASCADE`;
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

/**
 * Tạo thiết bị có device token thẳng trong DB (thay cho `tl join` khi test không cần
 * luồng mời). DB chỉ lưu SHA-256 của token. Trả id và token gốc.
 */
export async function insertDevice(
  userId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const { randomToken, sha256 } = await import('../src/common/crypto.js');
  const { DEVICE_TOKEN_PREFIX } =
    await import('../src/modules/device/device.service.js');
  const token = DEVICE_TOKEN_PREFIX + randomToken();
  const [row] = await querySql<{ id: string }>(
    `INSERT INTO devices (user_id, name, os, cli_version, token_hash)
     VALUES ($1, $2, 'windows', '0.1.0', $3) RETURNING id`,
    [userId, name, sha256(token)],
  );
  return { id: row.id, token };
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
