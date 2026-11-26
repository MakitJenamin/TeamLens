import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
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
import { devices } from './devices.js';
import { projects } from './projects.js';
import { users } from './users.js';

const tz = { withTimezone: true } as const;

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

export type PermissionMode =
  'default' | 'accept_edits' | 'plan' | 'bypass' | 'unknown';

export interface InstructionFile {
  path: string;
  bytes: number;
}

/** Session làm việc với AI agent (đã chuẩn hóa theo schema v1). */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    sourceId: text('source_id').notNull(),
    agent: text('agent').notNull(),
    agentVersion: text('agent_version'),
    repoRemote: text('repo_remote').notNull(),
    branch: text('branch'),
    cwdRelative: text('cwd_relative'),
    startedAt: timestamp('started_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz),
    // Chế độ quyền của agent (default, accept_edits, plan, bypass, unknown); null khi CLI không gửi.
    permissionMode: text('permission_mode').$type<PermissionMode>(),
    // File hướng dẫn ở gốc repo (chỉ đường dẫn + kích thước). null: CLI không thu thập; []: không có file.
    instructionFiles: jsonb('instruction_files').$type<InstructionFile[]>(),
    turnCount: integer('turn_count').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    parentSessionId: uuid('parent_session_id').references(
      (): AnyPgColumn => sessions.id,
      {
        onDelete: 'set null',
      },
    ),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('sessions_user_source_uq').on(t.userId, t.sourceId),
    index('sessions_project_started_idx').on(t.projectId, t.startedAt),
    index('sessions_user_started_idx').on(t.userId, t.startedAt),
    index('sessions_parent_idx').on(t.parentSessionId),
  ],
);

export type TurnRole = 'user' | 'assistant' | 'system';
export type TurnKind =
  'prompt' | 'reply' | 'tool_call' | 'tool_result' | 'compaction';

/**
 * Từng lượt trong session.
 *
 * Bảng thật được tạo bằng SQL tay trong migration `0001_turns_partitioned.sql`:
 * PARTITION BY RANGE (ts) theo tháng, PK (session_id, seq, ts) vì Postgres bắt buộc
 * khóa partition nằm trong PK. Khai báo ở đây chỉ để query bằng Drizzle.
 */
export const turns = pgTable(
  'turns',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').$type<TurnRole>().notNull(),
    kind: text('kind').$type<TurnKind>().notNull(),
    ts: timestamp('ts', tz).notNull(),
    model: text('model'),
    text: text('text'),
    tool: jsonb('tool'),
    output: jsonb('output'),
    diff: jsonb('diff'),
    usage: jsonb('usage'),
    attachments: jsonb('attachments'),
    redactions: jsonb('redactions'),
    // Người dùng ngắt lượt này (rule `high-interruption`).
    interrupted: boolean('interrupted').notNull().default(false),
    // Mức suy luận agent dùng cho lượt (Codex: low/medium/high); null khi agent không ghi.
    reasoningEffort: text('reasoning_effort'),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("text", ''))`,
    ),
  },
  (t) => [
    primaryKey({ name: 'turns_pkey', columns: [t.sessionId, t.seq, t.ts] }),
    index('turns_tsv_idx').using('gin', t.tsv),
  ],
);

/**
 * Batch ingest đã nhận, để gửi lại cùng `batch_id` trả đúng kết quả lần đầu (idempotent).
 * Khóa theo (user_id, batch_id): batch_id do CLI sinh nên không tin là duy nhất giữa các user.
 * `result` là `IngestResult` (camelCase) của lần nhận đầu.
 */
export const ingestBatches = pgTable(
  'ingest_batches',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'ingest_batches_pkey', columns: [t.userId, t.batchId] }),
    index('ingest_batches_created_idx').on(t.createdAt),
  ],
);
