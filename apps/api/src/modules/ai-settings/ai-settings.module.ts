import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { AiSettingsController } from './ai-settings.controller.js';
import { AgentTokensService } from './agent-tokens.service.js';

/** Trang "Cài đặt AI" (M6.2): API key BYO của tôi + token `tlp_` cho agent. Xem README.md. */
@Module({
  imports: [LlmModule],
  controllers: [AiSettingsController],
  providers: [AgentTokensService],
  exports: [AgentTokensService],
})
export class AiSettingsModule {}
