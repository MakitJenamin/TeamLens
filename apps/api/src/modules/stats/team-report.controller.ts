import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { localeSchema } from '../skills/skills.schemas.js';
import { TeamReportService } from './team-report.service.js';

export const teamReportQuerySchema = z.object({
  // Thứ Hai của tuần; kiểm tra ngày hợp lệ, thứ Hai và không ở tương lai ở service.
  week: z.string().optional(),
  locale: localeSchema.default('vi'),
});

export const runTeamReportBodySchema = z.strictObject({
  locale: localeSchema,
  week: z.string().optional(),
});

/** B2 (M6.9; contract `stats.yaml`): báo cáo tuần của team do AI viết, chỉ leader. */
@Controller('api/v1/projects/:projectId/ai/weekly-report')
export class TeamReportController {
  constructor(
    @Inject(TeamReportService) private readonly reports: TeamReportService,
  ) {}

  @Get()
  saved(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: teamReportQuerySchema })
    query: z.infer<typeof teamReportQuerySchema>,
  ) {
    return this.reports.saved(user, projectId, query.week, query.locale);
  }

  @Post()
  @HttpCode(200)
  run(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body({ schema: runTeamReportBodySchema })
    body: z.infer<typeof runTeamReportBodySchema>,
  ) {
    const { locale, ...rest } = body;
    return this.reports.run(user, projectId, rest, locale);
  }
}
