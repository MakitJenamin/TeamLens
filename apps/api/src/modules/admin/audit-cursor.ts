import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../../common/api-error.js';
import { auditLog } from '../../db/schema/index.js';

/**
 * `audit_log.at` chính xác tới micro giây, còn `Date` của JS chỉ tới mili giây. Cursor phải lấy chuỗi
 * thời điểm do Postgres in ra (đủ 6 chữ số lẻ, UTC) chứ không đi qua `Date`, nếu không các dòng ghi cùng
 * mili giây nhưng khác micro giây (vd. cùng transaction) sẽ bị bỏ sót khi chuyển trang.
 * Thêm cột này vào select với tên `cursorAt`; `auditPage` dùng rồi bỏ nó khỏi kết quả.
 */
export const auditCursorAt = sql<string>`to_char(${auditLog.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const cursorShape = z.object({ at: z.iso.datetime({ offset: true }), id: z.uuid() });

export function encodeAuditCursor(item: { id: string; cursorAt: string }): string {
  return Buffer.from(JSON.stringify({ at: item.cursorAt, id: item.id })).toString('base64url');
}

export function auditCursorCondition(cursor?: string): SQL | undefined {
  if (!cursor) return undefined;
  let decoded: z.infer<typeof cursorShape>;
  try {
    decoded = cursorShape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new ApiError(400, 'validation_error', 'Cursor không hợp lệ');
  }
  // So sánh trong Postgres với giá trị gốc dạng text, khớp thứ tự `ORDER BY at DESC, id DESC`.
  return sql`(${auditLog.at}, ${auditLog.id}) < (${decoded.at}::timestamptz, ${decoded.id}::uuid)`;
}

export function auditPage<T extends { id: string; cursorAt: string }>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  const nextCursor = hasMore ? encodeAuditCursor(page[page.length - 1]) : null;
  return { items: page.map(({ cursorAt: _cursorAt, ...rest }) => rest), nextCursor };
}
