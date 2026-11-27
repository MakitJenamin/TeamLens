/** Số tuần cho bộ chọn khoảng thời gian (mặc định 8, khớp mặc định của API). */
export const RANGE_WEEKS = [4, 8, 12, 26] as const;
export const DEFAULT_RANGE_WEEKS = 8;

/**
 * Mốc `from` (ISO 8601) để API trả đúng `weeks` tuần UTC tính cả tuần hiện tại:
 * thứ Hai 00:00 UTC của tuần hiện tại lùi `weeks - 1` tuần. Không truyền `to`, API lấy hết tuần hiện tại.
 */
export function rangeFrom(weeks: number, now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) - (weeks - 1) * 7);
  return day.toISOString();
}

/** Chiều rộng thanh (0–100) theo tỉ lệ với giá trị lớn nhất. */
export function barPercent(value: number, max: number): number {
  return max > 0 ? Math.round((value / max) * 100) : 0;
}
