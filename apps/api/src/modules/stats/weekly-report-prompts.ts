import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { UntrustedBlock } from '../llm/llm.types.js';

/**
 * Prompt, schema đầu ra và cách dựng đầu vào cho B1 (báo cáo tuần theo người, M6.8).
 * Đổi chỉ dẫn hoặc cách dựng đầu vào thì tăng số phiên bản.
 */
export const WEEKLY_REPORT_PROMPT_VERSION = 'weekly_user@1';

/** Giới hạn ký tự của prompt ví dụ gửi đi và trả về. */
export const EXAMPLE_PROMPT_CHARS = 400;
const MAX_ITEMS = 3;
const LINE_MAX = 400;
const HEADLINE_MAX = 400;
const COMMENT_MAX = 300;

export const reportSchema = z.object({
  headline: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  vsLastWeek: z.string(),
  focus: z.object({ title: z.string(), detail: z.string() }),
  examples: z.array(z.object({ example: z.string(), comment: z.string() })),
});

export type ReportOutput = z.infer<typeof reportSchema>;

export const REPORT_SYSTEM = `You write a short weekly coaching report for one developer about how they used AI coding agents (such as Claude Code or Codex) during one week. The reader is the developer or their team lead.
You get data blocks: "weekly stats" (numbers already computed by the server: sessions, tokens, skill scores from 0 to 100 where higher is better, the previous week, the team average, rules the developer violated with advice, the kinds of work) and up to three "example e<number>" blocks holding a real prompt the developer wrote, each marked "good" or "needs_work".
Rules:
- Use only the numbers and facts given. Never invent a number, a rule, a file or a prompt. If the previous week has no data, say so in vsLastWeek instead of guessing.
- Skill scores are about habits, not about the person's ability. Be specific, kind and practical; no flattery and no blame.
Fields:
- headline: one or two sentences summarising the week.
- strengths: up to 3 things that went well, each citing a number or a rule from the data (skill scores clearly above the team average or the previous week, categories without violations).
- weaknesses: up to 3 recurring problems, each citing a number or a rule and saying why it matters.
- vsLastWeek: how this week compares with last week (scores and volume), one or two sentences.
- focus: ONE habit to practise next week: a short title and one or two sentences of concrete advice, preferably based on the most frequent or severe rule violation and its advice.
- examples: for the example blocks worth discussing, the id exactly as shown (for example "e1") and one or two sentences of comment: why the prompt works well, or what to add to it. Never invent an id. Do not copy secrets or file contents from a prompt.
Write every field in the requested language.`;

