/** 5 nhóm kỹ năng (SPEC 9.1). Thứ tự này cũng là thứ tự hiển thị. */
export const CATEGORIES = [
  'prompt_quality',
  'context',
  'correction_loop',
  'session_management',
  'verification',
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Severity = 'low' | 'medium' | 'high';

/** Điểm trừ theo mức độ (SPEC 9.1). */
export const PENALTIES: Record<Severity, number> = {
  low: 5,
  medium: 10,
  high: 20,
};

/** Một session gốc trong tuần đã có điểm 5 nhóm. */
export interface WeekScoredSession {
  turnCount: number;
  scores: Record<string, number>;
}

/** Một finding phạm vi `user_week` của tuần đó. */
export interface WeekFinding {
  category: string;
  severity: Severity;
}

export type WeeklyScores = Partial<Record<Category, number>>;

/**
 * Điểm tuần theo từng nhóm (M2.8):
 * 1. Trung bình điểm session gốc, trọng số là `turnCount` (SPEC 9.1). Mọi session không có turn thì chia đều.
 * 2. Trừ điểm phạt của finding `user_week` cùng nhóm (low 5, medium 10, high 20), tối thiểu 0.
 *
 * Điểm session chỉ dùng rule phạm vi session nên finding tuần không bị trừ hai lần.
 * Trả `{}` khi tuần chưa có session nào được chấm.
 */
export function computeWeeklyScores(
  sessions: readonly WeekScoredSession[],
  findings: readonly WeekFinding[],
): WeeklyScores {
  if (sessions.length === 0) return {};
  const totalTurns = sessions.reduce((sum, s) => sum + s.turnCount, 0);
  const result: WeeklyScores = {};
  for (const category of CATEGORIES) {
    let weighted = 0;
    let weight = 0;
    for (const s of sessions) {
      const score = s.scores[category];
      if (score === undefined) continue;
      const w = totalTurns > 0 ? s.turnCount : 1;
      weighted += score * w;
      weight += w;
    }
    if (weight === 0) continue;
    const penalty = findings
      .filter((f) => f.category === category)
      .reduce((sum, f) => sum + PENALTIES[f.severity], 0);
    result[category] = Math.max(0, Math.round(weighted / weight - penalty));
  }
  return result;
}
