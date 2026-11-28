import { ApiError } from '../../common/api-error.js';
import type { RuleSeverity } from '../../db/schema/scoring.js';
import { evaluateSession, type SessionRule } from './session-engine.js';
import { sessionRules } from './session-rules.js';
import { evaluateWeek, weeklyRules, type WeeklyRule } from './weekly-rules.js';

/** Rule chỉnh được qua dashboard và MCP: rule session hoặc rule tuần dựng sẵn. */
export type EditableRule = SessionRule | WeeklyRule;

/** Phần của rule được phép chỉnh (M6.16). Không có `match`: logic và regex luôn lấy từ code. */
export interface RuleOverride {
  severity?: RuleSeverity;
  thresholds?: Record<string, number>;
  message?: string;
  advice?: string;
}

export interface RuleChange {
  /** `enabled`, `severity`, `message`, `advice` hoặc `thresholds.<khóa>`. */
  field: string;
  from: unknown;
  to: unknown;
}

export interface RuleTestResult {
  name: string;
  expect: 'triggered' | 'clean';
  actual: 'triggered' | 'clean';
  passed: boolean;
}

interface RuleRowLike {
  key: string;
  category: string;
  severity: RuleSeverity;
  definition: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Dựng `SessionRule` từ một dòng `rules` (cùng cách `score-session.ts` gộp: cột `key`, `severity`, `category`
 * đè lên `definition`). Trả `null` khi không phải rule session hợp lệ (ví dụ rule tuần).
 */
export function toSessionRule(row: RuleRowLike): SessionRule | null {
  const d = row.definition;
  if (
    !isObject(d) ||
    d.scope !== 'session' ||
    !isObject(d.match) ||
    !isObject(d.thresholds) ||
    typeof d.thresholds.min !== 'number' ||
    typeof d.message !== 'string' ||
    typeof d.advice !== 'string' ||
    !Array.isArray(d.tests)
  ) {
    return null;
  }
  return {
    ...(d as unknown as SessionRule),
    key: row.key,
    category: row.category,
    severity: row.severity,
  };
}

/**
 * Dựng rule (session hoặc tuần) từ một dòng `rules`, cột `key`, `severity`, `category` đè lên `definition`.
 * Trả `null` khi định nghĩa hỏng.
 */
export function toEditableRule(row: RuleRowLike): EditableRule | null {
  const session = toSessionRule(row);
  if (session) return session;
  const d = row.definition;
  if (
    !isObject(d) ||
    d.scope !== 'user_week' ||
    !isObject(d.thresholds) ||
    typeof d.message !== 'string' ||
    typeof d.advice !== 'string' ||
    !Array.isArray(d.tests)
  ) {
    return null;
  }
  return {
    ...(d as unknown as WeeklyRule),
    key: row.key,
    category: row.category,
    severity: row.severity,
  };
}

const catalog = new Map<string, EditableRule>(
  [...sessionRules, ...weeklyRules].map((rule) => [rule.key, rule]),
);

const invalid = (message: string) =>
  new ApiError(400, 'validation_error', `Thay đổi không hợp lệ: ${message}`);

/** Ngưỡng tỉ lệ (`...Rate`, `...Ratio`) nằm trong [0, 1]; các ngưỡng khác là số đếm hoặc độ dài, phải > 0. */
const isRatio = (name: string) => /Rate|Ratio/.test(name);

/**
 * Áp thay đổi lên một bản sao của rule (dùng chung cho dashboard và MCP). Chỉ cho đổi ngưỡng đã có, mức độ,
 * thông điệp và lời khuyên. Kiểu của ngưỡng (nguyên hay thực) lấy theo rule dựng sẵn trong code cùng khóa.
 */
export function applyOverride<R extends EditableRule>(
  base: R,
  override: RuleOverride,
): { rule: R; changes: RuleChange[] } {
  const reference = catalog.get(base.key)?.thresholds ?? base.thresholds;
  const rule = structuredClone(base);
  const changes: RuleChange[] = [];

  if (override.severity !== undefined && override.severity !== base.severity) {
    changes.push({
      field: 'severity',
      from: base.severity,
      to: override.severity,
    });
    rule.severity = override.severity;
  }

  for (const [name, value] of Object.entries(override.thresholds ?? {})) {
    if (!(name in base.thresholds)) {
      throw invalid(
        `rule không có ngưỡng "${name}" (có: ${Object.keys(base.thresholds).join(', ')})`,
      );
    }
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
      throw invalid(`ngưỡng "${name}" phải là số từ 0 tới 1000000`);
    }
    const integer = Number.isInteger(reference[name] ?? base.thresholds[name]);
    if (integer && (!Number.isInteger(value) || value < 1)) {
      throw invalid(`ngưỡng "${name}" phải là số nguyên từ 1 trở lên`);
    }
    if (isRatio(name) && value > 1) {
      throw invalid(`ngưỡng "${name}" là tỉ lệ, phải từ 0 tới 1`);
    }
    if (!isRatio(name) && value === 0) {
      throw invalid(`ngưỡng "${name}" phải lớn hơn 0`);
    }
    if (value !== base.thresholds[name]) {
      changes.push({
        field: `thresholds.${name}`,
        from: base.thresholds[name],
        to: value,
      });
      rule.thresholds[name] = value;
    }
  }

  for (const field of ['message', 'advice'] as const) {
    const next = override[field]?.trim();
    if (next === undefined) continue;
    if (next.length === 0) throw invalid(`${field} không được để trống`);
    if (next !== base[field]) {
      changes.push({ field, from: base[field], to: next });
      rule[field] = next;
    }
  }
  return { rule, changes };
}

/** Chạy mọi `tests` nội tuyến của rule (session hoặc tuần) bằng chính engine chấm điểm. */
export function runRuleTests(rule: EditableRule): RuleTestResult[] {
  const tests: { name: string; expect: 'triggered' | 'clean'; triggered: () => boolean }[] =
    rule.scope === 'session'
      ? rule.tests.map((t) => ({ ...t, triggered: () => evaluateSession(t.input, [rule]).length > 0 }))
      : rule.tests.map((t) => ({ ...t, triggered: () => evaluateWeek(t.input, [rule]).length > 0 }));
  return tests.map((test) => {
    const actual = test.triggered() ? 'triggered' : 'clean';
    return {
      name: test.name,
      expect: test.expect,
      actual,
      passed: actual === test.expect,
    };
  });
}

/** Phần rule hiển thị cho agent. */
export function describeRule(rule: EditableRule) {
  return {
    key: rule.key,
    category: rule.category,
    severity: rule.severity,
    thresholds: rule.thresholds as Record<string, number>,
    message: rule.message,
    advice: rule.advice,
  };
}
