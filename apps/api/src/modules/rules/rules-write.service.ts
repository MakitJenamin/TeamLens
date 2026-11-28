import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { findings, projects, rules, sessions, turns } from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import {
  applyOverride,
  describeRule,
  runRuleTests,
  toEditableRule,
  toSessionRule,
  type RuleChange,
  type RuleOverride,
  type RuleTestResult,
} from './rule-definition.js';
import { RescoreService } from './rescore.service.js';
import { RulesQueryService, type RuleDetail } from './rules-query.service.js';
import {
  evaluateSession,
  type RuleSession,
  type RuleTurn,
} from './session-engine.js';

type RuleRow = typeof rules.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Thay đổi một rule của project: phần định nghĩa chỉnh được ({@link RuleOverride}) và/hoặc bật/tắt. */
export type RuleUpdate = RuleOverride & { enabled?: boolean };

export interface RuleWriteResult {
  /** Dòng rule hiệu lực sau khi ghi (không đổi gì thì là dòng hiện hành). */
  row: RuleRow;
  changes: RuleChange[];
  previousEnabled: boolean;
}

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
 * Đường ghi rule duy nhất, dùng chung cho dashboard (M4.4, `RuleConfigService`) và tool MCP (M6.16).
 *
 * - {@link update}: khóa dòng (rule mặc định cùng khóa `FOR UPDATE`, nên hai request đồng thời chạy lần lượt, kể cả
 *   khi chưa có bản riêng), áp thay đổi lên rule **hiện hành** rồi chạy `tests` nội tuyến trên kết quả (422
 *   `rule_tests_failed`), tăng phiên bản khi định nghĩa hoặc mức độ đổi (bật/tắt không tăng), audit `rule.save`
 *   hoặc `rule.set_enabled` vào `audit_log.details` kèm giá trị cũ và mới.
 * - {@link restore}: xóa bản riêng nhưng chuyển finding cũ sang rule mặc định (không để cascade xóa), rồi chấm lại.
 *
 * Không đổi `match` (logic và regex lấy từ code, tránh ReDoS), không tạo rule mới. Tool MCP còn hẹp hơn: chỉ chỉnh
 * rule session (`save_rule`), rule tuần chỉ bật/tắt được.
 */
