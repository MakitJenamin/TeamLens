import { Module } from '@nestjs/common';

import { FindingsController } from './findings.controller.js';
import { RerunController } from './rerun.controller.js';
import { RulesWorker } from './rules.worker.js';
import { RescoreService } from './rescore.service.js';
import { RuleConfigController } from './rule-config.controller.js';
import { RuleConfigService } from './rule-config.service.js';

@Module({
  controllers: [FindingsController, RerunController, RuleConfigController],
  providers: [RulesWorker, RescoreService, RuleConfigService],
})
export class RulesModule {}
