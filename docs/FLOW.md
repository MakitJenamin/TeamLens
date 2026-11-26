# TeamLens — luồng chính

Bản đồ đường đi của một session từ máy thành viên tới dashboard. Mỗi khúc ghi: làm gì, code nằm ở đâu, ai sở hữu, mốc nào làm (mã task ở [TASKS.md](TASKS.md)). **Kết thúc mỗi mốc, người sở hữu khúc đó cập nhật mục "Ghi chú của người làm"** (đã làm thế nào, chỗ nào khó, cách debug) rồi giải thích cho người kia.

```
 Máy thành viên (tl.exe)                                   Server (NestJS + Postgres)                    Trình duyệt (Next.js)
 ───────────────────────                                   ──────────────────────────                    ─────────────────────
 ① Log của agent ──► ② Adapter ──► ③ Lọc phạm vi ──► ④ Che secret, cắt ──► ⑤ Hàng đợi ──► ⑥ Gửi ──► ⑦ Ingest ──► ⑧ Rule + điểm ──► ⑨ Dashboard
    (.jsonl)            chuẩn hóa      (git remote)        output               (SQLite)      HTTPS      (DB)        (pg-boss)          (leader/member)

 ⓪ Danh tính: tl join <link mời> → đồng ý → mã mời đổi lấy device token trong Credential Manager → mọi request /agent/v1 kèm Bearer token
```

## ⓪ Danh tính và quyền — giai đoạn nền, làm lại ở Mốc 1.5 (J.1–J.10)

- **Làm gì (SPEC 7.1 và 11.1):** chỉ hai vai trò toàn server: leader (làm mọi thứ, đăng nhập web bằng email + mật khẩu) và member (không email, không mật khẩu). Device token là danh tính của member; member vào dashboard bằng `tl open` (ticket một lần → cookie). Mọi chỗ xem dữ liệu đi qua `AccessService` và ghi audit.
- **Code:** `cli/crates/teamlens/src/commands/{join,open,logout,status}.rs`, `cli/crates/tl-platform/src/credentials.rs`; `apps/api/src/modules/{device,auth,access,projects}/`; `apps/web/src/app/[locale]/(auth)/`.
- **Thử ngay:** `pnpm db:seed && pnpm dev`, rồi `tl join http://localhost:3000/i/seed-invite-teamlens` (đồng ý bằng `yes`), `tl status`, `tl open`. Dashboard leader: `leader@teamlens.local` / `teamlens123`. Seed còn in device token của hai member mẫu để gọi thẳng API (`curl -H "Authorization: Bearer <token>" http://localhost:3000/agent/v1/whoami`).

## ⓪+ Tham gia và đồng ý — Người 2, Mốc 1.5 (J.1, J.3, J.5, J.7, J.9) và mốc 3 (M3.5–M3.8)

- **Làm gì:** leader chạy wizard `/setup` (tài khoản + project + repo) → nhận link mời chung → gửi cho nhóm → thành viên chạy đúng một lệnh `tl join <link>` (hoặc `install.ps1?code=…`): xem trước link (`GET /agent/v1/invites/{code}`) → màn hình đồng ý trong terminal (tên, backfill, `yes`) → `POST /agent/v1/join` tạo user + thành viên project + thiết bị + bản đồng ý trong một transaction, trả device token → đăng ký daemon bằng Task Scheduler. Không đồng ý thì CLI không gửi gì. Máy thứ hai hoặc cài lại Windows tạo user mới; leader gộp trên trang Thành viên (J.8, Người 1).
- **Code:** `apps/api/src/modules/{invites,consent}/`, `apps/web/src/app/[locale]/(auth)/i/[code]/`, `cli/crates/teamlens/src/commands/{join,consent,uninstall}.rs`, `cli/crates/teamlens/src/consent/`, `cli/crates/tl-platform/`.
- **Ghi chú của người làm:** CLI (J.5): `tl join`/`tl login <link>` ở `commands/join.rs` (tách link, xem trước, hỏi tên/backfill/`yes`, `409 consent_outdated` thì xem lại; máy đã có token còn hiệu lực thì gửi Bearer và giữ token cũ). Bản đồng ý lưu ở bảng `[consent]` của `config.toml` (`consent/`); `tl sync` không gửi khi chưa đồng ý cho server hiện tại, bỏ session của project chưa đồng ý và session cũ khi không backfill. `tl open` ở `commands/open.rs`. Task Scheduler (M3.8) chưa làm: `tl join` chỉ nhắc chạy `tl sync`.

## ① → ② Đọc log và chuẩn hóa — Người 1, mốc 1 (M1.3), mốc 2 (M2.3–M2.5)

