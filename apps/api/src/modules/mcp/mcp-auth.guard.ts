import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { McpAuthService } from './mcp-auth.service.js';
import type { McpRequest } from './mcp.types.js';

/**
 * Guard riêng của `/api/v1/mcp` (route này là `@Public()` nên bỏ qua guard cookie và guard thiết bị):
 * nhận `tld_` hoặc `tlp_`, gắn người gọi vào `req.mcp` và `req.user`.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly auth: McpAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<McpRequest>();
    const caller = await this.auth.authenticate(req.headers.authorization);
    req.mcp = caller;
    req.user = caller.user;
    return true;
  }
}
