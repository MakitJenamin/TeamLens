import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';

/** User đã đăng nhập (dashboard hoặc chủ thiết bị CLI). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

/** Thiết bị CLI đã xác thực bằng device token. */
export interface AuthDevice {
  id: string;
  name: string;
  userId: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  device?: AuthDevice;
  /** SHA-256 của cookie phiên hiện tại (dùng khi logout). */
  authSessionId?: string;
}

export const IS_PUBLIC_KEY = 'teamlens:isPublic';

/** Đánh dấu route công khai, bỏ qua SessionAuthGuard và DeviceAuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** User hiện tại (đã qua SessionAuthGuard hoặc DeviceAuthGuard). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw new Error('CurrentUser dùng trên route chưa xác thực');
    return user;
  },
);

/** Thiết bị hiện tại (chỉ có trên route `/agent/v1/*` đã qua DeviceAuthGuard). */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthDevice => {
    const device = ctx.switchToHttp().getRequest<AuthRequest>().device;
    if (!device)
      throw new Error('CurrentDevice dùng trên route chưa xác thực thiết bị');
    return device;
  },
);

/** Route của CLI (xác thực bằng device token) thay vì cookie. */
export function isAgentPath(req: Request): boolean {
  return req.path === '/agent' || req.path.startsWith('/agent/');
}
