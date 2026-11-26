import { Controller, Get } from '@nestjs/common';
import type { AgentConfig } from '@teamlens/schema';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { AgentConfigService } from './agent-config.service.js';

/**
 * `GET /agent/v1/config` (contract `packages/schema/openapi/agent.yaml`, JSON snake_case).
 * Xác thực bằng `DeviceAuthGuard` toàn cục (401 `invalid_token` khi token sai).
 */
@Controller('agent/v1')
export class AgentConfigController {
  constructor(private readonly agentConfig: AgentConfigService) {}

  @Get('config')
  getConfig(@CurrentUser() user: AuthUser): Promise<AgentConfig> {
    return this.agentConfig.getConfig(user);
  }
}
