import {
  eq,
  inArray,
  isNull,
  or,
  and,
  sql,
  gte,
  gt,
  lt,
  asc,
} from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  findings,
  rules,
  sessions,
  sessionScores,
  turns,
} from '../../db/schema/index.js';
import {
  evaluateSession,
  type RuleTurn,
  type SessionRule,
} from './session-engine.js';
import {
  refreshWeeklyStats,
  weekWindow,
} from '../stats/refresh-weekly-stats.js';
import { CATEGORIES, PENALTIES } from '../stats/weekly-stats.js';
import { sessionRules } from './session-rules.js';
import { classifyWorkType } from './work-type.js';
import {
  weeklyRules,
  evaluateWeek,
  type WeekSession,
  type WeeklyRule,
} from './weekly-rules.js';

const catalog = [...sessionRules, ...weeklyRules];

const categories = CATEGORIES;
const penalties = PENALTIES;

export async function installDefaultRules(db: Database) {
  await db
    .insert(rules)
    .values(
      catalog.map((definition) => ({
        key: definition.key,
        category: definition.category,
        severity: definition.severity,
        definition,
      })),
    )
    .onConflictDoNothing();
}

/** Khóa session để các lần nhận thêm turn và chấm lại không ghi đè kết quả mới hơn. */
export function scoreSession(db: Database, sessionId: string) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('no key update');
    if (!session) return false;
    const isChild =
      session.parentSourceId !== null || session.parentSessionId !== null;
    const turnRows = isChild
      ? []
      : await tx
          .select({
            seq: turns.seq,
            role: turns.role,
            kind: turns.kind,
            text: turns.text,
            model: turns.model,
            interrupted: turns.interrupted,
            tool: sql<RuleTurn['tool']>`${turns.tool}`,
            diff: sql<RuleTurn['diff']>`${turns.diff}`,
          })
          .from(turns)
          .where(eq(turns.sessionId, sessionId));
    // Khi retention đã xóa turn, giữ điểm lịch sử thay vì chấm lại trên dữ liệu thiếu.
    if (!isChild && turnRows.length < session.turnCount) return true;
    await tx
      .delete(findings)
      .where(
        and(
          eq(findings.sessionId, sessionId),
          sql`coalesce(${findings.evidence}->>'scope','session')='session'`,
        ),
      );
    await tx
      .delete(sessionScores)
      .where(eq(sessionScores.sessionId, sessionId));
    // Tuần UTC của session. Khóa tuần cũng bảo vệ `user_weekly_stats`, kể cả khi session là session con:
    // token của session con vẫn cộng vào thống kê tuần của người đó (M2.8).
    const { start, end } = weekWindow(new Date(session.startedAt));
    const weekKey = [
      session.projectId,
      session.userId,
      start.toISOString(),
    ].join('/');
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${weekKey}, 0))`,
    );
    const weekOwner = {
      userId: session.userId,
      projectId: session.projectId,
      start,
      end,
    };
    if (isChild) {
      await refreshWeeklyStats(tx, weekOwner);
      return true;
    }

    // Nhãn loại việc B4 (heuristic, không gọi LLM). Tính cùng lúc với điểm nên chấm lại project cũng gán nhãn cho session cũ.
    await tx
      .update(sessions)
      .set({ workType: classifyWorkType(turnRows) })
      .where(eq(sessions.id, sessionId));

    const rows = await tx
      .select()
      .from(rules)
      .where(
        and(
          inArray(
            rules.key,
            catalog.map((rule) => rule.key),
          ),
          or(isNull(rules.projectId), eq(rules.projectId, session.projectId)),
        ),
      );
    const applicable = new Map(
      rows.filter((rule) => !rule.projectId).map((rule) => [rule.key, rule]),
    );
    for (const row of rows) if (row.projectId) applicable.set(row.key, row);
    const active = [...applicable.values()].filter((row) => row.enabled);
    const definitions = active
      .filter((row) => sessionRules.some((rule) => rule.key === row.key))
      .map((row) => ({
        ...(row.definition as SessionRule),
        key: row.key,
        severity: row.severity,
        category: row.category,
      }));
    const hits = evaluateSession(
      {
        parentSourceId: null,
        permissionMode: session.permissionMode,
        instructionFiles: session.instructionFiles,
        turns: turnRows,
      },
      definitions,
    );
    if (hits.length) {
      await tx.insert(findings).values(
        hits.map((hit) => {
          const rule = applicable.get(hit.ruleKey)!;
          return {
            sessionId,
            ruleId: rule.id,
            ruleVersion: rule.version,
            turnSeq: hit.turnSeq,
            evidence: {
              count: hit.count,
              message: hit.message,
              severity: hit.severity,
            },
          };
        }),
      );
    }
    await tx.insert(sessionScores).values(
      categories.map((category) => ({
        sessionId,
        category,
        score: Math.max(
          0,
          100 -
            hits
              .filter((hit) => hit.category === category)
              .reduce((sum, hit) => sum + penalties[hit.severity], 0),
        ),
      })),
    );
    const group = await tx
      .select({ id: sessions.id, turnCount: sessions.turnCount })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, session.projectId),
          eq(sessions.userId, session.userId),
          gte(sessions.startedAt, start),
          lt(sessions.startedAt, end),
          isNull(sessions.parentSourceId),
          isNull(sessions.parentSessionId),
        ),
      );
    const ids = group.map((row) => row.id);
    const weekTurns = await tx
      .select({
        id: turns.sessionId,
        seq: turns.seq,
        role: turns.role,
        kind: turns.kind,
        text: turns.text,
        model: turns.model,
        interrupted: turns.interrupted,
        ts: turns.ts,
        diff: sql<RuleTurn['diff']>`${turns.diff} - 'patch'`,
      })
      .from(turns)
      .where(inArray(turns.sessionId, ids));
    const inputs = new Map<string, WeekSession & { turns: RuleTurn[] }>(
      ids.map((id) => [id, { id, parentSourceId: null, turns: [] }]),
    );
    for (const row of weekTurns)
      inputs.get(row.id)!.turns.push({ ...row, ts: row.ts.toISOString() });
    // Thiếu turn do retention: giữ finding tuần cũ, nhưng vẫn tính lại thống kê tuần từ điểm đã lưu.
    if (group.some((row) => inputs.get(row.id)!.turns.length < row.turnCount)) {
      await refreshWeeklyStats(tx, weekOwner);
      return true;
    }
    const weekDefinitions = active
      .filter((row) => weeklyRules.some((rule) => rule.key === row.key))
      .map((row) => ({
        ...(row.definition as WeeklyRule),
        key: row.key,
        severity: row.severity,
        category: row.category,
      }));
    const weeklyHits = evaluateWeek([...inputs.values()], weekDefinitions);
    await tx
      .delete(findings)
      .where(
        and(
          inArray(findings.sessionId, ids),
          sql`${findings.evidence}->>'scope'='user_week'`,
        ),
      );
    if (weeklyHits.length)
      await tx.insert(findings).values(
        weeklyHits.map((hit) => {
          const rule = applicable.get(hit.ruleKey)!;
          return {
            sessionId: hit.sessionId,
            turnSeq: hit.turnSeq,
            ruleId: rule.id,
            ruleVersion: rule.version,
            evidence: {
              scope: 'user_week',
              week: start.toISOString(),
              count: hit.count,
              total: hit.total,
              ratio: hit.ratio,
              message: hit.message,
              severity: hit.severity,
            },
          };
        }),
      );
    await refreshWeeklyStats(tx, weekOwner);
    return true;
  });
}

/**
 * Chấm lại mọi session của project theo rule hiện hành (M2.8): finding, điểm 5 nhóm, `user_weekly_stats`.
 * Duyệt theo `id` từng lô 100 session; chạy lại nhiều lần không tạo bản ghi trùng.
 */
export async function rescoreProject(db: Database, projectId: string, onBatch?: (processed: number) => Promise<void>) {
  let cursor: string | undefined;
  let total = 0;
  while (true) {
    const batch = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        cursor
          ? and(eq(sessions.projectId, projectId), gt(sessions.id, cursor))
          : eq(sessions.projectId, projectId),
      )
      .orderBy(asc(sessions.id))
      .limit(100);
    if (!batch.length) return total;
    for (const row of batch) if (await scoreSession(db, row.id)) total++;
    await onBatch?.(total);
    cursor = batch[batch.length - 1].id;
  }
}
