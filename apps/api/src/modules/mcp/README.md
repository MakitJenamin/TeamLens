# Module `mcp` — endpoint MCP cho agent (M6.3)

Contract: `packages/schema/openapi/mcp.yaml` (lớp HTTP) và `packages/schema/mcp/<tool>.json` (từng tool).
Thiết kế: [docs/AI_PLAN.md](../../../../../docs/AI_PLAN.md) mục 4. Người 3 sở hữu module này.

Một endpoint duy nhất `/api/v1/mcp` (Streamable HTTP, JSON-RPC 2.0) cho Claude Code, Codex hoặc agent bất kỳ hỗ trợ MCP.

| File | Nội dung |
| --- | --- |
| `mcp.controller.ts` | `POST` (JSON-RPC), `GET` luôn 405, `DELETE` luôn 204. `@Public()` + `McpAuthGuard`. |
| `mcp-auth.guard.ts`, `mcp-auth.service.ts` | Nhận `Authorization: Bearer tld_…` (device token, member qua `tl mcp`) hoặc `tlp_…` (token cá nhân, bảng `agent_tokens`). Sai, thiếu hoặc đã thu hồi → 401 `invalid_token`. `tlp_` ghi `last_used_at` (tối đa 5 phút một lần). |
| `mcp.service.ts` | Mỗi request dựng một `Server` + `StreamableHTTPServerTransport` của SDK chính thức (`@modelcontextprotocol/sdk`), gắn với người gọi, rồi bỏ đi. Xử lý `tools/list`, `tools/call`. |
| `mcp-tool-registry.ts` | Sổ đăng ký tool; `loadToolDefinition(name)` đọc `packages/schema/mcp/<name>.json` qua `@teamlens/schema/mcp/*.json`. |
| `mcp-redact.ts` | Cửa ra che secret: `redactDeep` chạy trên mọi kết quả tool (cả `content` lẫn `structuredContent`). |
| `tools/` | Mỗi tool một file. Hiện có `whoami`. |

## Quy tắc

- **Không giữ phiên (stateless):** không cấp `Mcp-Session-Id`, mỗi request tự xác thực. Chạy được nhiều instance, restart không mất gì.
- **Quyền = quyền dashboard của user sở hữu token.** Tool tự kiểm quyền như endpoint dashboard (`AccessService`); đọc dữ liệu người khác thì ghi audit ở chính tool (dùng lại cách `session.view`). Tool ghi (M6.16) ghi audit kèm giá trị cũ và mới.
- **Cửa ra che secret:** dữ liệu trên server đã được CLI che từ máy thành viên; `mcp-redact.ts` là lớp phòng thủ thêm, chỉ gồm mẫu chắc chắn (khóa riêng, khóa AWS/GitHub/Anthropic/OpenAI/Slack/Google, JWT, token TeamLens, mật khẩu trong URL, `password=…`, `API_KEY=…`), **không phải bộ che đầy đủ**. Muốn thêm mẫu: thêm vào `RULES` và một ca vào `mcp-redact.spec.ts`.
- Tool lỗi nghiệp vụ (`ApiError`) trả `isError: true` với thông báo; lỗi lạ trả "Lỗi nội bộ", chỉ log tên tool và loại lỗi, không log nội dung.
- Không gọi LLM ở đây: agent của người dùng mới là AI.

## Thêm một tool (M6.15, M6.16)

1. Viết `packages/schema/mcp/<tên>.json` (`name`, `description`, `inputSchema`, `outputSchema`) trong PR contract.
2. Tạo `tools/<tên>.tool.ts`: class `@Injectable()` implements `McpTool` và `OnModuleInit`, lấy định nghĩa bằng `loadToolDefinition('<tên>')`, `onModuleInit()` gọi `registry.register(this)`; xem `tools/whoami.tool.ts`.
3. Khai báo provider trong `mcp.module.ts`. Chỉ **import service đã có** của `sessions`, `stats`, `rules`, `projects`; không sửa code module khác (service chưa export thì mở PR nhỏ riêng để export).
4. Trong `run`, kiểm tra `args` (không tin client) bằng zod và kiểm quyền; trả object khớp `outputSchema`.

## Thử thủ công

Lấy token: member dùng device token (`tld_…`, seed in ra console), leader tạo token `tlp_…` ở trang "Cài đặt AI" hoặc `POST /api/v1/me/agent-tokens`. Client MCP của SDK chạy được trực tiếp:

```ts
const client = new Client({ name: 'thu', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3001/api/v1/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
console.log((await client.callTool({ name: 'whoami', arguments: {} })).structuredContent);
```

Test: `src/modules/mcp/*.spec.ts` (che secret, sổ đăng ký), `test/mcp.e2e-spec.ts` (xác thực, giao thức, `whoami` theo quyền, che secret end to end).
