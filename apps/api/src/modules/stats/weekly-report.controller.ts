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
import { WeeklyReportService } from './weekly-report.service.js';

export const weeklyReportQuerySchema = z.object({
  project: z.uuid('project phải là UUID'),
  // Thứ Hai của tuần; kiểm tra ngày hợp lệ, thứ Hai và không ở tương lai ở service.
  week: z.string().optional(),
  locale: localeSchema.default('vi'),
});

export const runWeeklyReportBodySchema = z.strictObject({
  project: z.uuid('project phải là UUID'),
  locale: localeSchema,
  week: z.string().optional(),
});

/** B1 (M6.8; contract `stats.yaml`): báo cáo tuần theo người do AI viết, và đọc lại kết quả của người gọi. */
@Controller('api/v1/users/:userId/ai/weekly-report')
export class WeeklyReportController {
  constructor(
    @Inject(WeeklyReportService) private readonly reports: WeeklyReportService,
  ) {}

  @Get()
  saved(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Query({ schema: weeklyReportQuerySchema })
    query: z.infer<typeof weeklyReportQuerySchema>,
  ) {
    const { locale, ...rest } = query;
    return this.reports.saved(user, userId, rest, locale);
  }

  @Post()
  @HttpCode(200)
  run(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Body({ schema: runWeeklyReportBodySchema })
    body: z.infer<typeof runWeeklyReportBodySchema>,
  ) {
    const { locale, ...rest } = body;
    return this.reports.run(user, userId, rest, locale);
  }
}
