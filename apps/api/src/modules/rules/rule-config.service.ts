import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { ApiError, isUniqueViolation, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projectRescoreRuns, projects, rules, sessions, turns } from '../../db/schema/index.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import { AuditService } from '../access/audit.service.js';
import { isUuid } from '../access/access.service.js';
import { evaluateSession, type RuleTurn, type SessionRule } from './session-engine.js';
import { evaluateWeek, type WeekSession, type WeeklyRule } from './weekly-rules.js';

type Definition = SessionRule | WeeklyRule;
type RuleRow = typeof rules.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function validateThresholds(base: Definition, next: Record<string, number>) {
  for (const [key, value] of Object.entries(next)) {
    if (!(key in base.thresholds) || !Number.isFinite(value) || value < 0 || value > 1_000_000 ||
        (Number.isInteger(base.thresholds[key]) && !Number.isInteger(value)) ||
        (/Rate|Ratio/.test(key) && value > 1)) {
      throw new ApiError(400, 'rule_invalid', `Ngưỡng ${key} không hợp lệ`);
    }
  }
  const merged = { ...base.thresholds, ...next };
  // Các ngưỡng đếm/chữ không nhận 0; tỉ lệ có thể bằng 0.
  for (const [key, value] of Object.entries(merged)) {
    if (value === 0 && !/Rate|Ratio/.test(key)) throw new ApiError(400, 'rule_invalid', `Ngưỡng ${key} phải lớn hơn 0`);
  }
  return next;
}

/** Chạy các ca nội tuyến của rule gốc để phát hiện definition sai trước khi tạo bản ghi đè. */
function checkInlineTests(rule: Definition) {
  for (const test of rule.tests) {
    const hits = rule.scope === 'session'
      ? evaluateSession((test as SessionRule['tests'][number]).input, [rule])
      : evaluateWeek((test as WeeklyRule['tests'][number]).input, [rule]);
    if ((hits.length > 0) !== (test.expect === 'triggered'))
      throw new ApiError(400, 'rule_invalid', `Ca nội tuyến ${test.name} không đạt`);
  }
}

