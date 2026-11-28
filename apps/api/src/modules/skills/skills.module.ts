import { Module } from '@nestjs/common';
import { SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';

/** Skill Finder (Mốc 6, Người 3). M6.11: S0 gom cụm prompt lặp lại. S1 đến S3 thêm ở M6.12, M6.13. Xem README.md. */
@Module({
  controllers: [SkillsController],
  providers: [SkillsService],
  // Tool MCP `get_skill_clusters` dùng lại dịch vụ này.
  exports: [SkillsService],
})
export class SkillsModule {}
