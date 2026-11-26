import { Controller, Get, Inject, Param } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { forbidden, notFound } from '../../common/api-error.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { sessions, findings, rules, turns } from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';

@Controller('api/v1/sessions')
export class FindingsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get(':sessionId/findings')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
  ) {
    if (!isUuid(sessionId)) throw notFound('Không tìm thấy session');
    const [session] = await this.db
      .select({ userId: sessions.userId, projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw notFound('Không tìm thấy session');
    if (
      !(await this.access.canViewUserData(
        user,
        session.userId,
        session.projectId,
      ))
    )
      throw forbidden();
    if (user.id !== session.userId)
      await this.audit.record(user.id, 'session.view', 'session', sessionId);
    const items = await this.db
      .select({
        id: findings.id,
        ruleKey: rules.key,
        turnSeq: findings.turnSeq,
        message: sql<string>`${findings.evidence}->>'message'`,
        severity: sql<string>`${findings.evidence}->>'severity'`,
        evidenceExcerpt: sql<
          string | null
        >`left(coalesce(nullif(${turns.text}, ''), ${turns.diff}->>'path'), 160)`,
      })
      .from(findings)
      .innerJoin(rules, eq(rules.id, findings.ruleId))
      .leftJoin(
        turns,
        and(
          eq(turns.sessionId, findings.sessionId),
          eq(turns.seq, findings.turnSeq),
        ),
      )
      .where(eq(findings.sessionId, sessionId))
      .orderBy(asc(findings.turnSeq), asc(rules.key));
    return { items };
  }
}
