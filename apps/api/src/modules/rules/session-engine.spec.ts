import { describe, expect, it } from 'vitest';
import { evaluateSession } from './session-engine.js';
import { sessionRules } from './session-rules.js';

for (const rule of sessionRules) {
  describe(rule.key, () => {
    for (const test of rule.tests) {
      it(test.name, () => {
        expect(evaluateSession(test.input, [rule])).toHaveLength(
          test.expect === 'triggered' ? 1 : 0,
        );
      });
    }
  });
}

it('giữ thứ tự seq, trả bằng chứng và tôn trọng cấu hình ngưỡng', () => {
  const rule = sessionRules[0];
  const { input } = rule.tests[0];
  const session = { ...input, turns: [...input.turns].reverse() };
  expect(evaluateSession(session, [rule])).toMatchObject([
    {
      ruleKey: rule.key,
      count: 3,
      turnSeq: 3,
      evidenceExcerpt: 'CHƯA ĐƯỢC',
      message: 'Có 3 prompt liên tiếp báo kết quả vẫn sai.',
    },
  ]);
  expect(
    evaluateSession(session, [{ ...rule, thresholds: { min: 4 } }]),
  ).toEqual([]);
});

it('bỏ qua session con và không có finding khi session rỗng', () => {
  for (const rule of sessionRules) {
    expect(
      evaluateSession({ ...rule.tests[0].input, parentSourceId: 'parent' }, [
        rule,
      ]),
    ).toEqual([]);
  }
  expect(
    evaluateSession({ parentSourceId: null, turns: [] }, sessionRules),
  ).toEqual([]);
});
