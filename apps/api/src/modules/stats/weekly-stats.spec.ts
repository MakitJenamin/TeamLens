import { describe, expect, it } from 'vitest';
import { computeWeeklyScores } from './weekly-stats.js';

const full = (n: number) => ({
  prompt_quality: n,
  context: n,
  correction_loop: n,
  session_management: n,
  verification: n,
});

describe('computeWeeklyScores', () => {
  it('trả {} khi tuần chưa có session nào được chấm', () => {
    expect(computeWeeklyScores([], [])).toEqual({});
  });

  it('trung bình có trọng số theo số turn', () => {
    const scores = computeWeeklyScores(
      [
        { turnCount: 30, scores: full(100) },
        { turnCount: 10, scores: full(60) },
      ],
      [],
    );
    // (100*30 + 60*10) / 40 = 90
    expect(scores.verification).toBe(90);
    expect(scores.prompt_quality).toBe(90);
  });

  it('chia đều khi mọi session không có turn', () => {
    const scores = computeWeeklyScores(
      [
        { turnCount: 0, scores: full(100) },
        { turnCount: 0, scores: full(50) },
      ],
      [],
    );
    expect(scores.context).toBe(75);
  });

  it('trừ finding tuần đúng nhóm và đúng mức độ', () => {
    const scores = computeWeeklyScores(
      [{ turnCount: 10, scores: full(100) }],
      [
        { category: 'prompt_quality', severity: 'medium' },
        { category: 'prompt_quality', severity: 'low' },
        { category: 'verification', severity: 'medium' },
      ],
    );
    expect(scores.prompt_quality).toBe(85);
    expect(scores.verification).toBe(90);
    expect(scores.context).toBe(100);
  });

  it('không xuống dưới 0', () => {
    const scores = computeWeeklyScores(
      [{ turnCount: 5, scores: full(10) }],
      [{ category: 'context', severity: 'high' }],
    );
    expect(scores.context).toBe(0);
  });

  it('bỏ qua nhóm không có điểm session nào', () => {
    const scores = computeWeeklyScores(
      [{ turnCount: 5, scores: { context: 80 } }],
      [],
    );
    expect(scores).toEqual({ context: 80 });
  });
});
