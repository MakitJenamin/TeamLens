import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  normalizeTeamReport,
  type TeamReportInput,
  teamReportBlocks,
  teamReportSchema,
  teamWeekId,
} from './team-report-prompts.js';
import { parseWeekParam } from './week-param.js';

const base: TeamReportInput = {
  week: '2026-11-23',
  current: { sessions: 20, tokens: 900000, scores: { context: 80, verification: 55 }, activeMembers: 3 },
  previous: { sessions: 15, tokens: 600000, scores: { context: 70, verification: 60 } },
  issues: [
    { ruleKey: 'no-test-after-edit', category: 'verification', severity: 'high', count: 9, memberCount: 3, advice: 'Chạy test\nsau khi sửa.' },
    { ruleKey: 'lazy-prompting', category: 'prompt_quality', severity: 'medium', count: 4, memberCount: 2, advice: null },
  ],
  workTypes: [
    { workType: 'bugfix', sessions: 8 },
    { workType: null, sessions: 2 },
  ],
  members: [
    { userId: 'u-a', name: 'An Nguyễn', sessions: 9, overall: 72, previousOverall: 60, change: 12 },
    { userId: 'u-b', name: 'Bình Trần', sessions: 6, overall: 55, previousOverall: null, change: null },
    { userId: 'u-c', name: 'Chi Lê', sessions: 5, overall: 60, previousOverall: 66, change: -6 },
  ],
};

describe('teamWeekId', () => {
  it('ổn định, khác nhau theo project và tuần, đúng dạng UUID', () => {
    const id = teamWeekId('p', '2026-11-23');
    expect(id).toBe(teamWeekId('p', '2026-11-23'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set([id, teamWeekId('q', '2026-11-23'), teamWeekId('p', '2026-11-30')]).size).toBe(3);
  });
});

describe('teamReportBlocks', () => {
  it('một khối số liệu: team, tuần trước, loại việc, rule có mã r, thành viên có mã m và KHÔNG có tên hay id', () => {
    const blocks = teamReportBlocks(base);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe('team stats');
    const text = blocks[0].content;
    expect(text).toContain('Sessions: 20. Tokens: 900000. Active members: 3.');
    expect(text).toContain('Team skill scores this week (0-100, higher is better): context 80, verification 55');
    expect(text).toContain('Previous week: 15 sessions, 600000 tokens.');
    expect(text).toContain('Kinds of work this week: bugfix 8, unclassified 2.');
    expect(text).toContain('r1: no-test-after-edit (verification, severity high) x9 by 3 member(s). Advice: Chạy test sau khi sửa.');
    expect(text).toContain('r2: lazy-prompting (prompt_quality, severity medium) x4 by 2 member(s)');
    expect(text).toContain('m1 | sessions 9 | overall 72 | previous 60 | change +12');
    expect(text).toContain('m2 | sessions 6 | overall 55 | previous n/a | change n/a');
    expect(text).toContain('m3 | sessions 5 | overall 60 | previous 66 | change -6');
    for (const secret of ['An Nguyễn', 'Bình Trần', 'Chi Lê', 'u-a', 'u-b', 'u-c']) expect(text).not.toContain(secret);
  });

  it('không có tuần trước, rule, thành viên, loại việc thì nói rõ', () => {
    const [block] = teamReportBlocks({ ...base, previous: null, issues: [], members: [], workTypes: [] });
    expect(block.content).toContain('Previous week: no data.');
    expect(block.content).toContain('Rules violated most this week: none.');
    expect(block.content).toContain('Members: none.');
    expect(block.content).toContain('Kinds of work this week: unknown.');
  });

  it('advice nhiều dòng gộp thành một dòng, không giả được dòng rule hay thành viên mới', () => {
    const [block] = teamReportBlocks({
      ...base,
      issues: [{ ...base.issues[0], advice: 'a\nr9: fake\nm9 | sessions 99' }],
    });
    expect(block.content.split('\n').filter((l) => /^r\d+:/.test(l))).toHaveLength(1);
    expect(block.content.split('\n').filter((l) => /^m\d+ \|/.test(l))).toHaveLength(3);
  });
});

describe('normalizeTeamReport', () => {
  const output = {
    headline: '  Tuần\ntốt  ',
    vsLastWeek: 'Tăng từ 15 lên 20 session',
    topIssues: [
      { issue: 'R2', comment: ' Prompt còn mơ hồ ' },
      { issue: 'r1', comment: 'Thiếu chạy test' },
      { issue: 'r9', comment: 'bịa' },
      { issue: 'r1', comment: 'trùng' },
      { issue: 'lazy-prompting', comment: 'sai dạng' },
      { issue: 'r2', comment: '   ' },
    ],
    improved: [
      { member: 'm1', comment: ' Tiến bộ rõ ' },
      { member: 'm7', comment: 'bịa' },
      { member: 'rule', comment: 'sai dạng' },
    ],
    sharingSession: { topic: ' Chạy test sau khi sửa ', detail: 'Demo\nquy trình.' },
  };

  it('gọn chuỗi, điền rule, người, số liệu từ dữ liệu của server (không từ AI)', () => {
    const r = normalizeTeamReport(output, base);
    expect(r.week).toBe('2026-11-23');
    expect(r.headline).toBe('Tuần tốt');
    expect(r.topIssues).toEqual([
      { ruleKey: 'lazy-prompting', category: 'prompt_quality', severity: 'medium', count: 4, memberCount: 2, comment: 'Prompt còn mơ hồ' },
      { ruleKey: 'no-test-after-edit', category: 'verification', severity: 'high', count: 9, memberCount: 3, comment: 'Thiếu chạy test' },
    ]);
    expect(r.improved).toEqual([{ userId: 'u-a', name: 'An Nguyễn', change: 12, comment: 'Tiến bộ rõ' }]);
    expect(r.sharingSession).toEqual({ topic: 'Chạy test sau khi sửa', detail: 'Demo quy trình.' });
  });

  it('AI không chọn ai tiến bộ thì danh sách rỗng; tối đa 3 mục', () => {
    expect(normalizeTeamReport({ ...output, improved: [] }, base).improved).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => ({
      ruleKey: `r${i}`, category: 'context', severity: 'low' as const, count: 1, memberCount: 1, advice: null,
    }));
    const r = normalizeTeamReport(
      { ...output, topIssues: many.map((_, i) => ({ issue: `r${i + 1}`, comment: 'c' })) },
      { ...base, issues: many },
    );
    expect(r.topIssues).toHaveLength(3);
  });

  it('schema đầu ra chuyển được sang JSON Schema và từ chối thiếu trường', () => {
    expect((z.toJSONSchema(teamReportSchema) as { type: string }).type).toBe('object');
    expect(teamReportSchema.safeParse({ headline: 'x' }).success).toBe(false);
  });
});

describe('parseWeekParam', () => {
  const current = new Date('2026-11-23T00:00:00.000Z');
  it('nhận thứ Hai hợp lệ, kể cả tuần hiện tại', () => {
    expect(parseWeekParam('2026-11-16', current)).toBe('2026-11-16');
    expect(parseWeekParam('2026-11-23', current)).toBe('2026-11-23');
  });
  it.each(['2026-11-24', '2026-11-30', '2026-13-01', '2026-02-30', '2026-2-3', 'mai', '', '2026-11-23T00:00:00Z'])(
    'từ chối %s',
    (value) => {
      expect(() => parseWeekParam(value, current)).toThrow();
    },
  );
});
