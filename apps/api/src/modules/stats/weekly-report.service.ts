import { Inject, Injectable } from '@nestjs/common';
import type { AiResult, WeeklyReportSaved } from '@teamlens/schema';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import { ApiError, forbidden, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  aiResults,
  findings,
  projectMembers,
  projects,
  rules,
  sessions,
  sessionScores,
  turns,
  userWeeklyStats,
} from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { llmError } from '../llm/llm-errors.js';
import { LlmService, toAiResult } from '../llm/llm.service.js';
import type { AiLocale, AiResultRow } from '../llm/llm.types.js';
import { mergeWeeklyScores, type StatsRow } from './overview-math.js';
import { parseWeekParam } from './week-param.js';
import { weekWindow } from './refresh-weekly-stats.js';
import {
  normalizeReport,
  type ReportExampleInput,
  type ReportInput,
  REPORT_SYSTEM,
  reportBlocks,
  reportSchema,
  userWeekId,
  type WeekNumbers,
  WEEKLY_REPORT_PROMPT_VERSION,
} from './weekly-report-prompts.js';

const DAY_MS = 86_400_000;
const MAX_PATTERNS = 8;
/** Số session `needs_work` lấy làm ví dụ, và số session xét khi tìm ví dụ. */
const NEEDS_WORK_EXAMPLES = 2;
const MIN_PROMPT_CHARS = 15;
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const GOOD_SCORE = 70;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * B1 (M6.8): AI viết báo cáo tuần của một thành viên (key BYO của người bấm).
 *
 * AI không nhận cả session của tuần mà chỉ nhận số liệu đã tính (`user_weekly_stats`, finding theo rule, loại việc B4,
 * so với tuần trước và trung bình team) cùng tối đa 3 prompt ví dụ chọn bằng heuristic. Kết quả AI chỉ gồm lời nhận xét
 * và mã ví dụ; id session, turn, nội dung ví dụ do server điền.
 */
