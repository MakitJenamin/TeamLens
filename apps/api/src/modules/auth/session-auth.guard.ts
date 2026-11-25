import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { unauthenticated } from '../../common/api-error.js';
import {
  type AuthRequest,
  IS_PUBLIC_KEY,
  isAgentPath,
} from '../../common/auth-context.js';
import { AuthService, SESSION_COOKIE } from './auth.service.js';

/**
 * Guard toàn cục: mọi route (trừ `/agent/*` và route `@Public()`) yêu cầu cookie `tl_session`.
 * Route `/agent/*` do DeviceAuthGuard xử lý.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (isAgentPath(req)) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || !token) throw unauthenticated();
    const result = await this.auth.validateSessionToken(token);
    if (!result) throw unauthenticated();
    req.user = result.user;
    req.authSessionId = result.sessionId;
    return true;
  }
}
