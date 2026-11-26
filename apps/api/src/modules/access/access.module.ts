import { Global, Module } from '@nestjs/common';
import { LeaderGuard, ProjectAccessGuard } from './access.guards.js';
import { AccessService } from './access.service.js';
import { AuditService } from './audit.service.js';

/** Phân quyền + audit, dùng chung cho mọi module. */
@Global()
@Module({
  providers: [AccessService, AuditService, LeaderGuard, ProjectAccessGuard],
  exports: [AccessService, AuditService, LeaderGuard, ProjectAccessGuard],
})
export class AccessModule {}
