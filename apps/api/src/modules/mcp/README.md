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
| `mcp-prompts.ts` | MCP prompt (M6.16): `coach-me`, `weekly-review`; đọc từ `packages/schema/mcp/prompts/*.json`, `prompts/list` ẩn prompt của leader với member. |
| `tools/` | Mỗi nhóm tool một file, kế thừa `BaseMcpTool` (`base-tool.ts`: nạp định nghĩa từ contract, tự đăng ký, `parseArgs` bằng zod, `truncateText`). 17 tool: 12 tool đọc (M6.15, M6.11) và 5 tool ghi cho leader (M6.16, `write-tools.ts`). Tool đọc: `whoami`; `list_projects`, `list_members`, `get_overview`, `get_member_profile` (`project-tools.ts`); `search_sessions`, `get_session`, `get_findings` (`session-tools.ts`); `list_rules`, `get_rule`, `get_my_ai_results` (`rule-and-ai-tools.ts`). Bảng đầy đủ ở `packages/schema/mcp/README.md`. |

## Quy tắc

- **Không giữ phiên (stateless):** không cấp `Mcp-Session-Id`, mỗi request tự xác thực. Chạy được nhiều instance, restart không mất gì.
- **Quyền = quyền dashboard của user sở hữu token.** Tool tự kiểm quyền như endpoint dashboard (`AccessService`); đọc dữ liệu người khác thì ghi audit ở chính tool (dùng lại cách `session.view`). Tool ghi (M6.16) ghi audit kèm giá trị cũ và mới.
- **Cửa ra che secret:** dữ liệu trên server đã được CLI che từ máy thành viên; `mcp-redact.ts` là lớp phòng thủ thêm, chỉ gồm mẫu chắc chắn (khóa riêng, khóa AWS/GitHub/Anthropic/OpenAI/Slack/Google, JWT, token TeamLens, mật khẩu trong URL, `password=…`, `API_KEY=…`), **không phải bộ che đầy đủ**. Muốn thêm mẫu: thêm vào `RULES` và một ca vào `mcp-redact.spec.ts`.
- Tool lỗi nghiệp vụ (`ApiError`) trả `isError: true` với thông báo; lỗi lạ trả "Lỗi nội bộ", chỉ log tên tool và loại lỗi, không log nội dung.
- Không gọi LLM ở đây: agent của người dùng mới là AI.

## Tool đọc (M6.15)

Mỗi tool chỉ **gọi service đã có** của module khác (nên quyền và audit giống hệt dashboard); các module đó export service cho MCP: `SessionsService` (`sessions`), `OverviewService`, `ProfileService` (`stats`), `FindingsService`, `RulesQueryService` (`rules`), `ProjectsService`, `LlmService`.

- **Quyền:** member chỉ thấy dữ liệu của mình (session, hồ sơ, danh sách thành viên chỉ có chính mình); leader thấy tất cả. `get_overview` chỉ leader. Tool đọc dữ liệu của người khác ghi audit qua service tương ứng (`session.view` ở `get_session`, `get_findings`; `profile.view` ở `get_member_profile`). `search_sessions` cũng cần vào được project (`canAccessProject`, bước thay cho `@ProjectAccess()` của controller).
- **Bảo vệ ngữ cảnh của agent:** `limit` tối đa 50 (mặc định 20). `get_session` phân trang turn theo `fromSeq`/`page.nextFromSeq`, cắt mỗi đoạn văn dài ở 2000 ký tự (cờ `textTruncated`/`truncated`), diff chỉ có đường dẫn và số dòng, không có `tool.input`.
- **Tham số chặt:** zod `strictObject`, trường lạ hoặc sai kiểu trả 400 `validation_error` (chỉ nêu đường dẫn, không in giá trị). Lỗi nghiệp vụ trả `isError: true` với thông báo tiếng Việt.
- `get_my_ai_results` luôn lọc theo `userId` của người gọi (`LlmService.findResults`), không có đường nào đọc kết quả của người khác.
- `list_rules`/`get_rule` đọc qua `RulesQueryService` (chỉ đọc): rule riêng của project ghi đè rule mặc định cùng khóa, giống `score-session.ts`. M4.4 mở rộng dịch vụ này khi làm màn quản lý rule.
- `get_skill_clusters` (M6.11, `tools/skill-tools.ts`) gọi `SkillsService` của module `skills` (Skill Finder S0), cùng quyền và audit như REST.
- **Chưa có:** `get_leaderboard` (chờ M4.3), `get_prompt_library` (chờ M6.14).
- Test: `test/mcp-read-tools.e2e-spec.ts` gọi từng tool bằng member và leader và **kiểm mỗi kết quả thật bằng Ajv theo `outputSchema` trong contract**, nên lệch schema là test đỏ.

