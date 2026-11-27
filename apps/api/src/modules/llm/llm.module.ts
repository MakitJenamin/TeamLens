import { Module } from '@nestjs/common';
import { LLM_ADAPTERS, type LlmAdapters } from './adapters/adapter.js';
import { AnthropicAdapter } from './adapters/anthropic.adapter.js';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.adapter.js';
import { LlmKeyService } from './llm-key.service.js';
import { LlmService } from './llm.service.js';

/** Lõi gọi LLM (M6.1). Tính năng AI import module này và dùng `LlmService`. Xem README.md. */
@Module({
  providers: [
    LlmService,
    LlmKeyService,
    {
      provide: LLM_ADAPTERS,
      useFactory: (): LlmAdapters => ({
        anthropic: new AnthropicAdapter(),
        openai_compatible: new OpenAiCompatibleAdapter(),
      }),
    },
  ],
  exports: [LlmService, LlmKeyService],
})
export class LlmModule {}