@Injectable()
export class RuleConfigService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(QueueService) private readonly queue: QueueService,
  ) {}

  private async requireProject(projectId: string) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
  }

  private async effective(projectId: string) {
    await this.requireProject(projectId);
    const rows = await this.db.select().from(rules).where(or(isNull(rules.projectId), eq(rules.projectId, projectId)));
    const defaults = new Map(rows.filter((row) => row.projectId === null).map((row) => [row.key, row]));
    const selected = new Map(defaults);
    for (const row of rows) if (row.projectId) selected.set(row.key, row);
    return { defaults, selected };
  }

  private toDto(row: RuleRow, needsRerun = false) {
    const definition = row.definition as Definition;
    return { key: row.key, category: row.category, scope: definition.scope, severity: row.severity,
      enabled: row.enabled, thresholds: definition.thresholds, definition, version: row.version,
      source: row.projectId ? 'project' as const : 'default' as const, needsRerun };
  }

  async list(projectId: string) {
    const { selected } = await this.effective(projectId);
    const [lastRun] = await this.db.select({ finishedAt: projectRescoreRuns.finishedAt })
      .from(projectRescoreRuns)
      .where(and(eq(projectRescoreRuns.projectId, projectId), eq(projectRescoreRuns.status, 'succeeded')))
      .orderBy(desc(projectRescoreRuns.finishedAt)).limit(1);
    return [...selected.values()].sort((a, b) => a.key.localeCompare(b.key))
      .map((row) => this.toDto(row, Boolean(row.projectId && (!lastRun?.finishedAt || row.updatedAt > lastRun.finishedAt))));
  }

  async update(user: AuthUser, projectId: string, key: string,
    patch: { enabled?: boolean; severity?: 'low' | 'medium' | 'high'; thresholds?: Record<string, number> }) {
    const { defaults, selected } = await this.effective(projectId);
    const current = selected.get(key);
    const base = defaults.get(key);
    if (!current || !base) throw notFound('Không tìm thấy rule');
    const baseDefinition = base.definition as Definition;
    checkInlineTests(baseDefinition);
    const definition = current.definition as Definition;
    const thresholds = patch.thresholds
      ? { ...definition.thresholds, ...validateThresholds(baseDefinition, patch.thresholds) }
      : definition.thresholds;
    const updatedDefinition = { ...definition, thresholds, severity: patch.severity ?? current.severity };
    const old = { enabled: current.enabled, severity: current.severity, thresholds: definition.thresholds };
    const next = { enabled: patch.enabled ?? current.enabled, severity: patch.severity ?? current.severity, thresholds };
    const row = await this.db.transaction(async (tx) => {
      const values = { projectId, key, category: current.category, severity: next.severity,
        definition: updatedDefinition, enabled: next.enabled, version: current.version + 1, updatedAt: new Date() };
      const [saved] = current.projectId
        ? await tx.update(rules).set(values).where(eq(rules.id, current.id)).returning()
        : await tx.insert(rules).values(values).returning();
      await this.audit.record(user.id, 'rules.update', 'project', projectId, tx, { key, old, next });
      return saved;
    });
    return this.toDto(row, true);
  }

  async restore(user: AuthUser, projectId: string, key: string) {
    const { defaults, selected } = await this.effective(projectId);
    if (!defaults.has(key)) throw notFound('Không tìm thấy rule');
    const override = selected.get(key);
    if (!override?.projectId) throw notFound('Project không có bản rule ghi đè');
    let run: typeof projectRescoreRuns.$inferSelect;
    try {
      run = await this.db.transaction(async (tx: Tx) => {
        const [created] = await tx.insert(projectRescoreRuns).values({ projectId }).returning();
        await tx.delete(rules).where(eq(rules.id, override.id));
        await this.audit.record(user.id, 'rules.restore', 'project', projectId, tx, { key });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'rescore_in_progress', 'Project đang được chấm lại');
      throw error;
    }
    try {
      await this.queue.send(JOBS.projectRescore, { projectId, runId: run.id });
    } catch (error) {
      await this.db.update(projectRescoreRuns).set({ status: 'failed', errorCode: 'queue_failed', updatedAt: new Date(), finishedAt: new Date() }).where(eq(projectRescoreRuns.id, run.id));
      throw error;
    }
    return { status: 'queued' as const, runId: run.id };
  }

  async test(user: AuthUser, projectId: string, key: string) {
    const { selected } = await this.effective(projectId);
    const row = selected.get(key);
    if (!row) throw notFound('Không tìm thấy rule');
    const definition = { ...(row.definition as Definition), severity: row.severity };
    const roots = await this.db.select({ id: sessions.id, userId: sessions.userId, startedAt: sessions.startedAt,
      parentSourceId: sessions.parentSourceId, permissionMode: sessions.permissionMode, instructionFiles: sessions.instructionFiles })
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), isNull(sessions.parentSourceId), isNull(sessions.parentSessionId)))
      .orderBy(desc(sessions.startedAt), desc(sessions.id)).limit(50);
    const deadline = Date.now() + 10_000;
    const turnRows = roots.length ? await this.db.select({ sessionId: turns.sessionId, seq: turns.seq,
      role: turns.role, kind: turns.kind, text: turns.text, ts: turns.ts, model: turns.model,
      interrupted: turns.interrupted, diff: turns.diff, tool: turns.tool })
      .from(turns).where(inArray(turns.sessionId, roots.map((root) => root.id))) : [];
    if (Date.now() > deadline) throw new ApiError(408, 'rule_test_timeout', 'Thử rule quá 10 giây');
    const bySession = new Map<string, RuleTurn[]>();
    for (const turn of turnRows) {
      const list = bySession.get(turn.sessionId) ?? [];
      list.push({ ...turn, ts: turn.ts.toISOString(), diff: turn.diff as RuleTurn['diff'], tool: turn.tool as RuleTurn['tool'] });
      bySession.set(turn.sessionId, list);
    }
    const examples: { sessionId: string; turnSeq: number | null; excerpt: string | null }[] = [];
    let matchedSessions = 0;
    if (definition.scope === 'session') {
      for (const root of roots) {
        if (Date.now() > deadline) throw new ApiError(408, 'rule_test_timeout', 'Thử rule quá 10 giây');
        const hits = evaluateSession({ parentSourceId: null, permissionMode: root.permissionMode,
          instructionFiles: root.instructionFiles, turns: bySession.get(root.id) ?? [] }, [definition]);
        if (hits.length) {
          matchedSessions++;
          if (examples.length < 10) examples.push({ sessionId: root.id, turnSeq: hits[0].turnSeq, excerpt: null });
        }
      }
    } else {
      const groups = new Map<string, WeekSession[]>();
      for (const root of roots) {
        const week = new Date(root.startedAt);
        week.setUTCHours(0, 0, 0, 0);
        week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
        const groupKey = `${root.userId}/${week.toISOString()}`;
        const group = groups.get(groupKey) ?? [];
        group.push({ id: root.id, parentSourceId: null, turns: bySession.get(root.id) ?? [] });
        groups.set(groupKey, group);
      }
      for (const group of groups.values()) {
        if (Date.now() > deadline) throw new ApiError(408, 'rule_test_timeout', 'Thử rule quá 10 giây');
        for (const hit of evaluateWeek(group, [definition])) {
          matchedSessions++;
          if (examples.length < 10) examples.push({ sessionId: hit.sessionId, turnSeq: hit.turnSeq, excerpt: null });
        }
      }
    }
    await this.audit.record(user.id, 'rules.test', 'project', projectId, this.db, { key, sampledSessions: roots.length, matchedSessions });
    return { sampledSessions: roots.length, matchedSessions, approximate: definition.scope === 'user_week', examples };
  }
}
