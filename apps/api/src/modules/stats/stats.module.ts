import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { OverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';
import { LeaderboardController } from './leaderboard.controller.js';
import { LeaderboardService } from './leaderboard.service.js';
import { TeamReportController } from './team-report.controller.js';
import { TeamReportService } from './team-report.service.js';
import { WeeklyReportController } from './weekly-report.controller.js';
import { WeeklyReportService } from './weekly-report.service.js';

/**
 * Thống kê: tổng quan project (M2.9), hồ sơ thành viên (M2.10), leaderboard (M4.3), báo cáo tuần theo người do AI viết
 * (B1, M6.8) và của team (B2, M6.9). Xem README.md.
 */
@Module({
  imports: [LlmModule],
  controllers: [
    OverviewController,
    ProfileController,
    LeaderboardController,
    WeeklyReportController,
    TeamReportController,
  ],
  providers: [
    OverviewService,
    ProfileService,
    LeaderboardService,
    WeeklyReportService,
    TeamReportService,
  ],
  // Tool MCP (M6.15) dùng dịch vụ tổng quan và hồ sơ thành viên.
  exports: [OverviewService, ProfileService],
})
export class StatsModule {}
