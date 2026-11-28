import { ApiError } from '../../common/api-error.js';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

const invalidWeek = (message: string) =>
  new ApiError(400, 'validation_error', message);

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Kiểm tra tham số `week` của các báo cáo tuần (B1, B2): ngày hợp lệ dạng `YYYY-MM-DD`, là thứ Hai (UTC) và không ở
 * tương lai (so với thứ Hai của tuần hiện tại `currentWeekStart`). Trả lại chính chuỗi đã kiểm; sai thì 400.
 */
export function parseWeekParam(week: string, currentWeekStart: Date): string {
  const date = WEEK_RE.test(week) ? new Date(`${week}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || isoDay(date) !== week)
    throw invalidWeek('`week` phải là ngày hợp lệ dạng YYYY-MM-DD.');
  if (date.getUTCDay() !== 1)
    throw invalidWeek('`week` phải là thứ Hai (UTC) của tuần.');
  if (date.getTime() > currentWeekStart.getTime())
    throw invalidWeek('`week` không được ở tương lai.');
  return week;
}
