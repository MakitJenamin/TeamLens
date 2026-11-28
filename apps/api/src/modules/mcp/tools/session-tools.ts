import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { forbidden } from '../../../common/api-error.js';
import { AccessService } from '../../access/access.service.js';
import { FindingsService } from '../../rules/findings.service.js';
import { AGENT_KINDS } from '../../sessions/session-mappers.js';
import { SessionsService } from '../../sessions/sessions.service.js';
import { McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller } from '../mcp.types.js';
import {
  BaseMcpTool,
  isoDateTime,
  parseArgs,
  truncateText,
  uuidArg,
} from './base-tool.js';

/** Một đoạn văn dài (prompt, output tool) bị cắt ở mức này để không làm tràn ngữ cảnh của agent. */
export const TURN_TEXT_MAX = 2000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const searchArgs = z.strictObject({
  projectId: uuidArg('projectId'),
  userId: uuidArg('userId').optional(),
  agent: z.enum(AGENT_KINDS, 'agent không hợp lệ').optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  q: z.string().trim().min(1, 'q không được để trống').max(200).optional(),
  includeSubagents: z.boolean().default(false),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(500).optional(),
});

/**
 * `search_sessions`: danh sách session của project, có lọc và phân trang. Dùng đúng `SessionsService.list`
 * của dashboard (member chỉ thấy session của mình, lọc userId người khác trả 403). Từ khóa `q` là nội dung
 * prompt nên không bao giờ được log.
 */
@Injectable()
export class SearchSessionsTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
  ) {
    super('search_sessions', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const query = parseArgs(searchArgs, args);
    // `SessionsService.list` giả định người gọi đã qua `@ProjectAccess()`: ở đây là bước tương đương.
    if (!(await this.access.canAccessProject(caller.user, query.projectId))) {
      throw forbidden();
    }
    const page = await this.sessions.list(caller.user, query.projectId, {
      userId: query.userId,
      agent: query.agent,
      from: query.from,
      to: query.to,
      q: query.q,
      includeSubagents: query.includeSubagents,
      limit: query.limit,
      cursor: query.cursor,
    });
    return page as unknown as Record<string, unknown>;
  }
}

const getSessionArgs = z.strictObject({
  sessionId: uuidArg('sessionId'),
  fromSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/**
 * `get_session`: chi tiết session và một trang turn đã rút gọn. Quyền và audit `session.view` do
 * `SessionsService.get` lo. Văn bản dài bị cắt ở {@link TURN_TEXT_MAX}; diff chỉ còn đường dẫn và số dòng.
 */
@Injectable()
export class GetSessionTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly sessions: SessionsService,
  ) {
    super('get_session', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { sessionId, fromSeq, limit } = parseArgs(getSessionArgs, args);
    const { turns, ...session } = await this.sessions.get(
      caller.user,
      sessionId,
    );
    const rest = turns.filter((t) => t.seq >= fromSeq);
    const pageTurns = rest.slice(0, limit);
    return {
      session,
      turns: pageTurns.map((t) => {
        const text = t.text === null ? null : truncateText(t.text, TURN_TEXT_MAX);
        const output =
          t.output === null
            ? null
            : (() => {
                const cut = truncateText(t.output.text, TURN_TEXT_MAX);
                return {
                  text: cut.text,
                  truncated: t.output.truncated || cut.truncated,
                };
              })();
        return {
          seq: t.seq,
          role: t.role,
          kind: t.kind,
          ts: t.ts,
          model: t.model,
          text: text?.text ?? null,
          textTruncated: text?.truncated ?? false,
          tool: t.tool === null ? null : { name: t.tool.name, status: t.tool.status },
          output,
          diff:
            t.diff === null
              ? null
              : { path: t.diff.path, added: t.diff.added, removed: t.diff.removed },
          usage:
            t.usage === null
              ? null
              : { input: t.usage.input, output: t.usage.output },
          interrupted: t.interrupted,
        };
      }),
      page: {
        fromSeq,
        returned: pageTurns.length,
        totalTurns: turns.length,
        nextFromSeq: rest.length > limit ? rest[limit].seq : null,
      },
    };
  }
}

const findingsArgs = z.strictObject({ sessionId: uuidArg('sessionId') });

/** `get_findings`: nhận xét của một session. Quyền và audit do `FindingsService` lo. */
@Injectable()
export class GetFindingsTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly findings: FindingsService,
  ) {
    super('get_findings', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { sessionId } = parseArgs(findingsArgs, args);
    const result = await this.findings.list(caller.user, sessionId);
    return result as unknown as Record<string, unknown>;
  }
}
