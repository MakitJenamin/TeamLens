import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { forbidden, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { auditLog, findings, rules, sessions, turns } from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';

/** Khoảng thời gian coi lần gọi findings là cùng một lượt xem với lần mở session trước đó. */
const VIEW_DEDUP_WINDOW = '30 minutes';

export interface SessionFindingItem {
  id: string;
  ruleKey: string;
  turnSeq: number | null;
  message: string;
  severity: string;
  evidenceExcerpt: string | null;
}

/**
 * Nhận xét (finding) của một session (contract `rules.yaml`). Tách khỏi controller (M6.15) để tool MCP
 * `get_findings` dùng lại đúng quy tắc quyền và audit của dashboard.
 */
@Injectable()
export class FindingsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Member xem session của mình, leader xem mọi session; xem của người khác ghi audit `session.view`. */
  async list(
    user: AuthUser,
    sessionId: string,
  ): Promise<{ items: SessionFindingItem[] }> {
    if (!isUuid(sessionId)) throw notFound('Không tìm thấy session');
    const [session] = await this.db
      .select({ userId: sessions.userId, projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw notFound('Không tìm thấy session');
    if (!this.access.canViewUserData(user, session.userId)) throw forbidden();
    if (user.id !== session.userId && !(await this.viewedRecently(user.id, sessionId)))
      await this.audit.record(user.id, 'session.view', 'session', sessionId, undefined, undefined, {
        ownerId: session.userId,
      });
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

  /**
   * Trang session gọi `GET /sessions/:id` (đã ghi `session.view`) rồi mới gọi findings. Không ghi thêm
   * dòng thứ hai nếu người này vừa xem session đó; gọi findings riêng (vd. tool MCP) vẫn ghi audit.
   */
  private async viewedRecently(actorId: string, sessionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, 'session'),
          eq(auditLog.targetId, sessionId),
          eq(auditLog.actorId, actorId),
          eq(auditLog.action, 'session.view'),
          gt(auditLog.at, sql`now() - ${VIEW_DEDUP_WINDOW}::interval`),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
}
