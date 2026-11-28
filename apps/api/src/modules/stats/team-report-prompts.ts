import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { UntrustedBlock } from '../llm/llm.types.js';

/**
 * Prompt, schema đầu ra và cách dựng đầu vào cho B2 (báo cáo tuần của team, M6.9).
 * Đầu vào chỉ có số liệu tổng hợp với mã ẩn danh: không có prompt và không có tên người.
 * Đổi chỉ dẫn hoặc cách dựng đầu vào thì tăng số phiên bản.
 */
export const TEAM_REPORT_PROMPT_VERSION = 'weekly_team@1';

const MAX_ITEMS = 3;
const TEXT_MAX = 400;
const COMMENT_MAX = 300;

export const teamReportSchema = z.object({
  headline: z.string(),
  vsLastWeek: z.string(),
  topIssues: z.array(z.object({ issue: z.string(), comment: z.string() })),
  improved: z.array(z.object({ member: z.string(), comment: z.string() })),
  sharingSession: z.object({ topic: z.string(), detail: z.string() }),
});

export type TeamReportOutput = z.infer<typeof teamReportSchema>;

export const TEAM_REPORT_SYSTEM = `You write a short weekly report for a team lead about how their developer team used AI coding agents (such as Claude Code or Codex) during one week.
You get one data block, "team stats", with numbers already computed by the server: sessions and tokens, skill scores from 0 to 100 (higher is better) for this week, the previous week and the team, the rules the team violated most (each with an id like r1, how many times, how many members, and the rule's advice), the kinds of work, and one line per member with an anonymous id like m1 (sessions, overall score, previous overall score, change).
Rules:
- Use only the numbers and facts given. Never invent a number, a rule or a member. If the previous week has no data, say so in vsLastWeek instead of guessing.
- Members are anonymous ids. Refer to them only through the "member" field of "improved"; never guess who they are.
- Scores describe habits, not people's ability. Be specific, constructive and practical; no blame.
Fields:
- headline: one or two sentences summarising the team's week.
- vsLastWeek: how the week compares with the previous one (volume and scores), one or two sentences.
- topIssues: up to 3 of the most common problems: the rule id exactly as shown (for example "r1") and one or two sentences of comment (why it matters, what the team could do). Never invent an id.
- improved: up to 3 members who improved the most (use a positive change in their overall score and enough sessions): the member id exactly as shown (for example "m2") and one sentence of comment. Leave the list empty if nobody improved or there is no previous week.
- sharingSession: one idea for a short team sharing session next week: a topic and one or two sentences on what to cover, based on the most common problem or on what the improving members did.
Write every field in the requested language.`;

