import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const tz = { withTimezone: true } as const;

/** Tài khoản người dùng. Email lưu dạng chữ thường. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', tz),
});

/** Phiên đăng nhập dashboard (cookie `tl_session`). `id` = SHA-256 của token. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    lastUsedAt: timestamp('last_used_at', tz).notNull().defaultNow(),
  },
  (t) => [index('auth_sessions_user_id_idx').on(t.userId)],
);

export type User = typeof users.$inferSelect;
