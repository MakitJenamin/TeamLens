import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';

/** Thống kê: tổng quan project (M2.9). Hồ sơ thành viên (M2.10) và leaderboard (M4.3) thêm sau. Xem README.md. */
@Module({
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class StatsModule {}
