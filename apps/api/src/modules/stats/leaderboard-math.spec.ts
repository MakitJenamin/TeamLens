import { describe, expect, it } from 'vitest';
import { leaderboardWindow, monthScores, overallScore, rankLeaderboard } from './leaderboard-math.js';

describe('leaderboard M4.3', () => {
  it('tuần bắt đầu thứ Hai UTC; tháng là tháng dương lịch UTC kể cả ngày giáp ranh', () => {
    expect(leaderboardWindow('week', new Date('2026-03-01T23:30:00Z'))).toEqual({
      from: new Date('2026-02-23T00:00:00Z'), to: new Date('2026-03-02T00:00:00Z'),
    });
    expect(leaderboardWindow('month', new Date('2026-03-01T00:00:00Z'))).toEqual({
      from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z'),
    });
  });

  it('bỏ nhóm thiếu điểm, dùng đúng công thức trọng số và phạt của tuần cho tháng', () => {
    expect(overallScore({ prompt_quality: 81, context: 90 })).toBe(85.5);
    expect(overallScore({})).toBeNull();
    expect(monthScores([
      { turnCount: 1, scores: { prompt_quality: 100 } },
      { turnCount: 3, scores: { prompt_quality: 60 } },
    ], [{ category: 'prompt_quality', severity: 'low' }])).toEqual({ prompt_quality: 65 });
  });

  it('ngưỡng 5, hòa điểm theo session rồi tên; member không nhận danh tính người khác', () => {
    const candidates = [
      { userId: 'b', name: 'Bình', sessions: 5, scores: { context: 80 } },
      { userId: 'a', name: 'An', sessions: 6, scores: { context: 80 } },
      { userId: 'c', name: 'Chi', sessions: 4, scores: { context: 100 } },
    ];
    expect(rankLeaderboard(candidates, 'overall', 'b', false)).toEqual([
      { rank: 1, userId: null, name: null, isSelf: false, sessions: 6, overall: 80, scores: { context: 80 } },
      { rank: 2, userId: 'b', name: 'Bình', isSelf: true, sessions: 5, overall: 80, scores: { context: 80 } },
    ]);
    expect(rankLeaderboard(candidates, 'verification', 'b', false)).toEqual([]);
  });
});
