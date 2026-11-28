import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { auditLog, consents, devices, sessions, users } from '../../db/schema/index.js';
import { auditCursorCondition, auditPage } from '../admin/audit-cursor.js';

const actors = alias(users, 'session_view_actors');

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

  async views(userId: string, query: { cursor?: string; limit: number }) {
    const rows = await this.db.select({ id: auditLog.id, sessionId: sessions.id,
      sessionStartedAt: sessions.startedAt, actorId: auditLog.actorId, actorName: actors.name,
      at: auditLog.at })
      .from(auditLog)
      .innerJoin(sessions, eq(auditLog.targetId, sql`${sessions.id}::text`))
      .leftJoin(actors, eq(actors.id, auditLog.actorId))
      .where(and(eq(auditLog.action, 'session.view'), eq(auditLog.targetType, 'session'),
        eq(sessions.userId, userId), auditCursorCondition(query.cursor)))
      .orderBy(desc(auditLog.at), desc(auditLog.id)).limit(query.limit + 1);
    return auditPage(rows, query.limit);
  }
}
