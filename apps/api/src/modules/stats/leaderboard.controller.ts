import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { ProjectAccess } from '../access/access.guards.js';
import { LeaderboardService } from './leaderboard.service.js';

const validDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Ngày không hợp lệ');

export const leaderboardQuerySchema = z.object({
  period: z.enum(['week', 'month']).default('week'),
  at: validDate.optional(),
  category: z.enum([
    'overall', 'prompt_quality', 'context', 'correction_loop', 'session_management', 'verification',
  ]).default('overall'),
});

@Controller('api/v1/projects/:projectId')
export class LeaderboardController {
  constructor(@Inject(LeaderboardService) private readonly leaderboard: LeaderboardService) {}

  @Get('leaderboard')
  @ProjectAccess()
  get(
    @CurrentUser() viewer: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: leaderboardQuerySchema }) query: z.infer<typeof leaderboardQuerySchema>,
  ) {
    return this.leaderboard.get(viewer, projectId, query);
  }
}
