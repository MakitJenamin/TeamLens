import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service.js';
import { AuditService } from './audit.service.js';
import { ProjectRolesGuard } from './project-roles.guard.js';

/** Phân quyền + audit, dùng chung cho mọi module. */
@Global()
@Module({
  providers: [AccessService, AuditService, ProjectRolesGuard],
  exports: [AccessService, AuditService, ProjectRolesGuard],
})
export class AccessModule {}
