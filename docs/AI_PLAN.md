# TeamLens — kế hoạch tính năng AI (Mốc 6)

> Chốt sau buổi brainstorm 2026-11-28. Thay cho SPEC 9.3 ("Chấm bằng LLM" dùng một key chung của server). Đã đồng bộ vào [SPEC.md](SPEC.md) (mục 2, 3, 7.4, 8, 9.3, 10, 11, 12), [TASKS.md](TASKS.md) (Mốc 6), [FLOW.md](FLOW.md) (khúc ⑩), [RULES.md](RULES.md) và các `AGENTS.md` (vùng sở hữu của Người 3). File này giữ phần thiết kế chi tiết.
>
> Tham khảo: [microsoft/ai-engineering-coach](https://github.com/microsoft/ai-engineering-coach) (MIT), sau đây gọi là AEC. Mỗi tính năng ghi rõ lấy ý từ đâu.

## 1. Nguyên tắc đã chốt

| # | Nguyên tắc | Hệ quả |
| --- | --- | --- |
| 1 | **Làm song song ngay**, không chờ nghiệm thu MVP. Ba người, mỗi người một cục lớn, không đụng vùng code của nhau (mục 7) | Người 2 làm nốt Mốc 4, 5 rồi mới tới phần AI của mình. M4.6 bỏ phần "LLM provider" ở cài đặt server |
| 2 | **BYO theo từng người**: ai muốn dùng AI thì tự nhập API key của mình. Không có key chung của server | Bảng `user_llm_keys` thay cho `settings.llm_key`. Người chưa có key không thấy nút AI (hiện "Thêm API key để dùng") |
| 3 | Key **lưu trên server, mã hóa theo user** (AES-GCM, khóa từ `TEAMLENS_SECRET_KEY`). Chỉ chính người đó dùng được key của mình | Không ai, kể cả leader, đọc hay dùng được key của người khác |
| 4 | **Provider bản đầu: Anthropic + chuẩn OpenAI-compatible** | Hai adapter phủ được Anthropic, OpenAI, Gemini (endpoint tương thích), Ollama, vLLM, OpenRouter |
| 5 | **Không chạy nền**: mọi tính năng AI chỉ chạy khi người dùng bấm | Không có job AI trong pg-boss. Không có "tự tóm tắt sau ingest" |
| 6 | **Kết quả AI là riêng của người bấm**: người khác không thấy, kể cả khi cùng xem một session | Hai người tóm tắt cùng một session thì mỗi người tự trả tiền và có bản riêng. Ngoại lệ duy nhất: mục leader đã duyệt vào thư viện prompt (C2) |
| 7 | **Kết quả AI lưu theo retention của nội dung thô** (mặc định 90 ngày). Bấm lại thì **ghi đè** bản cũ | Mỗi người chỉ có một bản cho mỗi (loại, đối tượng, ngôn ngữ). Xóa dữ liệu của một người thì xóa luôn kết quả AI về người đó |
| 8 | **Quyền giống hệt dashboard**: member chỉ dùng AI trên dữ liệu của mình, leader dùng trên dữ liệu của mọi người. Dùng AI trên dữ liệu người khác thì ghi audit như khi mở session | Đi qua `AccessService` + `AuditService` như mọi API khác |
| 9 | **Kết quả trả về theo ngôn ngữ giao diện của người bấm** (vi/en, next-intl) | Prompt gửi kèm locale, kết quả lưu kèm locale |
| 10 | **Không kiểm soát chi phí**: tiền của ai người nấy tự theo dõi ở trang provider | Vẫn lưu số token của mỗi lần gọi để debug, không làm trần hay cảnh báo |
| 11 | Dữ liệu repo **không được gửi thêm** lên server | Bỏ Context Health (review CLAUDE.md/AGENTS.md theo nội dung repo) |

## 2. Hai cách dùng AI

| | Nút AI trên dashboard | MCP trong agent |
| --- | --- | --- |
| Ở đâu | Trình duyệt (leader đăng nhập, member vào bằng `tl open`) | Claude Code, Codex hoặc agent bất kỳ hỗ trợ MCP |
| AI là gì | API key người đó nhập ở trang **"Cài đặt AI"** | Chính agent của người đó, chạy bằng gói họ đang dùng. **Không cần key trên server** |
| Kiểu dùng | Bấm, ra kết quả theo khuôn cố định (tóm tắt, báo cáo, đề xuất skill…) | Hỏi tự do, kết hợp nhiều dữ liệu, sửa luôn repo (ghi `SKILL.md`, bổ sung `AGENTS.md`), leader bật/tắt rule |
| Thấy dữ liệu gì | Đúng quyền dashboard | Đúng quyền dashboard |

## 3. Tính năng

### 3.1 Danh sách

| Mã | Tính năng | Leader | Member | Gọi LLM | Lấy ý từ |
| --- | --- | --- | --- | --- | --- |
| **A1** | Tóm tắt session: việc gì, kết quả, file bị đụng, loại việc | Mọi session | Session của mình | Có | Mới |
| **A4** | Giải thích finding: vì sao bị bắt, nên làm gì trong đúng session này | Mọi session | Session của mình | Có | AEC "explain rule occurrence" |
| **A5** | Đánh giá kết quả session: xong / bỏ dở / kẹt vòng lặp, kèm bằng chứng là số turn | Mọi session | Session của mình | Có | Mới |
| **B1** | Báo cáo tuần theo người: điểm mạnh, điểm yếu, 2–3 ví dụ prompt thật, so với tuần trước, một việc nên tập | Từng thành viên | Của mình | Có | AEC `/summary`, `/improve` |
| **B2** | Báo cáo tuần của team: lỗi phổ biến nhất, ai tiến bộ, gợi ý buổi chia sẻ | Có | Không | Có | Mới |
| **B4** | Phân loại việc (bugfix, feature, refactor, hỏi đáp, ops…) cho từng session | Thấy nhãn, lọc, thống kê | Thấy nhãn trên session của mình | **Không**, heuristic trong rule worker | AEC `classifyWorkType` |
| **C2** | Thư viện prompt mẫu: AI đề xuất prompt và session tốt kèm lý do, leader duyệt thì thành dữ liệu chung của project (có thể ẩn tên) | Đề xuất, duyệt | Xem mục đã duyệt | Có | Mới |
| **C3** | Đề xuất bổ sung file hướng dẫn (CLAUDE.md/AGENTS.md) từ lỗi lặp lại của team trong một project, ví dụ "6 session agent không chạy test → thêm lệnh test vào AGENTS.md" | Theo project | Không | Có | Biến thể của AEC Context Health, dựa trên finding thay vì nội dung repo |
| **S0** | Skill Finder · gom cụm prompt lặp lại | Theo project và theo người | Của mình | **Không**, heuristic | AEC `analyzer-workflows.ts` |
| **S1** | Skill Finder · triage cụm: `strong`/`maybe`/`skip`, lý do, tên skill gợi ý | Có | Của mình | Có | AEC triage |
| **S2** | Skill Finder · sinh `SKILL.md` từ một cụm, tải về hoặc để agent ghi vào repo qua MCP | Có | Của mình | Có | AEC generate skill |
| **S3** | Skill Finder · chọn tối đa 5 skill trong catalog có sẵn hợp với workflow thật, lý do phải trích số liệu | Có | Của mình | Có | AEC catalog picks |
| **MCP** | `tl mcp` + endpoint MCP trên API, bộ tool đọc theo quyền dashboard, thao tác ghi cho leader | Có | Có | Không (agent là AI) | AEC `languageModelTools` |

### 3.2 Ghi chú từng nhóm

**A1, A4, A5 (trang Xem session)**
- Đầu vào là các turn của session (đã che secret từ máy thành viên), cắt theo ngân sách token, kèm finding của session.
- Đầu ra ép theo JSON schema; turn được trích dẫn bằng `seq` để web nhảy tới đúng turn.
- A4 là rẻ nhất: chỉ gửi rule (JSON + message + advice) và các turn quanh chỗ dính finding.
- A1 tự nêu loại việc theo cách hiểu của LLM, độc lập với nhãn B4.

**B1, B2 (trang hồ sơ thành viên, Tổng quan)**
- Không gửi toàn bộ session của tuần. Gửi số liệu đã tính (`user_weekly_stats`, finding theo nhóm, so với tuần trước) và vài prompt mẫu chọn bằng heuristic (dính finding nặng nhất, điểm cao nhất).

**B4 (rule worker, không AI)**
- Từ khóa tiếng Việt và tiếng Anh trong prompt, cộng tín hiệu từ tool và diff (chỉ đọc, có chạy test, sửa file test…).
- Nhãn lưu trên session (`sessions.work_type`), ai xem được session thì thấy nhãn. Đây không phải kết quả AI nên không theo nguyên tắc 6.
- Mở đường cho rule `session-drift` (RULES.md, Phase 2) nếu heuristic đủ tốt.

**C2 (thư viện prompt)**
- Bước 1: leader bấm "Tìm prompt mẫu" cho một project và khoảng ngày. Ứng viên lấy bằng heuristic (session điểm cao, không có finding nặng), AI viết lý do "vì sao tốt". Kết quả riêng của leader.
- Bước 2: leader chọn "Thêm vào thư viện", có tùy chọn ẩn tên. Mục được duyệt nằm ở bảng `prompt_library` của project, member xem được. Mục đã duyệt bị xóa khi session gốc hết retention.

**C3 (đề xuất file hướng dẫn)**
- Đầu vào: finding lặp lại của project theo rule và nhóm kỹ năng, kèm vài trích đoạn turn làm bằng chứng. Không có nội dung repo (nguyên tắc 11).
- Đầu ra: danh sách đoạn văn nên thêm vào CLAUDE.md/AGENTS.md, mỗi đoạn kèm lý do và số liệu. Agent có thể áp dụng qua MCP.

**Skill Finder (S0–S3)**
- S0 dựa theo AEC: bỏ prompt dưới 15 ký tự, prompt rác ("tiếp", "ok", "continue", "yes"), prompt quá 2000 ký tự. Chuẩn hóa code, chuỗi, đường dẫn, số. "Dấu vân tay" là 4 token đầu sau khi sắp xếp. Cụm cần ít nhất 3 lần lặp, tối đa 200 cụm.
- **Phải sửa so với AEC:** AEC xóa mọi ký tự ngoài `a-z`, làm hỏng tiếng Việt. TeamLens chuẩn hóa NFC, giữ chữ có dấu, thêm stop word tiếng Việt ("giúp", "mình", "cho", "nhé", "ạ"…).
- Chỉ dùng prompt của session gốc (prompt trong session con do agent viết, SPEC 9.1).
- S3 dùng **danh sách nguồn catalog cấu hình được**, mặc định `anthropics/skills` và `github/awesome-copilot`; leader thêm hoặc bớt URL ngay trên trang Skill Finder. Server cần ra được GitHub.
- "Cài vào repo": web cho tải `SKILL.md`. Qua MCP thì agent đang mở repo tự ghi vào `.claude/skills/<tên>/SKILL.md` (Claude Code) hoặc thư mục skill của Codex.

**Chống prompt injection (mọi tính năng gọi LLM)**
- Nội dung turn là dữ liệu không đáng tin. Đặt sau một câu chặn kiểu `UNTRUSTED_DATA_GUARD` của AEC và bọc trong khối phân tách rõ ràng.
- Đầu ra ép JSON schema, validate bằng zod. Sai schema thì báo lỗi, không hiển thị nửa vời.

## 4. MCP

### 4.1 Kết nối

| Ai | Cách cài | Token |
| --- | --- | --- |
| Member | `claude mcp add teamlens -- tl mcp` | Device token có sẵn từ `tl join`; `tl mcp` tự lấy trong Credential Manager |
| Leader | Vào **"Cài đặt AI" → "Token cho agent"**, tạo token `tlp_…`, rồi `claude mcp add --transport http teamlens https://<server>/api/v1/mcp --header "Authorization: Bearer tlp_…"` | Token cá nhân: DB chỉ lưu SHA-256 (như device token), thu hồi được, có `last_used_at` |

- Server có **một** endpoint MCP (Streamable HTTP) ở `/api/v1/mcp`. Đặt dưới `/api/` để dùng lại rewrite của web và Caddy sẵn có, không phải sửa `next.config` hay `Caddyfile`. Route đánh dấu `@Public()` và dùng guard riêng, nhận cả device token `tld_` lẫn token cá nhân `tlp_`.
- `tl mcp` chỉ là cầu nối stdio ↔ HTTP, không chứa logic tool.
- Quyền tính theo user của token, giống hệt dashboard. Đọc dữ liệu người khác thì ghi audit.
- Mọi kết quả đi qua một cửa ra duy nhất, áp lại bộ che secret (như `textResult` của AEC) trước khi trả cho agent.

### 4.2 Bộ tool

| Nhóm | Tool | Ai |
| --- | --- | --- |
| Định hướng | `whoami`, `list_projects`, `list_members` | Mọi người (member chỉ thấy mình) |
| Số liệu | `get_overview`, `get_leaderboard`, `get_member_profile` (điểm 5 nhóm theo tuần, token) | Theo quyền |
| Session | `search_sessions` (người, agent, ngày, từ khóa, loại việc B4), `get_session` (phân trang turn), `get_findings` | Theo quyền |
| Rule | `list_rules`, `get_rule` | Mọi người |
| Tri thức team | `get_skill_clusters` (S0), `get_prompt_library` (C2, mục đã duyệt) | Theo quyền |
| Kết quả AI | `get_my_ai_results` (các kết quả AI chính người gọi đã tạo trên dashboard) | Mọi người |
| **Ghi (leader)** | `draft_rule` (validate JSON rule + chạy `tests` nội tuyến), `test_rule` (chạy thử trên 50 session gần nhất), `save_rule`, **`set_rule_enabled`** (bật/tắt rule theo project), `add_session_note` | Leader |
| MCP prompts | `/teamlens:coach-me`, `/teamlens:weekly-review`, `/teamlens:find-skills`, `/teamlens:improve-agents-md` | Theo quyền |

- Qua MCP, agent tự làm phần "AI" (tóm tắt, giải thích, viết skill) từ dữ liệu thô nên không cần tool gọi LLM trên server.
- Mọi thao tác ghi ghi audit kèm nguồn `mcp` và tên token. Bật/tắt rule làm đổi điểm của cả team, nên audit ghi đủ rule, project, giá trị cũ và mới. Sau khi đổi, phát job "chạy lại rule" như khi bấm trên dashboard.
- Tool **chỉ import service đã có** của các module (sessions, stats, rules, projects…), không sửa code module khác. Service nào chưa export thì mở PR nhỏ riêng để export.

## 5. Thay đổi dữ liệu và contract

**Bảng mới**: tất cả nằm trong **một PR migration duy nhất ở đầu Mốc 6** (M6.0), để không ai phải tự generate migration song song.

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| `user_llm_keys` | user_id, provider (`anthropic` \| `openai_compatible`), base_url, model, key_encrypted, created_at, updated_at | Một user một key ở bản đầu |
| `ai_results` | id, user_id (người bấm), kind (`session_summary`, `session_outcome`, `finding_explain`, `weekly_user`, `weekly_team`, `context_suggestions`, `skill_triage`, `skill_content`, `catalog_picks`, `prompt_candidates`), subject_type, subject_id, locale, provider, model, prompt_version, input_tokens, output_tokens, result (jsonb), created_at | Thay `llm_reviews`. Unique (user_id, kind, subject_type, subject_id, locale) để bấm lại thì ghi đè. Chỉ người tạo đọc được. Retention theo nội dung thô |
| `agent_tokens` | id, user_id, name, token_hash, last_used_at, created_at, revoked_at | Token cá nhân `tlp_` cho MCP |
| `prompt_library` | id, project_id, session_id, turn_seq, note, hide_author, approved_by, created_at | Mục C2 đã duyệt, dữ liệu chung |
| `skill_catalog_sources` | id, url, kind, enabled, created_at | Nguồn catalog S3 |
| Cột `sessions.work_type` | | Nhãn B4 |

**Bảng cũ phải xử lý trong cùng PR migration:**
- `llm_reviews` đã có trong code (`apps/api/src/db/schema/scoring.ts`, migration `0000_init.sql`) nhưng chưa dùng: **xóa bảng**, thay bằng `ai_results`. `apps/api/src/modules/projects/user-merge.service.ts` đang `UPDATE llm_reviews` khi gộp user: đổi sang chuyển `ai_results`, `agent_tokens` và `user_llm_keys` (user cũ chưa có key thì lấy key của user thừa, có rồi thì bỏ key của user thừa).
- Xóa toàn bộ dữ liệu của một người (M5.6) phải xóa cả `ai_results` (người đó tạo và về người đó), `user_llm_keys`, `agent_tokens`, mục `prompt_library` trỏ tới session của người đó.
- Contract `sessions.yaml` đang ghi "Để sau: `POST /api/v1/sessions/{sessionId}/llm-review`": bỏ dòng này, các nút AI nằm ở `ai.yaml`.

**Contract** (`packages/schema/openapi/`): một PR đầu tiên chứa khung `ai.yaml` (key của tôi, kết quả AI, các nút AI), `agent-tokens.yaml`, `prompt-library.yaml`, `skills.yaml`, `mcp.yaml` (endpoint) và `packages/schema/mcp/` (JSON Schema đầu vào và đầu ra của từng tool). Sau đó mỗi người sở hữu file của mình (mục 7).

**SPEC phải sửa:** 8 (bảng), 9.3 (viết lại theo file này), 10 (màn hình mới: Cài đặt AI, Skill Finder, Thư viện prompt, mục AI ở trang session/hồ sơ/tổng quan), 11.1 (dòng "Cấu hình LLM key: chỉ leader" đổi thành "mỗi người tự cấu hình key của mình"; thêm dòng MCP và bật/tắt rule qua MCP), 12.2 (rủi ro: lộ key cá nhân, lộ token `tlp_`, prompt injection qua nội dung turn).

## 6. Task (Mốc 6)

| Mã | Việc | Người | Phụ thuộc |
| --- | --- | --- | --- |
| **M6.0** | PR contract (khung mọi file ở mục 5) + PR migration toàn bộ bảng AI, xóa `llm_reviews`, sửa `user-merge.service.ts` (mục 5) | 1 | |
| **M6.1** | Module `llm`: **tuần đầu merge interface `LlmService` + adapter giả** để người khác code theo; sau đó adapter Anthropic + OpenAI-compatible, gọi có JSON schema, timeout, phân loại lỗi (key sai, hết quota, model không có), câu chặn injection, ghi và ghi đè `ai_results`, mã hóa key | 1 | M6.0 |
| **M6.2** | Trang **"Cài đặt AI"** `(dashboard)/settings/ai`: API key của tôi (nhập, kiểm tra, xóa) + Token cho agent (tạo, liệt kê, thu hồi); link ở sidebar (PR vùng nền nhỏ) | 1 | M6.0, M6.1 |
| **M6.5** | A1 tóm tắt + A5 đánh giá kết quả trên trang session | 1 | M6.1 |
| **M6.6** | A4 giải thích finding | 1 | M6.1 |
| **M6.3** | Khung MCP: endpoint `/api/v1/mcp` (Streamable HTTP), guard nhận `tld_`/`tlp_`, cửa ra che secret, audit | 3 | M6.0 |
| **M6.4** | `tl mcp` trong CLI: cầu nối stdio ↔ `/api/v1/mcp` bằng device token, tài liệu cài cho Claude Code và Codex | 3 | M6.3 |
| **M6.15** | Tool MCP đọc (mục 4.2) | 3 | M6.3 |
| **M6.16** | Tool MCP ghi cho leader (`draft_rule`, `test_rule`, `save_rule`, `set_rule_enabled`, `add_session_note`) + MCP prompts | 3 | M6.3 |
| **M6.11** | S0 gom cụm prompt (hỗ trợ tiếng Việt) + trang Skill Finder | 3 | M6.0 |
| **M6.12** | S1 triage + S2 sinh `SKILL.md` | 3 | M6.1, M6.11 |
| **M6.13** | S3 catalog nhiều nguồn cấu hình được + chọn skill | 3 | M6.12 |
| **M6.14** | C2 thư viện prompt: tìm ứng viên, duyệt, trang thư viện cho member | 3 | M6.1 |
| — | Làm nốt **M4.3–M4.6** (M4.6 bỏ phần LLM provider) và **M5.4–M5.6** | 2 | |
| **M6.7** | B4 phân loại việc bằng heuristic trong rule worker, lọc theo loại việc, thống kê ở Tổng quan | 2 | M6.0 |
| **M6.8** | B1 báo cáo tuần theo người (trang hồ sơ thành viên) | 2 | M6.1 |
| **M6.9** | B2 báo cáo tuần của team (Tổng quan) | 2 | M6.8 |
| **M6.10** | C3 đề xuất bổ sung file hướng dẫn | 2 | M6.1 |
| **M6.17** | Nghiệm thu chung: nút AI với key Anthropic và với Ollama; MCP với Claude Code và Codex, đăng nhập bằng member và leader | Cả 3 | Tất cả |

## 7. Vùng sở hữu (bổ sung vào AGENTS.md mục 3)

| | Người 1 · Lõi AI + AI trên session | Người 2 · Giá trị cho leader (giữ nguyên) + báo cáo AI | Người 3 · MCP + tri thức team |
| --- | --- | --- | --- |
| CLI | (giữ vùng cũ) | (giữ vùng cũ) | `cli/crates/teamlens/src/mcp/`, lệnh `mcp` |
| API (`apps/api/src/modules/`) | `llm/`, `ai-settings/` (key, token `tlp_`), phần AI trong `sessions/` | (giữ vùng cũ), phần AI trong `stats/` (B1, B2), `rules/` (B4, C3) | `mcp/`, `skills/`, `prompt-library/` |
| Web (`apps/web/src/app/[locale]/`) | `(dashboard)/settings/ai/`, mục AI trên trang session | (giữ vùng cũ), mục AI trên Tổng quan, hồ sơ thành viên, C3 | `(dashboard)/projects/[projectId]/{skills,prompt-library}/` |
| Schema | `openapi/{ai,agent-tokens}.yaml` | (giữ vùng cũ) | `openapi/{mcp,skills,prompt-library}.yaml`, `mcp/` |

**Điểm chạm** (chốt bằng contract, không sửa code của nhau):
- Mọi tính năng gọi LLM (Người 2, 3) dùng `LlmService` của Người 1.
- Tool MCP (Người 3) import service của sessions, stats, rules, projects; tool bật/tắt rule gọi service của `rules` (Người 2).
- Link sidebar tới "Cài đặt AI", Skill Finder, Thư viện prompt là vùng nền: mỗi người một PR nhỏ.
- Đăng ký module mới trong `app.module.ts` và lệnh `mcp` trong bộ phân tích lệnh của CLI là vùng nền: PR nhỏ, merge sớm.
