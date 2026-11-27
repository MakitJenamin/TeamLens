import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../../common/api-error.js';
import { LeaderOnly } from '../access/access.guards.js';
import { isUuid } from '../access/access.service.js';
import { OverviewService } from './overview.service.js';

const isoDateTime = z.iso
  .datetime({ offset: true, message: 'Phải là thời điểm ISO 8601' })
  .transform((value) => new Date(value));

export const overviewQuerySchema = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/** Tổng quan project, chỉ leader (M2.9; contract `stats.yaml`). */
@Controller('api/v1/projects/:projectId')
export class OverviewController {
  constructor(
    @Inject(OverviewService) private readonly overview: OverviewService,
  ) {}

  @Get('overview')
  @LeaderOnly()
  get(
    @Param('projectId') projectId: string,
    @Query({ schema: overviewQuerySchema })
    query: z.infer<typeof overviewQuerySchema>,
  ) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    return this.overview.get(projectId, query);
  }
}
