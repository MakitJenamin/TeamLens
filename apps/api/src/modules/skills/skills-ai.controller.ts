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
import { SkillsAiService } from './skills-ai.service.js';
import { isoDateTime, localeSchema } from './skills.schemas.js';

export const skillAiResultsQuerySchema = z.object({
  locale: localeSchema.default('vi'),
});

export const runSkillAiBodySchema = z.strictObject({
  locale: localeSchema,
  userId: z.uuid('userId phải là UUID').optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/** Nút AI của Skill Finder (M6.12; contract `skills.yaml`): S1 triage, S2 sinh SKILL.md, đọc lại kết quả của người gọi. */
@Controller('api/v1/projects/:projectId/skill-clusters/:clusterId')
export class SkillsAiController {
  constructor(@Inject(SkillsAiService) private readonly ai: SkillsAiService) {}

  @Get('ai')
  results(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('clusterId') clusterId: string,
    @Query({ schema: skillAiResultsQuerySchema })
    query: z.infer<typeof skillAiResultsQuerySchema>,
  ) {
    return this.ai.results(user, projectId, clusterId, query.locale);
  }

  @Post('ai/triage')
  @HttpCode(200)
  triage(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('clusterId') clusterId: string,
    @Body({ schema: runSkillAiBodySchema })
    body: z.infer<typeof runSkillAiBodySchema>,
  ) {
    const { locale, ...filters } = body;
    return this.ai.triage(user, projectId, clusterId, filters, locale);
  }

  @Post('ai/skill')
  @HttpCode(200)
  skill(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('clusterId') clusterId: string,
    @Body({ schema: runSkillAiBodySchema })
    body: z.infer<typeof runSkillAiBodySchema>,
  ) {
    const { locale, ...filters } = body;
    return this.ai.skill(user, projectId, clusterId, filters, locale);
  }
}
