import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { devices } from './devices.js';
import { users } from './users.js';

/** Đồng ý thu thập dữ liệu của thành viên (theo từng thiết bị). */
export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    textVersion: text('text_version').notNull(),
    backfill: boolean('backfill').notNull().default(false),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('consents_user_id_idx').on(t.userId)],
);
