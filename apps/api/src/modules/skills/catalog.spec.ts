import { describe, expect, it } from 'vitest';
import { normalizeGithubUrl, parseGithubRepoUrl } from './catalog-github.js';
import { type CatalogEntry, shortlist, tokensOf } from './catalog-shortlist.js';
import { parseSkillFrontmatter } from './skill-md.js';
import {
  CANDIDATES_FOR_AI,
  MAX_PICKS,
  normalizePicks,
  pickBlocks,
  picksSchema,
} from './skills-catalog-prompts.js';

describe('parseGithubRepoUrl', () => {
  it.each([
    ['https://github.com/anthropics/skills', 'anthropics', 'skills'],
    ['https://github.com/anthropics/skills/', 'anthropics', 'skills'],
    ['https://github.com/anthropics/skills.git', 'anthropics', 'skills'],
    ['  https://www.github.com/github/awesome-copilot  ', 'github', 'awesome-copilot'],
    ['https://github.com/o/r/tree/main/skills', 'o', 'r'],
    ['https://github.com/o/r.js', 'o', 'r.js'],
  ])('nhận %s', (input, owner, repo) => {
    expect(parseGithubRepoUrl(input)).toEqual({ owner, repo });
  });

  it.each([
    'http://github.com/o/r',
    'https://gitlab.com/o/r',
    'https://github.com.evil.com/o/r',
    'https://evil.com/github.com/o/r',
    'https://github.com/o',
    'https://github.com/',
    'https://github.com/o/r/blob/main/x',
    'https://github.com/o/r/tree',
    'https://user:pw@github.com/o/r',
    'https://github.com:8443/o/r',
    'https://github.com/o/r?x=1',
    'https://github.com/o/r#frag',
    'https://github.com/-bad/r',
    'https://github.com/o/..',
    'https://github.com/o/r with space',
    'ftp://github.com/o/r',
    'github.com/o/r',
    '',
    'không phải url',
  ])('từ chối %s', (input) => {
    expect(parseGithubRepoUrl(input)).toBeNull();
  });

  it('URL chuẩn bỏ .git, dấu / cuối và nhánh', () => {
    const ref = parseGithubRepoUrl('https://www.github.com/o/r.git');
    expect(normalizeGithubUrl(ref!)).toBe('https://github.com/o/r');
  });
});

describe('parseSkillFrontmatter', () => {
  it('đọc name và description một dòng', () => {
    expect(
      parseSkillFrontmatter('---\nname: pdf\ndescription: Làm việc với PDF.\nlicense: x\n---\n# Body', 'dir'),
    ).toEqual({ name: 'pdf', description: 'Làm việc với PDF.' });
  });
  it('giá trị có nháy kép hoặc đơn', () => {
    expect(
      parseSkillFrontmatter('---\nname: "a"\ndescription: "Dùng khi: \\"x\\""\n---\n', 'd'),
    ).toEqual({ name: 'a', description: 'Dùng khi: "x"' });
    expect(parseSkillFrontmatter("---\nname: 'a'\ndescription: 'it''s ok'\n---\n", 'd')?.description).toBe("it's ok");
  });
  it('khối gấp > và khối nguyên văn |', () => {
    const folded = parseSkillFrontmatter('---\nname: x\ndescription: >\n  dòng một\n  dòng hai\nlicense: y\n---\n', 'd');
    expect(folded?.description).toBe('dòng một dòng hai');
    const literal = parseSkillFrontmatter('---\nname: x\ndescription: |-\n  a\n  b\n---\n', 'd');
    expect(literal?.description).toBe('a b');
  });
  it('thiếu name thì dùng tên thư mục; thiếu description hoặc front matter thì null', () => {
    expect(parseSkillFrontmatter('---\ndescription: mô tả\n---\n', 'thu-muc')?.name).toBe('thu-muc');
    expect(parseSkillFrontmatter('---\nname: x\n---\n', 'd')).toBeNull();
    expect(parseSkillFrontmatter('# không có front matter', 'd')).toBeNull();
    expect(parseSkillFrontmatter('', 'd')).toBeNull();
  });
  it('đầu file bị cắt giữa chừng (chưa có --- đóng) vẫn đọc được phần đã có; chịu BOM và CRLF', () => {
    expect(parseSkillFrontmatter('﻿---\r\nname: x\r\ndescription: mô tả dài bị cắt', 'd')).toEqual({
      name: 'x',
      description: 'mô tả dài bị cắt',
    });
  });
  it('cắt tên ở 80 và mô tả ở 300 ký tự', () => {
    const r = parseSkillFrontmatter(`---\nname: ${'n'.repeat(200)}\ndescription: ${'d'.repeat(900)}\n---\n`, 'd');
    expect(Array.from(r!.name).length).toBe(80);
    expect(Array.from(r!.description).length).toBe(300);
  });
});

const entry = (name: string, description: string): CatalogEntry => ({
  sourceUrl: 'https://github.com/o/r',
  name,
  description,
  skillUrl: `https://github.com/o/r/blob/HEAD/skills/${name}/SKILL.md`,
});

