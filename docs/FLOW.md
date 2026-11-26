# TeamLens — luồng chính

Bản đồ đường đi của một session từ máy thành viên tới dashboard. Mỗi khúc ghi: làm gì, code nằm ở đâu, ai sở hữu, mốc nào làm (mã task ở [TASKS.md](TASKS.md)). **Kết thúc mỗi mốc, người sở hữu khúc đó cập nhật mục "Ghi chú của người làm"** (đã làm thế nào, chỗ nào khó, cách debug) rồi giải thích cho người kia.

```
 Máy thành viên (tl.exe)                                   Server (NestJS + Postgres)                    Trình duyệt (Next.js)
 ───────────────────────                                   ──────────────────────────                    ─────────────────────
 ① Log của agent ──► ② Adapter ──► ③ Lọc phạm vi ──► ④ Che secret, cắt ──► ⑤ Hàng đợi ──► ⑥ Gửi ──► ⑦ Ingest ──► ⑧ Rule + điểm ──► ⑨ Dashboard
    (.jsonl)            chuẩn hóa      (git remote)        output               (SQLite)      HTTPS      (DB)        (pg-boss)          (leader/member)

 ⓪ Danh tính: tl join <link mời> → đồng ý → mã mời đổi lấy device token trong Credential Manager → mọi request /agent/v1 kèm Bearer token
```

## ⓪ Danh tính và quyền — giai đoạn nền, đổi ở Mốc 1.5 (J.1–J.10)

- **Làm gì (đích Mốc 1.5, SPEC 7.1 và 11.1):** chỉ hai vai trò toàn server: leader (làm mọi thứ, đăng nhập web bằng email + mật khẩu) và member (không email, không mật khẩu). Device token là danh tính của member; member vào dashboard bằng `tl open` (ticket một lần → cookie). Mọi chỗ xem dữ liệu đi qua `AccessService` và ghi audit.
- **Hiện trạng trên `main` (trước Mốc 1.5):** máy nhận token qua device login giống `gh auth login` (`device_codes`, trang `/device`); vai trò admin + leader/member theo project.
- **Code:** `cli/crates/teamlens/src/commands/{login,logout,status}.rs`, `cli/crates/tl-platform/src/credentials.rs`; `apps/api/src/modules/{device,auth,access,projects}/`; `apps/web/src/app/[locale]/(auth)/`.
- **Thử ngay (hiện trạng):** `pnpm dev`, rồi `tl login --server http://localhost:3000`, duyệt mã bằng `member1@teamlens.local`, rồi `tl status`.

## ⓪+ Tham gia và đồng ý — Người 2, Mốc 1.5 (J.1, J.3, J.5, J.7, J.9) và mốc 3 (M3.5–M3.8)

- **Làm gì:** leader chạy wizard `/setup` (tài khoản + project + repo) → nhận link mời chung → gửi cho nhóm → thành viên chạy đúng một lệnh `tl join <link>` (hoặc `install.ps1?code=…`): xem trước link (`GET /agent/v1/invites/{code}`) → màn hình đồng ý trong terminal (tên, backfill, `yes`) → `POST /agent/v1/join` tạo user + thành viên project + thiết bị + bản đồng ý trong một transaction, trả device token → đăng ký daemon bằng Task Scheduler. Không đồng ý thì CLI không gửi gì. Máy thứ hai hoặc cài lại Windows tạo user mới; leader gộp trên trang Thành viên (J.8, Người 1).
- **Code:** `apps/api/src/modules/{invites,consent}/`, `apps/web/src/app/[locale]/(auth)/i/[code]/`, `cli/crates/teamlens/src/commands/{join,consent,uninstall}.rs`, `cli/crates/teamlens/src/consent/`, `cli/crates/tl-platform/`.
- **Ghi chú của người làm:** _(điền sau Mốc 1.5 và mốc 3)_

## ① → ② Đọc log và chuẩn hóa — Người 1, mốc 1 (M1.3), mốc 2 (M2.3–M2.5)

- **Làm gì:** tìm file log của Claude Code (`%USERPROFILE%\.claude\projects\...\*.jsonl`) và Codex (`%USERPROFILE%\.codex\sessions\...`), đọc từng dòng, biến thành schema chung `session.v1` (spec mục 5). Server không bao giờ biết định dạng log gốc.
- **Code:** `cli/crates/tl-adapters/src/{claude_code,codex}/`, kiểu dữ liệu ở `cli/crates/tl-core/src/session.rs`, contract ở `packages/schema/session.v1.schema.json`.
- **Ghi chú của người làm:** _(điền sau mốc 1)_

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
  - Gửi (`sync/mod.rs::send_all`): 413 → chia đôi (theo session, rồi theo turn) và gửi lại; 429 → chờ `Retry-After` (tối đa 120 s) rồi thử lại một lần cùng `batch_id`; 401/403/426/lỗi mạng → dừng, exit 1 kèm gợi ý.
  - Chưa có hàng đợi/offset: mỗi `tl sync` gửi lại toàn bộ session trong phạm vi (server idempotent). M2.3 đọc tăng dần, M3.1 thay bằng hàng đợi `state.db`. Điểm móc consent: `sync/consent_gate.rs::may_send()` (luôn `true`, chờ module `consent` của M3.7).

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
