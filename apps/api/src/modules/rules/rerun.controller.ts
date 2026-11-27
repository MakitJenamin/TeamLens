import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { notFound } from '../../common/api-error.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projects } from '../../db/schema/index.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import { LeaderOnly } from '../access/access.guards.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';

/** M2.8: leader bấm "Chạy lại" sau khi đổi rule. Việc chấm lại chạy ở nền (job `project.rescore`). */
@Controller('api/v1/projects/:projectId/rules')
export class RerunController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post('rerun')
  @LeaderOnly()
  @HttpCode(202)
  async rerun(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
  ) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    await this.queue.send(JOBS.projectRescore, { projectId });
    await this.audit.record(user.id, 'rules.rerun', 'project', projectId);
    return { status: 'queued' as const };
  }
}
