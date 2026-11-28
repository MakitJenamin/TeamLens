import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ApiError, isUniqueViolation, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projects, rules, sessions, turns } from '../../db/schema/index.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import {
  applyOverride,
  describeRule,
  runRuleTests,
  toSessionRule,
  type RuleChange,
  type RuleOverride,
  type RuleTestResult,
} from './rule-definition.js';
import { RulesQueryService, type RuleDetail } from './rules-query.service.js';
import {
  evaluateSession,
  type RuleSession,
  type RuleTurn,
} from './session-engine.js';

type RuleRow = typeof rules.$inferSelect;

/** Số session gốc gần nhất dùng để chạy thử một rule. */
export const TEST_SESSION_LIMIT = 50;
const SAMPLE_LIMIT = 5;

export interface DraftResult {
  rule: ReturnType<typeof describeRule>;
  changes: RuleChange[];
  tests: RuleTestResult[];
  allPassed: boolean;
}

export interface RuleTestOnSessions {
  sessionsEvaluated: number;
  baselineTriggered: number;
  candidateTriggered: number;
  samples: { sessionId: string; turnSeq: number | null; count: number }[];
}

/** Giá trị đưa vào audit: đủ để đảo lại, không có nội dung prompt. */
function auditView(row: RuleRow) {
  const definition = (row.definition ?? {}) as Record<string, unknown>;
  return {
    scope: row.projectId ? 'project' : 'default',
    enabled: row.enabled,
    version: row.version,
    severity: row.severity,
    thresholds: definition.thresholds ?? null,
    message: definition.message ?? null,
    advice: definition.advice ?? null,
  };
}

/**
 * Ghi rule cho leader qua MCP (M6.16): thử, chạy thử trên session, lưu bản riêng của project, bật/tắt.
 *
 * Phạm vi hẹp có chủ ý: chỉ chỉnh ngưỡng, mức độ, thông điệp, lời khuyên của rule **session có sẵn**; không đổi
 * `match` (logic và regex lấy từ code, tránh ReDoS), không tạo rule mới (pipeline chấm điểm chỉ biết rule dựng
 * sẵn). Mọi thao tác: chỉ leader, audit kèm giá trị cũ và mới (`audit_log.details`), rồi phát job chấm lại
 * (`project.rescore`) như nút "Chạy lại" trên dashboard. M4.4 (màn quản lý rule) có thể dùng lại dịch vụ này.
 */
