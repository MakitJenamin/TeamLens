import { describe, it, expect } from 'vitest';
import { evaluateWeek, weeklyRules } from './weekly-rules.js';
import { sessionRules } from './session-rules.js';

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
