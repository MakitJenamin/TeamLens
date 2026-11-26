import type { RuleSession, RuleTurn } from './session-engine.js';
import { hasCriteria, humanPrompts, loc } from './session-signals.js';

export interface WeekSession extends RuleSession {
  id: string;
}
interface Sample {
  eligible: number;
  hits: RuleTurn[];
}
interface WeeklyTest {
  name: string;
  input: WeekSession[];
  expect: 'triggered' | 'clean';
}
export interface WeeklyRule {
  key: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  scope: 'user_week';
  aggregate: 'ratio' | 'count';
  min_sample: number;
  metric: 'shortPrompt' | 'missingCriteria' | 'fastFollowup';
  thresholds: Record<string, number>;
  message: string;
  advice: string;
  tests: WeeklyTest[];
}

function sample(session: WeekSession, rule: WeeklyRule): Sample {
  const ordered = [...session.turns].sort((a, b) => a.seq - b.seq);
  const prompts = humanPrompts(ordered);
  const { thresholds: t } = rule;
  if (rule.metric === 'shortPrompt') {
    const eligible = prompts.filter((p) => p.text?.trim());
    return {
      eligible: eligible.length,
      hits: eligible.filter(
        (p) => Array.from(p.text!.trim()).length < t.minChars,
      ),
    };
  }
  if (rule.metric === 'missingCriteria') {
    if (prompts.length < t.minPrompts) return { eligible: 0, hits: [] };
    return {
      eligible: 1,
      hits: hasCriteria(prompts[0].text ?? '') ? [] : [prompts[0]],
    };
  }
  const hits: RuleTurn[] = [];
  let diff: RuleTurn | undefined;
  let eligible = 0;
  for (const turn of ordered) {
    if (turn.role === 'user' && turn.kind === 'prompt') {
      if (diff?.ts && turn.ts) {
        const gap = Date.parse(turn.ts) - Date.parse(diff.ts);
        if (gap >= 0) {
          eligible++;
          if (gap <= t.maxGapSec * 1000) hits.push(turn);
        }
      }
      diff = undefined;
    }
    if (loc(turn) >= t.minLoc) diff = turn;
  }
  return { eligible, hits };
}

/** Đầu vào thuộc cùng user, project và tuần UTC. Một rule chọn tối đa một session làm ví dụ. */
export function evaluateWeek(
  sessions: readonly WeekSession[],
  rules: readonly WeeklyRule[],
) {
  return rules.flatMap((rule) => {
    let total = 0,
      count = 0,
      best = 0;
    let witness: { sessionId: string; turnSeq: number } | undefined;
    for (const session of sessions) {
      if (session.parentSourceId !== null) continue;
      const { eligible, hits } = sample(session, rule);
      total += eligible;
      count += hits.length;
      if (
        hits.length > best ||
        (hits.length > 0 &&
          hits.length === best &&
          witness &&
          session.id < witness.sessionId)
      ) {
        best = hits.length;
        witness = { sessionId: session.id, turnSeq: hits[0].seq };
      }
    }
    if (!witness || total < rule.min_sample) return [];
    const ratio = count / total;
    if (
      rule.metric === 'missingCriteria'
        ? (total - count) / total >= rule.thresholds.structuredRate
        : rule.aggregate === 'ratio'
          ? ratio <= rule.thresholds.maxRatio
          : count < rule.thresholds.minOccurrences
    )
      return [];
    return [
      {
        ...witness,
        ruleKey: rule.key,
        severity: rule.severity,
        count,
        total,
        ratio,
        message: rule.message
          .replace('{{count}}', String(count))
          .replace('{{total}}', String(total)),
      },
    ];
  });
}

const p = (seq: number, text: string): RuleTurn => ({
  seq,
  text,
  role: 'user',
  kind: 'prompt',
});
const session = (id: string, turns: RuleTurn[]): WeekSession => ({
  id,
  parentSourceId: null,
  turns,
});
const short = (n: number) => [
  session(
    'a',
    Array.from({ length: n }, (_, i) => p(i, 'fix')),
  ),
];
const missing = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    session(String(i), [p(0, 'sửa'), p(1, 'làm tiếp'), p(2, 'thử lại')]),
  );
const fast = (gap: number) =>
  Array.from({ length: 5 }, (_, i) =>
    session(String(i), [
      {
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        ts: '2026-11-02T09:00:00Z',
        diff: { added: 20, removed: 0, path: 'a.ts' },
      },
      {
        ...p(1, 'tiếp'),
        ts: new Date(
          Date.parse('2026-11-02T09:00:00Z') + gap * 1000,
        ).toISOString(),
      },
    ]),
  );
export const weeklyRules: WeeklyRule[] = [
  {
    key: 'lazy-prompting',
    category: 'prompt_quality',
    severity: 'medium',
    scope: 'user_week',
    aggregate: 'ratio',
    metric: 'shortPrompt',
    min_sample: 10,
    thresholds: { minChars: 30, maxRatio: 0.3 },
    message: '{{count}}/{{total}} prompt trong tuần quá ngắn.',
    advice: 'Bổ sung mục tiêu và ngữ cảnh.',
    tests: [
      { name: 'đủ mẫu', input: short(10), expect: 'triggered' },
      { name: 'thiếu mẫu', input: short(9), expect: 'clean' },
    ],
  },
  {
    key: 'no-acceptance-criteria',
    category: 'prompt_quality',
    severity: 'medium',
    scope: 'user_week',
    aggregate: 'ratio',
    metric: 'missingCriteria',
    min_sample: 5,
    thresholds: { minPrompts: 3, structuredRate: 0.15 },
    message: '{{count}}/{{total}} session thiếu tiêu chí ở prompt đầu.',
    advice: 'Ghi rõ tiêu chí hoàn thành.',
    tests: [
      {
        name: 'năm phiên đủ điều kiện',
        input: missing(5),
        expect: 'triggered',
      },
      { name: 'bốn phiên', input: missing(4), expect: 'clean' },
    ],
  },
  {
    key: 'speed-accept',
    category: 'verification',
    severity: 'medium',
    scope: 'user_week',
    aggregate: 'count',
    metric: 'fastFollowup',
    min_sample: 5,
    thresholds: { minLoc: 20, maxGapSec: 15, minOccurrences: 5 },
    message: '{{count}} lượt phản hồi nhanh sau diff lớn trong tuần.',
    advice: 'Đọc và kiểm tra diff trước khi tiếp tục.',
    tests: [
      { name: '15 giây', input: fast(15), expect: 'triggered' },
      { name: '16 giây', input: fast(16), expect: 'clean' },
    ],
  },
];
