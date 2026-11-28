import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';

/** Thống kê: tổng quan project (M2.9), hồ sơ thành viên (M2.10). Leaderboard (M4.3) thêm sau. Xem README.md. */
@Module({
  controllers: [OverviewController, ProfileController],
  providers: [OverviewService, ProfileService],
  // Tool MCP (M6.15) import hai dịch vụ này, không sửa code module này.
  exports: [OverviewService, ProfileService],
})
export class StatsModule {}
