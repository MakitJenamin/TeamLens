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
| Định hướng | `whoami`, `list_projects`, `list_members` | Mọi người (member chỉ thấy mình) | [`whoami.json`](whoami.json) |
| Số liệu | `get_overview`, `get_leaderboard`, `get_member_profile` (điểm 5 nhóm theo tuần, token) | Theo quyền | |
| Session | `search_sessions` (người, agent, ngày, từ khóa, loại việc B4), `get_session` (phân trang turn), `get_findings` | Theo quyền | |
| Rule | `list_rules`, `get_rule` | Mọi người | |
| Tri thức team | `get_skill_clusters` (S0), `get_prompt_library` (C2, mục đã duyệt) | Theo quyền | |
| Kết quả AI | `get_my_ai_results` (kết quả AI chính người gọi đã tạo trên dashboard) | Mọi người | |
| Ghi (leader) | `draft_rule`, `test_rule`, `save_rule`, `set_rule_enabled`, `add_session_note` | Leader | |
| MCP prompts | `/teamlens:coach-me`, `/teamlens:weekly-review`, `/teamlens:find-skills`, `/teamlens:improve-agents-md` | Theo quyền | |

Thêm tool: tạo file `<tên-tool>.json`, điền cột "File" của bảng trên, chạy `test`.
