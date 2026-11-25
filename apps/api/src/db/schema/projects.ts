import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

const tz = { withTimezone: true } as const;

export const PROJECT_ROLES = ['leader', 'member'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Cấu hình riêng của project (bật leaderboard, ngưỡng cắt output...). */
export type ProjectSettings = Record<string, unknown>;

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  settings: jsonb('settings').$type<ProjectSettings>().notNull().default({}),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

/** Pattern remote git thuộc project, đã chuẩn hóa (ví dụ `github.com/org/*`). */
export const projectRepos = pgTable(
  'project_repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    remotePattern: text('remote_pattern').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('project_repos_project_pattern_uq').on(t.projectId, t.remotePattern),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<ProjectRole>().notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_user_id_idx').on(t.userId),
  ],
);

/** Link mời vào project. Chỉ lưu SHA-256 của mã. */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull().unique(),
  role: text('role').$type<ProjectRole>().notNull().default('member'),
  expiresAt: timestamp('expires_at', tz).notNull(),
  // null = không giới hạn số lần dùng.
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

export type Project = typeof projects.$inferSelect;
