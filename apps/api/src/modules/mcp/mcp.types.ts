import type { AuthRequest, AuthUser } from '../../common/auth-context.js';

/** Loại token đã xác thực: `device` (`tld_`, qua `tl mcp`) hoặc `agent` (`tlp_`, token cá nhân). */
export type McpTokenKind = 'device' | 'agent';

/** Người gọi MCP sau khi guard xác thực token. Quyền tính theo `user`, giống hệt dashboard. */
export interface McpCaller {
  user: AuthUser;
  tokenKind: McpTokenKind;
}

export interface McpRequest extends AuthRequest {
  mcp?: McpCaller;
}

/**
 * Một tool MCP. `name`, `description`, `inputSchema`, `outputSchema` lấy nguyên văn từ
 * `packages/schema/mcp/<tên>.json` (contract); server trả đúng như vậy ở `tools/list`.
 */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  /**
   * Chạy tool. Tự kiểm tra `args` (không tin client) và quyền xem dữ liệu như endpoint dashboard
   * (AccessService, audit). Trả object khớp `outputSchema`; ném `ApiError` để báo lỗi cho agent.
   */
  run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>>;
}

/** Cấu trúc file `packages/schema/mcp/<tên>.json`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}