const truncate = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Id (UUID dạng v5) cho kết quả AI của một người trong một tuần của một project (`subject_id` của `ai_results`). */
export function userWeekId(
  projectId: string,
  userId: string,
  week: string,
): string {
  const bytes = createHash('sha256')
    .update(`user-week|${projectId}|${userId}|${week}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type Scores = Record<string, number>;

export interface WeekNumbers {
  sessions: number;
  tokens: number;
  scores: Scores;
}

export interface RulePattern {
  ruleKey: string;
  category: string;
  severity: string;
  count: number;
  advice: string | null;
}

export interface ReportExampleInput {
  sessionId: string;
  turnSeq: number;
  kind: 'good' | 'needs_work';
  text: string;
}

export interface ReportInput {
  /** Thứ Hai của tuần, `YYYY-MM-DD`. */
  week: string;
  current: WeekNumbers;
  /** `null` khi tuần trước không có session nào. */
  previous: WeekNumbers | null;
  teamScores: Scores;
  patterns: readonly RulePattern[];
  workTypes: readonly { workType: string | null; sessions: number }[];
  examples: readonly ReportExampleInput[];
}

const scoreLine = (label: string, scores: Scores) => {
  const parts = Object.keys(scores)
    .sort()
    .map((key) => `${key} ${scores[key]}`);
  return `${label}: ${parts.length > 0 ? parts.join(', ') : 'no scores'}`;
};

/** Các khối dữ liệu gửi cho AI: số liệu tuần rồi mỗi ví dụ một khối (nhãn chỉ có mã `e1`, `e2`...). */
export function reportBlocks(input: ReportInput): UntrustedBlock[] {
  const { current, previous } = input;
  const lines = [
    `Week starting Monday ${input.week} (UTC).`,
    `Sessions: ${current.sessions}. Tokens: ${current.tokens}.`,
    scoreLine('Skill scores this week (0-100, higher is better)', current.scores),
    previous
      ? `Previous week: ${previous.sessions} sessions, ${previous.tokens} tokens. ${scoreLine('Previous week scores', previous.scores)}`
      : 'Previous week: no data.',
    scoreLine('Team average this week', input.teamScores),
    `Kinds of work this week: ${
      input.workTypes.length > 0
        ? input.workTypes.map((w) => `${w.workType ?? 'unclassified'} ${w.sessions}`).join(', ')
        : 'unknown'
    }.`,
    input.patterns.length > 0
      ? `Rules violated this week:\n${input.patterns
          .map(
            (p) =>
              `- ${p.ruleKey} (${p.category}, severity ${p.severity}) x${p.count}${p.advice ? `. Advice: ${oneLine(p.advice)}` : ''}`,
          )
          .join('\n')}`
      : 'Rules violated this week: none.',
  ];
  return [
    { label: 'weekly stats', content: lines.join('\n') },
    ...input.examples.map((e, i) => ({
      label: `example e${i + 1}`,
      content: `Marked: ${e.kind}.\n\n${truncate(e.text.trim(), EXAMPLE_PROMPT_CHARS)}`,
    })),
  ];
}

export interface WeeklyReportView {
  week: string;
  headline: string;
  strengths: string[];
  weaknesses: string[];
  vsLastWeek: string;
  focus: { title: string; detail: string };
  examples: {
    sessionId: string;
    turnSeq: number;
    kind: 'good' | 'needs_work';
    excerpt: string;
    comment: string;
  }[];
}

const clean = (items: readonly string[], max: number, length = LINE_MAX) =>
  items
    .map((item) => truncate(oneLine(item), length))
    .filter((item) => item.length > 0)
    .slice(0, max);

/**
 * Dạng lưu và trả về: gọn chuỗi, tối đa 3 mục mỗi danh sách; ví dụ chỉ giữ mã hợp lệ (`e1`, `e2`...), không trùng,
 * và `sessionId`, `turnSeq`, `kind`, `excerpt` lấy từ dữ liệu của server chứ không từ AI.
 */
export function normalizeReport(
  output: ReportOutput,
  input: Pick<ReportInput, 'week' | 'examples'>,
): WeeklyReportView {
  const seen = new Set<number>();
  const examples: WeeklyReportView['examples'] = [];
  for (const item of output.examples) {
    const match = /^e(\d+)$/.exec(item.example.trim().toLowerCase());
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const source = input.examples[index];
    if (!source || seen.has(index)) continue;
    const comment = truncate(oneLine(item.comment), COMMENT_MAX);
    if (!comment) continue;
    seen.add(index);
    examples.push({
      sessionId: source.sessionId,
      turnSeq: source.turnSeq,
      kind: source.kind,
      excerpt: truncate(source.text.trim(), EXAMPLE_PROMPT_CHARS),
      comment,
    });
    if (examples.length === MAX_ITEMS) break;
  }
  return {
    week: input.week,
    headline: truncate(oneLine(output.headline), HEADLINE_MAX),
    strengths: clean(output.strengths, MAX_ITEMS),
    weaknesses: clean(output.weaknesses, MAX_ITEMS),
    vsLastWeek: truncate(oneLine(output.vsLastWeek), HEADLINE_MAX),
    focus: {
      title: truncate(oneLine(output.focus.title), 120),
      detail: truncate(oneLine(output.focus.detail), LINE_MAX),
    },
    examples,
  };
}