const truncate = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Id (UUID dạng v5) cho kết quả AI của một project trong một tuần (`subject_id` của `ai_results`). */
export function teamWeekId(projectId: string, week: string): string {
  const bytes = createHash('sha256')
    .update(`project-week|${projectId}|${week}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type Scores = Record<string, number>;

export interface TeamWeekNumbers {
  sessions: number;
  tokens: number;
  scores: Scores;
}

export interface TeamIssue {
  ruleKey: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  count: number;
  memberCount: number;
  advice: string | null;
}

export interface TeamMember {
  userId: string;
  name: string;
  sessions: number;
  /** Điểm tổng (trung bình các nhóm có điểm); `null` khi chưa có điểm. */
  overall: number | null;
  previousOverall: number | null;
  /** `overall - previousOverall`, `null` khi thiếu một trong hai. */
  change: number | null;
}

export interface TeamReportInput {
  /** Thứ Hai của tuần, `YYYY-MM-DD`. */
  week: string;
  current: TeamWeekNumbers & { activeMembers: number };
  /** `null` khi tuần trước project không có session nào. */
  previous: TeamWeekNumbers | null;
  issues: readonly TeamIssue[];
  workTypes: readonly { workType: string | null; sessions: number }[];
  members: readonly TeamMember[];
}

const scoreLine = (label: string, scores: Scores) => {
  const parts = Object.keys(scores)
    .sort()
    .map((key) => `${key} ${scores[key]}`);
  return `${label}: ${parts.length > 0 ? parts.join(', ') : 'no scores'}`;
};

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Một khối số liệu duy nhất. Thành viên chỉ có mã `m1`, `m2`... (không tên); rule có mã `r1`, `r2`... */
export function teamReportBlocks(input: TeamReportInput): UntrustedBlock[] {
  const { current, previous } = input;
  const lines = [
    `Week starting Monday ${input.week} (UTC).`,
    `Sessions: ${current.sessions}. Tokens: ${current.tokens}. Active members: ${current.activeMembers}.`,
    scoreLine('Team skill scores this week (0-100, higher is better)', current.scores),
    previous
      ? `Previous week: ${previous.sessions} sessions, ${previous.tokens} tokens. ${scoreLine('Previous week team scores', previous.scores)}`
      : 'Previous week: no data.',
    `Kinds of work this week: ${
      input.workTypes.length > 0
        ? input.workTypes.map((w) => `${w.workType ?? 'unclassified'} ${w.sessions}`).join(', ')
        : 'unknown'
    }.`,
    input.issues.length > 0
      ? `Rules violated most this week:\n${input.issues
          .map(
            (p, i) =>
              `r${i + 1}: ${p.ruleKey} (${p.category}, severity ${p.severity}) x${p.count} by ${p.memberCount} member(s)${p.advice ? `. Advice: ${oneLine(p.advice)}` : ''}`,
          )
          .join('\n')}`
      : 'Rules violated most this week: none.',
    input.members.length > 0
      ? `Members:\n${input.members
          .map(
            (m, i) =>
              `m${i + 1} | sessions ${m.sessions} | overall ${m.overall ?? 'n/a'} | previous ${m.previousOverall ?? 'n/a'} | change ${m.change === null ? 'n/a' : signed(m.change)}`,
          )
          .join('\n')}`
      : 'Members: none.',
  ];
  return [{ label: 'team stats', content: lines.join('\n') }];
}

export interface TeamReportView {
  week: string;
  headline: string;
  vsLastWeek: string;
  topIssues: {
    ruleKey: string;
    category: string;
    severity: 'low' | 'medium' | 'high';
    count: number;
    memberCount: number;
    comment: string;
  }[];
  improved: { userId: string; name: string; change: number | null; comment: string }[];
  sharingSession: { topic: string; detail: string };
}

/**
 * Dạng lưu và trả về: gọn chuỗi; `topIssues` và `improved` chỉ giữ mã hợp lệ (`r1`..., `m1`...), không trùng, tối đa 3;
 * `ruleKey`, `category`, `count`, `memberCount`, `userId`, `name`, `change` lấy từ dữ liệu của server chứ không từ AI.
 */
export function normalizeTeamReport(
  output: TeamReportOutput,
  input: Pick<TeamReportInput, 'week' | 'issues' | 'members'>,
): TeamReportView {
  const pick = <T>(
    items: readonly { code: string; comment: string }[],
    prefix: string,
    source: readonly T[],
  ): { source: T; comment: string }[] => {
    const seen = new Set<number>();
    const out: { source: T; comment: string }[] = [];
    for (const item of items) {
      const match = new RegExp(`^${prefix}(\\d+)$`).exec(item.code.trim().toLowerCase());
      if (!match) continue;
      const index = Number(match[1]) - 1;
      const found = source[index];
      if (found === undefined || seen.has(index)) continue;
      const comment = truncate(oneLine(item.comment), COMMENT_MAX);
      if (!comment) continue;
      seen.add(index);
      out.push({ source: found, comment });
      if (out.length === MAX_ITEMS) break;
    }
    return out;
  };

  return {
    week: input.week,
    headline: truncate(oneLine(output.headline), TEXT_MAX),
    vsLastWeek: truncate(oneLine(output.vsLastWeek), TEXT_MAX),
    topIssues: pick(
      output.topIssues.map((i) => ({ code: i.issue, comment: i.comment })),
      'r',
      input.issues,
    ).map(({ source, comment }) => ({
      ruleKey: source.ruleKey,
      category: source.category,
      severity: source.severity,
      count: source.count,
      memberCount: source.memberCount,
      comment,
    })),
    improved: pick(
      output.improved.map((i) => ({ code: i.member, comment: i.comment })),
      'm',
      input.members,
    ).map(({ source, comment }) => ({
      userId: source.userId,
      name: source.name,
      change: source.change,
      comment,
    })),
    sharingSession: {
      topic: truncate(oneLine(output.sharingSession.topic), 160),
      detail: truncate(oneLine(output.sharingSession.detail), TEXT_MAX),
    },
  };
}
