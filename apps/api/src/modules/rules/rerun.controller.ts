import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { LeaderOnly } from '../access/access.guards.js';
import { RescoreService } from './rescore.service.js';

/** M2.8: leader bấm "Chạy lại" sau khi đổi rule. Việc chấm lại chạy ở nền (job `project.rescore`). */
@Controller('api/v1/projects/:projectId/rules')
export class RerunController {
  constructor(
    @Inject(RescoreService) private readonly rescore: RescoreService,
  ) {}

  @Post('rerun')
  @LeaderOnly()
  @HttpCode(202)
  async rerun(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
  ) {
    return this.rescore.enqueue(user, projectId);
  }

  @Get('rerun/status')
  @LeaderOnly()
  status(@Param('projectId') projectId: string) {
    return this.rescore.status(projectId);
  }
}
