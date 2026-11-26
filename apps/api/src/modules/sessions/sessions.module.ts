import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

/** Xem session trên dashboard (M1.8). Xem README.md. */
@Module({
  controllers: [SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
