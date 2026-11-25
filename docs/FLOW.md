# TeamLens — luồng chính

Bản đồ đường đi của một session từ máy thành viên tới dashboard. Mỗi khúc ghi: làm gì, code nằm ở đâu, ai sở hữu, mốc nào làm (mã task ở [TASKS.md](TASKS.md)). **Kết thúc mỗi mốc, người sở hữu khúc đó cập nhật mục "Ghi chú của người làm"** (đã làm thế nào, chỗ nào khó, cách debug) rồi giải thích cho người kia.

```
 Máy thành viên (tl.exe)                                   Server (NestJS + Postgres)                    Trình duyệt (Next.js)
 ───────────────────────                                   ──────────────────────────                    ─────────────────────
 ① Log của agent ──► ② Adapter ──► ③ Lọc phạm vi ──► ④ Che secret, cắt ──► ⑤ Hàng đợi ──► ⑥ Gửi ──► ⑦ Ingest ──► ⑧ Rule + điểm ──► ⑨ Dashboard
    (.jsonl)            chuẩn hóa      (git remote)        output               (SQLite)      HTTPS      (DB)        (pg-boss)          (leader/member)

 ⓪ Danh tính: tl login (device login) → token trong Credential Manager → mọi request /agent/v1 kèm Bearer token
```

## ⓪ Danh tính và quyền — xong ở giai đoạn nền (vùng chung)

- **Làm gì:** máy nhận device token qua luồng giống `gh auth login`; dashboard dùng cookie; mọi chỗ xem dữ liệu đi qua `AccessService` và ghi audit.
- **Code:** `cli/crates/teamlens/src/commands/{login,logout,status}.rs`, `cli/crates/tl-platform/src/credentials.rs`; `apps/api/src/modules/{device,auth,access,projects}/`; `apps/web/src/app/[locale]/(auth)/`.
- **Thử ngay:** `pnpm dev`, rồi `tl login --server http://localhost:3000`, duyệt mã bằng `member1@teamlens.local`, rồi `tl status`.

## ⓪+ Tham gia và đồng ý — Người 2, mốc 3 (M3.5–M3.8)

- **Làm gì:** leader tạo invite → thành viên mở `/i/[code]`, chạy `tl join` → device login → màn hình đồng ý (spec 4.3) → ghi bản đồng ý lên server → đăng ký daemon bằng Task Scheduler. Không đồng ý thì CLI không gửi gì.
- **Code:** `apps/api/src/modules/{invites,consent}/`, `apps/web/src/app/[locale]/(auth)/i/[code]/`, `cli/crates/teamlens/src/commands/{join,consent,uninstall}.rs`, `cli/crates/teamlens/src/consent/`, `cli/crates/tl-platform/`.
- **Ghi chú của người làm:** _(điền sau mốc 3)_

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
- **Ghi chú của người làm:** _(điền sau mốc 1 và mốc 3)_

## ⑦ Ingest — Người 1, mốc 1 (M1.6)

- **Làm gì:** `POST /agent/v1/ingest` nhận batch gzip, kiểm tra JSON Schema, kiểm tra lại repo thuộc project của user, upsert session/turn theo `(user_id, source_id)` và `(session_id, seq)` để gửi lại không bị trùng, rồi phát job `session.ingested`.
- **Code:** `apps/api/src/modules/agent/`, bảng ở `apps/api/src/db/schema/`, hàng đợi job ở `apps/api/src/queue/` (pg-boss).
- **Ghi chú của người làm:** _(điền sau mốc 1)_

## ⑧ Rule và điểm — Người 2, mốc 1 (M1.10–M1.11), mốc 2 (M2.6–M2.8), mốc 4 (M4.4)

- **Làm gì:** worker nhận `session.ingested`, chạy rule JSON (danh mục ở [RULES.md](RULES.md)), ghi `findings`, tính điểm 5 nhóm và thống kê tuần.
- **Code:** `apps/api/src/modules/rules/` (engine + worker), `apps/api/src/modules/stats/`.
- **Ghi chú của người làm:** _(điền sau mốc 1 và mốc 2)_

## ⑨ Dashboard — xem session: Người 1 (M1.8, M3.4, M4.1, M4.2); báo cáo: Người 2 (M2.9, M2.10, M4.3)

- **Làm gì:** leader xem session của thành viên trong project (có audit), member chỉ xem của mình; điểm, anti-pattern, leaderboard.
- **Code:** `apps/web/src/app/[locale]/(dashboard)/projects/[projectId]/...`, API ở `apps/api/src/modules/{sessions,stats}/`.
- **Ghi chú của người làm:** _(điền sau mốc 1)_
