import { Module } from '@nestjs/common';

import { FindingsController } from './findings.controller.js';
import { RerunController } from './rerun.controller.js';
import { RulesWorker } from './rules.worker.js';

@Module({
  controllers: [FindingsController, RerunController],
  providers: [RulesWorker],
})
export class RulesModule {}
