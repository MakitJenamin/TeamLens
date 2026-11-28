import { and, eq, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../../common/api-error.js';
import { auditLog } from '../../db/schema/index.js';

const cursorShape = z.object({ at: z.iso.datetime({ offset: true }), id: z.uuid() });

export function encodeAuditCursor(item: { id: string; at: Date }): string {
  return Buffer.from(JSON.stringify({ at: item.at.toISOString(), id: item.id })).toString('base64url');
}

export function auditCursorCondition(cursor?: string): SQL | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = cursorShape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    const at = new Date(decoded.at);
    return or(lt(auditLog.at, at), and(eq(auditLog.at, at), lt(auditLog.id, decoded.id)));
  } catch {
    throw new ApiError(400, 'validation_error', 'Cursor không hợp lệ');
  }
}

export function auditPage<T extends { id: string; at: Date }>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  return { items: page, nextCursor: hasMore ? encodeAuditCursor(page[page.length - 1]) : null };
}