describe('tokensOf và shortlist', () => {
  it('bỏ từ ngắn, từ dừng, ký tự lạ; giữ chữ có dấu', () => {
    expect([...tokensOf('Use the PDF skill để chạy test, ok?')].sort()).toEqual(['chạy', 'pdf', 'test']);
  });

  it('xếp theo độ trùng từ khóa, từ trùng ở tên tính gấp đôi, giữ thứ tự gốc khi hòa', () => {
    const entries = [
      entry('alpha', 'unrelated thing'),
      entry('lint-fixer', 'fix style problems'),
      entry('other', 'run lint on code'),
      entry('beta', 'also unrelated'),
    ];
    const out = shortlist(entries, ['sửa lỗi lint trong code'], 3);
    expect(out.map((e) => e.name)).toEqual(['lint-fixer', 'other', 'alpha']);
  });

  it('điểm 0 không bị loại (catalog tiếng Anh, prompt tiếng Việt): lấy đủ `limit` theo thứ tự ổn định', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`s${i}`, 'x'));
    expect(shortlist(entries, ['chạy kiểm thử'], 4).map((e) => e.name)).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('ít mục hơn limit thì trả hết', () => {
    expect(shortlist([entry('a', 'b')], ['x'], CANDIDATES_FOR_AI)).toHaveLength(1);
  });
});

describe('pickBlocks', () => {
  it('khối workflows và catalog, mỗi dòng một mục, đánh số w và s từ 1, gộp xuống dòng', () => {
    const blocks = pickBlocks(
      [
        { label: 'Chạy test\nrồi sửa lint', count: 9, userCount: 3 },
        { label: 'Viết changelog', count: 4, userCount: 1 },
      ],
      [entry('lint-fixer', 'fix\nstyle'), entry('changelog', 'write notes')],
    );
    expect(blocks.map((b) => b.label)).toEqual(['workflows', 'catalog']);
    expect(blocks[0].content).toBe(
      'w1: typed 9 times by 3 people. Example: Chạy test rồi sửa lint\nw2: typed 4 times by 1 person. Example: Viết changelog',
    );
    expect(blocks[1].content).toBe('s1 | lint-fixer | fix style\ns2 | changelog | write notes');
  });

  it('cắt mô tả gửi đi ở 160 ký tự', () => {
    const [, catalog] = pickBlocks([], [entry('a', 'd'.repeat(500))]);
    const line = catalog.content.split(' | ')[2];
    expect(Array.from(line).length).toBe(160);
  });
});

describe('normalizePicks', () => {
  const candidates = [entry('one', 'mô tả một'), entry('two', 'mô tả hai'), entry('three', 'ba')];

  it('điền tên, mô tả, đường dẫn từ catalog chứ không từ AI', () => {
    const out = normalizePicks({ picks: [{ candidate: 's2', reason: '  Gõ  9 lần\nbởi 3 người. ' }] }, candidates);
    expect(out).toEqual({
      picks: [
        {
          name: 'two',
          description: 'mô tả hai',
          sourceUrl: 'https://github.com/o/r',
          skillUrl: 'https://github.com/o/r/blob/HEAD/skills/two/SKILL.md',
          reason: 'Gõ 9 lần bởi 3 người.',
        },
      ],
      candidatesConsidered: 3,
    });
  });

  it('bỏ mã không có, mã sai dạng, mã trùng, lý do rỗng; chịu hoa thường và khoảng trắng', () => {
    const out = normalizePicks(
      {
        picks: [
          { candidate: 's9', reason: 'ma khong co' },
          { candidate: 'two', reason: 'sai dang' },
          { candidate: 's0', reason: 'bắt đầu từ 1' },
          { candidate: ' S1 ', reason: 'ok 5 lần' },
          { candidate: 's1', reason: 'trùng' },
          { candidate: 's3', reason: '   ' },
        ],
      },
      candidates,
    );
    expect(out.picks.map((p) => p.name)).toEqual(['one']);
  });

  it(`giữ tối đa ${MAX_PICKS} gợi ý`, () => {
    const many = Array.from({ length: 8 }, (_, i) => entry(`n${i}`, 'd'));
    const out = normalizePicks({ picks: many.map((_, i) => ({ candidate: `s${i + 1}`, reason: 'r 1' })) }, many);
    expect(out.picks).toHaveLength(MAX_PICKS);
  });

  it('cắt lý do ở 400 ký tự', () => {
    const out = normalizePicks({ picks: [{ candidate: 's1', reason: 'x'.repeat(900) }] }, candidates);
    expect(Array.from(out.picks[0].reason).length).toBe(400);
  });

  it('schema đầu ra từ chối thiếu trường', () => {
    expect(picksSchema.safeParse({ picks: [{ candidate: 's1' }] }).success).toBe(false);
    expect(picksSchema.safeParse({ picks: [] }).success).toBe(true);
  });
});
