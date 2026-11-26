import type { AgentConfig } from '@teamlens/schema';

type Truncation = AgentConfig['truncation'];
type RedactionPattern = AgentConfig['redaction_patterns'][number];

/** Ngưỡng cắt mặc định (byte UTF-8, SPEC 6.3); key `truncation` trong `settings` ghi đè từng trường. */
export const DEFAULT_TRUNCATION: Readonly<Truncation> = Object.freeze({
  tool_input_bytes: 4096,
  output_head_bytes: 2048,
  output_tail_bytes: 1024,
  diff_bytes: 262144,
  thinking_bytes: 8192,
});

/** Key trong bảng `settings`. */
export const SETTINGS_KEYS = {
  redactionPatterns: 'redaction_patterns',
  truncation: 'truncation',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Đọc giá trị `settings.redaction_patterns`: mảng `{ id, regex }`. Phần tử sai dạng bị bỏ qua
 * (không làm hỏng cả cấu hình); thiếu hoặc không phải mảng thì `[]`.
 * Không biên dịch regex ở đây: cú pháp theo crate `regex` của Rust, CLI tự bỏ pattern lỗi.
 */
export function parseRedactionPatterns(value: unknown): RedactionPattern[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) =>
    isRecord(item) &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.regex === 'string' &&
    item.regex.length > 0
      ? [{ id: item.id, regex: item.regex }]
      : [],
  );
}

/** Ghép `settings.truncation` với mặc định; trường thiếu hoặc không phải số nguyên ≥ 0 dùng mặc định. */
export function mergeTruncation(value: unknown): Truncation {
  const merged: Truncation = { ...DEFAULT_TRUNCATION };
  if (!isRecord(value)) return merged;
  for (const key of Object.keys(DEFAULT_TRUNCATION) as (keyof Truncation)[]) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
      merged[key] = raw;
    }
  }
  return merged;
}
