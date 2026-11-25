import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health.controller.js';
import { AccessModule } from './modules/access/access.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AgentModule } from './modules/agent/agent.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConsentModule } from './modules/consent/consent.module.js';
import { DeviceModule } from './modules/device/device.module.js';
import { InvitesModule } from './modules/invites/invites.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { RetentionModule } from './modules/retention/retention.module.js';
import { RulesModule } from './modules/rules/rules.module.js';
import { SessionsModule } from './modules/sessions/sessions.module.js';
import { StatsModule } from './modules/stats/stats.module.js';
import { QueueModule } from './queue/queue.module.js';

// Mọi module đã được đăng ký sẵn ở đây; task sau chỉ sửa trong thư mục module của mình.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    DbModule,
    QueueModule,
    // Nền
    AccessModule,
    AuthModule,
    DeviceModule,
    ProjectsModule,
    // A · Đường dữ liệu
    AgentModule,
    SessionsModule,
    // B · Con người và điểm số
    InvitesModule,
    ConsentModule,
    RulesModule,
    StatsModule,
    AdminModule,
    RetentionModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
