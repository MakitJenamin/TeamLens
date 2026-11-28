import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { auditLog, settings } from '../../db/schema/index.js';
import {
  readRetentionDays,
  RETENTION_KEY,
  RETENTION_LAST_RUN_KEY,
  retentionCutoff,
  type RetentionRun,
} from './retention-settings.js';

/** Lấy cận trên trong biểu thức partition: `FOR VALUES FROM ('...') TO ('...')`. */
const PARTITION_UPPER_BOUND = "TO \\('([^']+)'\\)";
/** Chỉ drop partition do `ensure_turns_partitions` tạo ra. */
const PARTITION_NAME = /^turns_y\d{4}m\d{2}$/;

export interface RetentionOptions {
  /** Thời điểm coi là "bây giờ" (test). */
  now?: Date;
  /** Ghi đè số ngày (lệnh `retention:run --days`, test); `null` là vô hạn. */
  days?: number | null;
}

function count(result: unknown): number {
  const [row] = result as { n: number }[];
  return row?.n ?? 0;
}

/**
 * Job retention (M5.5, SPEC 11.2). Chạy lại nhiều lần an toàn.
 *
 * 1. Tạo trước partition `turns` cho tháng này và 2 tháng tới.
 * 2. Đọc số ngày (`settings.retention_days`); vô hạn thì dừng ở đây.
 * 3. Drop partition `turns` có cả tháng nằm trước mốc cắt; mỗi lần drop là một lệnh riêng
 *    để khóa bảng cha thật ngắn.
 * 4. Trong một transaction: xóa lẻ turn trước mốc cắt (partition chỉ quá hạn một phần), rồi
 *    nội dung thô gắn với session đã hết hạn: ghi chú, mục thư viện prompt, kết quả AI.
 *    Metadata session, finding, điểm và `user_weekly_stats` giữ lại.
 * 5. Lưu kết quả vào `settings.retention_last_run` và ghi audit `retention.run`.
 *
 * Session "hết hạn" là session có `coalesce(ended_at, started_at)` trước mốc cắt.
 */
export async function runRetention(
  db: Database,
  options: RetentionOptions = {},
): Promise<RetentionRun> {
  const now = options.now ?? new Date();
  await db.execute(sql`SELECT ensure_turns_partitions(now(), 2)`);

  const days =
    options.days !== undefined ? options.days : await readRetentionDays(db);
  const run: RetentionRun = {
    at: now.toISOString(),
    retentionDays: days,
    cutoff: null,
    droppedPartitions: [],
    deletedTurns: 0,
    deletedAiResults: 0,
    deletedNotes: 0,
    deletedPromptLibrary: 0,
  };

  if (days !== null) {
    const cutoff = retentionCutoff(now, days);
    run.cutoff = cutoff.toISOString();

    const expired = (await db.execute(sql`
      SELECT c.relname AS name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'public.turns'::regclass
        AND (regexp_match(pg_get_expr(c.relpartbound, c.oid), ${PARTITION_UPPER_BOUND}))[1]::timestamptz
            <= ${cutoff.toISOString()}::timestamptz
      ORDER BY c.relname`)) as unknown as { name: string }[];
    for (const { name } of expired) {
      if (!PARTITION_NAME.test(name)) continue;
      await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(name)}`);
      run.droppedPartitions.push(name);
    }

    await db.transaction(async (tx) => {
      const at = cutoff.toISOString();
      run.deletedTurns = count(
        await tx.execute(sql`
          WITH d AS (DELETE FROM turns WHERE ts < ${at}::timestamptz RETURNING 1)
          SELECT count(*)::int AS n FROM d`),
      );
      const expiredSessions = sql`
        SELECT id FROM sessions WHERE coalesce(ended_at, started_at) < ${at}::timestamptz`;
      run.deletedNotes = count(
        await tx.execute(sql`
          WITH d AS (DELETE FROM notes WHERE session_id IN (${expiredSessions}) RETURNING 1)
          SELECT count(*)::int AS n FROM d`),
      );
      run.deletedPromptLibrary = count(
        await tx.execute(sql`
          WITH d AS (DELETE FROM prompt_library WHERE session_id IN (${expiredSessions}) RETURNING 1)
          SELECT count(*)::int AS n FROM d`),
      );
      run.deletedAiResults = count(
        await tx.execute(sql`
          WITH d AS (
            DELETE FROM ai_results
            WHERE created_at < ${at}::timestamptz
              OR (subject_type = 'session' AND subject_id IN (${expiredSessions}))
              OR (subject_type = 'finding' AND subject_id IN (
                SELECT f.id FROM findings f WHERE f.session_id IN (${expiredSessions})))
            RETURNING 1)
          SELECT count(*)::int AS n FROM d`),
      );
      await recordRun(tx, run);
    });
  } else {
    await db.transaction((tx) => recordRun(tx, run));
  }
  return run;
}

async function recordRun(
  tx: Pick<Database, 'insert'>,
  run: RetentionRun,
): Promise<void> {
  await tx
    .insert(settings)
    .values({ key: RETENTION_LAST_RUN_KEY, value: run })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: run, updatedAt: new Date() },
    });
  // Job hệ thống nên không có người thực hiện. Chỉ ghi số đếm, không ghi nội dung.
  const { at: _at, ...counts } = run;
  await tx.insert(auditLog).values({
    actorId: null,
    action: 'retention.run',
    targetType: 'settings',
    targetId: RETENTION_KEY,
    metadata: counts,
  });
}
