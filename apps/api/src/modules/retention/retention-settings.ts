import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { settings } from '../../db/schema/index.js';

/** Khóa `settings` của số ngày giữ nội dung thô (SPEC 11.2), leader sửa ở trang Quản trị (M4.6). */
export const RETENTION_KEY = 'retention_days';
/** Không có dòng `retention_days` thì giữ 90 ngày. */
export const DEFAULT_RETENTION_DAYS = 90;
/** Khóa `settings` lưu kết quả lần chạy gần nhất của job retention (M5.5). */
export const RETENTION_LAST_RUN_KEY = 'retention_last_run';

/** Kết quả một lần chạy, khớp schema `RetentionRun` trong `admin.yaml`. */
export interface RetentionRun {
  at: string;
  retentionDays: number | null;
  cutoff: string | null;
  droppedPartitions: string[];
  deletedTurns: number;
  deletedAiResults: number;
  deletedNotes: number;
  deletedPromptLibrary: number;
}

/**
 * Số ngày retention hiện hành. Phân biệt hai trường hợp dễ nhầm:
 * - không có dòng `retention_days` → mặc định {@link DEFAULT_RETENTION_DAYS};
 * - có dòng với giá trị jsonb `null` → giữ vô hạn, trả `null`.
 */
export async function readRetentionDays(
  db: Pick<Database, 'select'>,
): Promise<number | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, RETENTION_KEY));
  if (!row) return DEFAULT_RETENTION_DAYS;
  return typeof row.value === 'number' && Number.isInteger(row.value) && row.value > 0
    ? row.value
    : null;
}

/** Kết quả lần chạy gần nhất, `null` khi job chưa chạy lần nào. */
export async function readLastRetentionRun(
  db: Pick<Database, 'select'>,
): Promise<RetentionRun | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, RETENTION_LAST_RUN_KEY));
  return (row?.value as RetentionRun | undefined) ?? null;
}

/** Mốc cắt: nội dung thô có thời điểm trước mốc này bị xóa. */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
