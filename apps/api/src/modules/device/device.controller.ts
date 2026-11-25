import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  type AuthDevice,
  type AuthUser,
  CurrentDevice,
  CurrentUser,
  Public,
} from '../../common/auth-context.js';
import { DeviceService } from './device.service.js';

const createCodeSchema = z.object({
  deviceName: z.string().trim().min(1, 'Thiếu tên thiết bị').max(100),
  os: z.string().trim().min(1, 'Thiếu hệ điều hành').max(50),
  cliVersion: z.string().trim().min(1, 'Thiếu phiên bản CLI').max(50),
});

const pollTokenSchema = z.object({ deviceCode: z.string().min(1).max(200) });

const approveSchema = z.object({ userCode: z.string().min(1).max(20) });

/** Endpoint cho CLI (`/agent/v1`, xác thực bằng device token). */
@Controller('agent/v1')
export class AgentDeviceController {
  constructor(private readonly devices: DeviceService) {}

  @Public()
  @Post('device/code')
  @HttpCode(200)
  createCode(
    @Body({ schema: createCodeSchema }) body: z.infer<typeof createCodeSchema>,
  ) {
    return this.devices.createCode(body);
  }

  @Public()
  @Post('device/token')
  @HttpCode(200)
  pollToken(
    @Body({ schema: pollTokenSchema }) body: z.infer<typeof pollTokenSchema>,
  ) {
    return this.devices.pollToken(body.deviceCode);
  }

  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser, @CurrentDevice() device: AuthDevice) {
    return this.devices.whoami(user, device);
  }

  /** Thu hồi token của chính thiết bị đang gọi. */
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthUser,
    @CurrentDevice() device: AuthDevice,
  ) {
    await this.devices.revoke(user, device.id);
  }
}

/** Endpoint cho dashboard (`/api/v1`, xác thực bằng cookie). */
@Controller('api/v1')
export class DashboardDeviceController {
  constructor(private readonly devices: DeviceService) {}

  @Post('device/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthUser,
    @Body({ schema: approveSchema }) body: z.infer<typeof approveSchema>,
  ) {
    return this.devices.approve(user, body.userCode);
  }

  @Get('devices')
  list(@CurrentUser() user: AuthUser) {
    return this.devices.listOwn(user.id);
  }

  @Post('devices/:deviceId/revoke')
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
  ) {
    await this.devices.revoke(user, deviceId);
  }
}
