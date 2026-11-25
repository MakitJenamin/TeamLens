# TeamLens — danh sách việc

Quy ước: mỗi task là một nhánh `feat/<mã>-<tên-ngắn>` và một PR. Vùng file của A và B xem ở [AGENTS.md](../AGENTS.md#3-vùng-sở-hữu-quan-trọng-nhất). Cột "Tự test" là cách người làm tự kiểm chứng trước khi mở PR.

## Giai đoạn nền (làm trước khi chia, nhánh `chore/foundation`)

| # | Việc | Trạng thái |
| --- | --- | --- |
| F1 | Monorepo gốc: pnpm workspace, turbo, `.gitignore`, `AGENTS.md`, Postgres dev | Xong |
| F2 | `packages/schema`: OpenAPI tách file, JSON Schema session v1, JSON mẫu, sinh type TS | Xong |
| F3 | `apps/api`: NestJS, Drizzle + migration đủ bảng (partition `turns`), pg-boss, seed, đăng ký sẵn mọi module | Xong |
| F4 | Auth dashboard (email + mật khẩu, cookie), `/setup` tạo admin đầu tiên | Xong |
| F5 | Project, thành viên, vai trò, repo pattern (API) + `AccessService` + `AuditService` | Xong |
| F6 | Device login (API + trang nhập mã) + guard device token cho `/agent/v1/*` + `GET /agent/v1/whoami` | Xong |
| F7 | `apps/web`: Next.js, i18n vi/en, layout + sidebar đủ link, login/setup/device, placeholder mọi màn hình | Xong |
| F8 | `cli/`: workspace 4 crate, đủ 11 lệnh (stub), `tl login`/`logout` thật + Credential Manager, `tl status` gọi `whoami` | Xong |
| F9 | CI GitHub Actions: Rust trên `windows-latest`, pnpm lint/typecheck/test, kiểm tra JSON mẫu khớp schema | Xong |

**Điểm tách:** chạy `tl login` vào server local thành công và `tl status` hiển thị đúng user, project qua `GET /agent/v1/whoami`.

## Sau điểm tách

### A · Đường dữ liệu

| # | Việc | Cần xong trước | Tự test |
| --- | --- | --- | --- |
| A1 | `tl-core`: kiểu dữ liệu session v1 | Nền | Test khớp JSON Schema với file trong `examples/` |
| A2 | Adapter Claude Code: tìm file, đọc JSONL tăng dần theo offset; thu thập fixtures đã che | A1 | Test trên fixtures |
| A3 | Adapter Claude Code: chuẩn hóa turns, usage đếm một lần theo `message.id`, session con (subagent) | A2 | Snapshot test; `tl preview <file>` in JSON |
| A4 | Lọc phạm vi theo git remote (worktree, submodule, cache) | A3 | Test repo giả; test "ngoài phạm vi không bao giờ gửi" |
| A5 | Che secret (≥30 loại + entropy) + cắt output + đổi đường dẫn tuyệt đối | A3 | Bộ test secret mẫu; `tl preview` |
| A6 | API `POST /agent/v1/ingest` (validate, idempotent `batch_id`, upsert, phát job `session.ingested`) + `GET /agent/v1/config` | Nền | Gửi file mẫu bằng curl |
| A7 | `tl sync`: pipeline đầy đủ → gửi batch gzip | A4, A5, A6 | Session thật của mình vào DB |
| A8 | API + web xem session: danh sách, chi tiết, diff, session con | A6 | Mở trình duyệt xem session vừa gửi |
| A9 | Adapter Codex (fixtures, đọc, chuẩn hóa) | A1 | Snapshot test; `tl sync` |
| A10 | Hàng đợi SQLite + retry/backoff + giới hạn 500 MB + xử lý `426` | A7 | Tắt API rồi bật lại: không mất, không trùng |
| A11 | Daemon: watch file, quét 10 phút, ổn định 2 phút; heartbeat (CLI + API); `status`/`pause`/`resume` | A10 | Dùng Claude Code và thấy session hiện lên |
| A12 | Full-text search session | A8 | Tìm theo nội dung prompt trên web |

### B · Con người và điểm số

| # | Việc | Cần xong trước | Tự test |
| --- | --- | --- | --- |
| B1 | Web quản trị project, thành viên, repo pattern (API đã có ở nền) | Nền | Thao tác trên UI |
| B2 | Invite: API + trang `/i/[code]` (tạo tài khoản từ invite) | Nền | Mở link invite bằng trình duyệt ẩn danh |
| B3 | `tl join`: lưu server từ invite → login → màn hình đồng ý → `POST /agent/v1/consent`; `consent revoke`, `uninstall` | B2 | Chạy `tl join` với invite local |
| B4 | `tl-platform`: Task Scheduler (At log on) + named mutex; `tl join` đăng ký daemon | B3 | Đăng xuất Windows rồi đăng nhập lại |
| B5 | Trang "Của tôi" (đồng ý, thiết bị, ai đã xem session của mình) + trang audit cho admin | Nền | Đăng nhập 2 tài khoản seed |
| B6 | Rule engine: thông dịch JSON (đếm, ngưỡng, regex, chuỗi liên tiếp) | Nền | Unit test trên session seed |
| B7 | Worker nhận job `session.ingested` + 15 rule đầu (seed) + ghi `findings` | B6 | Ingest file mẫu → có finding |
| B8 | Điểm 5 nhóm + `user_weekly_stats` (chỉ session gốc) | B7 | Test với dữ liệu seed |
| B9 | Màn hình tổng quan project + hồ sơ thành viên | B8 | Xem trên web với dữ liệu seed |
| B10 | Leaderboard (công tắc theo project) + màn hình quản lý rule (thử 50 session, chạy lại) | B8 | Xem trên web |
| B11 | Job retention (drop partition) + `install.ps1` + workflow GitHub Release `tl.exe` kèm SHA-256 | Nền | Chạy job với retention 1 ngày; cài thử bằng `install.ps1` |

### Mốc ghép

- **A7 + B3:** thành viên mới `tl join` từ invite rồi `tl sync` được.
- **A11 + B7:** session thật đi qua daemon và tự được chấm điểm.
- Sau đó: chạy tiêu chí hoàn thành mục 12.3 của spec.
