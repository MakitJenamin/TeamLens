import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditQueryService } from './audit-query.service.js';
import { RegexValidatorService } from './regex-validator.service.js';
import { ServerSettingsController } from './server-settings.controller.js';
import { ServerSettingsService } from './server-settings.service.js';
import { UserEraseController } from './user-erase.controller.js';
import { UserEraseService } from './user-erase.service.js';

/** Audit toàn server (M4.5), cài đặt server (M4.6), xóa dữ liệu một người (M5.6). Xem README.md. */
@Module({
  controllers: [AuditController, ServerSettingsController, UserEraseController],
  providers: [
    AuditQueryService,
    ServerSettingsService,
    RegexValidatorService,
    UserEraseService,
  ],
})
export class AdminModule {}
