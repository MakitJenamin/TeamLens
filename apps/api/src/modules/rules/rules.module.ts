import { Module } from '@nestjs/common';

import { FindingsController } from './findings.controller.js';
import { FindingsService } from './findings.service.js';
import { RerunController } from './rerun.controller.js';
import { RulesQueryService } from './rules-query.service.js';
import { RulesWriteService } from './rules-write.service.js';
import { RulesWorker } from './rules.worker.js';

@Module({
  controllers: [FindingsController, RerunController],
  providers: [
    RulesWorker,
    FindingsService,
    RulesQueryService,
    RulesWriteService,
  ],
  // Tool MCP (M6.15, M6.16) import các dịch vụ này, không sửa code module này.
  exports: [FindingsService, RulesQueryService, RulesWriteService],
})
export class RulesModule {}
