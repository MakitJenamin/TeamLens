import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditQueryService } from './audit-query.service.js';

/** Module rỗng, đã đăng ký sẵn trong AppModule. Xem README.md. */
@Module({ controllers: [AuditController], providers: [AuditQueryService] })
export class AdminModule {}
