import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SkillsService } from '../../skills/skills.service.js';
import { McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller } from '../mcp.types.js';
import { BaseMcpTool, isoDateTime, parseArgs, uuidArg } from './base-tool.js';

const clustersArgs = z.strictObject({
  projectId: uuidArg('projectId'),
  userId: uuidArg('userId').optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

/**
 * `get_skill_clusters`: cụm prompt lặp lại của project (Skill Finder S0). Quyền và audit
 * (`skill_clusters.view`) do `SkillsService` lo, giống hệt `GET /api/v1/projects/:id/skill-clusters`.
 */
@Injectable()
export class GetSkillClustersTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly skills: SkillsService,
  ) {
    super('get_skill_clusters', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { projectId, ...query } = parseArgs(clustersArgs, args);
    const result = await this.skills.list(caller.user, projectId, query);
    return result as unknown as Record<string, unknown>;
  }
}
