import { describe, expect, it } from 'vitest';
import { normalizeRange, type StatsRow } from './overview-math.js';
import {
  buildProfile,
  MAX_EXAMPLES,
  PROFILE_DEFAULT_WEEKS,
  type ExampleRow,
  type PatternRow,
} from './profile-math.js';

const d = (iso: string) => new Date(iso);
const user = { id: 'u1', name: 'Thành viên 1' };

const row = (
  userId: string,
  week: string,
  sessions: number,
  scores: Record<string, number>,
  tokens = 0,
): StatsRow => ({ userId, week, sessions, tokens, scores });

describe('normalizeRange với số tuần mặc định của hồ sơ', () => {
  it('mặc định 2 tuần gần nhất, gồm tuần hiện tại', () => {
    const range = normalizeRange(
      undefined,
      undefined,
      d('2026-11-12T10:00:00Z'),
      PROFILE_DEFAULT_WEEKS,
    );
    expect(range.from.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });
});

describe('buildProfile', () => {
  const range = normalizeRange(
    d('2026-11-02T00:00:00Z'),
    d('2026-11-16T00:00:00Z'),
    d('2026-11-12T00:00:00Z'),
  );

  it('thành viên chưa có dữ liệu: số 0, điểm rỗng, không có anti-pattern', () => {
    const p = buildProfile({
      user,
      projectId: 'p',
      range,
      memberRows: [],
      teamRows: [],
      patterns: [],
      examples: [],
    });
    expect(p.totals).toEqual({ sessions: 0, tokens: 0 });
    expect(p.scores).toEqual({});
    expect(p.teamScores).toEqual({});
    expect(p.weeks).toEqual([
      { week: '2026-11-02', sessions: 0, tokens: 0, scores: {}, teamScores: {} },
      { week: '2026-11-09', sessions: 0, tokens: 0, scores: {}, teamScores: {} },
    ]);
    expect(p.patterns).toEqual([]);
  });

  it('điểm của thành viên và của team tính riêng, mỗi tuần và cả khoảng', () => {
    const member = [
      row('u1', '2026-11-02', 4, { context: 100 }, 1000),
      row('u1', '2026-11-09', 1, { context: 50 }, 500),
    ];
    const team = [
      ...member,
      row('u2', '2026-11-02', 4, { context: 60 }, 800),
      row('u2', '2026-11-09', 4, { context: 80 }, 900),
    ];
    const p = buildProfile({
      user,
      projectId: 'p',
      range,
      memberRows: member,
      teamRows: team,
      patterns: [],
      examples: [],
    });
    expect(p.totals).toEqual({ sessions: 5, tokens: 1500 });
    // (100*4 + 50*1) / 5 = 90
    expect(p.scores).toEqual({ context: 90 });
    // (100*4 + 50*1 + 60*4 + 80*4) / 13 = 77,7 -> 78
    expect(p.teamScores).toEqual({ context: 78 });
    expect(p.weeks[0]).toMatchObject({
      sessions: 4,
      tokens: 1000,
      scores: { context: 100 },
      teamScores: { context: 80 },
    });
    // (50*1 + 80*4) / 5 = 74
    expect(p.weeks[1].teamScores).toEqual({ context: 74 });
  });

  it('gắn ví dụ vào đúng rule, tối đa 3 ví dụ và giữ thứ tự đã xếp', () => {
    const patterns: PatternRow[] = [
      {
        ruleKey: 'lazy-prompting',
        category: 'prompt_quality',
        severity: 'medium',
        count: 6,
        advice: 'Bổ sung mục tiêu và ngữ cảnh.',
      },
      {
        ruleKey: 'repeated-correction',
        category: 'correction_loop',
        severity: 'high',
        count: 1,
        advice: null,
      },
    ];
    const ex = (ruleKey: string, n: number): ExampleRow => ({
      ruleKey,
      sessionId: `s${n}`,
      turnSeq: n,
      message: `m${n}`,
      excerpt: n % 2 ? 'fix' : null,
    });
    const p = buildProfile({
      user,
      projectId: 'p',
      range,
      memberRows: [],
      teamRows: [],
      patterns,
      examples: [
        ex('lazy-prompting', 1),
        ex('lazy-prompting', 2),
        ex('lazy-prompting', 3),
        ex('lazy-prompting', 4),
        ex('repeated-correction', 9),
      ],
    });
    expect(p.patterns[0].examples).toHaveLength(MAX_EXAMPLES);
    expect(p.patterns[0].examples.map((e) => e.sessionId)).toEqual([
      's1',
      's2',
      's3',
    ]);
    expect(p.patterns[0].examples[0]).not.toHaveProperty('ruleKey');
    expect(p.patterns[1].examples).toEqual([
      { sessionId: 's9', turnSeq: 9, message: 'm9', excerpt: 'fix' },
    ]);
    expect(p.patterns[1].advice).toBeNull();
  });

  it('chỉ giữ tối đa 10 anti-pattern', () => {
    const patterns: PatternRow[] = Array.from({ length: 12 }, (_, i) => ({
      ruleKey: `rule-${i}`,
      category: 'context',
      severity: 'low',
      count: 12 - i,
      advice: null,
    }));
    const p = buildProfile({
      user,
      projectId: 'p',
      range,
      memberRows: [],
      teamRows: [],
      patterns,
      examples: [],
    });
    expect(p.patterns).toHaveLength(10);
    expect(p.patterns[0].ruleKey).toBe('rule-0');
  });
});
