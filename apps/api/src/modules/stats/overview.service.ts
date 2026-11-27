import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { notFound } from '../../common/api-error.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  findings,
  projects,
  rules,
  sessions,
  turns,
  userWeeklyStats,
} from '../../db/schema/index.js';
import {
  type AgentRow,
  buildOverview,
  type FindingRow,
  normalizeRange,
  type ProjectOverview,
  type StatsRow,
  type TurnRow,
} from './overview-math.js';

const TOP_FINDINGS = 10;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Tổng quan project cho leader (M2.9, contract `stats.yaml`). Chỉ đọc, không ghi audit vì chỉ có số liệu gộp. */
@Injectable()
export class OverviewService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(
    projectId: string,
    query: { from?: Date; to?: Date },
    now = new Date(),
  ): Promise<ProjectOverview> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    const range = normalizeRange(query.from, query.to, now);
    const inRange = and(
      eq(sessions.projectId, projectId),
      gte(sessions.startedAt, range.from),
      lt(sessions.startedAt, range.to),
    );

    const stats = await this.db
      .select({
        userId: userWeeklyStats.userId,
        week: userWeeklyStats.week,
        sessions: userWeeklyStats.sessions,
        tokens: userWeeklyStats.tokens,
        scores: userWeeklyStats.scores,
      })
      .from(userWeeklyStats)
      .where(
        and(
          eq(userWeeklyStats.projectId, projectId),
          gte(userWeeklyStats.week, isoDay(range.from)),
          lt(userWeeklyStats.week, isoDay(range.to)),
        ),
      );

    const allTokens = sql<number>`coalesce(sum(
      coalesce(${sessions.inputTokens}, 0) + coalesce(${sessions.outputTokens}, 0)
      + coalesce(${sessions.cacheReadTokens}, 0) + coalesce(${sessions.cacheWriteTokens}, 0)
    ), 0)::float8`;
    const agents = await this.db
      .select({
        agent: sessions.agent,
        sessions: sql<number>`count(*) filter (where ${sessions.parentSourceId} is null and ${sessions.parentSessionId} is null)::int`,
        tokens: allTokens,
      })
      .from(sessions)
      .where(inRange)
      .groupBy(sessions.agent);

    const week = sql<string>`to_char(date_trunc('week', ${sessions.startedAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
    const usage = (key: string) =>
      sql<number>`coalesce(sum((${turns.usage}->>${sql.raw(`'${key}'`)})::numeric), 0)::float8`;
    const turnRows = await this.db
      .select({
        week,
        model: turns.model,
        turns: sql<number>`count(*)::int`,
        input: usage('input'),
        output: usage('output'),
        cacheRead: usage('cache_read'),
        cacheWrite: usage('cache_write'),
        reasoningKnown: sql<number>`count(*) filter (where ${turns.reasoningEffort} is not null)::int`,
        reasoningHigh: sql<number>`count(*) filter (where ${turns.reasoningEffort} in ('high', 'xhigh'))::int`,
      })
      .from(turns)
      .innerJoin(sessions, eq(sessions.id, turns.sessionId))
      .where(and(inRange, eq(turns.role, 'assistant')))
      .groupBy(week, turns.model);

    const severity = sql<string>`coalesce(${findings.evidence}->>'severity', ${rules.severity})`;
    const count = sql<number>`count(*)::int`;
    const topFindings = await this.db
      .select({
        ruleKey: rules.key,
        category: rules.category,
        severity,
        count,
        memberCount: sql<number>`count(distinct ${sessions.userId})::int`,
      })
      .from(findings)
      .innerJoin(rules, eq(rules.id, findings.ruleId))
      .innerJoin(sessions, eq(sessions.id, findings.sessionId))
      .where(inRange)
      .groupBy(rules.key, rules.category, severity)
      .orderBy(desc(count), asc(rules.key))
      .limit(TOP_FINDINGS);

    return buildOverview({
      range,
      stats: stats as StatsRow[],
      agents: agents as AgentRow[],
      turns: turnRows as TurnRow[],
      findings: topFindings as FindingRow[],
    });
  }
}
