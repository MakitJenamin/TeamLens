import type { Schemas } from '@teamlens/schema';
import { ApiError } from '../../common/api-error.js';
import { estimateCostUsd, isPremiumModel } from './pricing.js';
import { CATEGORIES } from './weekly-stats.js';
import { weekWindow } from './refresh-weekly-stats.js';

export type ProjectOverview = Schemas['ProjectOverview'];
type WeeklyScores = Schemas['WeeklyScores'];

const WEEK_MS = 7 * 86400000;
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 53;

export interface Range {
  from: Date;
  to: Date;
}

/**
 * Làm tròn khoảng thời gian ra biên tuần UTC (thứ Hai 00:00). `from` làm tròn xuống, `to` làm tròn lên.
 * Mặc định là `defaultWeeks` tuần gần nhất (8 cho tổng quan, 2 cho hồ sơ), gồm tuần hiện tại.
 * Lỗi 400 khi `from >= to` hoặc quá 53 tuần.
 */
export function normalizeRange(
  from: Date | undefined,
  to: Date | undefined,
  now: Date,
  defaultWeeks: number = DEFAULT_WEEKS,
): Range {
  const thisWeekEnd = weekWindow(now).end;
  let end: Date;
  if (to) {
    const w = weekWindow(to);
    end = to.getTime() === w.start.getTime() ? w.start : w.end;
  } else {
    end = thisWeekEnd;
  }
  const start = from
    ? weekWindow(from).start
    : new Date(end.getTime() - defaultWeeks * WEEK_MS);
  if (start.getTime() >= end.getTime())
    throw new ApiError(
      400,
      'validation_error',
      '`from` phải sớm hơn `to` ít nhất một tuần UTC',
    );
  if ((end.getTime() - start.getTime()) / WEEK_MS > MAX_WEEKS)
    throw new ApiError(
      400,
      'validation_error',
      `Khoảng thời gian tối đa ${MAX_WEEKS} tuần`,
    );
  return { from: start, to: end };
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Ngày thứ Hai của từng tuần trong khoảng, tăng dần. */
export function listWeeks(range: Range): string[] {
  const weeks: string[] = [];
  for (let t = range.from.getTime(); t < range.to.getTime(); t += WEEK_MS)
    weeks.push(isoDay(new Date(t)));
  return weeks;
}

/** Một dòng `user_weekly_stats`. */
export interface StatsRow {
  userId: string;
  week: string;
  sessions: number;
  tokens: number;
  scores: Record<string, number>;
}

export interface AgentRow {
  agent: Schemas['AgentKind'];
  sessions: number;
  tokens: number;
}

/** Gộp các lượt assistant theo (tuần, model). */
export interface TurnRow {
  week: string;
  model: string | null;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Số lượt có ghi mức suy luận. */
  reasoningKnown: number;
  /** Số lượt có mức suy luận cao (`high`, `xhigh`). */
  reasoningHigh: number;
}

export type FindingRow = Schemas['OverviewFinding'];

/**
 * Điểm tuần của project: trung bình điểm tuần của từng thành viên, trọng số là số session của họ trong tuần.
 * Nhóm không ai có điểm thì vắng mặt; không có điểm nào thì trả `{}`.
 */
export function mergeWeeklyScores(
  rows: readonly Pick<StatsRow, 'sessions' | 'scores'>[],
): WeeklyScores {
  const result: WeeklyScores = {};
  for (const category of CATEGORIES) {
    let weighted = 0;
    let weight = 0;
    for (const row of rows) {
      const score = row.scores[category];
      if (score === undefined) continue;
      const w = Math.max(row.sessions, 1);
      weighted += score * w;
      weight += w;
    }
    if (weight > 0) result[category] = Math.round(weighted / weight);
  }
  return result;
}

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;
const tokensOf = (row: Pick<TurnRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) =>
  row.input + row.output + row.cacheRead + row.cacheWrite;

/** Chi phí của các dòng; `null` khi không có dòng nào (không còn turn để tính). Model chưa có giá bị bỏ qua. */
function costOf(rows: readonly TurnRow[]): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) total += estimateCostUsd(row.model, row) ?? 0;
  return round4(total);
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function buildOverview(input: {
  range: Range;
  stats: readonly StatsRow[];
  agents: readonly AgentRow[];
  turns: readonly TurnRow[];
  findings: readonly FindingRow[];
}): ProjectOverview {
  const { range, stats, agents, turns, findings } = input;

  const weeks = listWeeks(range).map((week) => {
    const rows = stats.filter((row) => row.week === week);
    return {
      week,
      sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      estimatedCostUsd: costOf(turns.filter((row) => row.week === week)),
      scores: mergeWeeklyScores(rows),
    };
  });

  const byModelMap = new Map<string | null, TurnRow>();
  for (const row of turns) {
    const sum = byModelMap.get(row.model) ?? {
      ...row,
      week: '',
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    sum.turns += row.turns;
    sum.input += row.input;
    sum.output += row.output;
    sum.cacheRead += row.cacheRead;
    sum.cacheWrite += row.cacheWrite;
    byModelMap.set(row.model, sum);
  }
  const byModel = [...byModelMap.values()]
    .map((row) => {
      const cost = estimateCostUsd(row.model, row);
      return {
        model: row.model,
        turns: row.turns,
        tokens: tokensOf(row),
        estimatedCostUsd: cost === null ? null : round4(cost),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const sum = (pick: (row: TurnRow) => number) =>
    turns.reduce((total, row) => total + pick(row), 0);
  const knownModelTurns = sum((row) => (row.model ? row.turns : 0));
  const premiumTurns = sum((row) => (isPremiumModel(row.model) ? row.turns : 0));
  const cacheDenominator = sum((row) => row.input + row.cacheRead + row.cacheWrite);
  const totalTurns = sum((row) => row.turns);

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    totals: {
      sessions: weeks.reduce((total, w) => total + w.sessions, 0),
      activeMembers: new Set(
        stats.filter((row) => row.sessions > 0).map((row) => row.userId),
      ).size,
      tokens: weeks.reduce((total, w) => total + w.tokens, 0),
      estimatedCostUsd: costOf(turns),
    },
    weeks,
    byAgent: [...agents].sort((a, b) => b.tokens - a.tokens),
    byModel,
    usageStats: {
      cacheHitRate: ratio(sum((row) => row.cacheRead), cacheDenominator),
      premiumModelRate: ratio(premiumTurns, knownModelTurns),
      highReasoningRate: ratio(
        sum((row) => row.reasoningHigh),
        sum((row) => row.reasoningKnown),
      ),
      avgOutputTokensPerTurn: ratio(sum((row) => row.output), totalTurns),
    },
    topFindings: [...findings],
  };
}
