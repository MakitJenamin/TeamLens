import { eq, inArray, isNull, or, and, sql, gte, lt } from 'drizzle-orm';
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
import { sessionRules } from './session-rules.js';
import {
  weeklyRules,
  evaluateWeek,
  type WeekSession,
  type WeeklyRule,
} from './weekly-rules.js';

const catalog = [...sessionRules, ...weeklyRules];

const categories = [
  'prompt_quality',
  'context',
  'correction_loop',
  'session_management',
  'verification',
];
const penalties = { low: 5, medium: 10, high: 20 };

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
    if (isChild) return true;

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
    const start = new Date(session.startedAt);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    const end = new Date(start.getTime() + 7 * 86400000);
    const weekKey = [
      session.projectId,
      session.userId,
      start.toISOString(),
    ].join('/');
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${weekKey}, 0))`,
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
    if (group.some((row) => inputs.get(row.id)!.turns.length < row.turnCount))
      return true;
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
    return true;
  });
}
