import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Nhật ký thao tác nhạy cảm (ai làm gì, lên đối tượng nào, lúc nào). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    /** Chi tiết thay đổi (vd. giá trị cũ và mới khi sửa rule); null với thao tác không cần. Không chứa nội dung prompt. */
    details: jsonb('details'),
    /** Metadata kỹ thuật của thao tác M4.4; không chứa nội dung prompt. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    index('audit_log_actor_idx').on(t.actorId),
    index('audit_log_at_idx').on(t.at),
  ],
);