@Injectable()
export class RulesWriteService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(RulesQueryService) private readonly query: RulesQueryService,
  ) {}

  /** Soạn thử: không ghi gì. */
  async draft(
    actor: AuthUser,
    projectId: string,
    key: string,
    override: RuleOverride,
  ): Promise<DraftResult> {
    const { result } = await this.prepare(actor, projectId, key, override);
    return result;
  }

  /** Chạy thử trên tối đa {@link TEST_SESSION_LIMIT} session gốc gần nhất. Không trả nội dung turn. */
  async testOnSessions(
    actor: AuthUser,
    projectId: string,
    key: string,
    override: RuleOverride,
  ): Promise<RuleTestOnSessions> {
    const { base, candidate } = await this.prepare(
      actor,
      projectId,
      key,
      override,
    );
    const recent = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, projectId),
          isNull(sessions.parentSourceId),
          isNull(sessions.parentSessionId),
        ),
      )
      .orderBy(desc(sessions.startedAt), desc(sessions.id))
      .limit(TEST_SESSION_LIMIT);
    const turnRows =
      recent.length === 0
        ? []
        : await this.db
            .select({
              sessionId: turns.sessionId,
              seq: turns.seq,
              role: turns.role,
              kind: turns.kind,
              text: turns.text,
              tool: sql<RuleTurn['tool']>`${turns.tool}`,
              diff: sql<RuleTurn['diff']>`${turns.diff}`,
            })
            .from(turns)
            .where(
              inArray(
                turns.sessionId,
                recent.map((s) => s.id),
              ),
            );
    const bySession = new Map<string, RuleTurn[]>();
    for (const { sessionId, ...turn } of turnRows) {
      const list = bySession.get(sessionId) ?? [];
      list.push(turn);
      bySession.set(sessionId, list);
    }

    const out: RuleTestOnSessions = {
      sessionsEvaluated: 0,
      baselineTriggered: 0,
      candidateTriggered: 0,
      samples: [],
    };
    for (const session of recent) {
      const sessionTurns = bySession.get(session.id) ?? [];
      // Như `score-session.ts`: bỏ session đã bị retention xóa bớt turn (chấm trên dữ liệu thiếu là sai).
      if (sessionTurns.length < session.turnCount) continue;
      const input: RuleSession = {
        parentSourceId: null,
        permissionMode: session.permissionMode,
        instructionFiles: session.instructionFiles as RuleSession['instructionFiles'],
        turns: sessionTurns,
      };
      out.sessionsEvaluated += 1;
      if (evaluateSession(input, [base]).length > 0) out.baselineTriggered += 1;
      const [hit] = evaluateSession(input, [candidate]);
      if (hit) {
        out.candidateTriggered += 1;
        if (out.samples.length < SAMPLE_LIMIT) {
          out.samples.push({
            sessionId: session.id,
            turnSeq: hit.turnSeq,
            count: hit.count,
          });
        }
      }
    }
    return out;
  }

  /** Lưu thành bản riêng của project. Từ chối khi không đổi gì hoặc `tests` nội tuyến không còn đúng. */
  async save(
    actor: AuthUser,
    projectId: string,
    key: string,
    override: RuleOverride,
    via: string,
  ): Promise<{ rule: RuleDetail; changes: RuleChange[] }> {
    const { result, effective, candidate } = await this.prepare(
      actor,
      projectId,
      key,
      override,
    );
    if (result.changes.length === 0) {
      throw new ApiError(
        400,
        'no_changes',
        'Không có thay đổi nào so với cấu hình hiện hành.',
      );
    }
    if (!result.allPassed) {
      const failed = result.tests.filter((t) => !t.passed).map((t) => t.name);
      throw new ApiError(
        422,
        'rule_tests_failed',
        `Các tests nội tuyến của rule không còn đúng với cấu hình mới: ${failed.join('; ')}.`,
      );
    }

    const definition = {
      ...(effective.definition as Record<string, unknown>),
      severity: candidate.severity,
      thresholds: candidate.thresholds,
      message: candidate.message,
      advice: candidate.advice,
    };
    await this.writeProjectRow(
      actor,
      projectId,
      key,
      effective,
      {
        severity: candidate.severity,
        definition,
        action: 'rule.save',
        details: { changes: result.changes },
      },
      via,
    );
    await this.queue.send(JOBS.projectRescore, { projectId });
    return {
      rule: await this.query.get(key, projectId),
      changes: result.changes,
    };
  }

  /** Bật/tắt rule (cả rule session lẫn rule tuần) cho một project. */
  async setEnabled(
    actor: AuthUser,
    projectId: string,
    key: string,
    enabled: boolean,
    via: string,
  ): Promise<{ rule: RuleDetail; previousEnabled: boolean }> {
    this.access.assertLeader(actor);
    const { effective } = await this.loadEffective(projectId, key);
    if (effective.enabled === enabled) {
      throw new ApiError(
        409,
        'no_changes',
        `Rule đã ở trạng thái ${enabled ? 'bật' : 'tắt'}.`,
      );
    }
    await this.writeProjectRow(
      actor,
      projectId,
      key,
      effective,
      {
        enabled,
        action: 'rule.set_enabled',
        details: {},
      },
      via,
    );
    await this.queue.send(JOBS.projectRescore, { projectId });
    return {
      rule: await this.query.get(key, projectId),
      previousEnabled: effective.enabled,
    };
  }

  /** Quyền, rule hiện hành, áp thay đổi và chạy `tests` nội tuyến (không ghi gì). */
  private async prepare(
    actor: AuthUser,
    projectId: string,
    key: string,
    override: RuleOverride,
  ) {
    this.access.assertLeader(actor);
    const { effective } = await this.loadEffective(projectId, key);
    const base = toSessionRule(effective);
    if (!base) {
      throw new ApiError(
        422,
        'rule_not_editable',
        'Chỉ chỉnh được rule session có sẵn; rule này là rule tuần (chỉ bật/tắt được).',
      );
    }
    const { rule: candidate, changes } = applyOverride(base, override);
    const tests = runRuleTests(candidate);
    const result: DraftResult = {
      rule: describeRule(candidate),
      changes,
      tests,
      allPassed: tests.every((t) => t.passed),
    };
    return { effective, base, candidate, result };
  }

  /** Rule hiện hành của project: bản riêng nếu có, không thì bản mặc định. */
  private async loadEffective(projectId: string, key: string) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    const rows = await this.db
      .select()
      .from(rules)
      .where(
        and(
          eq(rules.key, key),
          or(isNull(rules.projectId), eq(rules.projectId, projectId)),
        ),
      );
    const projectRow = rows.find((r) => r.projectId !== null) ?? null;
    const effective = projectRow ?? rows.find((r) => r.projectId === null);
    if (!effective) throw notFound('Không tìm thấy rule');
    return { effective, projectRow };
  }

  /** Tạo hoặc sửa bản riêng của project trong một transaction, kèm audit giá trị cũ và mới. */
  private writeProjectRow(
    actor: AuthUser,
    projectId: string,
    key: string,
    effective: RuleRow,
    change: {
      severity?: RuleRow['severity'];
      definition?: Record<string, unknown>;
      enabled?: boolean;
      action: 'rule.save' | 'rule.set_enabled';
      details: Record<string, unknown>;
    },
    via: string,
  ): Promise<void> {
    return this.db
      .transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(rules)
          .where(and(eq(rules.projectId, projectId), eq(rules.key, key)))
          .for('update');
        const previous = auditView(effective);
        let saved: RuleRow;
        if (existing) {
          [saved] = await tx
            .update(rules)
            .set({
              severity: change.severity ?? existing.severity,
              definition: change.definition ?? existing.definition,
              enabled: change.enabled ?? existing.enabled,
              // Bật/tắt không đổi định nghĩa nên không tăng phiên bản; lưu thay đổi thì tăng.
              version: change.definition ? existing.version + 1 : existing.version,
              updatedAt: new Date(),
            })
            .where(eq(rules.id, existing.id))
            .returning();
        } else {
          [saved] = await tx
            .insert(rules)
            .values({
              projectId,
              key,
              category: effective.category,
              severity: change.severity ?? effective.severity,
              definition: change.definition ?? effective.definition,
              enabled: change.enabled ?? effective.enabled,
              version: change.definition
                ? effective.version + 1
                : effective.version,
            })
            .returning();
        }
        await this.audit.record(
          actor.id,
          change.action,
          'rule',
          `${projectId}:${key}`,
          tx,
          { via, projectId, key, ...change.details, previous, next: auditView(saved) },
        );
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) throw error;
        // Hai thao tác ghi cùng lúc tạo bản riêng đầu tiên: bên chậm gặp unique, bảo thử lại.
        if (isUniqueViolation(error)) {
          throw new ApiError(409, 'conflict', 'Rule vừa được sửa, hãy thử lại.');
        }
        throw error;
      });
  }
}
