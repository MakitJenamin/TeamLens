import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { SkillClusterList } from '@teamlens/schema';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
} from 'drizzle-orm';
import { ApiError, forbidden, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projects, sessions, turns, users } from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import {
  clusterPrompts,
  MAX_CLUSTERS,
  type PromptInput,
} from './prompt-clusterer.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 90;
/** Dung sai khi so với giới hạn 90 ngày: `from = bây giờ - 90 ngày` với `to` mặc định (bây giờ, muộn hơn vài mili giây) vẫn hợp lệ. */
const RANGE_SLACK_MS = 60 * 1000;
/** Số prompt tối đa được xét; vượt thì lấy các prompt mới nhất và báo `truncated`. */
export const MAX_PROMPTS = 20000;
export const DEFAULT_LIMIT = 50;
const TOP_USERS = 5;

export interface ListSkillClustersQuery {
  userId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * UUID ổn định của một cụm: sinh từ project và dấu vân tay (không từ bộ lọc người hay khoảng thời gian), để nút AI
 * ở M6.12 dùng làm `subjectId` và vẫn trỏ đúng cụm ở các lần xem sau.
 */
export function clusterIdOf(projectId: string, fingerprint: string): string {
  const bytes = createHash('sha256')
    .update(`skill-cluster|${projectId}|${fingerprint}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // phiên bản 5 (UUID sinh từ tên)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface CollectedPrompts {
  /** Chủ prompt khi bị giới hạn theo một người (member hoặc `userId`), `undefined` khi leader xem cả team. */
  owner: string | undefined;
  from: Date;
  to: Date;
  truncated: boolean;
  inputs: PromptInput[];
}

const invalidRange = (message: string) =>
  new ApiError(400, 'validation_error', message);

/**
 * Skill Finder S0 (M6.11, contract `skills.yaml`): các cụm prompt lặp lại của project, không gọi LLM.
 *
 * Quyền giống dashboard: leader thấy cả team (xem dữ liệu người khác ghi audit `skill_clusters.view`), member chỉ
 * thấy prompt của mình. Chỉ xét prompt của session gốc. Nội dung prompt không bao giờ được log.
 */
@Injectable()
export class SkillsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Project phải tồn tại (404) và người xem phải vào được project đó (403). */
  async assertProjectAccess(viewer: AuthUser, projectId: string): Promise<void> {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    if (!(await this.access.canAccessProject(viewer, projectId))) {
      throw forbidden();
    }
  }

  /**
   * Kiểm tra quyền và khoảng thời gian rồi lấy các prompt người xem được (session gốc, role user, kind prompt).
   * Dùng chung cho danh sách cụm và các nút AI (S1, S2) để hai nơi luôn dựng ra đúng cùng một tập prompt.
   */
  async collect(
    viewer: AuthUser,
    projectId: string,
    query: Pick<ListSkillClustersQuery, 'userId' | 'from' | 'to'>,
    now = new Date(),
  ): Promise<CollectedPrompts> {
    await this.assertProjectAccess(viewer, projectId);

    let owner = query.userId;
    if (owner !== undefined) {
      if (!this.access.canViewUserData(viewer, owner)) throw forbidden();
    } else if (!this.access.isLeader(viewer)) {
      owner = viewer.id; // member: chỉ prompt của chính mình
    }

    const to = query.to ?? now;
    const from = query.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    if (from.getTime() >= to.getTime()) {
      throw invalidRange('`from` phải trước `to`.');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS + RANGE_SLACK_MS) {
      throw invalidRange(`Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày.`);
    }

    const rows = await this.db
      .select({
        userId: sessions.userId,
        sessionId: turns.sessionId,
        turnSeq: turns.seq,
        ts: turns.ts,
        text: turns.text,
      })
      .from(turns)
      .innerJoin(sessions, eq(sessions.id, turns.sessionId))
      .where(
        and(
          eq(sessions.projectId, projectId),
          // Prompt trong session con do agent viết, không phải người dùng (SPEC 9.1).
          isNull(sessions.parentSourceId),
          isNull(sessions.parentSessionId),
          eq(turns.role, 'user'),
          eq(turns.kind, 'prompt'),
          isNotNull(turns.text),
          gte(turns.ts, from),
          lt(turns.ts, to),
          owner ? eq(sessions.userId, owner) : undefined,
        ),
      )
      .orderBy(desc(turns.ts))
      .limit(MAX_PROMPTS + 1);
    return {
      owner,
      from,
      to,
      truncated: rows.length > MAX_PROMPTS,
      inputs: rows.slice(0, MAX_PROMPTS).map((r) => ({
        userId: r.userId,
        sessionId: r.sessionId,
        turnSeq: r.turnSeq,
        ts: r.ts,
        text: r.text ?? '',
      })),
    };
  }

  async list(
    viewer: AuthUser,
    projectId: string,
    query: ListSkillClustersQuery,
    now = new Date(),
  ): Promise<SkillClusterList> {
    const { owner, from, to, truncated, inputs } = await this.collect(
      viewer,
      projectId,
      query,
      now,
    );
    const result = clusterPrompts(inputs, {
      maxClusters: Math.min(query.limit ?? DEFAULT_LIMIT, MAX_CLUSTERS),
    });

    const topUsers = result.clusters.map((c) => c.users.slice(0, TOP_USERS));
    const userIds = [
      ...new Set([
        ...topUsers.flatMap((list) => list.map((u) => u.userId)),
        ...result.clusters.flatMap((c) => c.examples.map((e) => e.userId)),
      ]),
    ];
    const names = new Map<string, string>();
    if (userIds.length > 0) {
      const found = await this.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds));
      for (const u of found) names.set(u.id, u.name);
    }

    // Leader xem prompt của người khác: ghi audit như khi mở session của họ.
    if (this.access.isLeader(viewer) && owner !== viewer.id) {
      await this.audit.record(
        viewer.id,
        'skill_clusters.view',
        'project',
        projectId,
      );
    }

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      stats: {
        promptsAnalyzed: result.promptsAnalyzed,
        promptsClustered: result.promptsClustered,
        clusterCount: result.clusterCount,
        truncated,
      },
      clusters: result.clusters.map((cluster, i) => ({
        id: clusterIdOf(projectId, cluster.fingerprint),
        label: cluster.label,
        count: cluster.count,
        userCount: cluster.userCount,
        firstSeenAt: cluster.firstSeenAt.toISOString(),
        lastSeenAt: cluster.lastSeenAt.toISOString(),
        users: topUsers[i].map((u) => ({
          userId: u.userId,
          name: names.get(u.userId) ?? 'Không rõ',
          count: u.count,
        })),
        examples: cluster.examples.map((e) => ({
          sessionId: e.sessionId,
          turnSeq: e.turnSeq,
          ts: e.ts.toISOString(),
          userId: e.userId,
          excerpt: e.excerpt,
        })),
      })),
    };
  }
}