@Injectable()
export class RulesWriteService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RescoreService) private readonly rescore: RescoreService,
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

  /** `save_rule` (MCP): lưu thành bản riêng của project rồi chấm lại. Từ chối khi không đổi gì. */
  async save(
    actor: AuthUser,
    projectId: string,
    key: string,
    override: RuleOverride,
    via: string,
  ): Promise<{ rule: RuleDetail; changes: RuleChange[]; rescore: 'queued' | 'in_progress' }> {
    const { changes } = await this.update(actor, projectId, key, override, via, {
      sessionOnly: true,
      requireChange: () =>
        new ApiError(400, 'no_changes', 'Không có thay đổi nào so với cấu hình hiện hành.'),
    });
    const rescore = await this.rescore.enqueueAfterChange(actor, projectId, via);
    return { rule: await this.query.get(key, projectId), changes, rescore };
  }

  /** `set_rule_enabled` (MCP): bật/tắt rule (cả rule session lẫn rule tuần) rồi chấm lại. */
  async setEnabled(
    actor: AuthUser,
    projectId: string,
    key: string,
    enabled: boolean,
    via: string,
  ): Promise<{ rule: RuleDetail; previousEnabled: boolean; rescore: 'queued' | 'in_progress' }> {
    const { previousEnabled } = await this.update(actor, projectId, key, { enabled }, via, {
      requireChange: () =>
        new ApiError(409, 'no_changes', `Rule đã ở trạng thái ${enabled ? 'bật' : 'tắt'}.`),
    });
    const rescore = await this.rescore.enqueueAfterChange(actor, projectId, via);
    return { rule: await this.query.get(key, projectId), previousEnabled, rescore };
  }

  /**
   * Sửa rule của project (tạo bản riêng nếu chưa có). Không phát job chấm lại: dashboard để leader bấm "Chạy lại"
   * (`needsRerun`), tool MCP tự gọi sau khi ghi.
   */
  async update(
    actor: AuthUser,
    projectId: string,
    key: string,
    change: RuleUpdate,
    via: string,
    options: { sessionOnly?: boolean; requireChange?: () => Error } = {},
  ): Promise<RuleWriteResult> {
    this.access.assertLeader(actor);
    await this.requireProject(projectId);
    return this.db.transaction(async (tx) => {
      const { defaultRow, projectRow } = await this.lockRule(tx, projectId, key);
      const effective = projectRow ?? defaultRow;
      const { enabled, ...override } = change;
      const { candidate, changes, result } = this.compute(effective, override, options.sessionOnly);
      if (enabled !== undefined && enabled !== effective.enabled) {
        changes.unshift({ field: 'enabled', from: effective.enabled, to: enabled });
      }
      if (changes.length === 0) {
        if (options.requireChange) throw options.requireChange();
        return { row: effective, changes, previousEnabled: effective.enabled };
      }
      const definitionChanged = changes.some((c) => c.field !== 'enabled');
      if (definitionChanged && !result.allPassed) {
        const failed = result.tests.filter((t) => !t.passed).map((t) => t.name);
        throw new ApiError(
          422,
          'rule_tests_failed',
          `Các tests nội tuyến của rule không còn đúng với cấu hình mới: ${failed.join('; ')}.`,
        );
      }
      const values = {
        severity: candidate.severity,
        definition: definitionChanged
          ? {
              ...(effective.definition as Record<string, unknown>),
              severity: candidate.severity,
              thresholds: candidate.thresholds,
              message: candidate.message,
              advice: candidate.advice,
            }
          : effective.definition,
        enabled: enabled ?? effective.enabled,
        // Bật/tắt không đổi định nghĩa nên không tăng phiên bản; đổi định nghĩa hoặc mức độ thì tăng.
        version: definitionChanged ? effective.version + 1 : effective.version,
        updatedAt: new Date(),
      };
      const [saved] = projectRow
        ? await tx.update(rules).set(values).where(eq(rules.id, projectRow.id)).returning()
        : await tx
            .insert(rules)
            .values({ ...values, projectId, key, category: defaultRow.category })
            .returning();
      await this.audit.record(
        actor.id,
        definitionChanged ? 'rule.save' : 'rule.set_enabled',
        'rule',
        `${projectId}:${key}`,
        tx,
        { via, projectId, key, changes, previous: auditView(effective), next: auditView(saved) },
      );
      return { row: saved, changes, previousEnabled: effective.enabled };
    });
  }

  /**
   * Khôi phục rule mặc định: xóa bản riêng của project rồi xếp chấm lại. Finding cũ trỏ vào bản riêng được chuyển
   * sang rule mặc định cùng khóa trước khi xóa (khóa ngoại `ON DELETE CASCADE` sẽ xóa chúng), nên điểm của session
   * đã bị retention xóa turn (không chấm lại được) giữ nguyên.
   */
  async restore(actor: AuthUser, projectId: string, key: string, via: string) {
    this.access.assertLeader(actor);
    await this.requireProject(projectId);
    const run = await this.db.transaction(async (tx) => {
      const { defaultRow, projectRow } = await this.lockRule(tx, projectId, key);
      if (!projectRow) throw notFound('Project không có bản rule ghi đè');
      const created = await this.rescore.createRun(projectId, tx);
      await tx.update(findings).set({ ruleId: defaultRow.id }).where(eq(findings.ruleId, projectRow.id));
      await tx.delete(rules).where(eq(rules.id, projectRow.id));
      await this.audit.record(actor.id, 'rule.restore', 'rule', `${projectId}:${key}`, tx, {
        via,
        projectId,
        key,
        runId: created.id,
        previous: auditView(projectRow),
        next: auditView(defaultRow),
      });
      return created;
    });
    await this.rescore.dispatch(run);
    return { status: 'queued' as const, runId: run.id };
  }

  /** Áp thay đổi lên rule hiện hành và chạy `tests` nội tuyến (không ghi gì). */
  private compute(effective: RuleRow, override: RuleOverride, sessionOnly = false) {
    const base = sessionOnly ? toSessionRule(effective) : toEditableRule(effective);
    if (!base) {
      throw new ApiError(
        422,
        'rule_not_editable',
        sessionOnly
          ? 'Chỉ chỉnh được rule session có sẵn; rule này là rule tuần (chỉ bật/tắt được).'
          : 'Định nghĩa rule không hợp lệ.',
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
    return { base, candidate, changes, result };
  }

  /** Quyền, rule hiện hành, áp thay đổi và chạy `tests` nội tuyến (không ghi gì). Chỉ rule session. */
  private async prepare(
    actor: AuthUser,
    projectId: string,
    key: string,
    override: RuleOverride,
  ) {
    this.access.assertLeader(actor);
    await this.requireProject(projectId);
    const rows = await this.db
      .select()
      .from(rules)
      .where(and(eq(rules.key, key), or(isNull(rules.projectId), eq(rules.projectId, projectId))));
    const effective =
      rows.find((r) => r.projectId !== null) ?? rows.find((r) => r.projectId === null);
    if (!effective) throw notFound('Không tìm thấy rule');
    const { base, candidate, result } = this.compute(effective, override, true);
    if (base.scope !== 'session' || candidate.scope !== 'session') {
      throw new Error('compute(sessionOnly) phải trả rule session');
    }
    return { effective, base, candidate, result };
  }

  private async requireProject(projectId: string) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
  }

  /**
   * Khóa rule mặc định cùng khóa rồi bản riêng của project (nếu có). Rule mặc định luôn tồn tại nên mọi thao tác ghi
   * cùng khóa xếp hàng tại đây, kể cả khi hai request cùng tạo bản riêng đầu tiên.
   */
  private async lockRule(tx: Tx, projectId: string, key: string) {
    const [defaultRow] = await tx
      .select()
      .from(rules)
      .where(and(isNull(rules.projectId), eq(rules.key, key)))
      .for('update');
    if (!defaultRow) throw notFound('Không tìm thấy rule');
    const [projectRow] = await tx
      .select()
      .from(rules)
      .where(and(eq(rules.projectId, projectId), eq(rules.key, key)))
      .for('update');
    return { defaultRow, projectRow: projectRow ?? null };
  }
}
