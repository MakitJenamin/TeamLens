import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditQueryService } from './audit-query.service.js';
import { RegexValidatorService } from './regex-validator.service.js';
import { ServerSettingsController } from './server-settings.controller.js';
import { ServerSettingsService } from './server-settings.service.js';

/** Audit toàn server (M4.5) và cài đặt server (M4.6). Xem README.md. */
@Module({
  controllers: [AuditController, ServerSettingsController],
  providers: [AuditQueryService, ServerSettingsService, RegexValidatorService],
})
export class AdminModule {}
