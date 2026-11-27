import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { auditLog, users } from '../../db/schema/index.js';
import { auditCursorCondition, auditPage } from './audit-cursor.js';

const actors = alias(users, 'audit_actors');

@Injectable()
export class AuditQueryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(query: { cursor?: string; limit: number; action?: string; actorId?: string;
    targetType?: string; targetId?: string; from?: Date; to?: Date }) {
    const rows = await this.db.select({ id: auditLog.id, actorId: auditLog.actorId,
      actorName: actors.name, action: auditLog.action, targetType: auditLog.targetType,
      targetId: auditLog.targetId, at: auditLog.at })
      .from(auditLog).leftJoin(actors, eq(actors.id, auditLog.actorId))
      .where(and(
        query.action ? eq(auditLog.action, query.action) : undefined,
        query.actorId ? eq(auditLog.actorId, query.actorId) : undefined,
        query.targetType ? eq(auditLog.targetType, query.targetType) : undefined,
        query.targetId ? eq(auditLog.targetId, query.targetId) : undefined,
        query.from ? gte(auditLog.at, query.from) : undefined,
        query.to ? lt(auditLog.at, query.to) : undefined,
        auditCursorCondition(query.cursor),
      ))
      .orderBy(desc(auditLog.at), desc(auditLog.id)).limit(query.limit + 1);
    return auditPage(rows, query.limit);
  }
}
