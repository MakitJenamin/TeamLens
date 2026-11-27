import type { Schemas } from '@teamlens/schema';
import {
  listWeeks,
  mergeWeeklyScores,
  type Range,
  type StatsRow,
} from './overview-math.js';

export type MemberProfile = Schemas['MemberProfile'];
export type ProfilePattern = Schemas['ProfilePattern'];
export type ProfileExample = Schemas['ProfileExample'];

/** Mặc định của hồ sơ thành viên: 2 tuần gần nhất, gồm tuần hiện tại. */
export const PROFILE_DEFAULT_WEEKS = 2;
export const MAX_PATTERNS = 10;
export const MAX_EXAMPLES = 3;

/** Một rule bị vi phạm, chưa gắn ví dụ. */
export type PatternRow = Omit<ProfilePattern, 'examples'>;

/** Một ví dụ của một rule (đã xếp hạng, mới nhất trước). */
export interface ExampleRow extends ProfileExample {
  ruleKey: string;
}

/**
 * Hồ sơ thành viên (M2.10):
 * - `scores`: trung bình điểm tuần của thành viên trong khoảng, trọng số là số session mỗi tuần.
 * - `teamScores`: trung bình điểm tuần của mọi thành viên project trong cùng khoảng (trọng số theo số session).
 * - `weeks`: mỗi tuần trong khoảng một phần tử, kể cả tuần không có dữ liệu.
 * - `patterns`: tối đa 10 rule, mỗi rule tối đa 3 ví dụ, theo thứ tự đã xếp sẵn.
 */
export function buildProfile(input: {
  user: { id: string; name: string };
  projectId: string;
  range: Range;
  memberRows: readonly StatsRow[];
  teamRows: readonly StatsRow[];
  patterns: readonly PatternRow[];
  examples: readonly ExampleRow[];
}): MemberProfile {
  const { user, projectId, range, memberRows, teamRows, patterns, examples } =
    input;

  const weeks = listWeeks(range).map((week) => {
    const mine = memberRows.filter((row) => row.week === week);
    return {
      week,
      sessions: mine.reduce((sum, row) => sum + row.sessions, 0),
      tokens: mine.reduce((sum, row) => sum + row.tokens, 0),
      scores: mergeWeeklyScores(mine),
      teamScores: mergeWeeklyScores(teamRows.filter((row) => row.week === week)),
    };
  });

  const examplesByRule = new Map<string, ProfileExample[]>();
  for (const { ruleKey, ...example } of examples) {
    const list = examplesByRule.get(ruleKey) ?? [];
    if (list.length < MAX_EXAMPLES) list.push(example);
    examplesByRule.set(ruleKey, list);
  }

  return {
    user,
    projectId,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    totals: {
      sessions: weeks.reduce((sum, w) => sum + w.sessions, 0),
      tokens: weeks.reduce((sum, w) => sum + w.tokens, 0),
    },
    scores: mergeWeeklyScores(memberRows),
    teamScores: mergeWeeklyScores(teamRows),
    weeks,
    patterns: patterns.slice(0, MAX_PATTERNS).map((pattern) => ({
      ...pattern,
      examples: examplesByRule.get(pattern.ruleKey) ?? [],
    })),
  };
}
