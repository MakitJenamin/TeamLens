import { Module } from '@nestjs/common';
import { AgentConfigController } from './agent-config.controller.js';
import { AgentConfigService } from './agent-config.service.js';
import { HeartbeatRateLimiter } from './heartbeat.js';
import { HeartbeatController } from './heartbeat.controller.js';
import { HeartbeatService } from './heartbeat.service.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestRateLimiter } from './rate-limiter.js';

/** Endpoint cho CLI: ingest (M1.6), config (M2.2); heartbeat (M3.3). Xem README.md. */
@Module({
  controllers: [IngestController, AgentConfigController, HeartbeatController],
  providers: [
    IngestService,
    AgentConfigService,
    HeartbeatService,
    { provide: IngestRateLimiter, useFactory: () => new IngestRateLimiter() },
    {
      provide: HeartbeatRateLimiter,
      useFactory: () => new HeartbeatRateLimiter(),
    },
  ],
})
export class AgentModule {}
