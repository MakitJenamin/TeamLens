import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { LeaderOnly } from '../access/access.guards.js';
import { RuleConfigService } from './rule-config.service.js';

const patchRuleSchema = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  thresholds: z.record(z.string(), z.number().finite()).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Cần ít nhất một thay đổi');

@Controller('api/v1/projects/:projectId/rules')
export class RuleConfigController {
  constructor(@Inject(RuleConfigService) private readonly config: RuleConfigService) {}

  @Get()
  @LeaderOnly()
  list(@Param('projectId') projectId: string) {
    return this.config.list(projectId);
  }

  @Patch(':key')
  @LeaderOnly()
  update(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string,
    @Param('key') key: string, @Body({ schema: patchRuleSchema }) body: z.infer<typeof patchRuleSchema>) {
    return this.config.update(user, projectId, key, body);
  }

  @Delete(':key/override')
  @LeaderOnly()
  @HttpCode(202)
  restore(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string, @Param('key') key: string) {
    return this.config.restore(user, projectId, key);
  }

  @Post(':key/test')
  @LeaderOnly()
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string, @Param('key') key: string) {
    return this.config.test(user, projectId, key);
  }
}
