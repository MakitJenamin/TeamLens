import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { LeaderOnly } from '../access/access.guards.js';
import { AuditQueryService } from './audit-query.service.js';

export const auditQuerySchema = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(20).max(100).default(20),
  action: z.string().min(1).max(100).optional(),
  actorId: z.uuid().optional(),
  targetType: z.string().min(1).max(100).optional(),
  targetId: z.string().min(1).max(200).optional(),
  from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to, 'from phải trước to');

@Controller('api/v1/audit')
export class AuditController {
  constructor(@Inject(AuditQueryService) private readonly audit: AuditQueryService) {}

  @Get()
  @LeaderOnly()
  list(@Query({ schema: auditQuerySchema }) query: z.infer<typeof auditQuerySchema>) {
    return this.audit.list(query);
  }
}
