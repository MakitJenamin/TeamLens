import { Inject, Injectable } from '@nestjs/common';
import type { AiResult, SessionAiResults } from '@teamlens/schema';
import { asc, eq, sql } from 'drizzle-orm';
import { forbidden, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { findings, rules, sessions, turns } from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { LlmService, toAiResult } from '../llm/llm.service.js';
import type { AiLocale, AiResultRow } from '../llm/llm.types.js';
import {
  dropUnknownSeqs,
  EXPLAIN_SYSTEM,
  explainBlocks,
  findingExplainSchema,
  OUTCOME_SYSTEM,
  PROMPT_VERSIONS,
  type PromptFinding,
  type PromptTurn,
  sessionBlocks,
  sessionOutcomeSchema,
  sessionSummarySchema,
  SUMMARY_SYSTEM,
} from './ai-prompts.js';

const sessionNotFound = () => notFound('Không tìm thấy session');
const findingNotFound = () => notFound('Không tìm thấy finding');

interface SessionRow {
  id: string;
  userId: string;
  agent: string;
  repoRemote: string;
  branch: string | null;
  turnCount: number;
}

/**
 * Nút AI trên trang xem session (M6.5, M6.6): A1 tóm tắt, A5 đánh giá kết quả, A4 giải thích finding.
 * Quyền như `GET /api/v1/sessions/:id`; chạy AI trên dữ liệu người khác ghi audit `session.ai`.
 * Kết quả chỉ người bấm đọc được (`LlmService.findResults` theo user của người gọi).
 */
@Injectable()
export class SessionsAiService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly llm: LlmService,
  ) {}

  /** Kết quả AI của chính người gọi cho session và các finding của nó. */
  async results(
    viewer: AuthUser,
    sessionId: string,
    locale: AiLocale,
  ): Promise<SessionAiResults> {
    // Không ghi audit: trang session đã gọi `GET /sessions/:id` (ghi `session.view`), tránh trùng.
    const session = await this.loadSession(viewer, sessionId, null);
    const findingIds = (
      await this.db
        .select({ id: findings.id })
        .from(findings)
        .where(eq(findings.sessionId, session.id))
    ).map((row) => row.id);
    const [sessionRows, findingRows, seqs] = await Promise.all([
      this.llm.findResults(viewer.id, {
        subjectType: 'session',
        subjectIds: [session.id],
        locale,
      }),
      this.llm.findResults(viewer.id, {
        kind: 'finding_explain',
        subjectType: 'finding',
        subjectIds: findingIds,
        locale,
      }),
      this.turnSeqs(session.id),
    ]);
    const pick = (kind: string) => {
      const row = sessionRows.find((r) => r.kind === kind);
      return row ? this.toResult(row, seqs) : null;
    };
    return {
      summary: pick('session_summary'),
      outcome: pick('session_outcome'),
      findingExplains: findingRows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => this.toResult(row, seqs)),
    };
  }

  /** A1: tóm tắt session. */
  async summarize(
    viewer: AuthUser,
    sessionId: string,
    locale: AiLocale,
  ): Promise<AiResult> {
    const session = await this.loadSession(viewer, sessionId, 'session.ai');
    const { turnRows, findingRows } = await this.loadInput(session.id);
    const row = await this.llm.run(viewer.id, {
      kind: 'session_summary',
      subjectType: 'session',
      subjectId: session.id,
      subjectUserId: session.userId,
      locale,
      promptVersion: PROMPT_VERSIONS.summary,
      system: SUMMARY_SYSTEM,
      untrusted: sessionBlocks(session, turnRows, findingRows),
      schema: sessionSummarySchema,
      maxOutputTokens: 2000,
    });
    return this.toResult(row, new Set(turnRows.map((t) => t.seq)));
  }

  /** A5: đánh giá session kết thúc thế nào. */
  async outcome(
    viewer: AuthUser,
    sessionId: string,
    locale: AiLocale,
  ): Promise<AiResult> {
    const session = await this.loadSession(viewer, sessionId, 'session.ai');
    const { turnRows, findingRows } = await this.loadInput(session.id);
    const row = await this.llm.run(viewer.id, {
      kind: 'session_outcome',
      subjectType: 'session',
      subjectId: session.id,
      subjectUserId: session.userId,
      locale,
      promptVersion: PROMPT_VERSIONS.outcome,
      system: OUTCOME_SYSTEM,
      untrusted: sessionBlocks(session, turnRows, findingRows),
      schema: sessionOutcomeSchema,
      maxOutputTokens: 1200,
    });
    return this.toResult(row, new Set(turnRows.map((t) => t.seq)));
  }

  /** A4: giải thích một finding (quyền như xem session chứa finding). */
  async explainFinding(
    viewer: AuthUser,
    findingId: string,
    locale: AiLocale,
  ): Promise<AiResult> {
    if (!isUuid(findingId)) throw findingNotFound();
    const [finding] = await this.db
      .select({
        id: findings.id,
        sessionId: findings.sessionId,
        turnSeq: findings.turnSeq,
        evidence: findings.evidence,
        ruleKey: rules.key,
        definition: rules.definition,
      })
      .from(findings)
      .innerJoin(rules, eq(rules.id, findings.ruleId))
      .where(eq(findings.id, findingId))
      .limit(1);
    if (!finding) throw findingNotFound();
    const session = await this.loadSession(
      viewer,
      finding.sessionId,
      'session.ai',
    );
    const turnRows = await this.loadTurns(session.id);
    const evidence = asRecord(finding.evidence);
    const definition = asRecord(finding.definition);
    const row = await this.llm.run(viewer.id, {
      kind: 'finding_explain',
      subjectType: 'finding',
      subjectId: finding.id,
      subjectUserId: session.userId,
      locale,
      promptVersion: PROMPT_VERSIONS.explain,
      system: EXPLAIN_SYSTEM,
      untrusted: explainBlocks(
        {
          ruleKey: finding.ruleKey,
          definition: finding.definition,
          message: stringOrNull(evidence?.message),
          advice: stringOrNull(definition?.advice),
          evidence: finding.evidence,
          turnSeq: finding.turnSeq,
        },
        turnRows,
      ),
      schema: findingExplainSchema,
      maxOutputTokens: 1000,
    });
    return this.toResult(row, new Set(turnRows.map((t) => t.seq)));
  }

  /**
   * Kiểm tra quyền như xem session: member chỉ session của mình, leader mọi session.
   * Đụng tới session của người khác ghi audit với `action` đã cho (`null` = chỉ kiểm quyền, không ghi).
   */
  private async loadSession(
    viewer: AuthUser,
    sessionId: string,
    action: 'session.ai' | null,
  ): Promise<SessionRow> {
    if (!isUuid(sessionId)) throw sessionNotFound();
    const [row] = await this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        agent: sessions.agent,
        repoRemote: sessions.repoRemote,
        branch: sessions.branch,
        turnCount: sessions.turnCount,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) throw sessionNotFound();
    if (!this.access.canViewUserData(viewer, row.userId)) throw forbidden();
    if (action && viewer.id !== row.userId)
      await this.audit.record(viewer.id, action, 'session', row.id);
    return row;
  }

  private loadTurns(sessionId: string): Promise<PromptTurn[]> {
    return this.db
      .select({
        seq: turns.seq,
        role: turns.role,
        kind: turns.kind,
        text: turns.text,
        tool: turns.tool,
        output: turns.output,
        diff: turns.diff,
        interrupted: turns.interrupted,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.seq));
  }

  private async loadInput(sessionId: string): Promise<{
    turnRows: PromptTurn[];
    findingRows: PromptFinding[];
  }> {
    const [turnRows, findingRows] = await Promise.all([
      this.loadTurns(sessionId),
      this.db
        .select({
          ruleKey: rules.key,
          message: sql<string | null>`${findings.evidence}->>'message'`,
          turnSeq: findings.turnSeq,
        })
        .from(findings)
        .innerJoin(rules, eq(rules.id, findings.ruleId))
        .where(eq(findings.sessionId, sessionId))
        .orderBy(asc(findings.turnSeq), asc(rules.key)),
    ]);
    return { turnRows, findingRows };
  }

  private async turnSeqs(sessionId: string): Promise<Set<number>> {
    const rows = await this.db
      .select({ seq: turns.seq })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    return new Set(rows.map((row) => row.seq));
  }

  /** Đổi sang `AiResult`, bỏ trích dẫn `seq` không có trong session (hậu kiểm). */
  private toResult(row: AiResultRow, seqs: ReadonlySet<number>): AiResult {
    const result = toAiResult(row);
    return {
      ...result,
      result: dropUnknownSeqs(result.result, seqs),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
