import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { SessionNotesService } from './session-notes.service.js';
import { SessionsAiController } from './sessions-ai.controller.js';
import { SessionsAiService } from './sessions-ai.service.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

/**
 * Xem session trên dashboard (M1.8), ghi chú theo turn (M3.4) và nút AI trên trang session
 * (M6.5 tóm tắt, đánh giá kết quả; M6.6 giải thích finding). Xem README.md.
 */
@Module({
  imports: [LlmModule],
  controllers: [SessionsController, SessionsAiController],
  providers: [SessionsService, SessionNotesService, SessionsAiService],
  // Tool MCP (M6.15, M6.16) import các dịch vụ này, không sửa code module này.
  exports: [SessionsService, SessionNotesService],
})
export class SessionsModule {}
