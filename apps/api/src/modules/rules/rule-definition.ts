import { ApiError } from '../../common/api-error.js';
import type { RuleSeverity } from '../../db/schema/scoring.js';
import { evaluateSession, type SessionRule } from './session-engine.js';

/** Phần của rule được phép chỉnh (M6.16). Không có `match`: logic và regex luôn lấy từ code. */
export interface RuleOverride {
  severity?: RuleSeverity;
  thresholds?: Record<string, number>;
  message?: string;
  advice?: string;
}

export interface RuleChange {
  /** `severity`, `message`, `advice` hoặc `thresholds.<khóa>`. */
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

const invalid = (message: string) =>
  new ApiError(400, 'validation_error', `Thay đổi không hợp lệ: ${message}`);

/**
 * Áp thay đổi lên một bản sao của rule. Chỉ cho đổi ngưỡng đã có, mức độ, thông điệp và lời khuyên.
 * `min` phải là số nguyên >= 1 (rule chỉ kết luận khi đủ số lần).
 */
export function applyOverride(
  base: SessionRule,
  override: RuleOverride,
): { rule: SessionRule; changes: RuleChange[] } {
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
    if (!Number.isFinite(value) || value < 0) {
      throw invalid(`ngưỡng "${name}" phải là số không âm`);
    }
    if (name === 'min' && (!Number.isInteger(value) || value < 1)) {
      throw invalid('ngưỡng "min" phải là số nguyên từ 1 trở lên');
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

/** Chạy mọi `tests` nội tuyến của rule bằng chính engine chấm điểm. */
export function runRuleTests(rule: SessionRule): RuleTestResult[] {
  return rule.tests.map((test) => {
    const actual =
      evaluateSession(test.input, [rule]).length > 0 ? 'triggered' : 'clean';
    return {
      name: test.name,
      expect: test.expect,
      actual,
      passed: actual === test.expect,
    };
  });
}

/** Phần rule hiển thị cho agent. */
export function describeRule(rule: SessionRule) {
  return {
    key: rule.key,
    category: rule.category,
    severity: rule.severity,
    thresholds: rule.thresholds as Record<string, number>,
    message: rule.message,
    advice: rule.advice,
  };
}
