# packages/schema/mcp — JSON Schema của tool MCP

Mô tả từng tool của endpoint MCP `/api/v1/mcp` (khung HTTP ở [`openapi/mcp.yaml`](../openapi/mcp.yaml)).
Thiết kế: [docs/AI_PLAN.md](../../../docs/AI_PLAN.md) mục 4. Task: M6.3 (khung), M6.15 (tool đọc), M6.16 (tool ghi + MCP prompts). Người 3 sở hữu thư mục này.

## Định dạng

Mỗi tool một file `<tên-tool>.json`:

```json
{
  "name": "whoami",
  "description": "Mô tả cho agent đọc (tiếng Việt).",
  "inputSchema": { "...JSON Schema draft 2020-12..." },
  "outputSchema": { "...JSON Schema draft 2020-12 của structuredContent..." }
}
```

- `name`, `description`, `inputSchema`, `outputSchema` đúng tên trường của `tools/list` trong đặc tả MCP, server trả nguyên văn.
- Input và output dùng camelCase như REST API; schema chặt (`additionalProperties: false`).
- `pnpm --filter @teamlens/schema test` kiểm tra mọi file ở đây compile được bằng Ajv (draft 2020-12).
- Quyền tính theo user của token, giống hệt dashboard; mọi kết quả đi qua cửa ra che secret trước khi trả cho agent.

## Bộ tool (AI_PLAN mục 4.2)

| Nhóm | Tool | Ai | File |
| --- | --- | --- | --- |
| Định hướng | `whoami`, `list_projects`, `list_members` | Mọi người (member chỉ thấy mình) | [`whoami`](whoami.json), [`list_projects`](list_projects.json), [`list_members`](list_members.json) |
| Số liệu | `get_overview` (chỉ leader), `get_leaderboard` (chưa có: chờ M4.3), `get_member_profile` (điểm 5 nhóm theo tuần, token) | Theo quyền | [`get_overview`](get_overview.json), [`get_member_profile`](get_member_profile.json) |
| Session | `search_sessions` (người, agent, ngày, từ khóa; lọc loại việc B4 khi B4 xong), `get_session` (phân trang turn), `get_findings` | Theo quyền | [`search_sessions`](search_sessions.json), [`get_session`](get_session.json), [`get_findings`](get_findings.json) |
| Rule | `list_rules`, `get_rule` | Mọi người | [`list_rules`](list_rules.json), [`get_rule`](get_rule.json) |
| Tri thức team | `get_skill_clusters` (S0), `get_prompt_library` (C2, mục đã duyệt, chờ M6.14) | Theo quyền | [`get_skill_clusters`](get_skill_clusters.json) |
| Kết quả AI | `get_my_ai_results` (kết quả AI chính người gọi đã tạo trên dashboard) | Mọi người | [`get_my_ai_results`](get_my_ai_results.json) |
| Ghi (leader) | `draft_rule`, `test_rule`, `save_rule`, `set_rule_enabled`, `add_session_note` | Leader | [`draft_rule`](draft_rule.json), [`test_rule`](test_rule.json), [`save_rule`](save_rule.json), [`set_rule_enabled`](set_rule_enabled.json), [`add_session_note`](add_session_note.json) |
| MCP prompts | `coach-me`, `find-skills` (mọi người), `weekly-review` (leader); `improve-agents-md` chờ C3 | Theo quyền | [`prompts/coach-me`](prompts/coach-me.json), [`prompts/find-skills`](prompts/find-skills.json), [`prompts/weekly-review`](prompts/weekly-review.json) |

Thêm tool: tạo file `<tên-tool>.json`, điền cột "File" của bảng trên, chạy `test`.

## Quy ước chung của tool đọc (M6.15)

- Schema đầu ra của `get_overview`, `get_member_profile`, `search_sessions`, `get_findings`, `get_my_ai_results` và `get_skill_clusters` **sinh từ các schema OpenAPI cùng tên** (`ProjectOverview`, `MemberProfile`, `SessionPage`, `SessionFindings`, `AiResult`, `SkillClusterList`): cùng hình dạng với REST của dashboard, chỉ bỏ từ khóa riêng của OpenAPI, gộp `allOf` và đóng kín object (`additionalProperties: false`). Đổi schema OpenAPI thì sinh lại các file này (và e2e `test/mcp-read-tools.e2e-spec.ts` kiểm từng kết quả thật bằng Ajv sẽ báo nếu lệch).
- Đầu vào của `search_sessions` và `get_session` chặt hơn REST để bảo vệ ngữ cảnh của agent: `limit` tối đa 50 (mặc định 20); `get_session` phân trang turn theo `fromSeq`/`page.nextFromSeq`, mỗi đoạn văn dài cắt ở 2000 ký tự (cờ `textTruncated`/`truncated`), diff chỉ có đường dẫn và số dòng.
- `get_overview` chỉ leader; `list_members` không trả email.

## Tool ghi cho leader (M6.16)

- Chỉ **leader**; mọi thao tác ghi ghi audit kèm **giá trị cũ và mới** (`audit_log.details`) và phát job chấm lại điểm của project.
- **Phạm vi hẹp có chủ ý:** `draft_rule`, `test_rule`, `save_rule` chỉ chỉnh **rule session có sẵn** (ngưỡng `thresholds`, `severity`, `message`, `advice`) và lưu thành bản riêng của project. **Không đổi `match`** (logic, regex), không tạo rule mới, không áp dụng cho rule tuần: pipeline chấm điểm chỉ biết các rule dựng sẵn, và cho agent tự viết regex là nguy cơ ReDoS. `set_rule_enabled` bật/tắt được cả rule tuần.
- `draft_rule` không lưu gì: trả rule sau khi đổi, các thay đổi và kết quả chạy các `tests` nội tuyến của rule. `save_rule` từ chối khi các `tests` đó không còn đúng. `test_rule` chạy thử trên 50 session gốc gần nhất và **không trả nội dung turn** (chỉ id, số turn, số lần).
- Schema của năm tool này cũng **sinh bằng `generate:mcp`** (sửa ở `scripts/gen-mcp-tools.mjs`, không sửa tay).

## MCP prompts (`prompts/*.json`)

Mỗi prompt một file `{ name, description, arguments: [{ name, description, required }], template }`. `template` là lời nhắc gửi cho agent; `{{tên}}` được thay bằng giá trị argument cùng tên (test kiểm mọi `{{tên}}` phải là một argument). Server trả đúng nội dung này ở `prompts/list` và `prompts/get`.
