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
    // null nếu thiết bị chưa có token (bản ghi cũ); `tl join` luôn cấp token ngay.
    tokenHash: text('token_hash').unique(),
    lastSeenAt: timestamp('last_seen_at', tz),
    status: text('status').$type<DeviceStatus>().notNull().default('offline'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);

export type Device = typeof devices.$inferSelect;
