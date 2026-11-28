import { Module } from '@nestjs/common';

import { FindingsController } from './findings.controller.js';
import { FindingsService } from './findings.service.js';
import { RerunController } from './rerun.controller.js';
import { RulesQueryService } from './rules-query.service.js';
import { RulesWriteService } from './rules-write.service.js';
import { RulesWorker } from './rules.worker.js';
import { RescoreService } from './rescore.service.js';
import { RuleConfigController } from './rule-config.controller.js';
import { RuleConfigService } from './rule-config.service.js';

@Module({
  controllers: [FindingsController, RerunController, RuleConfigController],
  providers: [
    RulesWorker,
    FindingsService,
    RulesQueryService,
    RulesWriteService,
    RescoreService,
    RuleConfigService,
  ],
  // Tool MCP (M6.15, M6.16) dùng các dịch vụ đọc và ghi rule.
  exports: [FindingsService, RulesQueryService, RulesWriteService],
})
export class RulesModule {}