## Tool ghi cho leader và prompt (M6.16)

Tool: `draft_rule`, `test_rule`, `save_rule`, `set_rule_enabled`, `add_session_note` (`tools/write-tools.ts`). Logic nằm ở `RulesWriteService` (`rules/rules-write.service.ts`) và `SessionNotesService`; tool chỉ kiểm tham số rồi gọi.

- **Chỉ leader**, kiểm cả ở tool lẫn ở dịch vụ. Member gọi nhận lỗi quyền.
- **Phạm vi hẹp có chủ ý:** chỉ chỉnh **rule session có sẵn** (`thresholds` đã có, `severity`, `message`, `advice`), lưu thành bản riêng của project. **Không đổi `match`** (logic, regex), không tạo rule mới, không áp dụng cho rule tuần (`set_rule_enabled` bật/tắt được cả rule tuần). Lý do: pipeline chấm điểm (`score-session.ts`) chỉ biết các rule dựng sẵn (khóa lạ bị bỏ qua) và để agent tự viết `textRegex` là nguy cơ ReDoS. Muốn mở rộng cần engine hỗ trợ trước.
- `draft_rule` không ghi gì: trả rule sau khi đổi, danh sách thay đổi và kết quả chạy các `tests` nội tuyến. `save_rule` **từ chối** khi không đổi gì (`no_changes`) hoặc khi `tests` nội tuyến không còn đúng (`rule_tests_failed`), nên không lưu được cấu hình làm hỏng chính rule (ví dụ `repeated-correction` chỉ chấp nhận `min = 3`, vì hai test của nó chặn cả hai phía).
- `test_rule` chạy thử trên 50 session gốc gần nhất (bỏ session con và session đã mất turn do retention, như `score-session.ts`), so với cấu hình hiện hành; **không trả nội dung turn**, chỉ id, số turn, số lần.
- **Audit:** mỗi thao tác ghi `audit_log` (`rule.save`, `rule.set_enabled`, `session.note.create`); hai thao tác rule có `details` (cột `audit_log.details`) gồm `via: 'mcp'`, `projectId`, `key`, `changes` (với `save`), `previous` và `next` (scope, enabled, version, severity, ngưỡng, thông điệp, lời khuyên): đủ để đảo lại. Ghi trong cùng transaction với thay đổi.
- **Chấm lại điểm:** sau `save_rule` và `set_rule_enabled`, phát job `project.rescore` như nút "Chạy lại" (kết quả `rescore: "queued"`; điểm cập nhật khi worker chạy xong).
- Bản riêng của project: `rules.project_id = <project>` (ghi đè rule mặc định cùng khóa như `score-session.ts`). Bật/tắt không tăng `version`, lưu thay đổi thì tăng.
- **Prompt:** `prompts/list`, `prompts/get`. `template` trong contract thay `{{tên}}` bằng argument; argument tên kết thúc `Id` phải là UUID (không nhét được chỉ dẫn lạ). `weekly-review` chỉ leader (member nhận như prompt không tồn tại). `find-skills` và `improve-agents-md` chờ M6.11 và C3.
- Test: `test/mcp-write-tools.e2e-spec.ts` (quyền, soạn thử, chạy thử, lưu, tắt/bật kèm kiểm finding đổi sau khi chấm lại, audit, ghi chú, prompt, kiểm kết quả theo `outputSchema` bằng Ajv), `rules/rule-definition.spec.ts`, `mcp/mcp-prompts.spec.ts`.

## Thêm một tool (M6.15, M6.16)

1. Viết `packages/schema/mcp/<tên>.json` (`name`, `description`, `inputSchema`, `outputSchema`) trong PR contract.
2. Tạo class `@Injectable()` kế thừa `BaseMcpTool` trong `tools/` (constructor gọi `super('<tên>', registry)`, chỉ viết `run`); xem `tools/whoami.tool.ts` và `tools/project-tools.ts`.
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
