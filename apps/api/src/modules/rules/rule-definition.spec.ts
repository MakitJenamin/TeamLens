import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/api-error.js';
import {
  applyOverride,
  describeRule,
  runRuleTests,
  toEditableRule,
  toSessionRule,
} from './rule-definition.js';
import { sessionRules } from './session-rules.js';
import { weeklyRules } from './weekly-rules.js';

const base = sessionRules.find((r) => r.key === 'repeated-correction')!;
const row = {
  key: base.key,
  category: base.category,
  severity: base.severity,
  definition: base as unknown,
};

describe('toSessionRule', () => {
  it('dựng rule session từ dòng DB, cột severity và category đè lên definition', () => {
    const rule = toSessionRule({ ...row, severity: 'low', category: 'khac' });
    expect(rule?.key).toBe('repeated-correction');
    expect(rule?.severity).toBe('low');
    expect(rule?.category).toBe('khac');
    expect(rule?.thresholds).toEqual({ min: 3 });
  });

  it('rule tuần và định nghĩa hỏng trả null', () => {
    const weekly = weeklyRules[0];
    expect(
      toSessionRule({
        key: weekly.key,
        category: weekly.category,
        severity: weekly.severity,
        definition: weekly,
      }),
    ).toBeNull();
    for (const definition of [null, 'x', [], {}, { ...base, tests: undefined }, { ...base, match: 1 }]) {
      expect(toSessionRule({ ...row, definition })).toBeNull();
    }
  });
});

describe('applyOverride', () => {
  it('ghi lại từng thay đổi và không sửa rule gốc', () => {
    const before = structuredClone(base);
    const { rule, changes } = applyOverride(base, {
      severity: 'medium',
      thresholds: { min: 5 },
      message: '  Thông điệp mới {{count}}  ',
      advice: 'Lời khuyên mới',
    });
    expect(changes).toEqual([
      { field: 'severity', from: 'high', to: 'medium' },
      { field: 'thresholds.min', from: 3, to: 5 },
      { field: 'message', from: base.message, to: 'Thông điệp mới {{count}}' },
      { field: 'advice', from: base.advice, to: 'Lời khuyên mới' },
    ]);
    expect(rule.thresholds.min).toBe(5);
    expect(rule.message).toBe('Thông điệp mới {{count}}');
    expect(base).toEqual(before);
  });

  it('giá trị trùng hiện hành không tính là thay đổi', () => {
    const { changes } = applyOverride(base, {
      severity: base.severity,
      thresholds: { min: 3 },
      message: base.message,
    });
    expect(changes).toEqual([]);
  });

  it('không đổi được match: override không có đường nào chạm vào logic', () => {
    const { rule } = applyOverride(base, { thresholds: { min: 4 } });
    expect(rule.match).toEqual(base.match);
  });

  it.each([
    ['ngưỡng không có', { thresholds: { khong_co: 1 } }],
    ['min bằng 0', { thresholds: { min: 0 } }],
    ['min không nguyên', { thresholds: { min: 2.5 } }],
    ['ngưỡng âm', { thresholds: { min: -1 } }],
    ['ngưỡng không hữu hạn', { thresholds: { min: Number.POSITIVE_INFINITY } }],
    ['message rỗng sau khi trim', { message: '   ' }],
    ['advice rỗng', { advice: '' }],
  ])('từ chối %s bằng 400 validation_error', (_name, override) => {
    try {
      applyOverride(base, override);
      throw new Error('phải ném lỗi');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).getStatus()).toBe(400);
      expect(((e as ApiError).getResponse() as { error: string }).error).toBe('validation_error');
    }
  });
});

describe('runRuleTests', () => {
  it('mọi rule session dựng sẵn qua hết tests nội tuyến của chính nó', () => {
    for (const rule of sessionRules) {
      const results = runRuleTests(rule);
      expect(results.length).toBeGreaterThan(0);
      expect(results.filter((r) => !r.passed), rule.key).toEqual([]);
    }
  });

  it('đổi ngưỡng làm hỏng test nội tuyến thì báo đúng test nào hỏng', () => {
    const { rule } = applyOverride(base, { thresholds: { min: 4 } });
    const failed = runRuleTests(rule).filter((r) => !r.passed);
    expect(failed).toEqual([
      {
        name: 'ba lần phản bác xen kẽ phản hồi',
        expect: 'triggered',
        actual: 'clean',
        passed: false,
      },
    ]);
  });

  it('chỉ đổi mức độ, thông điệp, lời khuyên thì tests vẫn qua', () => {
    const { rule } = applyOverride(base, { severity: 'low', message: 'x {{count}}', advice: 'y' });
    expect(runRuleTests(rule).every((r) => r.passed)).toBe(true);
  });
});

describe('describeRule', () => {
  it('chỉ lộ phần được phép chỉnh và nhận diện, không có match hay tests', () => {
    expect(Object.keys(describeRule(base)).sort()).toEqual(
      ['advice', 'category', 'key', 'message', 'severity', 'thresholds'],
    );
  });
});

describe('rule tuần (dùng chung dashboard và MCP)', () => {
  const weekly = weeklyRules.find((r) => r.key === 'lazy-prompting')!;
  const weeklyRow = { key: weekly.key, category: weekly.category, severity: weekly.severity, definition: weekly as unknown };

  it('toEditableRule dựng được cả rule tuần lẫn rule session', () => {
    expect(toEditableRule(weeklyRow)?.scope).toBe('user_week');
    expect(toEditableRule(row)?.scope).toBe('session');
    expect(toEditableRule({ ...weeklyRow, definition: { ...weekly, tests: undefined } })).toBeNull();
  });

  it('mọi rule tuần dựng sẵn qua hết tests nội tuyến của chính nó', () => {
    for (const rule of weeklyRules) {
      expect(runRuleTests(rule).filter((r) => !r.passed), rule.key).toEqual([]);
    }
  });

  it('ngưỡng tỉ lệ phải trong [0, 1], ngưỡng đếm phải nguyên và > 0', () => {
    const ratioKey = Object.keys(weekly.thresholds).find((k) => /Rate|Ratio/.test(k))!;
    const countKey = Object.keys(weekly.thresholds).find((k) => !/Rate|Ratio/.test(k))!;
    expect(() => applyOverride(weekly, { thresholds: { [ratioKey]: 1.5 } })).toThrow(ApiError);
    expect(() => applyOverride(weekly, { thresholds: { [countKey]: 0 } })).toThrow(ApiError);
    expect(() => applyOverride(weekly, { thresholds: { [countKey]: 2.5 } })).toThrow(ApiError);
    // Tỉ lệ đã từng đặt bằng số nguyên (1) vẫn sửa lại được thành số thực: kiểu lấy theo rule dựng sẵn.
    const { rule } = applyOverride(weekly, { thresholds: { [ratioKey]: 1 } });
    expect(applyOverride(rule, { thresholds: { [ratioKey]: 0.5 } }).rule.thresholds[ratioKey]).toBe(0.5);
  });
});
