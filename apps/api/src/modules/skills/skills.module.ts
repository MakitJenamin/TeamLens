import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { SkillsAiController } from './skills-ai.controller.js';
import { SkillsAiService } from './skills-ai.service.js';
import { SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';

/**
 * Skill Finder (Mốc 6, Người 3). M6.11: S0 gom cụm prompt lặp lại. M6.12: nút AI S1 (triage) và S2 (sinh SKILL.md),
 * gọi LLM qua `LlmService`. S3 (catalog) thêm ở M6.13. Xem README.md.
 */
@Module({
  imports: [LlmModule],
  controllers: [SkillsController, SkillsAiController],
  providers: [SkillsService, SkillsAiService],
  // Tool MCP `get_skill_clusters` dùng lại SkillsService.
  exports: [SkillsService],
})
export class SkillsModule {}
