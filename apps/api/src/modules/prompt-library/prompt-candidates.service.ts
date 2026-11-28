import { Inject, Injectable } from '@nestjs/common';
import type { AiResult, PromptCandidatesSaved } from '@teamlens/schema';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  sql,
} from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  aiResults,
  findings,
  promptLibrary,
  rules,
  sessions,
  sessionScores,
  turns,
  users,
} from '../../db/schema/index.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { llmError } from '../llm/llm-errors.js';
import { LlmService, toAiResult } from '../llm/llm.service.js';
import type { AiLocale, AiResultRow } from '../llm/llm.types.js';
import { keywordsOf } from '../skills/prompt-clusterer.js';
import {
  CANDIDATES_PROMPT_VERSION,
  CANDIDATES_SYSTEM,
  type CandidateInput,
  candidateBlocks,
  candidatesSchema,
  MAX_CANDIDATES,
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
  MIN_SCORE,
  normalizeCandidates,
} from './prompt-candidates-prompts.js';
import { PromptLibraryService } from './prompt-library.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 90;
/** Dung sai để `from = bây giờ - 90 ngày` với `to` mặc định vẫn hợp lệ (như Skill Finder). */
const RANGE_SLACK_MS = 60_000;
/** Số session lấy từ truy vấn điểm trước khi lọc theo prompt (để còn đủ sau khi bỏ prompt không hợp lệ). */
const SESSION_POOL = 40;

export interface RunPromptCandidatesInput {
  from?: Date;
  to?: Date;
}

const invalidRange = (message: string) =>
  new ApiError(400, 'validation_error', message);

/**
 * C2 bước 1 (M6.14): leader tìm prompt mẫu để đưa vào thư viện. Ứng viên chọn bằng heuristic (session gốc điểm cao,
 * không có finding nặng, chưa trong thư viện, prompt đầu đủ dài), AI (key của leader) viết tiêu đề và lý do.
 * Kết quả AI chỉ là mã ứng viên: id session, người gõ, điểm, nội dung do server điền.
 */
