import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { findings, projectMembers, projects, rules, sessions, sessionScores, users, userWeeklyStats } from '../../db/schema/index.js';
import { leaderboardWindow, monthScores, rankLeaderboard, type LeaderboardCategory, type LeaderboardCandidate, type LeaderboardPeriod, type MonthSession } from './leaderboard-math.js';
import type { Severity, WeeklyScores } from './weekly-stats.js';

@Injectable()
export class LeaderboardService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(
    viewer: AuthUser,
    projectId: string,
    query: { period: LeaderboardPeriod; at?: string; category: LeaderboardCategory },
    now = new Date(),
  ) {
    const [project] = await this.db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    const leaderboardEnabled = project.settings.leaderboardEnabled !== false;
    const leaderboardPublic = project.settings.leaderboardPublic === true;
    if (viewer.role !== 'leader' && (!leaderboardEnabled || !leaderboardPublic)) {
      throw new ApiError(403, 'leaderboard_disabled', 'Bảng xếp hạng chưa được công khai');
    }

    const { from, to } = leaderboardWindow(query.period, query.at ? new Date(`${query.at}T00:00:00.000Z`) : now);
    const candidates = query.period === 'week'
      ? await this.weekCandidates(projectId, from)
      : await this.monthCandidates(projectId, from, to);
    const mySessions = candidates.find((candidate) => candidate.userId === viewer.id)?.sessions ?? 0;
    return {
      projectId,
      period: query.period,
      category: query.category,
      from: from.toISOString(),
      to: to.toISOString(),
      leaderboardEnabled,
      leaderboardPublic,
      mySessions,
      sessionsNeeded: Math.max(0, 5 - mySessions),
      entries: leaderboardEnabled ? rankLeaderboard(candidates, query.category, viewer.id, viewer.role === 'leader') : [],
    };
  }

  private async weekCandidates(projectId: string, from: Date): Promise<LeaderboardCandidate[]> {
    const rows = await this.db
      .select({ userId: userWeeklyStats.userId, name: users.name, sessions: userWeeklyStats.sessions, scores: userWeeklyStats.scores })
      .from(userWeeklyStats)
      .innerJoin(users, eq(users.id, userWeeklyStats.userId))
      .innerJoin(projectMembers, and(eq(projectMembers.projectId, userWeeklyStats.projectId), eq(projectMembers.userId, userWeeklyStats.userId)))
      .where(and(
        eq(userWeeklyStats.projectId, projectId), eq(userWeeklyStats.week, from.toISOString().slice(0, 10)), isNull(users.deletedAt),
      ));
    return rows.map((row) => ({ userId: row.userId, name: row.name, sessions: row.sessions, scores: row.scores as WeeklyScores }));
  }

  private async monthCandidates(projectId: string, from: Date, to: Date): Promise<LeaderboardCandidate[]> {
    const roots = await this.db
      .select({ id: sessions.id, userId: sessions.userId, name: users.name, turnCount: sessions.turnCount, startedAt: sessions.startedAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(projectMembers, and(eq(projectMembers.projectId, sessions.projectId), eq(projectMembers.userId, sessions.userId)))
      .where(and(
        eq(sessions.projectId, projectId), isNull(users.deletedAt), gte(sessions.startedAt, from), lt(sessions.startedAt, to),
        isNull(sessions.parentSessionId), isNull(sessions.parentSourceId),
      ));
    if (roots.length === 0) return [];
    const ids = roots.map((root) => root.id);
    const [scores, penalties] = await Promise.all([
      this.db.select({ sessionId: sessionScores.sessionId, category: sessionScores.category, score: sessionScores.score })
        .from(sessionScores).where(inArray(sessionScores.sessionId, ids)),
      this.db.select({ sessionId: findings.sessionId, category: rules.category,
        severity: sql<Severity>`coalesce(${findings.evidence}->>'severity', ${rules.severity})` })
        .from(findings).innerJoin(rules, eq(rules.id, findings.ruleId))
        .where(and(inArray(findings.sessionId, ids), sql`${findings.evidence}->>'scope' = 'user_week'`)),
    ]);
    const scoresBySession = new Map<string, Record<string, number>>();
    for (const row of scores) {
      const values = scoresBySession.get(row.sessionId) ?? {};
      values[row.category] = row.score;
      scoresBySession.set(row.sessionId, values);
    }
    const byUser = new Map<string, { name: string; sessions: MonthSession[]; ids: Set<string> }>();
    for (const root of roots) {
      const user = byUser.get(root.userId) ?? { name: root.name, sessions: [], ids: new Set<string>() };
      user.sessions.push({ id: root.id, startedAt: root.startedAt, turnCount: root.turnCount, scores: scoresBySession.get(root.id) });
      user.ids.add(root.id);
      byUser.set(root.userId, user);
    }
    return [...byUser].map(([userId, user]) => ({
      userId, name: user.name, sessions: user.sessions.length,
      scores: monthScores(user.sessions, penalties.filter((penalty) => user.ids.has(penalty.sessionId))),
    }));
  }
}
