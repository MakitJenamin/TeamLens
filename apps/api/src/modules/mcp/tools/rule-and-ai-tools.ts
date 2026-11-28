import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { forbidden } from '../../../common/api-error.js';
import { AccessService } from '../../access/access.service.js';
import { LlmService, toAiResult } from '../../llm/llm.service.js';
import { RulesQueryService } from '../../rules/rules-query.service.js';
import { McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller } from '../mcp.types.js';
import { BaseMcpTool, parseArgs, uuidArg } from './base-tool.js';

const listRulesArgs = z.strictObject({ projectId: uuidArg('projectId').optional() });

/**
 * `list_rules`: rule hiệu lực (khóa, nhóm, mức độ, bật/tắt). Rule không chứa dữ liệu của ai nên ai cũng đọc
 * được; có `projectId` thì phải vào được project đó (như dashboard).
 */
@Injectable()
export class ListRulesTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly rules: RulesQueryService,
    private readonly access: AccessService,
  ) {
    super('list_rules', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { projectId } = parseArgs(listRulesArgs, args);
    if (
      projectId !== undefined &&
      !(await this.access.canAccessProject(caller.user, projectId))
    ) {
      throw forbidden();
    }
    return { rules: await this.rules.list(projectId) };
  }
}

const getRuleArgs = z.strictObject({
  key: z.string().min(1).max(100),
  projectId: uuidArg('projectId').optional(),
});

/** `get_rule`: một rule kèm định nghĩa JSON khai báo. */
@Injectable()
export class GetRuleTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly rules: RulesQueryService,
    private readonly access: AccessService,
  ) {
    super('get_rule', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { key, projectId } = parseArgs(getRuleArgs, args);
    if (
      projectId !== undefined &&
      !(await this.access.canAccessProject(caller.user, projectId))
    ) {
      throw forbidden();
    }
    return { rule: await this.rules.get(key, projectId) };
  }
}

const aiResultsArgs = z.strictObject({
  subjectType: z.enum([
    'session',
    'finding',
    'user_week',
    'project_week',
    'project',
    'skill_cluster',
  ]),
  subjectId: uuidArg('subjectId'),
  kind: z
    .enum([
      'session_summary',
      'session_outcome',
      'finding_explain',
      'weekly_user',
      'weekly_team',
      'context_suggestions',
      'skill_triage',
      'skill_content',
      'catalog_picks',
      'prompt_candidates',
    ])
    .optional(),
  locale: z.enum(['vi', 'en']).optional(),
});

/**
 * `get_my_ai_results`: kết quả AI của CHÍNH người gọi cho một đối tượng. `LlmService.findResults` luôn lọc theo
 * `userId` của người gọi, nên không có đường nào đọc kết quả của người khác (AI_PLAN nguyên tắc 6).
 */
@Injectable()
export class GetMyAiResultsTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly llm: LlmService,
  ) {
    super('get_my_ai_results', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { subjectType, subjectId, kind, locale } = parseArgs(
      aiResultsArgs,
      args,
    );
    const rows = await this.llm.findResults(caller.user.id, {
      subjectType,
      subjectIds: [subjectId],
      kind,
      locale,
    });
    const results = rows
      .map(toAiResult)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { results };
  }
}
