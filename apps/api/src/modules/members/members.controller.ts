import { Controller, Get, Inject, Param } from '@nestjs/common';
import { notFound } from '../../common/api-error.js';
import { LeaderOnly } from '../access/access.guards.js';
import { isUuid } from '../access/access.service.js';
import { MembersService } from './members.service.js';

/** Trang Thành viên, chỉ leader (M4.2; contract `members.yaml`). */
@Controller('api/v1/projects/:projectId')
export class MembersController {
  constructor(
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  @Get('member-status')
  @LeaderOnly()
  list(@Param('projectId') projectId: string) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    return this.members.listStatus(projectId);
  }
}
