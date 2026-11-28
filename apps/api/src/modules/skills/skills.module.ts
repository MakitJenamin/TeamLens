import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { SkillCatalogController } from './skill-catalog.controller.js';
import { SkillCatalogService } from './skill-catalog.service.js';
import { SkillsAiController } from './skills-ai.controller.js';
import { SkillsAiService } from './skills-ai.service.js';
import { SkillsCatalogAiController } from './skills-catalog-ai.controller.js';
import { SkillsCatalogAiService } from './skills-catalog-ai.service.js';
import { SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';

/**
 * Skill Finder (Mốc 6, Người 3). M6.11: S0 gom cụm prompt lặp lại. M6.12: nút AI S1 (triage) và S2 (sinh SKILL.md),
 * gọi LLM qua `LlmService`. M6.13: S3, nguồn catalog skill cộng đồng và chọn skill. Xem README.md.
 */
@Module({
  imports: [LlmModule],
  controllers: [
    SkillsController,
    SkillsAiController,
    SkillCatalogController,
    SkillsCatalogAiController,
  ],
  providers: [
    SkillsService,
    SkillsAiService,
    SkillCatalogService,
    SkillsCatalogAiService,
  ],
  // Tool MCP `get_skill_clusters` dùng lại SkillsService.
  exports: [SkillsService],
})
export class SkillsModule {}
