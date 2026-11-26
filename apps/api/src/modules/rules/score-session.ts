import { eq, inArray, isNull, or, and, sql } from 'drizzle-orm';
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
      sessionRules.map((definition) => ({
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
      .for('update');
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
            diff: sql<RuleTurn['diff']>`${turns.diff} - 'patch'`,
          })
          .from(turns)
          .where(eq(turns.sessionId, sessionId));
    // Khi retention đã xóa turn, giữ điểm lịch sử thay vì chấm lại trên dữ liệu thiếu.
    if (!isChild && turnRows.length < session.turnCount) return true;
    await tx.delete(findings).where(eq(findings.sessionId, sessionId));
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
            sessionRules.map((rule) => rule.key),
          ),
          or(isNull(rules.projectId), eq(rules.projectId, session.projectId)),
        ),
      );
    const applicable = new Map(
      rows.filter((rule) => !rule.projectId).map((rule) => [rule.key, rule]),
    );
    for (const row of rows) if (row.projectId) applicable.set(row.key, row);
    const active = [...applicable.values()].filter((row) => row.enabled);
    const definitions = active.map((row) => ({
      ...(row.definition as SessionRule),
      key: row.key,
      severity: row.severity,
      category: row.category,
    }));
    const hits = evaluateSession(
      { parentSourceId: null, turns: turnRows },
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
    return true;
  });
}
