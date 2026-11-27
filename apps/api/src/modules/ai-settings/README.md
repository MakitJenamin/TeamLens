# Module `ai-settings` — trang "Cài đặt AI" (M6.2)

Contract: `packages/schema/openapi/ai.yaml` (nhóm `/api/v1/me/llm-key`) và `openapi/agent-tokens.yaml`.
Mọi route chỉ thao tác trên user của chính người gọi (cookie `tl_session`, leader và member như nhau);
không route nào nhận userId từ ngoài.

| Route                                     | Việc                                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/me/llm-key`                  | `{ key: LlmKey \| null }`, chỉ `keyHint`, không bao giờ trả key.                                                                                          |
| `PUT /api/v1/me/llm-key`                  | Lưu/sửa qua `LlmKeyService.saveKey` (module `llm`). `apiKey` bỏ trống = giữ key cũ; chuỗi rỗng chỉ hợp lệ với `openai_compatible` (Ollama không cần key). |
| `DELETE /api/v1/me/llm-key`               | 204, kể cả khi chưa có key.                                                                                                                               |
| `POST /api/v1/me/llm-key/test`            | `LlmKeyService.resolveTestConfig` rồi `LlmService.testKey`; lỗi theo mã `llm_*`. Không lưu gì.                                                            |
| `GET /api/v1/me/agent-tokens`             | Token chưa thu hồi, mới nhất trước.                                                                                                                       |
| `POST /api/v1/me/agent-tokens`            | Sinh `tlp_` + 32 byte ngẫu nhiên (`randomToken`), DB chỉ lưu SHA-256, trả `secret` đúng một lần.                                                          |
| `DELETE /api/v1/me/agent-tokens/:tokenId` | Đặt `revoked_at`; không tồn tại / của người khác / đã thu hồi → 404.                                                                                      |

Lệch nhẹ so với contract: `apiKey` nhận chuỗi rỗng (contract ghi `minLength: 1`) để lưu cấu hình Ollama không cần key.

`AgentTokensService` (export) và `AGENT_TOKEN_PREFIX` dùng lại được cho guard MCP (M6.3): tra token bằng
`sha256(token)` trên `agent_tokens.token_hash`, bỏ qua token có `revoked_at`, cập nhật `last_used_at`.

Không log key hay token. e2e: `test/ai-settings.e2e-spec.ts` (adapter giả qua `LLM_ADAPTERS`).
