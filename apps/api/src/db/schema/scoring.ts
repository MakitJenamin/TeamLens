import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  bigint,
} from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { sessions } from './sessions.js';
import { users } from './users.js';

const tz = { withTimezone: true } as const;

export type RuleSeverity = 'low' | 'medium' | 'high';

/** Rule chấm điểm (JSON khai báo). `project_id` null = mặc định toàn instance. */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }),
    key: text('key').notNull(),
    category: text('category').notNull(),
    severity: text('severity').$type<RuleSeverity>().notNull(),
    definition: jsonb('definition').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('rules_project_key_uq').on(t.projectId, t.key).nullsNotDistinct(),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    ruleVersion: integer('rule_version').notNull(),
    turnSeq: integer('turn_seq'),
    evidence: jsonb('evidence'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('findings_session_id_idx').on(t.sessionId)],
);

/** Điểm 0–100 của session theo 5 nhóm kỹ năng. */
export const sessionScores = pgTable(
  'session_scores',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    score: integer('score').notNull(),
    computedAt: timestamp('computed_at', tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.category] })],
);

/** Bảng tổng hợp theo tuần, giữ lâu dài sau khi nội dung thô bị xóa. */
export const userWeeklyStats = pgTable(
  'user_weekly_stats',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Ngày thứ Hai đầu tuần.
    week: date('week').notNull(),
    sessions: integer('sessions').notNull().default(0),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    scores: jsonb('scores').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId, t.week] })],
);
