import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  findings,
  rules,
  sessions,
  sessionScores,
  userWeeklyStats,
} from '../../db/schema/index.js';
import {
  computeWeeklyScores,
  type Severity,
  type WeekFinding,
} from './weekly-stats.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Thứ Hai 00:00 UTC của tuần chứa `date`, và thứ Hai kế tiếp. */
export function weekWindow(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return { start, end: new Date(start.getTime() + 7 * 86400000) };
}

/**
 * Tính lại `user_weekly_stats` của một người trong một tuần UTC (M2.8). Gọi trong transaction chấm điểm,
 * khi đã giữ advisory lock của tuần đó, nên hai lần chấm đồng thời không ghi đè nhau.
 *
 * - `sessions`: số session gốc bắt đầu trong tuần (session con không tính).
 * - `tokens`: input + output + cache đọc + cache ghi của MỌI session trong tuần, kể cả session con.
 * - `scores`: xem `computeWeeklyScores`.
 */
export async function refreshWeeklyStats(
  tx: Tx,
  input: { userId: string; projectId: string; start: Date; end: Date },
): Promise<void> {
  const { userId, projectId, start, end } = input;
  const inWeek = and(
    eq(sessions.projectId, projectId),
    eq(sessions.userId, userId),
    gte(sessions.startedAt, start),
    lt(sessions.startedAt, end),
  );

  const [{ tokens }] = await tx
    .select({
      tokens: sql<number>`coalesce(sum(
        coalesce(${sessions.inputTokens}, 0) + coalesce(${sessions.outputTokens}, 0)
        + coalesce(${sessions.cacheReadTokens}, 0) + coalesce(${sessions.cacheWriteTokens}, 0)
      ), 0)::float8`,
    })
    .from(sessions)
    .where(inWeek);

  const roots = await tx
    .select({ id: sessions.id, turnCount: sessions.turnCount })
    .from(sessions)
    .where(
      and(
        inWeek,
        isNull(sessions.parentSourceId),
        isNull(sessions.parentSessionId),
      ),
    );

  const week = start.toISOString().slice(0, 10);
  if (roots.length === 0 && Number(tokens) === 0) {
    await tx
      .delete(userWeeklyStats)
      .where(
        and(
          eq(userWeeklyStats.userId, userId),
          eq(userWeeklyStats.projectId, projectId),
          eq(userWeeklyStats.week, week),
        ),
      );
    return;
  }

  const ids = roots.map((row) => row.id);
  const scoreRows = ids.length
    ? await tx
        .select()
        .from(sessionScores)
        .where(inArray(sessionScores.sessionId, ids))
    : [];
  const weekFindings = ids.length
    ? await tx
        .select({
          category: rules.category,
          severity: sql<Severity>`coalesce(${findings.evidence}->>'severity', ${rules.severity})`,
        })
        .from(findings)
        .innerJoin(rules, eq(rules.id, findings.ruleId))
        .where(
          and(
            inArray(findings.sessionId, ids),
            sql`${findings.evidence}->>'scope' = 'user_week'`,
          ),
        )
    : [];

  const bySession = new Map<string, Record<string, number>>();
  for (const row of scoreRows) {
    const scores = bySession.get(row.sessionId) ?? {};
    scores[row.category] = row.score;
    bySession.set(row.sessionId, scores);
  }
  const scored = roots
    .filter((row) => bySession.has(row.id))
    .map((row) => ({
      turnCount: row.turnCount,
      scores: bySession.get(row.id)!,
    }));
  const scores = computeWeeklyScores(scored, weekFindings as WeekFinding[]);

  const values = {
    userId,
    projectId,
    week,
    sessions: roots.length,
    tokens: Number(tokens),
    scores,
  };
  await tx
    .insert(userWeeklyStats)
    .values(values)
    .onConflictDoUpdate({
      target: [
        userWeeklyStats.userId,
        userWeeklyStats.projectId,
        userWeeklyStats.week,
      ],
      set: {
        sessions: values.sessions,
        tokens: values.tokens,
        scores: values.scores,
      },
    });
}
