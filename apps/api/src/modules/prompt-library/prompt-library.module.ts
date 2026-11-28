import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { PromptCandidatesService } from './prompt-candidates.service.js';
import {
  PromptCandidatesController,
  PromptLibraryController,
} from './prompt-library.controller.js';
import { PromptLibraryService } from './prompt-library.service.js';

/**
 * Thư viện prompt mẫu (Mốc 6, Người 3, M6.14, C2): leader tìm ứng viên (heuristic + AI viết lý do) rồi duyệt vào
 * thư viện, thành viên của project xem. Xem README.md.
 */
@Module({
  imports: [LlmModule],
  controllers: [PromptLibraryController, PromptCandidatesController],
  providers: [PromptLibraryService, PromptCandidatesService],
  // Tool MCP `get_prompt_library` dùng lại PromptLibraryService.
  exports: [PromptLibraryService],
})
export class PromptLibraryModule {}
