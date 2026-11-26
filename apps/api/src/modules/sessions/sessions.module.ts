import { Module } from '@nestjs/common';
import { SessionNotesService } from './session-notes.service.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

/** Xem session trên dashboard (M1.8) và ghi chú theo turn (M3.4). Xem README.md. */
@Module({
  controllers: [SessionsController],
  providers: [SessionsService, SessionNotesService],
})
export class SessionsModule {}
