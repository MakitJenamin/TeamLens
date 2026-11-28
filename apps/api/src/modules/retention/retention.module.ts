import { Module } from '@nestjs/common';
import { RetentionWorker } from './retention.worker.js';

/** Job retention hằng đêm (M5.5). Xem README.md. */
@Module({
  providers: [RetentionWorker],
})
export class RetentionModule {}
