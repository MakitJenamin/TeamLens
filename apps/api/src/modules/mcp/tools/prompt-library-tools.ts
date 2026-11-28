import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PromptLibraryService } from '../../prompt-library/prompt-library.service.js';
import { McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller } from '../mcp.types.js';
import { BaseMcpTool, parseArgs, uuidArg } from './base-tool.js';

const libraryArgs = z.strictObject({
  projectId: uuidArg('projectId'),
  limit: z.number().int().min(1).max(100).default(50),
});

/**
 * `get_prompt_library`: prompt mẫu leader đã duyệt của project (C2). Quyền và việc ẩn tên do `PromptLibraryService`
 * lo, giống hệt `GET /api/v1/projects/:id/prompt-library`.
 */
@Injectable()
export class GetPromptLibraryTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly library: PromptLibraryService,
  ) {
    super('get_prompt_library', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { projectId, limit } = parseArgs(libraryArgs, args);
    const result = await this.library.list(caller.user, projectId, limit);
    return result as unknown as Record<string, unknown>;
  }
}
