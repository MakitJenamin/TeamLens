import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';
import { LeaderboardController } from './leaderboard.controller.js';
import { LeaderboardService } from './leaderboard.service.js';

/** Thống kê: tổng quan project (M2.9), hồ sơ thành viên (M2.10), leaderboard (M4.3). Xem README.md. */
@Module({
  controllers: [OverviewController, ProfileController, LeaderboardController],
  providers: [OverviewService, ProfileService, LeaderboardService],
  // Tool MCP (M6.15) dùng dịch vụ tổng quan và hồ sơ thành viên.
  exports: [OverviewService, ProfileService],
})
export class StatsModule {}
