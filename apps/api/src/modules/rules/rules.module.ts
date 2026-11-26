import { Module } from '@nestjs/common';

import { FindingsController } from './findings.controller.js';
import { RulesWorker } from './rules.worker.js';

@Module({ controllers: [FindingsController], providers: [RulesWorker] })
export class RulesModule {}
