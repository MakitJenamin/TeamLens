import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { forbidden, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  findings,
  projectMembers,
  projects,
  rules,
  sessions,
  turns,
  userWeeklyStats,
  users,
} from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { normalizeRange, type StatsRow } from './overview-math.js';
import {
  buildProfile,
  type ExampleRow,
  MAX_EXAMPLES,
  MAX_PATTERNS,
  type MemberProfile,
  type PatternRow,
  PROFILE_DEFAULT_WEEKS,
} from './profile-math.js';

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const EXCERPT_LENGTH = 160;

/** Hồ sơ thành viên (M2.10, contract `stats.yaml`). */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get(
    viewer: AuthUser,
    userId: string,
    query: { project: string; from?: Date; to?: Date },
    now = new Date(),
  ): Promise<MemberProfile> {
    if (!isUuid(userId)) throw notFound('Không tìm thấy thành viên');
    // Member chỉ xem hồ sơ của chính mình; kiểm tra trước để không lộ ai có tồn tại hay không.
    if (!this.access.canViewUserData(viewer, userId)) throw forbidden();

    const { project: projectId } = query;
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    if (!(await this.access.canAccessProject(viewer, projectId)))
      throw forbidden();

    const [member] = await this.db
      .select({ id: users.id, name: users.name })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      );
    if (!member) throw notFound('Không tìm thấy thành viên trong project');

    const range = normalizeRange(
      query.from,
      query.to,
      now,
      PROFILE_DEFAULT_WEEKS,
    );

    // Xem nội dung (đoạn trích prompt) của người khác thì ghi audit, như khi xem session.
    if (viewer.id !== userId)
      await this.audit.record(viewer.id, 'profile.view', 'user', userId);

    const teamRows = (await this.db
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
          gte(userWeeklyStats.week, isoDay(range.from)),
          lt(userWeeklyStats.week, isoDay(range.to)),
        ),
      )) as StatsRow[];
    const memberRows = teamRows.filter((row) => row.userId === userId);

    const inRange = and(
      eq(sessions.projectId, projectId),
      eq(sessions.userId, userId),
      gte(sessions.startedAt, range.from),
      lt(sessions.startedAt, range.to),
    );

    // Mức nặng nhất của rule trong khoảng (finding cũ có thể lưu mức khác nhau).
    const severityRank = sql`case coalesce(${findings.evidence}->>'severity', ${rules.severity})
      when 'high' then 3 when 'medium' then 2 else 1 end`;
    const count = sql<number>`count(*)::int`;
    const patternRows = await this.db
      .select({
        ruleKey: rules.key,
        category: rules.category,
        severity: sql<
          'low' | 'medium' | 'high'
        >`case max(${severityRank}) when 3 then 'high' when 2 then 'medium' else 'low' end`,
        count,
        advice: sql<string | null>`max(${rules.definition}->>'advice')`,
      })
      .from(findings)
      .innerJoin(rules, eq(rules.id, findings.ruleId))
      .innerJoin(sessions, eq(sessions.id, findings.sessionId))
      .where(inRange)
      .groupBy(rules.key, rules.category)
      .orderBy(desc(count), asc(rules.key))
      .limit(MAX_PATTERNS);

    let examples: ExampleRow[] = [];
    if (patternRows.length > 0) {
      // Xếp hạng ví dụ theo rule, mới nhất trước, rồi chỉ lấy MAX_EXAMPLES đầu mỗi rule.
      const rank = sql<number>`row_number() over (
        partition by ${rules.key} order by ${sessions.startedAt} desc, ${findings.turnSeq}
      )`.as('rank');
      const ranked = this.db
        .select({
          ruleKey: rules.key,
          sessionId: findings.sessionId,
          turnSeq: findings.turnSeq,
          message: sql<string | null>`${findings.evidence}->>'message'`.as(
            'message',
          ),
          excerpt: sql<
            string | null
          >`left(coalesce(nullif(${turns.text}, ''), ${turns.diff}->>'path'), ${sql.raw(String(EXCERPT_LENGTH))})`.as(
            'excerpt',
          ),
          rank,
        })
        .from(findings)
        .innerJoin(rules, eq(rules.id, findings.ruleId))
        .innerJoin(sessions, eq(sessions.id, findings.sessionId))
        .leftJoin(
          turns,
          and(
            eq(turns.sessionId, findings.sessionId),
            eq(turns.seq, findings.turnSeq),
          ),
        )
        .where(
          and(
            inRange,
            inArray(
              rules.key,
              patternRows.map((row) => row.ruleKey),
            ),
          ),
        )
        .as('ranked');
      const rows = await this.db
        .select()
        .from(ranked)
        .where(lte(ranked.rank, MAX_EXAMPLES))
        .orderBy(asc(ranked.ruleKey), asc(ranked.rank));
      examples = rows.map((row) => ({
        ruleKey: row.ruleKey,
        sessionId: row.sessionId,
        turnSeq: row.turnSeq,
        message: row.message ?? '',
        excerpt: row.excerpt,
      }));
    }

    return buildProfile({
      user: { id: member.id, name: member.name },
      projectId,
      range,
      memberRows,
      teamRows,
      patterns: patternRows as PatternRow[],
      examples,
    });
  }
}
