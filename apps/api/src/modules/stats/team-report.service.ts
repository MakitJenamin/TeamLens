import { Inject, Injectable } from '@nestjs/common';
import type { AiResult, TeamReportSaved } from '@teamlens/schema';
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
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  aiResults,
  findings,
  projects,
  rules,
  sessions,
  userWeeklyStats,
  users,
} from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { llmError } from '../llm/llm-errors.js';
import { LlmService, toAiResult } from '../llm/llm.service.js';
import type { AiLocale, AiResultRow } from '../llm/llm.types.js';
import { mergeWeeklyScores, type StatsRow } from './overview-math.js';
import { weekWindow } from './refresh-weekly-stats.js';
import {
  normalizeTeamReport,
  type Scores,
  TEAM_REPORT_PROMPT_VERSION,
  TEAM_REPORT_SYSTEM,
  type TeamIssue,
  type TeamMember,
  type TeamReportInput,
  teamReportBlocks,
  teamReportSchema,
  teamWeekId,
} from './team-report-prompts.js';
import { parseWeekParam } from './week-param.js';

const DAY_MS = 86_400_000;
const MAX_ISSUES = 8;
const MAX_MEMBERS = 20;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const noWeekData = () =>
  new ApiError(409, 'no_week_data', 'Project này chưa có session nào trong tuần đó.');

