import { Inject, Injectable } from '@nestjs/common';
import type {
  AgentKind,
  SessionDetail,
  SessionPage,
  SessionSummary,
} from '@teamlens/schema';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  type SQL,
  sql,
} from 'drizzle-orm';
import { forbidden, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  devices,
  projects,
  sessions,
  turns,
  users,
} from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import {
  decodeCursor,
  encodeCursor,
  mapTurn,
  toAgentKind,
  toPermissionMode,
} from './session-mappers.js';

export interface ListSessionsQuery {
  userId?: string;
  agent?: AgentKind;
  from?: Date;
  to?: Date;
  includeSubagents: boolean;
  /** Từ khóa full-text (đã trim, 1–200 ký tự). Là nội dung prompt: không log. */
  q?: string;
  limit: number;
  cursor?: string;
}

const sessionNotFound = () => notFound('Không tìm thấy session');

/**
 * tsquery của từ khóa tìm kiếm, cú pháp kiểu web search, cấu hình `simple` khớp với cột `turns.tsv`.
 * `q` luôn đi qua tham số bind. Nếu `q` không còn từ nào (chỉ dấu câu), tsquery rỗng không khớp
 * turn nào nên danh sách rỗng.
 */
const tsQuery = (q: string) => sql`websearch_to_tsquery('simple', ${q})`;

/** Đoạn trích quanh từ khóa; từ khớp bao bởi «…» (client tự đánh dấu, không render HTML). */
const HEADLINE_OPTIONS = 'MaxWords=20, MinWords=8, StartSel=«, StopSel=»';

/** Gộp khoảng trắng (xuống dòng, tab) để đoạn trích hiển thị gọn trên một dòng. */
export function normalizeSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

