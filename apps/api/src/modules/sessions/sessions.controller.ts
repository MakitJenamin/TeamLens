import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { ProjectRoles } from '../access/project-roles.guard.js';
import { AGENT_KINDS } from './session-mappers.js';
import { SessionsService } from './sessions.service.js';

const isoDateTime = z.iso
  .datetime({ offset: true, message: 'Phải là thời điểm ISO 8601' })
  .transform((value) => new Date(value));

export const listSessionsQuerySchema = z.object({
  userId: z.uuid('userId phải là UUID').optional(),
  agent: z.enum(AGENT_KINDS, 'agent không hợp lệ').optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  includeSubagents: z
    .enum(['true', 'false'], 'includeSubagents phải là true hoặc false')
    .optional()
    .transform((value) => value === 'true'),
  limit: z.coerce
    .number()
    .int('limit phải là số nguyên')
    .min(1)
    .max(100)
    .default(50),
  cursor: z.string().min(1).max(500).optional(),
});

/** Xem session trên dashboard: danh sách theo project và chi tiết (contract `sessions.yaml`). */
@Controller('api/v1')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('projects/:projectId/sessions')
  @ProjectRoles('leader', 'member')
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: listSessionsQuerySchema })
    query: z.infer<typeof listSessionsQuerySchema>,
  ) {
    return this.sessions.list(user, projectId, query);
  }

  @Get('sessions/:sessionId')
  get(@CurrentUser() user: AuthUser, @Param('sessionId') sessionId: string) {
    return this.sessions.get(user, sessionId);
  }
}
