import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  candidateBlocks,
  type CandidateInput,
  candidatesSchema,
  normalizeCandidates,
  PROMPT_EXCERPT_CHARS,
} from './prompt-candidates-prompts.js';

const candidate = (i: number, over: Partial<CandidateInput> = {}): CandidateInput => ({
  sessionId: `s${i}`,
  turnSeq: i,
  userId: `u${i}`,
  userName: `Người ${i}`,
  startedAt: new Date('2026-11-20T09:00:00Z'),
  score: 80 + i,
  workType: 'bugfix',
  text: `Prompt số ${i}: sửa lỗi đăng nhập khi mật khẩu có ký tự đặc biệt`,
  ...over,
});

describe('candidateBlocks', () => {
  it('mỗi ứng viên một khối, nhãn chỉ có mã, nội dung có điểm và loại việc rồi tới prompt', () => {
    const blocks = candidateBlocks([candidate(1), candidate(2, { workType: null })]);
    expect(blocks.map((b) => b.label)).toEqual(['candidate p1', 'candidate p2']);
    expect(blocks[0].content).toBe(
      'Session score: 81/100. Type of work: bugfix.\n\nPrompt số 1: sửa lỗi đăng nhập khi mật khẩu có ký tự đặc biệt',
    );
    expect(blocks[1].content).toContain('Type of work: unknown.');
  });

  it('cắt prompt ở giới hạn ký tự, không chẻ cặp surrogate', () => {
    const [block] = candidateBlocks([candidate(1, { text: '🙂'.repeat(PROMPT_EXCERPT_CHARS + 50) })]);
    const prompt = block.content.split('\n\n')[1];
    expect(Array.from(prompt).length).toBe(PROMPT_EXCERPT_CHARS);
    expect(prompt).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('normalizeCandidates', () => {
  const list = [candidate(1), candidate(2), candidate(3)];

  it('điền id session, người gõ, điểm, nội dung từ dữ liệu của server chứ không từ AI', () => {
    const out = normalizeCandidates(
      { picks: [{ candidate: 'p2', title: '  Sửa\nlỗi đăng nhập ', why: 'Nêu rõ  triệu chứng\nvà bước tái hiện.' }] },
      list,
    );
    expect(out).toEqual({
      considered: 3,
      candidates: [
        {
          sessionId: 's2',
          turnSeq: 2,
          userId: 'u2',
          userName: 'Người 2',
          startedAt: '2026-11-20T09:00:00.000Z',
          score: 82,
          workType: 'bugfix',
          prompt: 'Prompt số 2: sửa lỗi đăng nhập khi mật khẩu có ký tự đặc biệt',
          title: 'Sửa lỗi đăng nhập',
          why: 'Nêu rõ triệu chứng và bước tái hiện.',
        },
      ],
    });
  });

  it('bỏ mã không có, sai dạng, mã trùng, tiêu đề hoặc lý do rỗng; chịu hoa thường và khoảng trắng', () => {
    const out = normalizeCandidates(
      {
        picks: [
          { candidate: 'p9', title: 't', why: 'w' },
          { candidate: 'x1', title: 't', why: 'w' },
          { candidate: 'p0', title: 't', why: 'w' },
          { candidate: ' P1 ', title: 'Một', why: 'ok' },
          { candidate: 'p1', title: 'Trùng', why: 'ok' },
          { candidate: 'p3', title: '  ', why: 'ok' },
          { candidate: 'p3', title: 'Ba', why: ' ' },
        ],
      },
      list,
    );
    expect(out.candidates.map((c) => c.sessionId)).toEqual(['s1']);
    expect(out.considered).toBe(3);
  });

  it('cho phép AI bỏ hết (danh sách rỗng) và cắt tiêu đề 80, lý do 400 ký tự', () => {
    expect(normalizeCandidates({ picks: [] }, list).candidates).toEqual([]);
    const out = normalizeCandidates({ picks: [{ candidate: 'p1', title: 't'.repeat(300), why: 'w'.repeat(900) }] }, list);
    expect(Array.from(out.candidates[0].title).length).toBe(80);
    expect(Array.from(out.candidates[0].why).length).toBe(400);
  });
});

describe('candidatesSchema', () => {
  it('chuyển được sang JSON Schema và từ chối thiếu trường', () => {
    expect((z.toJSONSchema(candidatesSchema) as { type: string }).type).toBe('object');
    expect(candidatesSchema.safeParse({ picks: [{ candidate: 'p1', title: 't' }] }).success).toBe(false);
  });
});
