import { Injectable } from '@nestjs/common';
import { ProjectsService } from '../../projects/projects.service.js';
import { McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller } from '../mcp.types.js';
import { BaseMcpTool } from './base-tool.js';

/**
 * `whoami`: token đang dùng thuộc về ai, vai trò gì, xem được project nào. Agent gọi đầu tiên.
 * Chỉ nói về chính người gọi nên không ghi audit. Project: member thấy project mình tham gia,
 * leader thấy mọi project (cùng quy tắc với `GET /api/v1/projects`).
 */
@Injectable()
export class WhoamiTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly projects: ProjectsService,
  ) {
    super('whoami', registry);
  }

  async run(caller: McpCaller): Promise<Record<string, unknown>> {
    const list = await this.projects.list(caller.user);
    return {
      user: {
        id: caller.user.id,
        name: caller.user.name,
        role: caller.user.role,
      },
      tokenKind: caller.tokenKind,
      projects: list.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
    };
  }
}
