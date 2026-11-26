import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestRateLimiter } from './rate-limiter.js';

/** Endpoint cho CLI: ingest (M1.6); sau này thêm config (M2.2), heartbeat (M3.3). Xem README.md. */
@Module({
  controllers: [IngestController],
  providers: [
    IngestService,
    { provide: IngestRateLimiter, useFactory: () => new IngestRateLimiter() },
  ],
})
export class AgentModule {}
