import type { RuleSession, RuleTurn } from './session-engine.js';
import { hasCriteria, humanPrompts, loc } from './session-signals.js';
import { isPremiumModel } from '../stats/pricing.js';

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
  metric: 'shortPrompt' | 'missingCriteria' | 'fastFollowup' | 'noSpecFirst' | 'missingConstraint' | 'noFileContext' | 'interrupted' | 'premiumTrivial';
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
  if (rule.metric === 'noSpecFirst') {
    if (prompts.length < t.minPrompts) return { eligible: 0, hits: [] };
    const first = prompts[0];
    const hasSpec = /\b(?:spec|plan)\b|kế hoạch|đặc tả|thiết kế|docs[/\\][\w.-]+\.md/iu.test(first.text ?? '');
    return { eligible: 1, hits: hasSpec ? [] : [first] };
  }
  if (rule.metric === 'missingConstraint') {
    const eligible = prompts.filter((prompt) => Array.from(prompt.text ?? '').length >= t.minChars);
    const constraint = /không được|đừng|\bchỉ\b|phải|tránh|tối đa|ít nhất|bắt buộc|giữ nguyên|không dùng|không sửa|\b(?:do not|don't|must|never|only|avoid|at most|at least|without|ensure)\b/iu;
    return { eligible: eligible.length, hits: eligible.filter((prompt) => !constraint.test(prompt.text ?? '')) };
  }
  if (rule.metric === 'noFileContext') {
    const file = /@\S+|(?:[\w.-]+[/\\])+[\w.-]+|\b[\w-]+\.[a-z][a-z0-9]{0,7}\b/iu;
    return { eligible: prompts.length, hits: prompts.filter((prompt) => !file.test(prompt.text ?? '')) };
  }
  if (rule.metric === 'interrupted') {
    // Adapter gắn `interrupted` cho turn assistant đang trả lời (Codex gắn vào prompt khi lượt chưa có turn
    // assistant nào), nên một prompt bị ngắt khi chính nó hoặc một turn trước prompt kế tiếp mang cờ này.
    const hits: RuleTurn[] = [];
    let current: RuleTurn | undefined;
    let interrupted = false;
    for (const turn of ordered) {
      if (turn.role === 'user' && turn.kind === 'prompt') {
        if (current && interrupted) hits.push(current);
        current = turn;
        interrupted = false;
      }
      if (current && turn.interrupted === true) interrupted = true;
    }
    if (current && interrupted) hits.push(current);
    return { eligible: prompts.length, hits };
  }
  if (rule.metric === 'premiumTrivial') {
    const hits: RuleTurn[] = [];
    const lookup = /(?:là gì|ở đâu|làm sao|tại sao|giải thích|what is|how do i|explain)/iu;
    for (let index = 0; index < ordered.length; index++) {
      const turn = ordered[index];
      if (turn.role !== 'user' || turn.kind !== 'prompt') continue;
      const text = turn.text ?? '';
      if (Array.from(text).length >= t.maxChars || !lookup.test(text)) continue;
      const following: RuleTurn[] = [];
      for (let next = index + 1; next < ordered.length; next++) {
        if (ordered[next].role === 'user' && ordered[next].kind === 'prompt') break;
        following.push(ordered[next]);
      }
      if (following.some((item) => item.kind === 'tool_call' || loc(item) > 0)) continue;
      if (following.some((item) => isPremiumModel(item.model ?? null))) hits.push(turn);
    }
    return { eligible: prompts.length, hits };
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
    const requiredSample = rule.thresholds.minReqs ?? rule.thresholds.minSample ?? rule.thresholds.minSessions ?? rule.min_sample;
    if (!witness || total < requiredSample) return [];
    const ratio = count / total;
    if (
      rule.metric === 'missingCriteria' || rule.metric === 'noSpecFirst' || rule.metric === 'missingConstraint'
        ? (total - count) / total >= (rule.thresholds.structuredRate ?? rule.thresholds.specRate ?? rule.thresholds.constraintRate)
        : rule.aggregate === 'ratio'
          ? ratio <= (rule.thresholds.maxRatio ?? rule.thresholds.maxNoContextRate ?? rule.thresholds.maxRate)
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
/** Giống dữ liệu thật: cờ ngắt nằm ở turn assistant trả lời prompt, không nằm ở prompt. */
const interruptedReplies = (n: number) => [
  session(
    'a',
    Array.from({ length: 20 }, (_, i) => [
      p(i * 2, 'Làm tiếp'),
      { seq: i * 2 + 1, role: 'assistant' as const, kind: 'reply' as const, interrupted: i < n },
    ]).flat(),
  ),
];
export const weeklyRules: WeeklyRule[] = [
  {
    key: 'no-spec-first', category: 'prompt_quality', severity: 'low', scope: 'user_week',
    aggregate: 'ratio', metric: 'noSpecFirst', min_sample: 5,
    thresholds: { minPrompts: 3, specRate: 0.2, minSessions: 5 },
    message: '{{count}}/{{total}} session không nhắc spec hoặc plan ở prompt đầu.',
    advice: 'Nhắc tới đặc tả hoặc kế hoạch khi bắt đầu công việc.',
    tests: [
      { name: 'năm session thiếu spec', input: missing(5), expect: 'triggered' },
      { name: 'có spec trong prompt đầu', input: Array.from({ length: 5 }, (_, i) => session(String(i), [p(0, 'Theo docs/SPEC.md hãy sửa'), p(1, 'làm tiếp'), p(2, 'kiểm tra')])) , expect: 'clean' },
    ],
  },
  {
    key: 'low-constraint-usage', category: 'prompt_quality', severity: 'low', scope: 'user_week',
    aggregate: 'ratio', metric: 'missingConstraint', min_sample: 30,
    thresholds: { minChars: 40, constraintRate: 0.08, minReqs: 30 },
    message: '{{count}}/{{total}} prompt dài thiếu ràng buộc.',
    advice: 'Nêu giới hạn và điều kiện bắt buộc trong yêu cầu.',
    tests: [
      { name: '30 prompt dài thiếu ràng buộc', input: [session('a', Array.from({ length: 30 }, (_, i) => p(i, 'Hãy làm chức năng xử lý dữ liệu theo yêu cầu hiện tại trong dự án này.')))], expect: 'triggered' },
      { name: 'prompt có ràng buộc', input: [session('a', Array.from({ length: 30 }, (_, i) => p(i, 'Hãy làm chức năng xử lý dữ liệu, phải giữ nguyên API và không sửa phần khác.')))], expect: 'clean' },
    ],
  },
  {
    key: 'no-file-context', category: 'context', severity: 'low', scope: 'user_week',
    aggregate: 'ratio', metric: 'noFileContext', min_sample: 10,
    thresholds: { maxNoContextRate: 0.7, minSample: 10 },
    message: '{{count}}/{{total}} prompt không nhắc file liên quan.',
    advice: 'Chỉ rõ file hoặc đường dẫn cần xem khi yêu cầu.',
    tests: [
      { name: 'mười prompt không file', input: short(10), expect: 'triggered' },
      { name: 'prompt có file', input: [session('a', Array.from({ length: 10 }, (_, i) => p(i, 'Sửa src/main.ts')))], expect: 'clean' },
    ],
  },
  {
    key: 'high-interruption', category: 'session_management', severity: 'low', scope: 'user_week',
    aggregate: 'ratio', metric: 'interrupted', min_sample: 20,
    thresholds: { maxRate: 0.15, minSample: 20 },
    message: '{{count}}/{{total}} prompt bị ngắt trong tuần.',
    advice: 'Kiểm tra nguyên nhân ngắt và chia nhỏ yêu cầu.',
    tests: [
      { name: 'bốn trong hai mươi lượt trả lời bị ngắt', input: interruptedReplies(4), expect: 'triggered' },
      { name: 'ba trong hai mươi', input: interruptedReplies(3), expect: 'clean' },
    ],
  },
  {
    key: 'premium-for-trivial', category: 'session_management', severity: 'low', scope: 'user_week',
    aggregate: 'ratio', metric: 'premiumTrivial', min_sample: 10,
    thresholds: { maxChars: 120, maxRatio: 0.1, minSample: 10 },
    message: '{{count}}/{{total}} câu hỏi ngắn dùng model cao cấp mà không cần tool.',
    advice: 'Dùng model vừa đủ cho câu hỏi tra cứu đơn giản.',
    tests: [
      { name: 'câu hỏi ngắn dùng Opus', input: [session('a', Array.from({ length: 10 }, (_, i) => [p(i * 2, 'Giải thích là gì?'), { seq: i * 2 + 1, role: 'assistant' as const, kind: 'reply' as const, model: 'claude-opus-4-6' }]).flat())], expect: 'triggered' },
      { name: 'câu hỏi ngắn dùng model thường', input: [session('a', Array.from({ length: 10 }, (_, i) => [p(i * 2, 'Giải thích là gì?'), { seq: i * 2 + 1, role: 'assistant' as const, kind: 'reply' as const, model: 'claude-sonnet-4-5' }]).flat())], expect: 'clean' },
    ],
  },
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
