import { Injectable, Logger } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { ApiError, type ApiErrorBody } from '../../common/api-error.js';
import {
  listPrompts,
  PromptError,
  renderPrompt,
} from './mcp-prompts.js';
import { redactDeep, redactSecrets } from './mcp-redact.js';
import { McpToolRegistry } from './mcp-tool-registry.js';
import type { McpCaller } from './mcp.types.js';

const SERVER_INFO = { name: 'teamlens', version: '0.1.0' } as const;

function textError(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: redactSecrets(message) }],
  };
}

/**
 * Server MCP (Streamable HTTP) không giữ phiên: mỗi request dựng một `Server` + transport riêng, gắn với
 * người gọi đã xác thực, rồi bỏ đi. Nhờ vậy không có trạng thái trong bộ nhớ, chạy được nhiều instance.
 * Mọi kết quả tool đi qua `redactDeep` (cửa ra che secret) trước khi trả cho agent.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(private readonly registry: McpToolRegistry) {}

  async handle(
    req: Request,
    res: Response,
    caller: McpCaller,
    body: unknown,
  ): Promise<void> {
    const server = this.createServer(caller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private createServer(caller: McpCaller): Server {
    const server = new Server(SERVER_INFO, {
      capabilities: { tools: {}, prompts: {} },
    });

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object' },
        outputSchema: tool.outputSchema as { type: 'object' },
      })),
    }));

    // Prompt (M6.16): lời nhắc dựng sẵn lấy từ contract; prompt dành cho leader bị ẩn với member.
    server.setRequestHandler(ListPromptsRequestSchema, () => ({
      prompts: listPrompts(caller.user.role).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
    }));

    server.setRequestHandler(GetPromptRequestSchema, (request) => {
      try {
        const rendered = renderPrompt(
          caller.user.role,
          request.params.name,
          request.params.arguments,
        );
        if (!rendered) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Không có prompt "${request.params.name}".`,
          );
        }
        return {
          description: rendered.description,
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: rendered.text },
            },
          ],
        };
      } catch (error) {
        if (error instanceof PromptError) {
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        throw error;
      }
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.registry.get(request.params.name);
      if (!tool) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Không có tool "${request.params.name}".`,
        );
      }
      try {
        const output = await tool.run(caller, request.params.arguments ?? {});
        const safe = redactDeep(output);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
          structuredContent: safe,
        };
      } catch (error) {
        if (error instanceof ApiError) {
          const body = error.getResponse() as ApiErrorBody;
          return textError(body.message);
        }
        // Không log nội dung (có thể chứa prompt): chỉ tên tool và loại lỗi.
        this.logger.error(
          `Tool ${tool.name} lỗi: ${error instanceof Error ? error.name : 'unknown'}`,
        );
        return textError('Lỗi nội bộ khi chạy tool.');
      }
    });

    return server;
  }
}
