import { describe, expect, it } from 'vitest';
import {
  buildOverview,
  listWeeks,
  mergeWeeklyScores,
  normalizeRange,
  sortWorkTypes,
  type TurnRow,
} from './overview-math.js';

const d = (iso: string) => new Date(iso);

describe('normalizeRange', () => {
  const now = d('2026-11-12T10:00:00Z'); // thứ Năm, tuần bắt đầu 2026-11-09

  it('mặc định 8 tuần gần nhất, gồm tuần hiện tại', () => {
    const range = normalizeRange(undefined, undefined, now);
    expect(range.to.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(range.from.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(listWeeks(range)).toHaveLength(8);
  });

  it('làm tròn from xuống và to lên theo tuần UTC', () => {
    const range = normalizeRange(
      d('2026-11-04T08:00:00Z'),
      d('2026-11-10T08:00:00Z'),
      now,
    );
    expect(range.from.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(listWeeks(range)).toEqual(['2026-11-02', '2026-11-09']);
  });

  it('giữ nguyên to khi đã đúng thứ Hai', () => {
    const range = normalizeRange(
      d('2026-11-02T00:00:00Z'),
      d('2026-11-09T00:00:00Z'),
      now,
    );
    expect(range.to.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('báo lỗi 400 khi from không sớm hơn to hoặc quá 53 tuần', () => {
    expect(() =>
      normalizeRange(d('2026-11-10T00:00:00Z'), d('2026-11-05T00:00:00Z'), now),
    ).toThrow(/sớm hơn/);
    expect(() =>
      normalizeRange(d('2025-01-01T00:00:00Z'), d('2026-11-01T00:00:00Z'), now),
    ).toThrow(/tối đa/);
  });
});

describe('mergeWeeklyScores', () => {
  it('trung bình có trọng số theo số session, nhóm thiếu thì vắng mặt', () => {
    const scores = mergeWeeklyScores([
      { sessions: 3, scores: { context: 100, verification: 40 } },
      { sessions: 1, scores: { context: 60 } },
    ]);
    expect(scores).toEqual({ context: 90, verification: 40 });
  });

  it('không có điểm nào thì trả {}', () => {
    expect(mergeWeeklyScores([{ sessions: 2, scores: {} }])).toEqual({});
    expect(mergeWeeklyScores([])).toEqual({});
  });
});

const turn = (over: Partial<TurnRow>): TurnRow => ({
  week: '2026-11-02',
  model: 'claude-opus-4-6',
  turns: 10,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoningKnown: 0,
  reasoningHigh: 0,
  ...over,
});

describe('buildOverview', () => {
  const range = normalizeRange(
    d('2026-11-02T00:00:00Z'),
    d('2026-11-16T00:00:00Z'),
    d('2026-11-12T00:00:00Z'),
  );

  it('tuần không có dữ liệu vẫn có mặt, chi phí null khi không còn turn', () => {
    const o = buildOverview({
      range,
      stats: [],
      agents: [],
      turns: [],
      findings: [],
      workTypes: [],
    });
    expect(o.weeks).toEqual([
      {
        week: '2026-11-02',
        sessions: 0,
        tokens: 0,
        estimatedCostUsd: null,
        scores: {},
      },
      {
        week: '2026-11-09',
        sessions: 0,
        tokens: 0,
        estimatedCostUsd: null,
        scores: {},
      },
    ]);
    expect(o.totals).toEqual({
      sessions: 0,
      activeMembers: 0,
      tokens: 0,
      estimatedCostUsd: null,
    });
    expect(o.usageStats).toEqual({
      cacheHitRate: null,
      premiumModelRate: null,
      highReasoningRate: null,
      avgOutputTokensPerTurn: null,
    });
  });

  it('cộng số liệu, đếm thành viên, tính chi phí và số liệu không tính điểm', () => {
    const o = buildOverview({
      range,
      stats: [
        {
          userId: 'a',
          week: '2026-11-02',
          sessions: 4,
          tokens: 1000,
          scores: { context: 80 },
        },
        {
          userId: 'b',
          week: '2026-11-02',
          sessions: 1,
          tokens: 500,
          scores: { context: 100 },
        },
        {
          userId: 'a',
          week: '2026-11-09',
          sessions: 2,
          tokens: 200,
          scores: {},
        },
      ],
      agents: [
        { agent: 'codex', sessions: 1, tokens: 100 },
        { agent: 'claude_code', sessions: 6, tokens: 1600 },
      ],
      turns: [
        turn({
          model: 'claude-opus-4-6',
          turns: 10,
          input: 1e6,
          output: 2e5,
          cacheRead: 3e6,
          reasoningKnown: 4,
          reasoningHigh: 1,
        }),
        turn({
          model: 'claude-sonnet-4-5',
          turns: 30,
          input: 1e6,
          output: 1e5,
        }),
        turn({ week: '2026-11-09', model: null, turns: 10 }),
        turn({ week: '2026-11-09', model: 'model-la', turns: 10 }),
      ],
      findings: [],
      workTypes: [],
    });

    expect(o.totals.sessions).toBe(7);
    expect(o.totals.activeMembers).toBe(2);
    expect(o.totals.tokens).toBe(1700);
    // opus: 5 + 5 + 1,5 = 11,5; sonnet: 3 + 1,5 = 4,5
    expect(o.weeks[0].estimatedCostUsd).toBe(16);
    expect(o.weeks[0].scores).toEqual({ context: 84 });
    // Tuần 2 có turn nhưng model không có giá: chi phí 0, không phải null.
    expect(o.weeks[1].estimatedCostUsd).toBe(0);
    expect(o.totals.estimatedCostUsd).toBe(16);

    expect(o.byAgent.map((a) => a.agent)).toEqual(['claude_code', 'codex']);
    expect(o.byModel[0].model).toBe('claude-opus-4-6');
    expect(
      o.byModel.find((m) => m.model === 'model-la')!.estimatedCostUsd,
    ).toBeNull();
    expect(
      o.byModel.find((m) => m.model === null)!.estimatedCostUsd,
    ).toBeNull();

    // cache hit = 3e6 / (input 2e6 + cacheRead 3e6 + cacheWrite 0)
    expect(o.usageStats.cacheHitRate).toBeCloseTo(0.6);
    // 10 turn opus / 50 turn có ghi model (opus 10 + sonnet 30 + model-la 10)
    expect(o.usageStats.premiumModelRate).toBeCloseTo(0.2);
    expect(o.usageStats.highReasoningRate).toBeCloseTo(0.25);
    // output 3e5 trên 60 turn
    expect(o.usageStats.avgOutputTokensPerTurn).toBeCloseTo(5000);
  });
});

describe('sortWorkTypes', () => {
  it('nhiều session nhất trước, hòa thì theo tên loại, chưa phân loại (null) cuối cùng, bỏ loại 0 session', () => {
    expect(
      sortWorkTypes([
        { workType: null, sessions: 9 },
        { workType: 'test', sessions: 2 },
        { workType: 'bugfix', sessions: 5 },
        { workType: 'docs', sessions: 2 },
        { workType: 'ops', sessions: 0 },
        { workType: 'feature', sessions: 9 },
      ]),
    ).toEqual([
      { workType: 'feature', sessions: 9 },
      { workType: null, sessions: 9 },
      { workType: 'bugfix', sessions: 5 },
      { workType: 'docs', sessions: 2 },
      { workType: 'test', sessions: 2 },
    ]);
  });

  it('không có dữ liệu thì mảng rỗng', () => {
    expect(sortWorkTypes([])).toEqual([]);
  });
});
