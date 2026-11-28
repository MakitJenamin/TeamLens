import { mergeWeeklyScores } from './overview-math.js';
import { weekWindow } from './refresh-weekly-stats.js';
import {
  CATEGORIES, computeWeeklyScores, type Category, type WeeklyScores, type WeekFinding, type WeekScoredSession,
} from './weekly-stats.js';

export type LeaderboardPeriod = 'week' | 'month';
export type LeaderboardCategory = 'overall' | Category;

export function leaderboardWindow(period: LeaderboardPeriod, at: Date): { from: Date; to: Date } {
  if (period === 'week') {
    const { start, end } = weekWindow(at);
    return { from: start, to: end };
  }
  return {
    from: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    to: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

export function overallScore(scores: WeeklyScores): number | null {
  const values = CATEGORIES.flatMap((category) =>
    scores[category] === undefined ? [] : [scores[category]],
  );
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, score) => sum + score, 0) / values.length) * 10) / 10;
}

export interface LeaderboardCandidate {
  userId: string;
  name: string;
  sessions: number;
  scores: WeeklyScores;
}

export interface LeaderboardEntry extends LeaderboardCandidate {
  rank: number;
  overall: number | null;
  isSelf: boolean;
}

export function rankLeaderboard(
  candidates: readonly LeaderboardCandidate[],
  category: LeaderboardCategory,
  viewerId: string,
  isLeader: boolean,
): Array<Omit<LeaderboardEntry, 'name' | 'userId'> & { name: string | null; userId: string | null }> {
  const score = (candidate: LeaderboardCandidate) =>
    category === 'overall' ? overallScore(candidate.scores) : (candidate.scores[category] ?? null);
  return candidates
    .filter((candidate) => candidate.sessions >= 5 && score(candidate) !== null)
    .sort((a, b) =>
      (score(b)! - score(a)!) ||
      (b.sessions - a.sessions) ||
      a.name.localeCompare(b.name, 'vi') ||
      a.userId.localeCompare(b.userId),
    )
    .map((candidate, index) => ({
      rank: index + 1,
      userId: isLeader || candidate.userId === viewerId ? candidate.userId : null,
      name: isLeader || candidate.userId === viewerId ? candidate.name : null,
      isSelf: candidate.userId === viewerId,
      sessions: candidate.sessions,
      overall: overallScore(candidate.scores),
      scores: candidate.scores,
    }));
}

/** Một session gốc bắt đầu trong tháng; `scores` vắng khi session chưa được chấm. */
export interface MonthSession {
  id: string;
  startedAt: Date;
  turnCount: number;
  scores?: Record<string, number>;
}

/** Một finding phạm vi `user_week`, gắn vào session gốc chứa nó. */
export interface MonthFinding extends WeekFinding {
  sessionId: string;
}

/**
 * Điểm tháng của một người (SPEC 9.1, mục 10):
 * 1. Chia session gốc trong tháng theo tuần UTC, mỗi tuần tính đúng công thức điểm tuần
 *    (trung bình theo turn rồi trừ phạt `user_week` của chính tuần đó, tối thiểu 0).
 * 2. Gộp các tuần như tổng quan và hồ sơ: trung bình có trọng số là số session gốc của tuần trong tháng.
 *
 * Phạt của một tuần chỉ trừ vào tuần đó, nên tháng có nhiều tuần bị phạt không bị trừ dồn một lần.
 * Tuần giáp ranh chỉ tính các session thuộc tháng.
 */
export function monthScores(
  sessions: readonly MonthSession[],
  findings: readonly MonthFinding[],
): WeeklyScores {
  const weeks = new Map<string, { sessions: number; scored: WeekScoredSession[]; findings: WeekFinding[] }>();
  const weekOf = new Map<string, string>();
  for (const session of sessions) {
    const key = weekWindow(session.startedAt).start.toISOString().slice(0, 10);
    const week = weeks.get(key) ?? { sessions: 0, scored: [], findings: [] };
    week.sessions++;
    if (session.scores) week.scored.push({ turnCount: session.turnCount, scores: session.scores });
    weeks.set(key, week);
    weekOf.set(session.id, key);
  }
  for (const finding of findings) {
    const key = weekOf.get(finding.sessionId);
    if (key) weeks.get(key)!.findings.push({ category: finding.category, severity: finding.severity });
  }
  return mergeWeeklyScores([...weeks.values()].map((week) => ({
    sessions: week.sessions,
    scores: computeWeeklyScores(week.scored, week.findings) as Record<string, number>,
  })));
}
