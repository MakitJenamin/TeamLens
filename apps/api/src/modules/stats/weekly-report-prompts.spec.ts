import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EXAMPLE_PROMPT_CHARS,
  normalizeReport,
  type ReportInput,
  reportBlocks,
  reportSchema,
  userWeekId,
} from './weekly-report-prompts.js';

const base: ReportInput = {
  week: '2026-11-23',
  current: { sessions: 12, tokens: 340000, scores: { context: 80, verification: 55 } },
  previous: { sessions: 8, tokens: 200000, scores: { context: 70, verification: 60 } },
  teamScores: { context: 75, verification: 65 },
  patterns: [
    { ruleKey: 'no-test-after-edit', category: 'verification', severity: 'high', count: 4, advice: 'Chạy test\nsau khi sửa.' },
  ],
  workTypes: [
    { workType: 'bugfix', sessions: 7 },
    { workType: null, sessions: 1 },
  ],
  examples: [
    { sessionId: 's1', turnSeq: 1, kind: 'needs_work', text: 'sửa lỗi đăng nhập' },
    { sessionId: 's2', turnSeq: 3, kind: 'good', text: 'Thêm trang cài đặt, mỗi mục có test, không đổi API' },
  ],
};

describe('userWeekId', () => {
  it('ổn định, khác nhau theo project, người và tuần, đúng dạng UUID', () => {
    const id = userWeekId('p', 'u', '2026-11-23');
    expect(id).toBe(userWeekId('p', 'u', '2026-11-23'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set([id, userWeekId('q', 'u', '2026-11-23'), userWeekId('p', 'v', '2026-11-23'), userWeekId('p', 'u', '2026-11-30')]).size).toBe(4);
  });
});

describe('reportBlocks', () => {
  it('khối số liệu có đủ số tuần này, tuần trước, trung bình team, loại việc, rule; mỗi ví dụ một khối nhãn chỉ có mã', () => {
    const blocks = reportBlocks(base);
    expect(blocks.map((b) => b.label)).toEqual(['weekly stats', 'example e1', 'example e2']);
    const stats = blocks[0].content;
    expect(stats).toContain('Week starting Monday 2026-11-23');
    expect(stats).toContain('Sessions: 12. Tokens: 340000.');
    expect(stats).toContain('Skill scores this week (0-100, higher is better): context 80, verification 55');
    expect(stats).toContain('Previous week: 8 sessions, 200000 tokens. Previous week scores: context 70, verification 60');
    expect(stats).toContain('Team average this week: context 75, verification 65');
    expect(stats).toContain('Kinds of work this week: bugfix 7, unclassified 1.');
    expect(stats).toContain('- no-test-after-edit (verification, severity high) x4. Advice: Chạy test sau khi sửa.');
    expect(blocks[1].content).toBe('Marked: needs_work.\n\nsửa lỗi đăng nhập');
    expect(blocks[2].content).toContain('Marked: good.');
  });

  it('không có tuần trước, rule, loại việc thì nói rõ; không có ví dụ thì chỉ có khối số liệu', () => {
    const blocks = reportBlocks({ ...base, previous: null, patterns: [], workTypes: [], examples: [] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain('Previous week: no data.');
    expect(blocks[0].content).toContain('Rules violated this week: none.');
    expect(blocks[0].content).toContain('Kinds of work this week: unknown.');
  });

  it('cắt prompt ví dụ ở giới hạn ký tự, không chẻ cặp surrogate', () => {
    const [, ex] = reportBlocks({ ...base, examples: [{ sessionId: 's', turnSeq: 1, kind: 'good', text: '🙂'.repeat(EXAMPLE_PROMPT_CHARS + 30) }] });
    const text = ex.content.split('\n\n')[1];
    expect(Array.from(text).length).toBe(EXAMPLE_PROMPT_CHARS);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('chữ do rule hoặc người dùng viết không làm đổi cấu trúc: advice nhiều dòng gộp thành một dòng', () => {
    const [stats] = reportBlocks({ ...base, patterns: [{ ruleKey: 'r', category: 'c', severity: 'low', count: 1, advice: 'a\n- fake: x' }] });
    expect(stats.content.split('\n').filter((l) => l.startsWith('- ')).length).toBe(1);
  });
});

describe('normalizeReport', () => {
  const output = {
    headline: '  Tuần\ntốt  ',
    strengths: ['  a  ', '', 'b', 'c', 'd'],
    weaknesses: ['x'],
    vsLastWeek: 'Tăng 10 điểm',
    focus: { title: ' Chạy test ', detail: 'Sau mỗi lần sửa\nchạy test.' },
    examples: [
      { example: 'e2', comment: ' Rõ phạm vi ' },
      { example: 'E1', comment: 'Thiếu bối cảnh' },
      { example: 'e9', comment: 'bịa' },
      { example: 'e2', comment: 'trùng' },
      { example: 'ví dụ 1', comment: 'sai dạng' },
      { example: 'e1', comment: '   ' },
    ],
  };

  it('gọn chuỗi, tối đa 3 mục, điền tuần và dữ liệu ví dụ từ server', () => {
    const r = normalizeReport(output, base);
    expect(r.week).toBe('2026-11-23');
    expect(r.headline).toBe('Tuần tốt');
    expect(r.strengths).toEqual(['a', 'b', 'c']);
    expect(r.weaknesses).toEqual(['x']);
    expect(r.focus).toEqual({ title: 'Chạy test', detail: 'Sau mỗi lần sửa chạy test.' });
    expect(r.examples).toEqual([
      { sessionId: 's2', turnSeq: 3, kind: 'good', excerpt: base.examples[1].text, comment: 'Rõ phạm vi' },
      { sessionId: 's1', turnSeq: 1, kind: 'needs_work', excerpt: 'sửa lỗi đăng nhập', comment: 'Thiếu bối cảnh' },
    ]);
  });

  it('AI không chọn ví dụ nào thì danh sách rỗng', () => {
    expect(normalizeReport({ ...output, examples: [] }, base).examples).toEqual([]);
  });

  it('schema đầu ra chuyển được sang JSON Schema và từ chối thiếu trường', () => {
    expect((z.toJSONSchema(reportSchema) as { type: string }).type).toBe('object');
    expect(reportSchema.safeParse({ headline: 'x' }).success).toBe(false);
  });
});
