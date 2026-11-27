import { CATEGORIES, computeWeeklyScores, type Category, type WeeklyScores, type WeekFinding } from './weekly-stats.js';
import { weekWindow } from './refresh-weekly-stats.js';

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

/** Dùng lại đúng công thức điểm tuần cho các session gốc trong tháng dương lịch UTC. */
export function monthScores(
  sessions: readonly { turnCount: number; scores: Record<string, number> }[],
  findings: readonly WeekFinding[],
): WeeklyScores {
  return computeWeeklyScores(sessions, findings);
}
