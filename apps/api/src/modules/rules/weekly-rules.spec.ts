import { describe, it, expect } from 'vitest';
import { evaluateWeek, weeklyRules } from './weekly-rules.js';
import { sessionRules } from './session-rules.js';
import type { RuleTurn } from './session-engine.js';

for (const rule of weeklyRules) {
  describe(rule.key, () => {
    for (const test of rule.tests) {
      it(test.name, () => {
        expect(evaluateWeek(test.input, [rule])).toHaveLength(
          test.expect === 'triggered' ? 1 : 0,
        );
      });
    }
  });
}

it('không tính session con; gắn một finding vào session có nhiều bằng chứng nhất', () => {
  const rule = weeklyRules.find((item) => item.key === 'lazy-prompting')!;
  const [a] = rule.tests[0].input;
  expect(evaluateWeek([{ ...a, parentSourceId: 'parent' }], [rule])).toEqual(
    [],
  );
  const b = { ...a, id: 'b', turns: a.turns.slice(0, 5) };
  expect(evaluateWeek([b, a], [rule])).toMatchObject([
    { sessionId: a.id, count: 15, total: 15, ratio: 1 },
  ]);
  const atThreshold = {
    ...a,
    turns: a.turns.map((t, i) => (i < 3 ? t : { ...t, text: 'x'.repeat(30) })),
  };
  expect(evaluateWeek([atThreshold], [rule])).toEqual([]);
});

it('đủ 16 rule high/medium và 8 rule low, mọi key riêng biệt', () => {
  expect(
    new Set([...sessionRules, ...weeklyRules].map((r) => r.key)).size,
  ).toBe(24);
});

describe('high-interruption đọc cờ ngắt như adapter CLI gắn', () => {
  const rule = weeklyRules.find((item) => item.key === 'high-interruption')!;
  const user = (seq: number): RuleTurn => ({ seq, role: 'user', kind: 'prompt', text: 'Làm tiếp' });
  const assistant = (seq: number, interrupted?: boolean): RuleTurn => ({
    seq,
    role: 'assistant',
    kind: 'tool_call',
    interrupted,
  });
  const week = (turns: RuleTurn[]) => [{ id: 'a', parentSourceId: null, turns }];

  it('Claude Code: turn assistant cuối của lượt bị ngắt, tính cho prompt của lượt đó', () => {
    // 20 prompt, mỗi lượt hai turn assistant; 4 lượt có turn cuối bị ngắt.
    const turns = Array.from({ length: 20 }, (_, i) => [
      user(i * 3),
      assistant(i * 3 + 1),
      assistant(i * 3 + 2, i % 5 === 0 ? true : undefined),
    ]).flat();
    expect(evaluateWeek(week(turns), [rule])).toMatchObject([
      { sessionId: 'a', turnSeq: 0, count: 4, total: 20, ratio: 0.2 },
    ]);
  });

  it('Codex: lượt bị hủy trước khi assistant trả lời thì cờ nằm trên prompt', () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      i < 4 ? [{ ...user(i * 2), interrupted: true }] : [user(i * 2), assistant(i * 2 + 1)],
    ).flat();
    expect(evaluateWeek(week(turns), [rule])).toMatchObject([{ count: 4, total: 20 }]);
  });

  it('nhiều turn bị ngắt trong một lượt chỉ tính một prompt; turn trước prompt đầu bị bỏ qua', () => {
    const turns = [
      assistant(0, true),
      ...Array.from({ length: 20 }, (_, i) => [
        user(i * 3 + 1),
        assistant(i * 3 + 2, i < 3),
        assistant(i * 3 + 3, i < 3),
      ]).flat(),
    ];
    expect(evaluateWeek(week(turns), [rule])).toEqual([]);
  });
});
