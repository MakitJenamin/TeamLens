import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assembleSkillMarkdown,
  cleanBody,
  clusterBlocks,
  contentSchema,
  EXAMPLES_FOR_AI,
  normalizeContent,
  normalizeTriage,
  PROMPT_MAX_CHARS,
  slugify,
  triageSchema,
} from './skills-ai-prompts.js';

describe('slugify', () => {
  it('bỏ dấu tiếng Việt, đổi đ thành d, ký tự lạ thành gạch ngang', () => {
    expect(slugify('Chạy test & sửa lỗi lint')).toBe('chay-test-sua-loi-lint');
    expect(slugify('Đồng bộ dữ liệu')).toBe('dong-bo-du-lieu');
    expect(slugify('  --Run_Tests!!  ')).toBe('run-tests');
  });
  it('cắt ở 60 ký tự và không để gạch ngang ở cuối', () => {
    const slug = slugify(`${'a'.repeat(59)} bbb`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
  it('rỗng hoặc toàn ký tự lạ thì dùng giá trị dự phòng', () => {
    expect(slugify('')).toBe('skill');
    expect(slugify('🙂🙂')).toBe('skill');
    expect(slugify('???', 'khac')).toBe('khac');
  });
  it('kết quả luôn khớp mẫu kebab-case của contract', () => {
    for (const name of ['Sửa lỗi', 'a_b c', 'X', 'đ', 'Test 2 lần']) {
      expect(slugify(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe('cleanBody', () => {
  it('bóc front matter nếu model lỡ viết', () => {
    expect(cleanBody('---\nname: x\ndescription: y\n---\n\n## Steps\n1. a')).toBe('## Steps\n1. a');
  });
  it('bóc hàng rào ```markdown bao quanh toàn bộ', () => {
    expect(cleanBody('```markdown\n## Steps\n1. a\n```')).toBe('## Steps\n1. a');
  });
  it('giữ nguyên khối code nằm giữa nội dung', () => {
    const body = '## Steps\n```bash\npnpm test\n```\nxong';
    expect(cleanBody(body)).toBe(body);
  });
  it('chuẩn hóa xuống dòng và cắt khoảng trắng hai đầu', () => {
    expect(cleanBody('\r\n  a\r\nb  \r\n')).toBe('a\nb');
  });
});

describe('assembleSkillMarkdown', () => {
  it('ghép front matter name và description (một dòng, chuỗi nháy kép) rồi body', () => {
    const md = assembleSkillMarkdown({ name: 'chay-test', description: 'Chạy test: "nhanh" & gọn', body: '## Steps\n1. a' });
    expect(md).toBe('---\nname: chay-test\ndescription: "Chạy test: \\"nhanh\\" & gọn"\n---\n\n## Steps\n1. a\n');
  });
  it('mô tả có ký tự đặc biệt của YAML vẫn là một giá trị nháy kép đọc lại được bằng JSON', () => {
    const description = 'Dùng khi: #1, [a], {b}, - c, > d, | e, ' + "' quote";
    const md = assembleSkillMarkdown({ name: 'x', description, body: 'b' });
    const line = md.split('\n')[2];
    expect(line.startsWith('description: ')).toBe(true);
    expect(JSON.parse(line.slice('description: '.length))).toBe(description);
  });
});

describe('normalizeTriage và normalizeContent', () => {
  it('chuẩn hóa tên và gọn chuỗi', () => {
    expect(
      normalizeTriage({ verdict: 'strong', reason: '  Rõ ràng.  ', suggestedName: 'Chạy Test & Lint', summary: 'a\n b' }),
    ).toEqual({ verdict: 'strong', reason: 'Rõ ràng.', suggestedName: 'chay-test-lint', summary: 'a b' });
  });
  it('normalizeContent ghép markdown từ name, description, body đã làm sạch', () => {
    const result = normalizeContent({
      name: 'Chạy test',
      description: 'Dùng khi\nchạy test',
      body: '```markdown\n## Steps\n1. a\n```',
    });
    expect(result.name).toBe('chay-test');
    expect(result.description).toBe('Dùng khi chạy test');
    expect(result.body).toBe('## Steps\n1. a');
    expect(result.markdown).toBe(assembleSkillMarkdown(result));
    expect(result.markdown.startsWith('---\nname: chay-test\n')).toBe(true);
  });
  it('mô tả quá dài bị cắt ở 500 ký tự', () => {
    const result = normalizeContent({ name: 'a', description: 'x'.repeat(900), body: 'b' });
    expect(Array.from(result.description).length).toBeLessThanOrEqual(500);
  });
});

describe('clusterBlocks', () => {
  const when = (d: string) => new Date(`${d}T09:00:00Z`);
  const occurrence = (i: number, text: string) => ({
    userId: 'u',
    sessionId: `s${i}`,
    turnSeq: i,
    ts: when('2026-11-20'),
    text,
  });

  it('có khối thống kê rồi mỗi prompt một khối, nhãn không chứa nội dung', () => {
    const blocks = clusterBlocks(
      { count: 9, userCount: 2, firstSeenAt: when('2026-11-03'), lastSeenAt: when('2026-11-27') },
      [occurrence(1, 'a b c'), occurrence(2, 'd e f')],
    );
    expect(blocks.map((b) => b.label)).toEqual(['cluster', 'prompt 1', 'prompt 2']);
    expect(blocks[0].content).toBe('Typed 9 times by 2 people between 2026-11-03 and 2026-11-27. Showing the 2 most recent occurrences.');
    expect(blocks[1].content).toBe('a b c');
  });
  it('cắt mỗi prompt ở giới hạn ký tự, không chẻ cặp surrogate', () => {
    const blocks = clusterBlocks(
      { count: 3, userCount: 1, firstSeenAt: when('2026-11-03'), lastSeenAt: when('2026-11-27') },
      [occurrence(1, '🙂'.repeat(PROMPT_MAX_CHARS + 50))],
    );
    expect(Array.from(blocks[1].content).length).toBe(PROMPT_MAX_CHARS);
    expect(blocks[1].content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it('số người ở số ít khi chỉ có một người', () => {
    const [stats] = clusterBlocks(
      { count: 3, userCount: 1, firstSeenAt: when('2026-11-03'), lastSeenAt: when('2026-11-03') },
      [],
    );
    expect(stats.content).toContain('1 person ');
  });
  it('EXAMPLES_FOR_AI là 8', () => {
    expect(EXAMPLES_FOR_AI).toBe(8);
  });
});

describe('schema đầu ra gửi cho LLM', () => {
  it('chuyển được sang JSON Schema (LlmService ép provider theo schema này)', () => {
    for (const schema of [triageSchema, contentSchema]) {
      const json = z.toJSONSchema(schema) as { type: string; required?: string[] };
      expect(json.type).toBe('object');
      expect(json.required?.length).toBeGreaterThan(0);
    }
  });
  it('từ chối verdict lạ', () => {
    expect(triageSchema.safeParse({ verdict: 'great', reason: 'r', suggestedName: 'n', summary: 's' }).success).toBe(false);
  });
});
