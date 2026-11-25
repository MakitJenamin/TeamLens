import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

const tz = { withTimezone: true } as const;

/** Trạng thái daemon trên thiết bị. */
export const DEVICE_STATUSES = [
  'online',
  'offline',
  'paused',
  'consent_revoked',
] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Máy cài CLI `tl`. Mỗi máy một token riêng (`tld_...`), DB chỉ lưu SHA-256. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    os: text('os').notNull(),
    cliVersion: text('cli_version').notNull(),
    // null cho tới khi CLI nhận token qua /agent/v1/device/token.
    tokenHash: text('token_hash').unique(),
    lastSeenAt: timestamp('last_seen_at', tz),
    status: text('status').$type<DeviceStatus>().notNull().default('offline'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);

export const DEVICE_CODE_STATUSES = [
  'pending',
  'approved',
  'denied',
  'consumed',
] as const;
export type DeviceCodeStatus = (typeof DEVICE_CODE_STATUSES)[number];

/** Phiên device login (giống `gh auth login`), hết hạn sau 15 phút. */
export const deviceCodes = pgTable('device_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceCodeHash: text('device_code_hash').notNull().unique(),
  userCode: text('user_code').notNull().unique(),
  deviceName: text('device_name').notNull(),
  os: text('os').notNull(),
  cliVersion: text('cli_version').notNull(),
  status: text('status').$type<DeviceCodeStatus>().notNull().default('pending'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').references(() => devices.id, {
    onDelete: 'cascade',
  }),
  expiresAt: timestamp('expires_at', tz).notNull(),
  lastPolledAt: timestamp('last_polled_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

export type Device = typeof devices.$inferSelect;
