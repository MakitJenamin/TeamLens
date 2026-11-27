import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import {
  AgentInvitesController,
  DashboardInvitesController,
  InviteRateLimiter,
} from './invites.controller.js';
import { InvitesService } from './invites.service.js';

/** Link mời chung và tham gia bằng `tl join` (SPEC 7.1, task J.3). */
@Module({
  imports: [DeviceModule],
  controllers: [
    DashboardInvitesController,
    AgentInvitesController,
    ],
  providers: [
    InvitesService,
    { provide: InviteRateLimiter, useFactory: () => new InviteRateLimiter() },
  ],
})
export class InvitesModule {}
