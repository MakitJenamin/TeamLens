import { describe, expect, it } from 'vitest';
import { estimateCostUsd, isPremiumModel } from './pricing.js';

const million = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 };

describe('estimateCostUsd', () => {
  it('nhân từng loại token với giá của model', () => {
    // opus: 5 + 25 + 0,5 + 6,25
    expect(estimateCostUsd('claude-opus-4-6', million)).toBeCloseTo(36.75);
    // sonnet: 3 + 15 + 0,3 + 3,75
    expect(estimateCostUsd('claude-sonnet-4-5', million)).toBeCloseTo(22.05);
  });

  it('ưu tiên tiền tố dài hơn (gpt-5-pro đắt hơn gpt-5)', () => {
    const pro = estimateCostUsd('gpt-5-pro', million)!;
    const base = estimateCostUsd('gpt-5.1-codex', million)!;
    expect(pro).toBeGreaterThan(base);
    expect(base).toBeCloseTo(1.25 + 10 + 0.125);
  });

  it('model chưa có giá hoặc không rõ thì trả null', () => {
    expect(estimateCostUsd('model-la', million)).toBeNull();
    expect(estimateCostUsd(null, million)).toBeNull();
  });

  it('không phân biệt hoa thường', () => {
    expect(estimateCostUsd('Claude-Haiku-4-5', million)).not.toBeNull();
  });
});

describe('isPremiumModel', () => {
  it('chỉ model cao cấp trong bảng giá', () => {
    expect(isPremiumModel('claude-opus-4-6')).toBe(true);
    expect(isPremiumModel('gpt-5-pro')).toBe(true);
    expect(isPremiumModel('claude-sonnet-4-5')).toBe(false);
    expect(isPremiumModel('model-la')).toBe(false);
    expect(isPremiumModel(null)).toBe(false);
  });
});
