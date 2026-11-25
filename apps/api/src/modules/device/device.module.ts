import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DeviceAuthGuard } from './device-auth.guard.js';
import {
  AgentDeviceController,
  DashboardDeviceController,
} from './device.controller.js';
import { DeviceService } from './device.service.js';

@Module({
  controllers: [AgentDeviceController, DashboardDeviceController],
  providers: [DeviceService, { provide: APP_GUARD, useClass: DeviceAuthGuard }],
  exports: [DeviceService],
})
export class DeviceModule {}
