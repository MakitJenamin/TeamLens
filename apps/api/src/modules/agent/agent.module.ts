import { Module } from '@nestjs/common';
import { AgentConfigController } from './agent-config.controller.js';
import { AgentConfigService } from './agent-config.service.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestRateLimiter } from './rate-limiter.js';

/** Endpoint cho CLI: ingest (M1.6), config (M2.2); sau này thêm heartbeat (M3.3). Xem README.md. */
@Module({
  controllers: [IngestController, AgentConfigController],
  providers: [
    IngestService,
    AgentConfigService,
    { provide: IngestRateLimiter, useFactory: () => new IngestRateLimiter() },
  ],
})
export class AgentModule {}