@Injectable()
export class PromptCandidatesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PromptLibraryService) private readonly library: PromptLibraryService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  /** Kết quả đã lưu của chính leader. Không đụng dữ liệu prompt nên không ghi audit. */
  async saved(
    viewer: AuthUser,
    projectId: string,
    locale: AiLocale,
  ): Promise<PromptCandidatesSaved> {
    this.access.assertLeader(viewer);
    await this.library.assertProjectAccess(viewer, projectId);
    const rows = await this.llm.findResults(viewer.id, {
      subjectType: 'project',
      subjectIds: [projectId],
      kind: 'prompt_candidates',
      locale,
    });
    return { result: rows[0] ? toAiResult(rows[0]) : null };
  }

  async run(
    viewer: AuthUser,
    projectId: string,
    input: RunPromptCandidatesInput,
    locale: AiLocale,
  ): Promise<AiResult> {
    this.access.assertLeader(viewer);
    await this.library.assertProjectAccess(viewer, projectId);
    // Kiểm key trước khi đụng dữ liệu: chưa có key thì không có gì rời máy chủ và không ghi audit.
    if (!(await this.llm.hasKey(viewer.id))) throw llmError('llm_key_missing');

    const { from, to } = this.range(input);
    const candidates = await this.findCandidates(projectId, from, to);
    if (candidates.length === 0)
      throw new ApiError(
        409,
        'no_candidates',
        'Chưa có session nào đủ tốt để đề xuất trong khoảng này. Thử mở rộng khoảng thời gian.',
      );

    // Leader gửi prompt của người khác cho nhà cung cấp LLM: ghi audit như khi mở session của họ.
    if (candidates.some((c) => c.userId !== viewer.id)) {
      await this.audit.record(
        viewer.id,
        'prompt_library.candidates',
        'project',
        projectId,
      );
    }

    const row = await this.llm.run(viewer.id, {
      kind: 'prompt_candidates',
      subjectType: 'project',
      subjectId: projectId,
      // Ứng viên của nhiều người nên không gán chủ dữ liệu.
      subjectUserId: null,
      locale,
      promptVersion: CANDIDATES_PROMPT_VERSION,
      system: CANDIDATES_SYSTEM,
      untrusted: candidateBlocks(candidates),
      schema: candidatesSchema,
      maxOutputTokens: 2000,
    });
    return this.finish(row, candidates);
  }

  private range(input: RunPromptCandidatesInput): { from: Date; to: Date } {
    const to = input.to ?? new Date();
    const from =
      input.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    if (from.getTime() >= to.getTime())
      throw invalidRange('`from` phải trước `to`.');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS + RANGE_SLACK_MS)
      throw invalidRange(`Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày.`);
    return { from, to };
  }

  /** Heuristic: session gốc điểm trung bình đủ cao, không finding `high`, chưa trong thư viện, prompt đầu hợp lệ. */
  private async findCandidates(
    projectId: string,
    from: Date,
    to: Date,
  ): Promise<CandidateInput[]> {
    const avgScore = sql<string>`avg(${sessionScores.score})`;
    const pool = await this.db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        userName: users.name,
        startedAt: sessions.startedAt,
        workType: sessions.workType,
        score: avgScore,
      })
      .from(sessions)
      .innerJoin(sessionScores, eq(sessionScores.sessionId, sessions.id))
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.projectId, projectId),
          isNull(sessions.parentSourceId),
          isNull(sessions.parentSessionId),
          gte(sessions.startedAt, from),
          lt(sessions.startedAt, to),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(findings)
              .innerJoin(rules, eq(rules.id, findings.ruleId))
              .where(
                and(
                  eq(findings.sessionId, sessions.id),
                  eq(rules.severity, 'high'),
                ),
              ),
          ),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(promptLibrary)
              .where(eq(promptLibrary.sessionId, sessions.id)),
          ),
        ),
      )
      .groupBy(sessions.id, users.name)
      .having(sql`avg(${sessionScores.score}) >= ${MIN_SCORE}`)
      .orderBy(desc(avgScore), desc(sessions.startedAt), desc(sessions.id))
      .limit(SESSION_POOL);
    if (pool.length === 0) return [];

    const firstPrompts = await this.db
      .selectDistinctOn([turns.sessionId], {
        sessionId: turns.sessionId,
        seq: turns.seq,
        text: turns.text,
      })
      .from(turns)
      .where(
        and(
          inArray(
            turns.sessionId,
            pool.map((s) => s.sessionId),
          ),
          eq(turns.role, 'user'),
          eq(turns.kind, 'prompt'),
          isNotNull(turns.text),
        ),
      )
      .orderBy(turns.sessionId, turns.seq);
    const promptOf = new Map(firstPrompts.map((p) => [p.sessionId, p]));

    const out: CandidateInput[] = [];
    for (const s of pool) {
      const prompt = promptOf.get(s.sessionId);
      const text = prompt?.text?.normalize('NFC').trim() ?? '';
      const length = Array.from(text).length;
      if (!prompt || length < MIN_PROMPT_CHARS || length > MAX_PROMPT_CHARS)
        continue;
      if (keywordsOf(text) === null) continue; // prompt rác hoặc quá ít nội dung
      out.push({
        sessionId: s.sessionId,
        turnSeq: prompt.seq,
        userId: s.userId,
        userName: s.userName,
        startedAt: s.startedAt,
        score: Math.round(Number(s.score)),
        workType: s.workType,
        text,
      });
      if (out.length === MAX_CANDIDATES) break;
    }
    return out;
  }

  /** Lưu bản đã lọc (mã hợp lệ, dữ liệu của server) đè lên đầu ra thô của model rồi trả `AiResult`. */
  private async finish(
    row: AiResultRow,
    candidates: readonly CandidateInput[],
  ): Promise<AiResult> {
    const parsed = candidatesSchema.safeParse(row.result);
    if (!parsed.success) return toAiResult(row);
    const normalized = normalizeCandidates(parsed.data, candidates);
    await this.db
      .update(aiResults)
      .set({ result: normalized })
      .where(eq(aiResults.id, row.id));
    return toAiResult({ ...row, result: normalized });
  }
}
