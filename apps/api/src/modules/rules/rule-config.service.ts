import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projectRescoreRuns, projects, rules, sessions, turns } from '../../db/schema/index.js';
import { AuditService } from '../access/audit.service.js';
import { isUuid } from '../access/access.service.js';
import { evaluateSession, type RuleTurn, type SessionRule } from './session-engine.js';
import { evaluateWeek, type WeekSession, type WeeklyRule } from './weekly-rules.js';
import { RulesWriteService } from './rules-write.service.js';

type Definition = SessionRule | WeeklyRule;
type RuleRow = typeof rules.$inferSelect;

@Injectable()
export class RuleConfigService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RulesWriteService) private readonly writer: RulesWriteService,
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

  /**
   * Thời điểm bắt đầu của lần chấm lại thành công gần nhất. Rule sửa sau thời điểm này cần chạy lại: lần chạy đọc rule
   * ở từng session trong lúc chạy, nên sửa giữa chừng thì chưa chắc đã áp cho mọi session.
   */
  private async lastRunStart(projectId: string) {
    const [lastRun] = await this.db.select({ startedAt: projectRescoreRuns.startedAt })
      .from(projectRescoreRuns)
      .where(and(eq(projectRescoreRuns.projectId, projectId), eq(projectRescoreRuns.status, 'succeeded')))
      .orderBy(desc(projectRescoreRuns.startedAt)).limit(1);
    return lastRun?.startedAt ?? null;
  }

  private needsRerun(row: RuleRow, lastStart: Date | null) {
    return Boolean(row.projectId && (!lastStart || row.updatedAt >= lastStart));
  }

  async list(projectId: string) {
    const { selected } = await this.effective(projectId);
    const lastStart = await this.lastRunStart(projectId);
    return [...selected.values()].sort((a, b) => a.key.localeCompare(b.key))
      .map((row) => this.toDto(row, this.needsRerun(row, lastStart)));
  }

  /** Dùng chung đường ghi với tool MCP (`RulesWriteService.update`). */
  async update(user: AuthUser, projectId: string, key: string,
    patch: { enabled?: boolean; severity?: 'low' | 'medium' | 'high'; thresholds?: Record<string, number> }) {
    const { row } = await this.writer.update(user, projectId, key, patch, 'dashboard');
    return this.toDto(row, this.needsRerun(row, await this.lastRunStart(projectId)));
  }

  restore(user: AuthUser, projectId: string, key: string) {
    return this.writer.restore(user, projectId, key, 'dashboard');
  }

  async test(user: AuthUser, projectId: string, key: string) {
    const { selected } = await this.effective(projectId);
    const row = selected.get(key);
    if (!row) throw notFound('Không tìm thấy rule');
    const definition = { ...(row.definition as Definition), severity: row.severity };
    const roots = await this.db.select({ id: sessions.id, userId: sessions.userId, startedAt: sessions.startedAt,
      turnCount: sessions.turnCount, parentSourceId: sessions.parentSourceId, permissionMode: sessions.permissionMode, instructionFiles: sessions.instructionFiles })
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
    // Bỏ session đã bị retention xóa turn (M5.5): chấm trên turn thiếu sẽ cho kết quả sai.
    const complete = roots.filter((root) => (bySession.get(root.id)?.length ?? 0) >= root.turnCount);
    const examples: { sessionId: string; turnSeq: number | null; excerpt: string | null }[] = [];
    let matchedSessions = 0;
    if (definition.scope === 'session') {
      for (const root of complete) {
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
      for (const root of complete) {
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
    await this.audit.record(user.id, 'rules.test', 'project', projectId, this.db, { key, sampledSessions: complete.length, matchedSessions });
    return { sampledSessions: complete.length, matchedSessions, approximate: definition.scope === 'user_week', examples };
  }
}
