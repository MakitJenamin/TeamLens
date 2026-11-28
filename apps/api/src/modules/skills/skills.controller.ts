import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { DEFAULT_LIMIT, SkillsService } from './skills.service.js';

const isoDateTime = z.iso
  .datetime({ offset: true, message: 'Phải là thời điểm ISO 8601' })
  .transform((value) => new Date(value));

export const listSkillClustersQuerySchema = z.object({
  userId: z.uuid('userId phải là UUID').optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.coerce
    .number()
    .int('limit phải là số nguyên')
    .min(1)
    .max(200)
    .default(DEFAULT_LIMIT),
});

/** Skill Finder S0 (M6.11; contract `skills.yaml`): cụm prompt lặp lại của project. */
@Controller('api/v1/projects/:projectId')
export class SkillsController {
  constructor(@Inject(SkillsService) private readonly skills: SkillsService) {}

  @Get('skill-clusters')
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: listSkillClustersQuerySchema })
    query: z.infer<typeof listSkillClustersQuerySchema>,
  ) {
    return this.skills.list(user, projectId, query);
  }
}
