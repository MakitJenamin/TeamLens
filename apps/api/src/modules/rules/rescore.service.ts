import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { ApiError, isUniqueViolation, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projectRescoreRuns, projects, rules, sessions } from '../../db/schema/index.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import { AuditService } from '../access/audit.service.js';
import { isUuid } from '../access/access.service.js';
import { rescoreProject } from './score-session.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Run = typeof projectRescoreRuns.$inferSelect;

/**
 * Lần chạy `queued`/`running` không cập nhật quá khoảng này coi như đã chết (tiến trình tắt giữa chừng).
 * Khi đang chạy, `execute` cập nhật `updated_at` mỗi {@link HEARTBEAT_MS} nên lần chạy sống không bị nhầm.
 */
export const RESCORE_STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

@Injectable()
export class RescoreService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async requireProject(projectId: string) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
  }

  /** Đánh `failed` (`rescore_stale`) các lần chạy chưa kết thúc mà quá lâu không cập nhật. */
  private async expireStale(db: Database | Tx, projectId: string) {
    const now = new Date();
    await db.update(projectRescoreRuns)
      .set({ status: 'failed', errorCode: 'rescore_stale', finishedAt: now, updatedAt: now })
      .where(and(eq(projectRescoreRuns.projectId, projectId), inArray(projectRescoreRuns.status, ['queued', 'running']),
        lt(projectRescoreRuns.updatedAt, new Date(now.getTime() - RESCORE_STALE_MS))));
  }

  async status(projectId: string) {
    await this.requireProject(projectId);
    // Đọc trạng thái cũng gỡ lần chạy đã chết, để nút "Chạy lại" trên UI mở lại.
    await this.expireStale(this.db, projectId);
    const [run] = await this.db.select().from(projectRescoreRuns)
      .where(eq(projectRescoreRuns.projectId, projectId))
      .orderBy(desc(projectRescoreRuns.createdAt), desc(projectRescoreRuns.id)).limit(1);
    return run ?? null;
  }

  /**
   * Tạo dòng `project_rescore_runs` (sau khi gỡ lần chạy đã chết). Có thể truyền transaction để tạo cùng thay đổi
   * rule. Project đang có lần chạy thì ném 409 `rescore_in_progress`. Gọi {@link dispatch} sau khi commit.
   */
  async createRun(projectId: string, db: Database | Tx = this.db): Promise<Run> {
    await this.expireStale(db, projectId);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(sessions).where(eq(sessions.projectId, projectId));
    try {
      // Savepoint: lỗi unique không làm hỏng transaction bên ngoài.
      return await db.transaction(async (inner) => {
        const [run] = await inner.insert(projectRescoreRuns).values({ projectId, totalSessions: count }).returning();
        return run;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'rescore_in_progress', 'Project đang được chấm lại');
      throw error;
    }
  }

  /** Phát job cho lần chạy vừa tạo; không phát được thì đánh `failed` (`queue_failed`). */
  async dispatch(run: Pick<Run, 'id' | 'projectId'>) {
    try {
      await this.queue.send(JOBS.projectRescore, { projectId: run.projectId, runId: run.id });
    } catch (error) {
      await this.db.update(projectRescoreRuns).set({ status: 'failed', errorCode: 'queue_failed', finishedAt: new Date(), updatedAt: new Date() }).where(eq(projectRescoreRuns.id, run.id));
      throw error;
    }
  }

  /** Nút "Chạy lại" trên dashboard. */
  async enqueue(user: AuthUser, projectId: string) {
    await this.requireProject(projectId);
    const run = await this.createRun(projectId);
    await this.dispatch(run);
    await this.audit.record(user.id, 'rules.rerun', 'project', projectId, this.db, { via: 'dashboard', runId: run.id });
    return { status: 'queued' as const, runId: run.id };
  }

  /**
   * Chấm lại sau khi tool MCP sửa rule: có dòng theo dõi như nút "Chạy lại". Project đang chấm lại thì trả
   * `in_progress` thay vì báo lỗi (thay đổi rule đã lưu): lần đang chạy xong sẽ tự xếp thêm một lần (xem
   * {@link execute}).
   */
  async enqueueAfterChange(user: AuthUser, projectId: string, via: string): Promise<'queued' | 'in_progress'> {
    let run: Run;
    try {
      run = await this.createRun(projectId);
    } catch (error) {
      if (error instanceof ApiError && error.getStatus() === 409) return 'in_progress';
      throw error;
    }
    await this.dispatch(run);
    await this.audit.record(user.id, 'rules.rerun', 'project', projectId, this.db, { via, runId: run.id });
    return 'queued';
  }

  async execute(projectId: string, runId: string) {
    const [run] = await this.db.update(projectRescoreRuns)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projectRescoreRuns.id, runId), eq(projectRescoreRuns.projectId, projectId), eq(projectRescoreRuns.status, 'queued')))
      .returning();
    if (!run) return;
    const active = and(eq(projectRescoreRuns.id, runId), eq(projectRescoreRuns.status, 'running'));
    // Nhịp sống: một lô 100 session có thể lâu hơn ngưỡng coi là chết. Tiến trình chết thì nhịp này dừng theo.
    const heartbeat = setInterval(() => {
      void this.db.update(projectRescoreRuns).set({ updatedAt: new Date() }).where(active).catch(() => undefined);
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await rescoreProject(this.db, projectId, async (processed) => {
        await this.db.update(projectRescoreRuns)
          .set({ processedSessions: processed, updatedAt: new Date() })
          .where(active);
      });
      await this.db.update(projectRescoreRuns)
        .set({ status: 'succeeded', processedSessions: run.totalSessions, finishedAt: new Date(), updatedAt: new Date() })
        .where(active);
    } catch (error) {
      clearInterval(heartbeat);
      await this.db.update(projectRescoreRuns)
        .set({ status: 'failed', errorCode: 'rescore_failed', finishedAt: new Date(), updatedAt: new Date() })
        .where(active);
      throw error;
    }
    clearInterval(heartbeat);
    await this.followUp(projectId, run.startedAt!);
  }

  /**
   * Rule của project bị sửa sau khi lần chạy bắt đầu (dashboard hoặc MCP) thì chưa chắc đã áp cho mọi session:
   * tự xếp thêm một lần. Dừng khi không còn thay đổi mới, nên không lặp vô hạn.
   */
  private async followUp(projectId: string, startedAt: Date) {
    const [changed] = await this.db.select({ id: rules.id }).from(rules)
      .where(and(eq(rules.projectId, projectId), gte(rules.updatedAt, startedAt))).limit(1);
    if (!changed) return;
    try {
      await this.dispatch(await this.createRun(projectId));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
}