/** Cột dùng chung cho danh sách và chi tiết. */
const summaryColumns = {
  id: sessions.id,
  projectId: sessions.projectId,
  userId: sessions.userId,
  userEmail: users.email,
  userName: users.name,
  agent: sessions.agent,
  agentVersion: sessions.agentVersion,
  repoRemote: sessions.repoRemote,
  branch: sessions.branch,
  cwdRelative: sessions.cwdRelative,
  startedAt: sessions.startedAt,
  // Đủ micro giây để cursor so sánh chính xác (Date của JS chỉ giữ mili giây).
  startedAtExact: sql<string>`to_char(${sessions.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  endedAt: sessions.endedAt,
  turnCount: sessions.turnCount,
  inputTokens: sessions.inputTokens,
  outputTokens: sessions.outputTokens,
  cacheReadTokens: sessions.cacheReadTokens,
  cacheWriteTokens: sessions.cacheWriteTokens,
  parentSessionId: sessions.parentSessionId,
  // Số session con đã gắn vào session này (alias `c` để tham chiếu được session ngoài).
  childCount: sql<number>`(
    SELECT count(*)::int FROM ${sessions} c WHERE c.parent_session_id = ${sessions.id}
  )`,
  permissionMode: sessions.permissionMode,
  // Model xuất hiện nhiều nhất ở turn của assistant.
  model: sql<string | null>`(
    SELECT t.model FROM ${turns} t
    WHERE t.session_id = ${sessions.id} AND t.role = 'assistant' AND t.model IS NOT NULL
    GROUP BY t.model ORDER BY count(*) DESC, t.model LIMIT 1
  )`,
  // Prompt đầu tiên của user, tối đa 200 ký tự.
  title: sql<string | null>`(
    SELECT left(t.text, 200) FROM ${turns} t
    WHERE t.session_id = ${sessions.id} AND t.role = 'user' AND t.kind = 'prompt' AND t.text IS NOT NULL
    ORDER BY t.seq LIMIT 1
  )`,
};

interface SummaryRow {
  id: string;
  projectId: string;
  userId: string;
  userEmail: string | null;
  userName: string;
  agent: string;
  agentVersion: string | null;
  repoRemote: string;
  branch: string | null;
  cwdRelative: string | null;
  startedAt: Date;
  endedAt: Date | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  parentSessionId: string | null;
  childCount: number;
  permissionMode: string | null;
  model: string | null;
  title: string | null;
}

function toSummary(row: SummaryRow): SessionSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    user: { id: row.userId, email: row.userEmail, name: row.userName },
    agent: toAgentKind(row.agent),
    agentVersion: row.agentVersion,
    model: row.model,
    repoRemote: row.repoRemote,
    branch: row.branch,
    cwdRelative: row.cwdRelative,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    turnCount: row.turnCount,
    usage: {
      input: Number(row.inputTokens),
      output: Number(row.outputTokens),
      cacheRead: Number(row.cacheReadTokens),
      cacheWrite: Number(row.cacheWriteTokens),
    },
    title: row.title,
    parentSessionId: row.parentSessionId,
    childCount: Number(row.childCount ?? 0),
    permissionMode: toPermissionMode(row.permissionMode),
  };
}

/** Xem session trên dashboard (spec 7.4, 11.1). Mọi kiểm tra quyền đi qua `AccessService`. */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Danh sách session của project (người gọi đã qua `@ProjectAccess()`).
   * Leader thấy mọi session; member chỉ thấy của mình, lọc `userId` người khác trả 403.
   */
  async list(
    viewer: AuthUser,
    projectId: string,
    query: ListSessionsQuery,
  ): Promise<SessionPage> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound('Không tìm thấy project');

    let ownerFilter: string | undefined = query.userId;
    if (ownerFilter !== undefined) {
      if (!this.access.canViewUserData(viewer, ownerFilter)) throw forbidden();
    } else if (!this.access.isLeader(viewer)) {
      // Member: chỉ thấy session của chính mình.
      ownerFilter = viewer.id;
    }

    const conditions: SQL[] = [eq(sessions.projectId, projectId)];
    if (ownerFilter) conditions.push(eq(sessions.userId, ownerFilter));
    if (query.agent) conditions.push(eq(sessions.agent, query.agent));
    if (query.from) conditions.push(gte(sessions.startedAt, query.from));
    if (query.to) conditions.push(lt(sessions.startedAt, query.to));
    if (!query.includeSubagents) {
      // Session con có `parent_source_id`; vẫn ẩn khi cha chưa tới (parent_session_id còn null).
      conditions.push(isNull(sessions.parentSessionId));
      conditions.push(isNull(sessions.parentSourceId));
    }
    if (query.q !== undefined) {
      const tsq = tsQuery(query.q);
      // Khớp ở turn của chính session, hoặc của session con trực tiếp (để mặc định
      // includeSubagents=false vẫn tìm thấy session gốc khi từ khóa nằm trong subagent).
      conditions.push(sql`(
        EXISTS (
          SELECT 1 FROM ${turns} t
          WHERE t.session_id = ${sessions.id} AND t.tsv @@ ${tsq}
        )
        OR EXISTS (
          SELECT 1 FROM ${sessions} c JOIN ${turns} t ON t.session_id = c.id
          WHERE c.parent_session_id = ${sessions.id} AND t.tsv @@ ${tsq}
        )
      )`);
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      conditions.push(
        sql`(${sessions.startedAt}, ${sessions.id}) < (${cursor.startedAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = await this.db
      .select(summaryColumns)
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(...conditions))
      .orderBy(desc(sessions.startedAt), desc(sessions.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    let items = page.map(toSummary);
    if (query.q !== undefined) {
      const matches = await this.findMatches(
        query.q,
        page.map((row) => row.id),
      );
      items = items.map((item) => ({
        ...item,
        match: matches.get(item.id) ?? null,
      }));
    }
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ startedAt: last.startedAtExact, id: last.id })
          : null,
    };
  }

  /**
   * Turn khớp đầu tiên (theo `seq`) và đoạn trích cho các session của trang hiện tại.
   * `ts_headline` chỉ chạy trên đúng một turn mỗi session, không trên mọi turn khớp.
   */
  private async findMatches(
    q: string,
    sessionIds: string[],
  ): Promise<Map<string, { turnSeq: number; snippet: string }>> {
    const result = new Map<string, { turnSeq: number; snippet: string }>();
    if (sessionIds.length === 0) return result;
    const tsq = tsQuery(q);
    const rows = await this.db
      .select({
        sessionId: turns.sessionId,
        seq: turns.seq,
        snippet: sql<string>`ts_headline('simple', coalesce(${turns.text}, ''), ${tsq}, ${HEADLINE_OPTIONS})`,
      })
      .from(turns)
      .where(
        and(
          inArray(turns.sessionId, sessionIds),
          sql`${turns.seq} = (
            SELECT min(t2.seq) FROM ${turns} t2
            WHERE t2.session_id = ${turns.sessionId} AND t2.tsv @@ ${tsq}
          )`,
        ),
      );
    for (const row of rows) {
      if (!result.has(row.sessionId))
        result.set(row.sessionId, {
          turnSeq: row.seq,
          snippet: normalizeSnippet(row.snippet),
        });
    }
    return result;
  }

  /** Chi tiết session kèm turn theo `seq`. Xem session của người khác ghi audit `session.view`. */
  async get(viewer: AuthUser, sessionId: string): Promise<SessionDetail> {
    if (!isUuid(sessionId)) throw sessionNotFound();
    const [row] = await this.db
      .select({
        ...summaryColumns,
        sourceId: sessions.sourceId,
        instructionFiles: sessions.instructionFiles,
        deviceId: devices.id,
        deviceName: devices.name,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .leftJoin(devices, eq(devices.id, sessions.deviceId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) throw sessionNotFound();

    if (!this.access.canViewUserData(viewer, row.userId)) throw forbidden();
    if (viewer.id !== row.userId)
      await this.audit.record(viewer.id, 'session.view', 'session', row.id);

    const [children, turnRows] = await Promise.all([
      this.db
        .select({
          id: sessions.id,
          sourceId: sessions.sourceId,
          agent: sessions.agent,
          startedAt: sessions.startedAt,
          endedAt: sessions.endedAt,
          turnCount: sessions.turnCount,
          title: summaryColumns.title,
        })
        .from(sessions)
        .where(eq(sessions.parentSessionId, row.id))
        .orderBy(asc(sessions.startedAt), asc(sessions.id)),
      this.db
        .select({
          seq: turns.seq,
          role: turns.role,
          kind: turns.kind,
          ts: turns.ts,
          model: turns.model,
          text: turns.text,
          tool: turns.tool,
          output: turns.output,
          diff: turns.diff,
          usage: turns.usage,
          attachments: turns.attachments,
          redactions: turns.redactions,
          interrupted: turns.interrupted,
          reasoningEffort: turns.reasoningEffort,
        })
        .from(turns)
        .where(eq(turns.sessionId, row.id))
        .orderBy(asc(turns.seq)),
    ]);

    return {
      ...toSummary(row),
      sourceId: row.sourceId,
      device:
        row.deviceId && row.deviceName
          ? { id: row.deviceId, name: row.deviceName }
          : null,
      instructionFiles: row.instructionFiles ?? null,
      childSessionIds: children.map((c) => c.id),
      children: children.map((c) => ({
        id: c.id,
        sourceId: c.sourceId,
        agent: toAgentKind(c.agent),
        title: c.title,
        startedAt: c.startedAt.toISOString(),
        endedAt: c.endedAt ? c.endedAt.toISOString() : null,
        turnCount: c.turnCount,
      })),
      turns: turnRows.map(mapTurn),
    };
  }
}
