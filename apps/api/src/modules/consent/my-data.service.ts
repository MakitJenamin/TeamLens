import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { auditLog, consents, devices, sessions, users } from '../../db/schema/index.js';
import { auditCursorAt, auditCursorCondition, auditPage } from '../admin/audit-cursor.js';

const actors = alias(users, 'session_view_actors');

/** Các audit về dữ liệu của một người mà chính người đó được xem lại (SPEC 11.1). */
export const PERSONAL_VIEW_ACTIONS = ['session.view', 'session.ai', 'profile.view'] as const;
export type PersonalViewAction = (typeof PERSONAL_VIEW_ACTIONS)[number];

@Injectable()
export class MyDataService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Không nhận userId từ client: luôn ràng buộc bằng user trong cookie. */
  async consents(userId: string) {
    return this.db.select({ id: consents.id, deviceId: consents.deviceId, deviceName: devices.name,
      deviceStatus: devices.status, textVersion: consents.textVersion, backfill: consents.backfill,
      grantedAt: consents.grantedAt, revokedAt: consents.revokedAt })
      .from(consents).leftJoin(devices, eq(devices.id, consents.deviceId))
      .where(eq(consents.userId, userId))
      .orderBy(desc(consents.grantedAt), desc(consents.id));
  }

  /**
   * Ai đã xem dữ liệu của tôi: `session.view`, `session.ai` (target là session) và `profile.view`
   * (target là chính tôi). Session đã bị xóa (retention) vẫn hiện nhờ `metadata.ownerId` ghi lúc xem;
   * dòng cũ trước khi có `ownerId` thì không xác định được chủ nên không hiện.
   */
  async views(userId: string, query: { cursor?: string; limit: number }) {
    const isSession = eq(auditLog.targetType, 'session');
    const rows = await this.db.select({ id: auditLog.id,
      action: sql<PersonalViewAction>`${auditLog.action}`,
      sessionId: sql<string | null>`CASE WHEN ${isSession} THEN ${auditLog.targetId} END`,
      sessionStartedAt: sessions.startedAt, actorId: auditLog.actorId, actorName: actors.name,
      at: auditLog.at, cursorAt: auditCursorAt })
      .from(auditLog)
      .leftJoin(sessions, and(isSession, eq(auditLog.targetId, sql`${sessions.id}::text`)))
      .leftJoin(actors, eq(actors.id, auditLog.actorId))
      .where(and(
        inArray(auditLog.action, [...PERSONAL_VIEW_ACTIONS]),
        or(
          and(inArray(auditLog.action, ['session.view', 'session.ai']), isSession,
            sql`coalesce(${sessions.userId}::text, ${auditLog.metadata}->>'ownerId') = ${userId}`),
          and(eq(auditLog.action, 'profile.view'), eq(auditLog.targetType, 'user'),
            eq(auditLog.targetId, userId)),
        ),
        auditCursorCondition(query.cursor)))
      .orderBy(desc(auditLog.at), desc(auditLog.id)).limit(query.limit + 1);
    return auditPage(rows, query.limit);
  }
}
