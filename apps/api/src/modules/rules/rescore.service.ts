import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { ApiError, isUniqueViolation, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projectRescoreRuns, projects, sessions } from '../../db/schema/index.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import { AuditService } from '../access/audit.service.js';
import { isUuid } from '../access/access.service.js';
import { rescoreProject } from './score-session.js';

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

  async status(projectId: string) {
    await this.requireProject(projectId);
    const [run] = await this.db.select().from(projectRescoreRuns)
      .where(eq(projectRescoreRuns.projectId, projectId))
      .orderBy(desc(projectRescoreRuns.createdAt), desc(projectRescoreRuns.id)).limit(1);
    return run ?? null;
  }

  async enqueue(user: AuthUser, projectId: string) {
    await this.requireProject(projectId);
    const staleBefore = new Date(Date.now() - 60 * 60 * 1000);
    await this.db.update(projectRescoreRuns)
      .set({ status: 'failed', errorCode: 'rescore_stale', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projectRescoreRuns.projectId, projectId), inArray(projectRescoreRuns.status, ['queued', 'running']), lt(projectRescoreRuns.updatedAt, staleBefore)));
    let run: typeof projectRescoreRuns.$inferSelect;
    try {
      const totalRows = await this.db.select({ count: sql<number>`count(*)::int` }).from(sessions).where(eq(sessions.projectId, projectId));
      [run] = await this.db.insert(projectRescoreRuns).values({ projectId, totalSessions: totalRows[0].count }).returning();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'rescore_in_progress', 'Project đang được chấm lại');
      throw error;
    }
    try {
      await this.queue.send(JOBS.projectRescore, { projectId, runId: run.id });
    } catch (error) {
      await this.db.update(projectRescoreRuns).set({ status: 'failed', errorCode: 'queue_failed', finishedAt: new Date(), updatedAt: new Date() }).where(eq(projectRescoreRuns.id, run.id));
      throw error;
    }
    await this.audit.record(user.id, 'rules.rerun', 'project', projectId, this.db, undefined, { runId: run.id });
    return { status: 'queued' as const, runId: run.id };
  }

  async execute(projectId: string, runId: string) {
    const [run] = await this.db.update(projectRescoreRuns)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projectRescoreRuns.id, runId), eq(projectRescoreRuns.projectId, projectId), eq(projectRescoreRuns.status, 'queued')))
      .returning();
    if (!run) return;
    try {
      await rescoreProject(this.db, projectId, async (processed) => {
        await this.db.update(projectRescoreRuns)
          .set({ processedSessions: processed, updatedAt: new Date() })
          .where(eq(projectRescoreRuns.id, runId));
      });
      await this.db.update(projectRescoreRuns)
        .set({ status: 'succeeded', processedSessions: run.totalSessions, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectRescoreRuns.id, runId));
    } catch (error) {
      await this.db.update(projectRescoreRuns)
        .set({ status: 'failed', errorCode: 'rescore_failed', finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectRescoreRuns.id, runId));
      throw error;
    }
  }
}
