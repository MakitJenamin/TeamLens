# TeamLens — danh mục rule anti-pattern

Tài liệu này chốt bộ rule chấm điểm của TeamLens (mục 9 của [SPEC.md](SPEC.md)). Người làm task B6–B8 code theo đây; người làm A1/A3 cần bổ sung các trường schema ở mục 4.

**Nguồn:** phần lớn ý tưởng, ngưỡng và lời khuyên được chuyển thể từ 45 rule của [microsoft/ai-engineering-coach](https://github.com/microsoft/ai-engineering-coach) (`src/core/rules/*.md`, license MIT, Copyright (c) Microsoft Corporation), cộng với các rule đã có trong spec. Mỗi rule ghi rõ nguồn ở cột "Nguồn".

## 1. Khác biệt cần biết khi chuyển thể

| ai-engineering-coach | TeamLens |
| --- | --- |
| Người dùng tự xem dữ liệu của mình | Leader xem dữ liệu thành viên, có leaderboard → rule phải công bằng và giải thích được |
| Đọc log VS Code Copilot (mode ask/edit/agent, auto-approve, slash command, auto model) | Claude Code và Codex: luôn là agent, không có mode ask/edit, không có auto model routing |
| Rule tổng hợp trên toàn bộ lịch sử (tỉ lệ trên mọi request) | Hai phạm vi: `session` (finding gắn vào một session) và `user_week` (tỉ lệ trên các session của một người trong một tuần) |
| Từ khóa tiếng Anh | Từ khóa phải có **cả tiếng Việt và tiếng Anh** |
| Rule viết bằng Markdown + DSL `detect` + khối `test` | Rule là JSON trong DB (spec 9.2); **giữ ý tưởng test nội tuyến** (mục 5) |

Chỉ tính **prompt do người gõ**: `role = user`, `kind = prompt`, session gốc (không tính session con của subagent, không tính tool_result, không tính tin nhắn hệ thống hay harness tự chèn).

## 2. Phân loại 45 rule gốc

**Áp dụng ở MVP** (17 rule gốc, gộp với rule của spec thành 24 rule ở mục 3):
`lazy-prompting`, `no-spec-structure`, `no-spec-driven-development`, `low-constraint-usage`, `no-file-context`, `no-custom-instructions` + `context-engineering-gaps` (gộp), `instruction-bloat`, `repeated-prompts`, `runaway-agent-loops`, `mega-sessions`, `high-cancellation`, `premium-waste` + `premium-for-lookup-questions` (gộp), `copy-paste-blindness`, `speed-accept`, `vibe-coding`, `yolo-mode`, `auto-approve-terminal` (gộp vào `yolo-mode`).

**Phase 2** (cần thêm dữ liệu hoặc phân loại loại việc):

| Rule gốc | Lý do để sau |
| --- | --- |
| `session-drift` | Cần phân loại "loại việc" của từng prompt. Mốc 6 làm phân loại việc bằng heuristic (B4, [AI_PLAN.md](AI_PLAN.md)), không dùng LLM vì tính năng AI chỉ chạy khi bấm và kết quả là riêng của người bấm; heuristic đủ tốt thì làm rule này trên nhãn đó |
| `no-plan-mode` | Claude Code ghi được (tool `ExitPlanMode`, `permissionMode: plan`), Codex chưa rõ; chờ có log thật |
| `low-markdown-ratio` | Viết spec/plan không phải lúc nào cũng cần; cần dữ liệu thật để đặt ngưỡng |
| `mcp-tool-bloat` | Ít gặp ở team nhỏ |
| `abandon-sessions` | Session một prompt thường là việc nhanh hợp lệ; dễ phạt oan |
| `excessive-file-context` | Claude Code/Codex không đính file hàng loạt như Copilot; chỉ đếm được `@file` trong prompt |

**Chỉ hiện thành thống kê, không tính điểm** (phản ánh chi phí hoặc cấu hình công cụ, không phải kỹ năng):
`cache-hit-starvation`, `model-overreliance`, `reasoning-effort-overuse`, `verbose-output`. Hiển thị ở màn hình tổng quan (B9) như số liệu chi phí.

**Không làm:**

| Rule gốc | Lý do |
| --- | --- |
| `agent-mode-for-asks`, `agentic-no-tools`, `auto-avoidance`, `no-slash-commands`, `no-skills` | Khái niệm riêng của Copilot hoặc không phản ánh kỹ năng với Claude Code/Codex |
| `no-devcontainer`, `no-language-exploration`, `tunnel-vision` | Ngoài mục tiêu: TeamLens đánh giá trong phạm vi một project |
| `slow-responses` | Đo tốc độ của model, không phải người |
| `verbose-prompt-no-compression` | Từ lịch sự ("làm ơn", "giúp mình", "nhé", "ạ") là bình thường trong tiếng Việt |
| `late-night-coding`, `weekend-overwork`, `broken-flow-state` | Là **giám sát giờ làm việc**, không phải kỹ năng prompt. Trái với non-goal của spec (mục 1) và rủi ro pháp lý (mục 12.1) |
| `profanity`, `caps-lock`, `frustration-signals` | Đo **cảm xúc** của người dùng; không được dùng để đánh giá hay xếp hạng. Phần có ích (người dùng phải sửa đi sửa lại) đã có ở rule `repeated-correction` |

## 3. Bộ rule MVP (24 rule)

Cột "Phạm vi": `session` = mỗi session vi phạm tạo một finding; `user_week` = tính tỉ lệ trên các session của người đó trong tuần, vượt ngưỡng thì tạo một finding cho tuần (gắn vào session tiêu biểu nhất làm ví dụ). Mức: low 5, medium 10, high 20 điểm trừ (spec 9.1).

### 3.1 Chất lượng prompt (`prompt_quality`)

| Key | Mức | Phạm vi | Phát hiện | Ngưỡng mặc định | Nguồn |
| --- | --- | --- | --- | --- | --- |
| `lazy-prompting` | medium | user_week | Tỉ lệ prompt có `0 < độ dài < minChars` | `minChars: 30`, `maxRatio: 0.3`, `minSample: 10` | coach `lazy-prompting` |
| `vague-first-prompt` | medium | session | Prompt đầu session dưới `minWords` từ **và** không nhắc tới file/đường dẫn (regex đường dẫn hoặc `@file`) | `minWords: 15` | spec 9.1 |
| `vague-followup` | low | session | Prompt chỉ gồm từ mơ hồ: `fix`, `làm tiếp`, `tiếp đi`, `sai rồi`, `continue`, `again`, `sửa đi` (sau khi bỏ dấu câu) | `minCount: 3` trong session | spec 9.1 |
| `no-acceptance-criteria` | medium | user_week | Session có ≥ 3 prompt mà prompt đầu không có cấu trúc (gạch đầu dòng, đánh số) **và** không có từ chỉ tiêu chí (`tiêu chí`, `yêu cầu`, `phải`, `kết quả mong muốn`, `acceptance`, `must`, `expected`, `should return`) | `structuredRate: 0.15`, `minSessions: 5` | coach `no-spec-structure` + spec 9.1 |
| `no-spec-first` | low | user_week | Tỉ lệ session ≥ 3 prompt mà prompt đầu không nhắc tới spec/plan (`spec`, `plan`, `kế hoạch`, `đặc tả`, `thiết kế`, file `*.md` trong `docs/`) | `specRate: 0.2`, `minSessions: 5` | coach `no-spec-driven-development` |
| `low-constraint-usage` | low | user_week | Tỉ lệ prompt dài ≥ 40 ký tự **không** có từ ràng buộc. Tiếng Việt: `không được`, `đừng`, `chỉ`, `phải`, `tránh`, `tối đa`, `ít nhất`, `bắt buộc`, `giữ nguyên`, `không dùng`, `không sửa`; tiếng Anh: `do not`, `don't`, `must`, `never`, `only`, `avoid`, `at most`, `at least`, `without`, `ensure` | `constraintRate: 0.08`, `minReqs: 30` | coach `low-constraint-usage` |

### 3.2 Cung cấp context (`context`)

| Key | Mức | Phạm vi | Phát hiện | Ngưỡng mặc định | Nguồn |
| --- | --- | --- | --- | --- | --- |
| `no-instruction-file` | medium | session | `session.instruction_files` rỗng (repo không có `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`) | – | spec 9.1 + coach `no-custom-instructions`, `context-engineering-gaps` |
| `instruction-bloat` | low | session | Tổng `bytes` của `session.instruction_files` vượt ngưỡng | `maxBytes: 4000` | coach `instruction-bloat` |
| `no-file-context` | low | user_week | Tỉ lệ prompt không nhắc tới file nào (không có đường dẫn, `@file`, tên file có đuôi) | `maxNoContextRate: 0.7`, `minSample: 10` | coach `no-file-context` + spec 9.1 |
| `pasted-long-log` | low | session | Prompt có khối text dài (≥ `minLines` dòng) giống log/stack trace (`at `, `Error`, `Traceback`, `panicked at`, `npm ERR!`) | `minLines: 40` | spec 9.1 |

### 3.3 Vòng sửa lỗi (`correction_loop`)

| Key | Mức | Phạm vi | Phát hiện | Ngưỡng mặc định | Nguồn |
| --- | --- | --- | --- | --- | --- |
| `repeated-correction` | high | session | ≥ `min` prompt **liên tiếp** chứa từ phản bác: `không đúng`, `vẫn lỗi`, `vẫn sai`, `sai rồi`, `chưa được`, `still (broken\|wrong\|failing)`, `doesn't work`, `not working` | `min: 3` | spec 9.2 |
| `repeated-prompts` | medium | session | ≥ `minDuplicates` prompt gần trùng nhau (chuẩn hóa: chữ thường, bỏ dấu câu và khoảng trắng thừa; so trùng tuyệt đối sau chuẩn hóa) | `minDuplicates: 3` | coach `repeated-prompts` |
| `same-test-failing` | medium | session | Cùng một lệnh test/build (tool Bash/shell, chuẩn hóa lệnh) có `status = error` ≥ `min` lần | `min: 3` | spec 9.1 |
| `edit-churn` | medium | session | Cùng một file bị sửa ≥ `minEdits` lần, trong đó có diff đảo ngược diff trước (dòng thêm của lần trước bị xóa lại) | `minEdits: 4` | spec 9.1 |
| `runaway-agent-loop` | high | session | Một prompt kéo theo ≥ `minTools` tool call **và** ≥ `minErrors` tool lỗi trước prompt kế tiếp | `minTools: 40`, `minErrors: 5` (ngưỡng gốc 15 tool quá thấp với Claude Code) | coach `runaway-agent-loops` |

### 3.4 Quản lý session (`session_management`)

| Key | Mức | Phạm vi | Phát hiện | Ngưỡng mặc định | Nguồn |
| --- | --- | --- | --- | --- | --- |
| `mega-session` | medium | session | Số prompt người gõ trong session ≥ ngưỡng | `maxPrompts: 50` | coach `mega-sessions` |
| `repeated-compaction` | medium | session | Số turn `kind = compaction` ≥ ngưỡng | `min: 2` | spec 9.1 |
| `high-interruption` | low | user_week | Tỉ lệ prompt bị người dùng ngắt (`turn.interrupted = true`) | `maxRate: 0.15`, `minSample: 20` | coach `high-cancellation` |
| `premium-for-trivial` | low | user_week | Tỉ lệ prompt ngắn (< 120 ký tự), không tạo diff, không gọi tool, dạng hỏi tra cứu (`là gì`, `ở đâu`, `làm sao`, `tại sao`, `giải thích`, `what is`, `how do i`, `explain`) mà chạy trên model đắt nhất (danh sách model "cao cấp" cấu hình được) | `maxRatio: 0.1`, `minSample: 10` | coach `premium-waste`, `premium-for-lookup-questions` + spec 9.1 |

### 3.5 Kiểm chứng kết quả (`verification`)

| Key | Mức | Phạm vi | Phát hiện | Ngưỡng mặc định | Nguồn |
| --- | --- | --- | --- | --- | --- |
| `no-test-after-edit` | high | session | Session có diff (tổng `added + removed ≥ minLoc`) nhưng không có tool call chạy test/build/lint (regex lệnh: `test`, `build`, `lint`, `cargo`, `pytest`, `vitest`, `jest`, `tsc`, `go test`, `mvn`, `gradle`) | `minLoc: 20` | spec 9.1 |
| `large-diff-unreviewed` | high | session | Tổng diff ≥ `minLoc` mà sau diff lớn cuối cùng không còn prompt nào (không có lượt review/hỏi lại) | `minLoc: 500` | spec 9.1 + coach `copy-paste-blindness` |
| `speed-accept` | medium | user_week | Prompt kế tiếp được gửi trong vòng `maxGapSec` giây sau một turn tạo diff ≥ `minLoc` dòng | `minLoc: 20`, `maxGapSec: 15`, `minOccurrences: 5` | coach `speed-accept` |
| `vibe-coding` | high | session | Diff ≥ `minLoc` dòng từ ≤ `maxPrompts` prompt, và không prompt nào nhắc spec/tiêu chí (như `no-acceptance-criteria`) | `minLoc: 300`, `maxPrompts: 5` | coach `vibe-coding` |
| `yolo-mode` | high | session | `session.permission_mode = bypass` (Claude Code `bypassPermissions`/`--dangerously-skip-permissions`; Codex `approval_policy: never` + sandbox `danger-full-access`) và session có chạy lệnh shell | – | coach `yolo-mode`, `auto-approve-terminal` |

> Thứ tự làm ở B7: 16 rule mức high/medium trước, 8 rule mức low sau.

## 4. Trường cần bổ sung vào schema session v1

Thêm dạng **tùy chọn** (tương thích ngược) vào `packages/schema/session.v1.schema.json`, làm cùng task A1 (kiểu dữ liệu) và A3/A9 (adapter điền giá trị):

| Trường | Kiểu | Lấy từ đâu | Dùng cho rule |
| --- | --- | --- | --- |
| `session.permission_mode` | `default \| accept_edits \| plan \| bypass \| unknown` | Claude Code: `permissionMode` trên dòng user; Codex: `turn_context.approval_policy` + `sandbox_policy` | `yolo-mode` |
| `session.instruction_files` | `[{ path, bytes }]` (chỉ đường dẫn tương đối và kích thước, **không gửi nội dung**) | CLI đọc thư mục gốc repo: `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.claude/CLAUDE.md` | `no-instruction-file`, `instruction-bloat` |
| `turn.interrupted` | boolean | Claude Code: tin nhắn `[Request interrupted by user]`; Codex: event `turn_aborted` | `high-interruption` |
| `turn.reasoning_effort` | string \| null | Codex: `turn_context.effort`; Claude Code: để null | thống kê `reasoning-effort-overuse` |

## 5. Định nghĩa rule và test nội tuyến

Giữ định dạng JSON của spec 9.2, bổ sung:

- `scope`: `session` hoặc `user_week`.
- Với `user_week`: `aggregate: "ratio"`, `min_sample` (dưới ngưỡng này không kết luận).
- `thresholds`: tách riêng để leader chỉnh trên UI mà không sửa logic.
- `tests`: mảng ca kiểm thử nằm ngay trong rule (ý tưởng từ khối `test` của ai-engineering-coach), ví dụ `{ "input": { "turns": [...] }, "expect": "triggered" | "clean" }`. Unit test của rule engine (B6) chạy mọi `tests` của mọi rule seed; nút "Thử trên 50 session" (B10) dùng cùng engine.
- `message` và `advice`: tiếng Việt, có biến `{{count}}`, `{{ratio}}`, `{{threshold}}`; nên có thêm bản tiếng Anh (`message_en`, `advice_en`) cho i18n.

## 6. Nguyên tắc công bằng

- Rule `user_week` chỉ chạy khi đủ `min_sample`; leaderboard vẫn giữ điều kiện tối thiểu 5 session (spec 10).
- Mỗi finding phải có bằng chứng: số thứ tự turn và đoạn trích ngắn, để người bị chấm kiểm tra được.
- Không có rule nào dựa trên giờ làm việc, ngày trong tuần hay cảm xúc trong câu chữ.
- Ngưỡng ở trên là điểm khởi đầu; chỉnh sau khi chạy trên log thật của team (spec 12.2).
