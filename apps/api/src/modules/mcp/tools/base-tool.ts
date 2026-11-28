import type { OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../../../common/api-error.js';
import { loadToolDefinition, McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller, McpTool } from '../mcp.types.js';

/**
 * Gốc của mọi tool: nạp định nghĩa từ contract (`packages/schema/mcp/<tên>.json`) và tự đăng ký vào
 * `McpToolRegistry` khi module khởi động. Lớp con chỉ viết `run`.
 */
export abstract class BaseMcpTool implements McpTool, OnModuleInit {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;

  protected constructor(
    toolName: string,
    private readonly registry: McpToolRegistry,
  ) {
    const definition = loadToolDefinition(toolName);
    this.name = definition.name;
    this.description = definition.description;
    this.inputSchema = definition.inputSchema;
    this.outputSchema = definition.outputSchema;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  abstract run(
    caller: McpCaller,
    args: unknown,
  ): Promise<Record<string, unknown>>;
}

/** Thời điểm ISO 8601 (như REST của dashboard), đổi sang `Date`. */
export const isoDateTime = z.iso
  .datetime({ offset: true, message: 'Phải là thời điểm ISO 8601' })
  .transform((value) => new Date(value));

export const uuidArg = (name: string) => z.uuid(`${name} phải là UUID`);

/**
 * Kiểm tra tham số của tool bằng zod (không tin client). Sai thì 400 `validation_error` với đường dẫn
 * và thông điệp, KHÔNG in giá trị (có thể là nội dung nhạy cảm).
 */
export function parseArgs<T extends z.ZodType>(
  schema: T,
  args: unknown,
): z.infer<T> {
  const result = schema.safeParse(args ?? {});
  if (result.success) return result.data;
  const details = result.error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  throw new ApiError(
    400,
    'validation_error',
    `Tham số không hợp lệ: ${details}`,
  );
}

/** Cắt chuỗi ở `max` ký tự, không chẻ đôi cặp surrogate (emoji). */
export function truncateText(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
