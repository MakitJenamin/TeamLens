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
import type { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import {
  runSkillAiBodySchema,
  skillAiResultsQuerySchema,
} from './skills-ai.controller.js';
import { SkillsCatalogAiService } from './skills-catalog-ai.service.js';

/** S3 (M6.13; contract `skills.yaml`): AI chọn skill trong catalog cộng đồng, và đọc lại kết quả của người gọi. */
@Controller('api/v1/projects/:projectId/ai/catalog-picks')
export class SkillsCatalogAiController {
  constructor(
    @Inject(SkillsCatalogAiService)
    private readonly picks: SkillsCatalogAiService,
  ) {}

  @Get()
  saved(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: skillAiResultsQuerySchema })
    query: z.infer<typeof skillAiResultsQuerySchema>,
  ) {
    return this.picks.saved(user, projectId, query.locale);
  }

  @Post()
  @HttpCode(200)
  run(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body({ schema: runSkillAiBodySchema })
    body: z.infer<typeof runSkillAiBodySchema>,
  ) {
    const { locale, ...filters } = body;
    return this.picks.run(user, projectId, filters, locale);
  }
}
