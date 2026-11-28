import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ProjectsService } from '../../projects/projects.service.js';
import { loadToolDefinition, McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller, McpTool } from '../mcp.types.js';

const definition = loadToolDefinition('whoami');

/**
 * `whoami`: token đang dùng thuộc về ai, vai trò gì, xem được project nào. Agent gọi đầu tiên.
 * Chỉ nói về chính người gọi nên không ghi audit. Project: member thấy project mình tham gia,
 * leader thấy mọi project (cùng quy tắc với `GET /api/v1/projects`).
 */
@Injectable()
export class WhoamiTool implements McpTool, OnModuleInit {
  readonly name = definition.name;
  readonly description = definition.description;
  readonly inputSchema = definition.inputSchema;
  readonly outputSchema = definition.outputSchema;

  constructor(
    private readonly registry: McpToolRegistry,
    private readonly projects: ProjectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
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