@Injectable()
export class WeeklyReportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  /** Kết quả đã lưu của chính người gọi. Không đụng prompt nên không ghi audit. */
  async saved(
    viewer: AuthUser,
    userId: string,
    query: { project: string; week?: string },
    locale: AiLocale,
  ): Promise<WeeklyReportSaved> {
    await this.assertAccess(viewer, userId, query.project);
    const week = await this.resolveWeek(userId, query.project, query.week);
    if (!week) return { result: null };
    const rows = await this.llm.findResults(viewer.id, {
      subjectType: 'user_week',
      subjectIds: [userWeekId(query.project, userId, week)],
      kind: 'weekly_user',
      locale,
    });
    return { result: rows[0] ? toAiResult(rows[0]) : null };
  }

  async run(
    viewer: AuthUser,
    userId: string,
    input: { project: string; week?: string },
    locale: AiLocale,
  ): Promise<AiResult> {
    await this.assertAccess(viewer, userId, input.project);
    // Kiểm key trước khi đụng dữ liệu: chưa có key thì không có gì rời máy chủ và không ghi audit.
    if (!(await this.llm.hasKey(viewer.id))) throw llmError('llm_key_missing');

    const week = await this.resolveWeek(userId, input.project, input.week);
    if (!week) throw noWeekData();
    const data = await this.gather(userId, input.project, week);
    if (data.current.sessions === 0) throw noWeekData();

    // Leader gửi prompt của người khác cho nhà cung cấp LLM: ghi audit như khi xem hồ sơ của họ.
    if (viewer.id !== userId)
      await this.audit.record(viewer.id, 'weekly_report.ai', 'user', userId);

    const row = await this.llm.run(viewer.id, {
      kind: 'weekly_user',
      subjectType: 'user_week',
      subjectId: userWeekId(input.project, userId, week),
      // Chủ dữ liệu là thành viên được báo cáo: xóa dữ liệu của họ (M5.6) xóa luôn báo cáo này.
      subjectUserId: userId,
      locale,
      promptVersion: WEEKLY_REPORT_PROMPT_VERSION,
      system: REPORT_SYSTEM,
      untrusted: reportBlocks(data),
      schema: reportSchema,
      maxOutputTokens: 1500,
    });
    return this.finish(row, data);
  }

  /** Giống hồ sơ thành viên: member chỉ về chính mình; leader về thành viên của project. */
  private async assertAccess(
    viewer: AuthUser,
    userId: string,
    projectId: string,
  ): Promise<void> {
    if (!isUuid(userId)) throw notFound('Không tìm thấy thành viên');
    if (!this.access.canViewUserData(viewer, userId)) throw forbidden();
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    if (!(await this.access.canAccessProject(viewer, projectId)))
      throw forbidden();
    const [member] = await this.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      );
    if (!member) throw notFound('Không tìm thấy thành viên trong project');
  }

  /**
   * Thứ Hai của tuần được báo cáo. `week` phải là thứ Hai (UTC) và không ở tương lai (400); bỏ trống thì lấy tuần gần
   * nhất mà người này có session, `null` khi chưa có tuần nào.
   */
  private async resolveWeek(
    userId: string,
    projectId: string,
    week: string | undefined,
    now = new Date(),
  ): Promise<string | null> {
    const current = weekWindow(now).start;
    if (week !== undefined) return parseWeekParam(week, current);
    const [latest] = await this.db
      .select({ week: userWeeklyStats.week })
      .from(userWeeklyStats)
      .where(
        and(
          eq(userWeeklyStats.userId, userId),
          eq(userWeeklyStats.projectId, projectId),
          lte(userWeeklyStats.week, isoDay(current)),
          sql`${userWeeklyStats.sessions} > 0`,
        ),
      )
      .orderBy(desc(userWeeklyStats.week))
      .limit(1);
    return latest?.week ?? null;
  }

  /** Số liệu tuần, tuần trước, trung bình team, rule bị vi phạm, loại việc và ví dụ prompt. */
  private async gather(
    userId: string,
    projectId: string,
    week: string,
  ): Promise<ReportInput> {
    const start = new Date(`${week}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    const previousWeek = isoDay(new Date(start.getTime() - 7 * DAY_MS));

    const statRows = (await this.db
      .select({
        userId: userWeeklyStats.userId,
        week: userWeeklyStats.week,
        sessions: userWeeklyStats.sessions,
        tokens: userWeeklyStats.tokens,
        scores: userWeeklyStats.scores,
      })
      .from(userWeeklyStats)
      .where(
        and(
          eq(userWeeklyStats.projectId, projectId),
          inArray(userWeeklyStats.week, [week, previousWeek]),
        ),
      )) as StatsRow[];
    const numbers = (rows: StatsRow[]): WeekNumbers => ({
      sessions: rows.reduce((sum, r) => sum + r.sessions, 0),
      tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
      scores: mergeWeeklyScores(rows) as Record<string, number>,
    });
    const mine = (w: string) =>
      statRows.filter((r) => r.userId === userId && r.week === w);
    const current = numbers(mine(week));
    const previousNumbers = numbers(mine(previousWeek));
    const teamScores = mergeWeeklyScores(
      statRows.filter((r) => r.week === week),
    ) as Record<string, number>;

    // Số session gốc thật của tuần (bảng thống kê có thể chậm hơn một nhịp so với session mới nhận).
    const inWeek = and(
      eq(sessions.projectId, projectId),
      eq(sessions.userId, userId),
      isNull(sessions.parentSourceId),
      isNull(sessions.parentSessionId),
      gte(sessions.startedAt, start),
      lt(sessions.startedAt, end),
    );
    const [{ n: realSessions }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(inWeek);
    current.sessions = realSessions;

    const workTypes = await this.db
      .select({
        workType: sessions.workType,
        sessions: sql<number>`count(*)::int`,
      })
      .from(sessions)
      .where(inWeek)
      .groupBy(sessions.workType)
      .orderBy(desc(sql`count(*)`), asc(sessions.workType));

    const severity = sql<string>`coalesce(${findings.evidence}->>'severity', ${rules.severity})`;
    const rank = sql`case ${severity} when 'high' then 3 when 'medium' then 2 else 1 end`;
    const count = sql<number>`count(*)::int`;
    const patterns = await this.db
      .select({
        ruleKey: rules.key,
        category: rules.category,
        severity: sql<string>`case max(${rank}) when 3 then 'high' when 2 then 'medium' else 'low' end`,
        count,
        advice: sql<string | null>`max(${rules.definition}->>'advice')`,
      })
      .from(findings)
      .innerJoin(rules, eq(rules.id, findings.ruleId))
      .innerJoin(sessions, eq(sessions.id, findings.sessionId))
      .where(inWeek)
      .groupBy(rules.key, rules.category)
      .orderBy(desc(count), asc(rules.key))
      .limit(MAX_PATTERNS);

    return {
      week,
      current,
      previous: previousNumbers.sessions > 0 ? previousNumbers : null,
      teamScores,
      patterns,
      workTypes,
      examples: await this.pickExamples(inWeek),
    };
  }

  /**
   * Tối đa 3 prompt ví dụ: {@link NEEDS_WORK_EXAMPLES} prompt đầu tiên của các session có finding nặng nhất (cần cải thiện)
   * và 1 prompt của session điểm cao nhất (tốt). Session đã mất turn do retention (không còn prompt) bị bỏ qua.
   */
  private async pickExamples(
    inWeek: ReturnType<typeof and>,
  ): Promise<ReportExampleInput[]> {
    const severity = sql<string>`coalesce(${findings.evidence}->>'severity', ${rules.severity})`;
    // Trọng số là hằng số của mã nguồn nên đưa thẳng vào SQL (tham số bind không suy ra được kiểu trong `then $1`).
    const weight = sql<number>`sum(case ${severity} when 'high' then ${sql.raw(String(SEVERITY_WEIGHT.high))} when 'medium' then ${sql.raw(String(SEVERITY_WEIGHT.medium))} else ${sql.raw(String(SEVERITY_WEIGHT.low))} end)::int`;
    const worst = await this.db
      .select({ sessionId: sessions.id, weight })
      .from(findings)
      .innerJoin(rules, eq(rules.id, findings.ruleId))
      .innerJoin(sessions, eq(sessions.id, findings.sessionId))
      .where(inWeek)
      .groupBy(sessions.id)
      .orderBy(desc(weight), desc(sql`max(${sessions.startedAt})`), desc(sessions.id))
      .limit(NEEDS_WORK_EXAMPLES * 3);

    const avg = sql<string>`avg(${sessionScores.score})`;
    const best = await this.db
      .select({ sessionId: sessions.id, avg })
      .from(sessions)
      .innerJoin(sessionScores, eq(sessionScores.sessionId, sessions.id))
      .where(inWeek)
      .groupBy(sessions.id)
      .having(sql`avg(${sessionScores.score}) >= ${GOOD_SCORE}`)
      .orderBy(desc(avg), desc(sessions.startedAt), desc(sessions.id))
      .limit(6);

    const ids = [...new Set([...worst, ...best].map((r) => r.sessionId))];
    if (ids.length === 0) return [];
    const prompts = await this.db
      .selectDistinctOn([turns.sessionId], {
        sessionId: turns.sessionId,
        seq: turns.seq,
        text: turns.text,
      })
      .from(turns)
      .where(
        and(
          inArray(turns.sessionId, ids),
          eq(turns.role, 'user'),
          eq(turns.kind, 'prompt'),
        ),
      )
      .orderBy(turns.sessionId, turns.seq);
    const promptOf = new Map(
      prompts
        .filter((p) => (p.text ?? '').trim().length >= MIN_PROMPT_CHARS)
        .map((p) => [p.sessionId, p]),
    );

    const out: ReportExampleInput[] = [];
    const used = new Set<string>();
    const take = (
      list: readonly { sessionId: string }[],
      kind: ReportExampleInput['kind'],
      limit: number,
    ) => {
      for (const { sessionId } of list) {
        if (limit === 0) break;
        const prompt = promptOf.get(sessionId);
        if (!prompt || used.has(sessionId)) continue;
        used.add(sessionId);
        out.push({
          sessionId,
          turnSeq: prompt.seq,
          kind,
          text: (prompt.text ?? '').normalize('NFC'),
        });
        limit -= 1;
      }
    };
    take(worst, 'needs_work', NEEDS_WORK_EXAMPLES);
    take(best, 'good', 1);
    return out;
  }

  /** Lưu bản đã chuẩn hóa (ví dụ do server điền) đè lên đầu ra thô của model rồi trả `AiResult`. */
  private async finish(
    row: AiResultRow,
    input: ReportInput,
  ): Promise<AiResult> {
    const parsed = reportSchema.safeParse(row.result);
    if (!parsed.success) return toAiResult(row);
    const normalized = normalizeReport(parsed.data, input);
    await this.db
      .update(aiResults)
      .set({ result: normalized })
      .where(eq(aiResults.id, row.id));
    return toAiResult({ ...row, result: normalized });
  }
}

const noWeekData = () =>
  new ApiError(
    409,
    'no_week_data',
    'Thành viên này chưa có session nào trong tuần đó.',
  );
