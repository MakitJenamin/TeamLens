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
      { id: 's1', startedAt: new Date('2026-03-03T10:00:00Z'), turnCount: 1, scores: { prompt_quality: 100 } },
      { id: 's2', startedAt: new Date('2026-03-04T10:00:00Z'), turnCount: 3, scores: { prompt_quality: 60 } },
    ], [{ sessionId: 's1', category: 'prompt_quality', severity: 'low' }])).toEqual({ prompt_quality: 65 });
  });

  it('phạt user_week chỉ trừ vào tuần của nó, rồi mới gộp tháng theo số session mỗi tuần', () => {
    // Tuần 02/03: 2 session điểm 80, bị phạt medium (10) -> 70. Tuần 09/03: 1 session điểm 80, bị phạt high (20) -> 60.
    // Tuần 16/03: 1 session điểm 90, không phạt. Tháng = (70*2 + 60 + 90) / 4 = 72,5 -> 73.
    // Cách cũ trừ dồn cả 30 điểm một lần: 82,5 - 30 = 53.
    const sessions = [
      { id: 'a', startedAt: new Date('2026-03-02T00:00:00Z'), turnCount: 2, scores: { context: 80 } },
      { id: 'b', startedAt: new Date('2026-03-08T23:59:59Z'), turnCount: 2, scores: { context: 80 } },
      { id: 'c', startedAt: new Date('2026-03-09T00:00:00Z'), turnCount: 2, scores: { context: 80 } },
      { id: 'd', startedAt: new Date('2026-03-17T08:00:00Z'), turnCount: 2, scores: { context: 90 } },
    ];
    expect(monthScores(sessions, [
      { sessionId: 'b', category: 'context', severity: 'medium' },
      { sessionId: 'c', category: 'context', severity: 'high' },
    ])).toEqual({ context: 73 });
  });

  it('phạt tuần tối thiểu 0 trong tuần, session chưa chấm vẫn tính trọng số tuần, finding lạ bị bỏ qua', () => {
    expect(monthScores([
      { id: 'a', startedAt: new Date('2026-03-03T00:00:00Z'), turnCount: 1, scores: { verification: 10 } },
      { id: 'b', startedAt: new Date('2026-03-10T00:00:00Z'), turnCount: 1, scores: { verification: 100 } },
      { id: 'c', startedAt: new Date('2026-03-11T00:00:00Z'), turnCount: 1 },
    ], [
      { sessionId: 'a', category: 'verification', severity: 'high' },
      { sessionId: 'zzz', category: 'verification', severity: 'high' },
    ])).toEqual({ verification: 67 });
    expect(monthScores([], [])).toEqual({});
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