- **Làm gì:** tìm file log của Claude Code (`%USERPROFILE%\.claude\projects\...\*.jsonl`) và Codex (`%USERPROFILE%\.codex\sessions\...`), đọc từng dòng, biến thành schema chung `session.v1` (spec mục 5). Server không bao giờ biết định dạng log gốc.
- **Code:** `cli/crates/tl-adapters/src/{claude_code,codex}/`, kiểu dữ liệu ở `cli/crates/tl-core/src/session.rs`, contract ở `packages/schema/session.v1.schema.json`.
- **Ghi chú của người làm:** Claude Code (M2.4): `discover` trả cả `<uuid>\subagents\agent-*.jsonl`; mỗi file subagent là một session con `claude_code:<sessionId>:<agentId>` với `parent_source_id = claude_code:<sessionId>` (server nối cha/con theo `parent_source_id`, cha tới sau con cũng được). Bản tóm tắt sau compaction (`isCompactSummary`) thành turn `compaction`; `permission_mode` lấy chế độ thoáng nhất trong session; `instruction_files` do pipeline điền ở bước `prepare`, không phải adapter. Chi tiết định dạng log ở doc đầu `claude_code/normalize.rs`. Codex (M2.5): mỗi file `rollout-*.jsonl` (trong `sessions\YYYY\MM\DD\` và `archived_sessions\`, root đổi qua `CODEX_HOME`) là một session `codex:<id>`; session fork bỏ phần lịch sử chép từ session cha (nhận ra bằng mốc thời gian UUIDv7 của `turn_id`); prompt lấy từ `event_msg/user_message`, bỏ tin nhắn Codex tự chèn; usage cộng `last_token_usage` khi `total_token_usage` đổi (`input` trừ phần `cached_input_tokens`); `reasoning_effort` từ `turn_context.effort`; diff `apply_patch` từ `patch_apply_end`. Chi tiết ở doc đầu `codex/normalize.rs`.

## ③ Lọc phạm vi — Người 1, mốc 1 (M1.4)

- **Làm gì:** từ `cwd` của session, tìm `.git`, đọc remote, so với pattern repo của project. Không khớp thì bỏ **toàn bộ**, kể cả metadata (spec 6.1). Đây là lời hứa quyền riêng tư quan trọng nhất.
- **Code:** `cli/crates/tl-core/src/scope.rs` (logic thuần) + phần đọc git trong `cli/crates/teamlens/src/pipeline/`.
- **Ghi chú của người làm:** _(điền sau mốc 1)_

## ④ Che secret và cắt output — Người 1, mốc 1 (M1.5), mốc 2 (M2.1)

- **Làm gì:** thay secret bằng `[REDACTED:<loại>]`, cắt output đọc file/chạy lệnh (giữ 2 KB đầu, 1 KB cuối), đổi đường dẫn tuyệt đối thành tương đối. Chạy **trước khi** dữ liệu được ghi ra đĩa hay gửi đi.
- **Code:** `cli/crates/tl-core/src/{redact,truncate}.rs`. Xem payload cuối cùng bằng `tl preview`.
- **Ghi chú của người làm:** _(điền sau mốc 1 và mốc 2)_

## ⑤ → ⑥ Hàng đợi và gửi — Người 1, mốc 1 (M1.7), mốc 3 (M3.1–M3.3)

- **Làm gì:** mốc 1 chỉ có `tl sync --once` gửi thẳng. Mốc 3 thêm hàng đợi SQLite (`%LOCALAPPDATA%\teamlens\state.db`), retry khi mất mạng, daemon tự chạy khi đăng nhập Windows và heartbeat 15 phút.
- **Code:** `cli/crates/teamlens/src/{sync,queue,daemon}/`, `cli/crates/teamlens/src/api_client/`.
- **Ghi chú của người làm:**
  - Mốc 1 (M1.7): chuỗi xử lý ở `cli/crates/teamlens/src/pipeline/` — `collect` (discover → đọc cả file từ offset 0 → normalize → `ScopeFilter::scope_of` ngay sau normalize; ngoài phạm vi chỉ tăng bộ đếm) → `prepare` (điền `repo_remote`/`branch`/`cwd_relative`/`instruction_files`; mỗi chuỗi: che secret → đổi đường dẫn → che tên user Windows/tên máy thành `[USER]`/`[HOST]` → cắt) → `batch` (JSON < 8 MB, session quá lớn chia theo turn, gzip).
  - `prepare` bỏ hẳn `diff` của file ngoài repo (schema chỉ nhận đường dẫn tương đối gốc repo); file `.env*`, `*.pem`, `*.key` bị thay toàn bộ output/patch/nội dung input bằng `[REDACTED:sensitive_file]`. Tool input cắt từng chuỗi lồng nhau (4 KB), không cắt JSON nguyên khối. Thinking không có trong schema v1 nên chưa cắt.
  - File log sửa trong 2 phút gần nhất coi là còn đang ghi → `ended_at = null`.
  - Gửi (M1.7, nay ở `queue::flush`): 413 → chia đôi (theo session, rồi theo turn) và gửi lại; 429 → chờ `Retry-After` (tối đa 120 s) rồi thử lại một lần cùng `batch_id`; 401/403/426/lỗi mạng → dừng, exit 1 kèm gợi ý.
  - Điểm móc consent: `sync/consent_gate.rs::may_send()`.
  - Mốc 2 (M2.2): `tl sync`/`tl preview` không gọi `whoami` nữa mà tải `GET /agent/v1/config` (`sync/agent_config.rs`, gọi trong `sync::connect`): repo pattern cho `ScopeFilter`, ngưỡng cắt vào `PrepareOptions.limits`, `redaction_patterns` vào `PrepareOptions.server_redaction_patterns` (M2.1 nối vào `Redactor`). Bản gần nhất cache ở `<thư mục dữ liệu>/agent_config.json` (kèm `server_url`), dùng khi lỗi mạng hoặc HTTP 5xx. Trước khi quét: `min_cli_version` lớn hơn bản đang chạy, hoặc không project nào trong `[consent]` đồng ý đúng `consent_text_version` → dừng, exit 1, không gửi gì (`--dry-run`/`preview` chỉ in lưu ý). API: `apps/api/src/modules/agent/agent-config.*`, đọc `settings` (`redaction_patterns`, `truncation`) và env `MIN_CLI_VERSION`.
  - Mốc 2 (M2.3): gửi tăng dần theo `state.db` (`cli/crates/teamlens/src/state/`, migration theo `PRAGMA user_version`; bảng `source_files`, `source_sessions`, `parse_errors`, `meta`; không lưu nội dung session). Logic ở `sync/incremental.rs`: file không đổi (size + mtime) thì không đọc; file sửa chưa tới 2 phút (`STABLE_AFTER`) thì chờ, trừ khi `tl sync --include-active`; file đổi thì đọc + chuẩn hóa **cả file** (normalize cần ngữ cảnh cả file) nhưng mỗi session chỉ gửi turn `seq` ≥ `resend_from` (min của turn cuối, assistant cuối, tool_call chưa có kết quả); file ngắn lại → gửi lại từ đầu. Offset chỉ ghi khi server nhận đủ (202) mọi batch chứa turn của file (từ M3.1: qua tiến độ đặt chỗ của hàng đợi). Đổi server/repo pattern/đồng ý (`meta.scope_fingerprint`) → quên mọi offset. Gửi lúc file còn ghi (`ended_at = null`) thì khi ổn định gửi lại turn cuối để chốt `ended_at`. `tl status` in số file đang chờ ổn định.
  - Mốc 3 (M3.1): hàng đợi batch trong `state.db` (`cli/crates/teamlens/src/queue/`, migration `user_version` 2: `queue_batches`, `queue_reservations`, `queue_reservation_batches`). `tl sync`: quét → prepare (đã che) → `queue::enqueue` (gom batch, gzip, `batch_id` cố định; **cùng transaction** ghi bản "đặt chỗ" tiến độ của từng file) → `queue::flush` (hỏi `consent_gate::may_send` + `agent_config::check_send` trước; gửi theo thứ tự cũ trước, giữ `batch_id` khi gửi lại). Offset thật (`source_files`/`source_sessions`) chỉ chốt khi mọi batch của lần đặt chỗ xong, lần đặt chỗ sau của cùng file chờ lần trước; lần quét sau so với bản đặt chỗ (`StateDb::effective_file`) nên mất mạng quét nhiều lần không xếp hàng trùng. Lỗi mạng/5xx/408 → `attempts + 1`, hẹn lại theo exponential backoff có jitter (30 s · 2^(n-1), hệ số 0,5–1, trần 30 phút) rồi dừng lượt (giữ thứ tự); 429 → hẹn theo `Retry-After` (`tl sync` chạy tay chờ tại chỗ một lần nếu ≤ 120 s); 413 → chia đôi thành hai batch mới đứng đúng chỗ cũ, một turn vẫn quá lớn → hỏng; 426 hoặc `min_cli_version` → dừng, giữ hàng đợi (`FlushStop::UpgradeRequired`); 401/403/chưa đồng ý → dừng, giữ hàng đợi (`FlushStop::Blocked`); 4xx khác → batch "hỏng" (`status = failed`, bỏ nội dung, giữ lý do), không thử lại. Vượt `MAX_QUEUE_BYTES` (500 MB) → bỏ batch chờ cũ nhất, cộng dồn `meta.queue_dropped_batches`. Batch hỏng/bị bỏ coi như xong với tiến độ (offset vẫn tiến, phần đó mất và được đếm). Phạm vi gửi đổi → `queue::clear` + quên offset. `tl sync` chạy tay bỏ qua backoff (`FlushOptions { ignore_backoff: true }`); daemon dùng `FlushOptions::background(now)`. API cho M3.2/M3.3: `queue::{enqueue, flush, queue_stats, list_pending, clear}`, `QueueStats { pending_batches, pending_bytes, failed_batches, dropped_batches, next_attempt_at, last_error }`. `tl status` in dòng "Hàng đợi" (JSON: `queue`).

## ⑦ Ingest — Người 1, mốc 1 (M1.6)

- **Làm gì:** `POST /agent/v1/ingest` nhận batch gzip, kiểm tra JSON Schema, kiểm tra lại repo thuộc project của user, upsert session/turn theo `(user_id, source_id)` và `(session_id, seq)` để gửi lại không bị trùng, rồi phát job `session.ingested`.
- **Code:** `apps/api/src/modules/agent/`, bảng ở `apps/api/src/db/schema/`, hàng đợi job ở `apps/api/src/queue/` (pg-boss).
- **Ghi chú của người làm:**
  - Body đọc bằng middleware `ingest-body.ts` (đăng ký trong `setup-app.ts` trước parser 100 KB của Nest): gzip, tối đa 10 MB sau giải nén → 413.
  - Thứ tự kiểm tra: 429 (60 request/phút/thiết bị, đếm trong bộ nhớ) → 426 nếu `schema_version` là số khác 1 → ajv (`session.v1.schema.json`) → 400.
  - Idempotent: bảng `ingest_batches` khóa `(user_id, batch_id)`, giữ chỗ ở đầu transaction nên hai request song song cùng batch cũng chỉ ghi một lần.
  - Project: pattern khớp đúng thắng `host/org/*`; `*` chỉ thay một đoạn (không khớp subgroup).
  - Turn upsert theo `(session_id, seq)` bằng xóa seq cũ rồi ghi lại (PK thật có `ts`). Tổng token và `turn_count` tính lại từ mọi turn của session.
  - Cha–con: lưu `parent_source_id`; cha tới sau thì `UPDATE` nối các con đang chờ.
  - Job `session.ingested` enqueue cùng transaction qua `fromDrizzle(tx, sql)` của pg-boss; mỗi lần session được nhận (kể cả gửi tăng dần) sinh một job.
  - Chưa kiểm tra consent: TODO M3.7 trong `ingest.service.ts` (chuyển thành task J.9 ở Mốc 1.5).

## ⑧ Rule và điểm — Người 2, mốc 1 (M1.10–M1.11), mốc 2 (M2.6–M2.8), mốc 4 (M4.4)

- **Làm gì:** worker nhận `session.ingested`, chạy rule JSON (danh mục ở [RULES.md](RULES.md)), ghi `findings`, tính điểm 5 nhóm và thống kê tuần.
- **Code:** `apps/api/src/modules/rules/` (engine + worker), `apps/api/src/modules/stats/`.
- **Ghi chú của người làm:** _(điền sau mốc 1 và mốc 2)_

## ⑨ Dashboard — xem session: Người 1 (M1.8, M3.4, M4.1, M4.2); báo cáo: Người 2 (M2.9, M2.10, M4.3)

- **Làm gì:** leader xem session của thành viên trong project (có audit), member chỉ xem của mình; điểm, anti-pattern, leaderboard.
- **Code:** `apps/web/src/app/[locale]/(dashboard)/projects/[projectId]/...`, API ở `apps/api/src/modules/{sessions,stats}/`.
- **Ghi chú của người làm:**
  - M1.8 (xem session): API `apps/api/src/modules/sessions/` (danh sách cursor `startedAt` giảm dần rồi `id`, mặc định ẩn session con; chi tiết kèm turn theo `seq`, jsonb snake_case → camelCase ở `session-mappers.ts`). Quyền qua `AccessService` (`hasProjectRole` cho danh sách, `canViewUserData` cho lọc `userId` và chi tiết); xem chi tiết session người khác ghi audit `session.view`. Web ở `sessions/_components/` (bảng + "Tải thêm", dòng thời gian, tool call thu gọn, diff text tô màu +/-). Finding gọi `GET /api/v1/sessions/{id}/findings` không type, đọc phòng thủ (`parseFindings`); lỗi/404 thì ẩn khu vực finding.