/** Điểm tổng của một dòng thống kê: trung bình các nhóm có điểm (làm tròn), `null` khi chưa có điểm. */
function overallOf(scores: Record<string, number>): number | null {
  const values = Object.values(scores).filter((v) => typeof v === 'number');
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * B2 (M6.9): AI viết báo cáo tuần của team cho leader (key BYO của leader).
 *
 * AI chỉ nhận số liệu tổng hợp với mã ẩn danh (`m1`, `r1`): không có prompt, không có tên người, nên không ghi audit.
 * Kết quả AI chỉ gồm lời nhận xét và mã; tên, id, số liệu do server điền. Kết quả nêu tên thành viên nên M5.6 (xóa dữ
 * liệu một người) xóa các báo cáo có nhắc tới họ.
 */
@Injectable()
export class TeamReportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  async saved(
    viewer: AuthUser,
    projectId: string,
    week: string | undefined,
    locale: AiLocale,
  ): Promise<TeamReportSaved> {
    await this.assertLeaderOfProject(viewer, projectId);
    const resolved = await this.resolveWeek(projectId, week);
    if (!resolved) return { result: null };
    const rows = await this.llm.findResults(viewer.id, {
      subjectType: 'project_week',
      subjectIds: [teamWeekId(projectId, resolved)],
      kind: 'weekly_team',
      locale,
    });
    return { result: rows[0] ? toAiResult(rows[0]) : null };
  }

  async run(
    viewer: AuthUser,
    projectId: string,
    input: { week?: string },
    locale: AiLocale,
  ): Promise<AiResult> {
    await this.assertLeaderOfProject(viewer, projectId);
    // Kiểm key trước khi đụng dữ liệu.
    if (!(await this.llm.hasKey(viewer.id))) throw llmError('llm_key_missing');

    const week = await this.resolveWeek(projectId, input.week);
    if (!week) throw noWeekData();
    const data = await this.gather(projectId, week);
    if (data.current.sessions === 0) throw noWeekData();

    const row = await this.llm.run(viewer.id, {
      kind: 'weekly_team',
      subjectType: 'project_week',
      subjectId: teamWeekId(projectId, week),
      // Kết quả của cả team nên không gán chủ dữ liệu; M5.6 xóa theo nội dung (kết quả có nêu tên thành viên).
      subjectUserId: null,
      locale,
      promptVersion: TEAM_REPORT_PROMPT_VERSION,
      system: TEAM_REPORT_SYSTEM,
      untrusted: teamReportBlocks(data),
      schema: teamReportSchema,
      maxOutputTokens: 1500,
    });
    return this.finish(row, data);
  }

  /** Chỉ leader (403); project không có thì 404. */
  private async assertLeaderOfProject(
    viewer: AuthUser,
    projectId: string,
  ): Promise<void> {
    this.access.assertLeader(viewer);
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
  }

  /** `week` đã kiểm hợp lệ, hoặc tuần gần nhất mà project có session (`null` khi chưa có tuần nào). */
  private async resolveWeek(
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
          eq(userWeeklyStats.projectId, projectId),
          lte(userWeeklyStats.week, isoDay(current)),
          sql`${userWeeklyStats.sessions} > 0`,
        ),
      )
      .orderBy(desc(userWeeklyStats.week))
      .limit(1);
    return latest?.week ?? null;
  }

  private async gather(
    projectId: string,
    week: string,
  ): Promise<TeamReportInput> {
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
    const rowsOf = (w: string) => statRows.filter((r) => r.week === w);
    const numbers = (rows: StatsRow[]) => ({
      sessions: rows.reduce((sum, r) => sum + r.sessions, 0),
      tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
      scores: mergeWeeklyScores(rows) as Scores,
    });
    const thisRows = rowsOf(week);
    const previousNumbers = numbers(rowsOf(previousWeek));

    // Số session gốc thật của tuần (bảng thống kê có thể chậm hơn một nhịp so với session mới nhận).
    const inWeek = and(
      eq(sessions.projectId, projectId),
      isNull(sessions.parentSourceId),
      isNull(sessions.parentSessionId),
      gte(sessions.startedAt, start),
      lt(sessions.startedAt, end),
    );
    const [{ n: realSessions }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(inWeek);

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
    const issues = (await this.db
      .select({
        ruleKey: rules.key,
        category: rules.category,
        severity: sql<string>`case max(${rank}) when 3 then 'high' when 2 then 'medium' else 'low' end`,
        count,
        memberCount: sql<number>`count(distinct ${sessions.userId})::int`,
        advice: sql<string | null>`max(${rules.definition}->>'advice')`,
      })
      .from(findings)
      .innerJoin(rules, eq(rules.id, findings.ruleId))
      .innerJoin(sessions, eq(sessions.id, findings.sessionId))
      .where(inWeek)
      .groupBy(rules.key, rules.category)
      .orderBy(desc(count), asc(rules.key))
      .limit(MAX_ISSUES)) as TeamIssue[];

    // Thành viên có session trong tuần, nhiều session nhất trước.
    const activeRows = thisRows
      .filter((r) => r.sessions > 0)
      .sort((a, b) => b.sessions - a.sessions || (a.userId < b.userId ? -1 : 1))
      .slice(0, MAX_MEMBERS);
    const names =
      activeRows.length > 0
        ? await this.db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(
              inArray(
                users.id,
                activeRows.map((r) => r.userId),
              ),
            )
        : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const previousOf = new Map(
      rowsOf(previousWeek)
        .filter((r) => r.sessions > 0)
        .map((r) => [r.userId, overallOf(r.scores as Record<string, number>)]),
    );
    const members: TeamMember[] = activeRows.map((r) => {
      const overall = overallOf(r.scores as Record<string, number>);
      const previousOverall = previousOf.get(r.userId) ?? null;
      return {
        userId: r.userId,
        name: nameOf.get(r.userId) ?? '',
        sessions: r.sessions,
        overall,
        previousOverall,
        change:
          overall !== null && previousOverall !== null
            ? overall - previousOverall
            : null,
      };
    });

    return {
      week,
      current: {
        sessions: realSessions,
        tokens: thisRows.reduce((sum, r) => sum + r.tokens, 0),
        scores: mergeWeeklyScores(thisRows) as Scores,
        activeMembers: thisRows.filter((r) => r.sessions > 0).length,
      },
      previous: previousNumbers.sessions > 0 ? previousNumbers : null,
      issues,
      workTypes,
      members,
    };
  }

  /** Lưu bản đã chuẩn hóa (tên, id, số liệu do server điền) đè lên đầu ra thô của model rồi trả `AiResult`. */
  private async finish(
    row: AiResultRow,
    input: TeamReportInput,
  ): Promise<AiResult> {
    const parsed = teamReportSchema.safeParse(row.result);
    if (!parsed.success) return toAiResult(row);
    const normalized = normalizeTeamReport(parsed.data, input);
    await this.db
      .update(aiResults)
      .set({ result: normalized })
      .where(eq(aiResults.id, row.id));
    return toAiResult({ ...row, result: normalized });
  }
}
