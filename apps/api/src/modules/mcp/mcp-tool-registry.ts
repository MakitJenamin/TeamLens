import { Injectable } from '@nestjs/common';
import { createRequire } from 'node:module';
import type { McpTool, McpToolDefinition } from './mcp.types.js';

const require = createRequire(import.meta.url);

/**
 * Đọc định nghĩa tool từ contract: `packages/schema/mcp/<tên>.json` (qua `@teamlens/schema`).
 * `name`, `description`, `inputSchema`, `outputSchema` đúng nguyên văn contract.
 */
export function loadToolDefinition(name: string): McpToolDefinition {
  return require(`@teamlens/schema/mcp/${name}.json`) as McpToolDefinition;
}

/**
 * Sổ đăng ký tool. Mỗi tool là một provider `@Injectable()` tự gọi `register(this)` ở `onModuleInit`,
 * nên thêm tool mới (M6.15, M6.16) chỉ cần thêm file tool và khai báo provider, không sửa `McpService`.
 */
@Injectable()
export class McpToolRegistry {
  private readonly tools = new Map<string, McpTool>();

  register(tool: McpTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool MCP trùng tên: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): McpTool | undefined {
    return this.tools.get(name);
  }

  /** Theo thứ tự tên để `tools/list` ổn định. */
  list(): McpTool[] {
    return [...this.tools.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}
