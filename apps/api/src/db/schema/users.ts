import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true } as const;

/** Vai trò toàn server: leader làm mọi thứ, member chỉ dữ liệu của mình (SPEC 11.1). */
export const USER_ROLES = ['leader', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Tài khoản người dùng. Email lưu dạng chữ thường.
 * Chỉ leader có email + mật khẩu (đăng nhập dashboard); member tham gia bằng `tl join`,
 * danh tính là device token nên `email`/`password_hash` để null.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  role: text('role').$type<UserRole>().notNull().default('member'),
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

/** Ticket đăng nhập dashboard một lần cho `tl open` (sống 60 giây). `id` = SHA-256 của ticket. */
export const webLoginTickets = pgTable(
  'web_login_tickets',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id'),
    expiresAt: timestamp('expires_at', tz).notNull(),
    usedAt: timestamp('used_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('web_login_tickets_user_id_idx').on(t.userId)],
);

export type User = typeof users.$inferSelect;
