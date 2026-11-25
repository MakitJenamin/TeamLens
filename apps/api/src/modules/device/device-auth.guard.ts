import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../../common/api-error.js';
import {
  type AuthRequest,
  IS_PUBLIC_KEY,
  isAgentPath,
} from '../../common/auth-context.js';
import { DeviceService } from './device.service.js';

const invalidToken = () =>
  new ApiError(
    401,
    'invalid_token',
    'Token thiết bị không hợp lệ hoặc đã bị thu hồi',
  );

/**
 * Guard toàn cục cho `/agent/*`: yêu cầu `Authorization: Bearer tld_...`
 * (trừ route `@Public()` như `device/code`, `device/token`).
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly devices: DeviceService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!isAgentPath(req)) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!match) throw invalidToken();
    const result = await this.devices.authenticate(match[1]);
    if (!result) throw invalidToken();
    req.user = result.user;
    req.device = result.device;
    return true;
  }
}
