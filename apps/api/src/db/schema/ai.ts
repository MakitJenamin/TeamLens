import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { sessions } from './sessions.js';
import { users } from './users.js';

const tz = { withTimezone: true } as const;

/**
 * Tính năng AI và MCP (Mốc 6, docs/AI_PLAN.md).
 * Không có key chung của server: mỗi người tự nhập API key của mình (BYO).
 */

export type LlmProvider = 'anthropic' | 'openai_compatible';

/** API key LLM của từng người, mỗi người tối đa một key. */
export const userLlmKeys = pgTable('user_llm_keys', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<LlmProvider>().notNull(),
  // null: dùng địa chỉ mặc định của provider.
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  // Key mã hóa AES-GCM bằng TEAMLENS_SECRET_KEY; định dạng do module `llm` quyết. Không bao giờ trả qua API.
  keyEncrypted: text('key_encrypted').notNull(),
  // Vài ký tự cuối của key để người dùng nhận ra, vd "…a1B2".
  keyHint: text('key_hint').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});

/**
 * Kết quả AI, chỉ người bấm (`user_id`) đọc được; bấm lại thì ghi đè (unique theo người bấm + đối tượng + locale).
 * `subject_user_id` là chủ dữ liệu, để xóa dữ liệu một người thì xóa luôn kết quả "về người đó".
 */
export const aiResults = pgTable(
  'ai_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    subjectUserId: uuid('subject_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    locale: text('locale').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('ai_results_owner_subject_uq').on(
      t.userId,
      t.kind,
      t.subjectType,
      t.subjectId,
      t.locale,
    ),
    index('ai_results_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

/** Token cá nhân `tlp_...` cho MCP; DB chỉ lưu SHA-256 (hex) như device token. */
export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    lastUsedAt: timestamp('last_used_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [index('agent_tokens_user_id_idx').on(t.userId)],
);

/** Thư viện prompt mẫu của project (leader duyệt từ session). */
export const promptLibrary = pgTable(
  'prompt_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // null: cả session; có giá trị: một lượt cụ thể.
    turnSeq: integer('turn_seq'),
    note: text('note'),
    hideAuthor: boolean('hide_author').notNull().default(false),
    approvedBy: uuid('approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('prompt_library_project_id_idx').on(t.projectId)],
);

/** Nguồn danh mục skill cộng đồng cho Skill Finder. */
export const skillCatalogSources = pgTable('skill_catalog_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  url: text('url').notNull().unique(),
  // Loại nguồn, vd `github`.
  kind: text('kind').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});
