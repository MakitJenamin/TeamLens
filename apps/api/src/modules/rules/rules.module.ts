import { Module } from '@nestjs/common';

import { FindingsController } from './findings.controller.js';
import { FindingsService } from './findings.service.js';
import { RerunController } from './rerun.controller.js';
import { RulesQueryService } from './rules-query.service.js';
import { RulesWorker } from './rules.worker.js';

@Module({
  controllers: [FindingsController, RerunController],
  providers: [RulesWorker, FindingsService, RulesQueryService],
  // Tool MCP (M6.15) import hai dịch vụ đọc này, không sửa code module này.
  exports: [FindingsService, RulesQueryService],
})
export class RulesModule {}
