import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  type AuthDevice,
  type AuthUser,
  CurrentDevice,
  CurrentUser,
} from '../../common/auth-context.js';
import { DeviceService } from './device.service.js';

/** Endpoint cho CLI (`/agent/v1`, xác thực bằng device token). */
@Controller('agent/v1')
export class AgentDeviceController {
  constructor(private readonly devices: DeviceService) {}

  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser, @CurrentDevice() device: AuthDevice) {
    return this.devices.whoami(user, device);
  }

  /** `tl open`: link đăng nhập dashboard một lần. */
  @Post('web-login')
  @HttpCode(200)
  webLogin(@CurrentUser() user: AuthUser, @CurrentDevice() device: AuthDevice) {
    return this.devices.createWebLoginTicket(user, device);
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
