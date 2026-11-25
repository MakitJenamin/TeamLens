# TeamLens — kế hoạch việc

Mục tiêu của hai người làm dự án: **trải nghiệm và hiểu luồng chính** từ máy thành viên tới dashboard, không chỉ một nửa. Vì vậy kế hoạch đi theo mốc:

- **Mốc 1 là "xương sống":** một session thật đi hết luồng sớm nhất có thể, bản đơn giản nhất.
- **Các mốc sau làm dày dần** từng khúc của luồng.
- **Đổi vai sau mỗi mốc:** ai làm phía máy (CLI) ở mốc trước thì làm phía server ở mốc sau, và ngược lại. Mốc 3 trở đi mỗi người làm một tính năng xuyên cả CLI, API và web.
- **Trong một mốc, hai người có vùng file tách nhau** (ghi ở đầu mỗi mốc), nên làm song song không conflict.
- **Kết thúc mỗi mốc:** demo trên máy thật, mỗi người cập nhật phần mình trong [FLOW.md](FLOW.md) rồi giải thích cho người kia.

**X** và **Y** là hai người (tự chọn ai là X). Mỗi task là một nhánh `feat/<mã>-<tên-ngắn>` (ví dụ `feat/m1x3-claude-adapter`) và một PR; CI phải xanh cả `validate` và `rust-windows` mới merge. Cột "Tự test" là cách tự kiểm chứng trước khi mở PR.

Thứ tự trong mỗi bảng là thứ tự nên làm. Task có ghi "PR contract" thì merge trước để người kia code theo.

## Giai đoạn nền — xong

Monorepo, contract, API (auth, project, quyền, audit, device login), web (login/setup/device, layout), CLI (`tl login`/`logout`/`status`), CI. Chi tiết ở PR #1.

---

## Mốc 1 · Xương sống: một session thật từ máy lên dashboard, có một finding

**X làm phía máy** (`cli/`, `packages/schema/session.v1.schema.json`, `packages/schema/examples/`) · **Y làm phía server** (`apps/api/src/modules/{agent,rules,sessions}`, `apps/web/.../projects/[projectId]/sessions/`, `packages/schema/openapi/{agent,sessions}.yaml`)

| # | X · phía máy | Tự test |
| --- | --- | --- |
| M1-X1 | **PR contract:** thêm 4 trường tùy chọn vào `session.v1.schema.json` (`permission_mode`, `instruction_files`, `interrupted`, `reasoning_effort`, xem [RULES.md](RULES.md) mục 4) + cập nhật `examples/` | `pnpm --filter @teamlens/schema test` |
| M1-X2 | `tl-core`: struct `serde` cho session v1 | Test serialize mọi file `examples/` khớp JSON Schema |
| M1-X3 | Adapter Claude Code bản đơn giản: tìm file, đọc **cả file**, chuẩn hóa prompt/reply/tool_call/tool_result/diff, usage đếm một lần theo `message.id`. Fixtures lấy từ máy mình, **che hết secret và đường dẫn cá nhân** trước khi commit | Snapshot test trên fixtures |
| M1-X4 | Lọc phạm vi theo git remote (đọc mọi remote, chuẩn hóa, khớp pattern lấy từ `whoami`) | Test repo giả; test "session ngoài phạm vi không bao giờ vào payload" |
| M1-X5 | Che secret bản cơ bản (khoảng 10 loại phổ biến) + cắt output theo spec 6.3 + đổi đường dẫn tuyệt đối thành tương đối | Unit test; `tl preview` không còn secret mẫu |
| M1-X6 | `tl preview [file]` và `tl sync --once`: pipeline lọc → chuẩn hóa → che → cắt → gửi một batch gzip lên `POST /agent/v1/ingest` (chưa có hàng đợi, chưa chạy nền) | Chạy trên máy thật với server local |

| # | Y · phía server | Tự test |
| --- | --- | --- |
| M1-Y1 | **PR contract:** viết `openapi/agent.yaml` cho `POST /agent/v1/ingest` (request = `IngestBatch`, `202`, `426`, lỗi) và `openapi/sessions.yaml` cho `GET /api/v1/projects/{projectId}/sessions`, `GET /api/v1/sessions/{sessionId}` | `pnpm --filter @teamlens/schema build` |
| M1-Y2 | API ingest: validate bằng `ajv`, idempotent theo `batch_id`, upsert session/turn, kiểm tra `repo_remote` thuộc project của user (chọn pattern cụ thể nhất), phát job `session.ingested` | Gửi file trong `examples/` bằng curl; gửi lại lần 2 không trùng |
| M1-Y3 | Rule engine lõi: phạm vi `session`, phép đếm/ngưỡng/regex/chuỗi liên tiếp, chạy `tests` nội tuyến (RULES.md mục 5). Seed 3 rule: `repeated-correction`, `mega-session`, `no-test-after-edit` | Unit test: mọi `tests` của rule seed qua |
| M1-Y4 | Worker `session.ingested`: chạy rule → ghi `findings` + `session_scores` | Ingest file mẫu → có finding trong DB |
| M1-Y5 | API + web xem session: danh sách theo project, trang chi tiết (prompt, reply, tool call thu gọn, diff dạng text, turn dính finding được đánh dấu). Dùng `AccessService` + ghi audit khi xem người khác | Mở trình duyệt với dữ liệu seed và dữ liệu vừa ingest |

**Demo mốc 1:** X dùng Claude Code trong repo TeamLens, chạy `tl sync --once` → Y mở dashboard thấy đúng session đó, có finding. Cả hai viết phần mình vào `FLOW.md`.

---

## Mốc 2 · Làm dày luồng (đổi vai: X làm server, Y làm máy)

**Y làm phía máy** (`cli/`) · **X làm phía server** (`apps/api/src/modules/{agent,rules,stats,sessions}`, `apps/web/.../sessions/`)

| # | Y · phía máy | Tự test |
| --- | --- | --- |
| M2-Y1 | Che secret đầy đủ: ≥ 30 loại theo gitleaks + kiểm tra entropy sau từ khóa + bỏ output file `.env*`/`*.pem`/`*.key`; nhận thêm pattern từ `GET /agent/v1/config` | Bộ test ≥ 30 secret mẫu bị che 100% |
| M2-Y2 | Đọc tăng dần theo offset, lưu offset trong SQLite `state.db`; session coi là ổn định khi file không đổi 2 phút | Thêm dòng vào file log → chỉ phần mới được gửi |
| M2-Y3 | Claude Code đầy đủ: subagent thành session con, điền `permission_mode`, `instruction_files`, `interrupted`, compaction | Snapshot test có subagent |
| M2-Y4 | Adapter Codex (fixtures, đọc, chuẩn hóa, `reasoning_effort`) | Snapshot test; `tl sync --once` gửi được session Codex |

| # | X · phía server | Tự test |
| --- | --- | --- |
| M2-X1 | **PR contract** + API `GET /agent/v1/config`: pattern remote, pattern redaction của admin, ngưỡng cắt, phiên bản văn bản đồng ý, phiên bản CLI tối thiểu | curl bằng device token |
| M2-X2 | Rule engine: phạm vi `user_week`, `aggregate: ratio`, `min_sample`; seed đủ 16 rule mức high/medium của RULES.md | Unit test `tests` nội tuyến |
| M2-X3 | Điểm 5 nhóm + `user_weekly_stats` (chỉ session gốc) + API "chạy lại rule" | Test với dữ liệu seed |
| M2-X4 | Web xem session nâng cao: diff tô màu (`react-diff-view`), session con lồng trong session cha, ghi chú của leader theo turn | Xem session có subagent và diff lớn |

**Demo mốc 2:** session Claude Code (có subagent) và Codex lên dashboard, secret đã che, có điểm 5 nhóm.

---

## Mốc 3 · Onboarding và chạy nền (mỗi người một tính năng xuyên CLI → API → web)

**X: thành viên mới tham gia** (`apps/api/src/modules/{invites,consent}`, web trang `/i/[code]` và `admin/`, lệnh `join`/`consent`/`uninstall`, Task Scheduler trong `tl-platform`) · **Y: chạy nền và trạng thái** (`cli/crates/teamlens/src/{queue,daemon,sync}`, lệnh `daemon`/`pause`/`resume`/`status`, heartbeat trong `apps/api/src/modules/agent`, trang `members/`)

| # | X · tham gia | Tự test |
| --- | --- | --- |
| M3-X1 | Web quản trị: project, thành viên, repo pattern, user (API đã có từ giai đoạn nền) | Thao tác trên UI |
| M3-X2 | Invite: API tạo/thu hồi invite + trang `/i/[code]` (tạo tài khoản hoặc đăng nhập rồi vào project) | Mở link bằng trình duyệt ẩn danh |
| M3-X3 | `tl join <url>`: lưu server → device login → màn hình đồng ý (spec 4.3, hỏi backfill) → `POST /agent/v1/consent`; `tl consent revoke`, `tl uninstall` | Chạy `tl join` với invite local |
| M3-X4 | Task Scheduler "At log on" trong `tl-platform`; `tl join` đăng ký daemon, `uninstall` gỡ | Đăng xuất Windows rồi đăng nhập lại |

| # | Y · chạy nền | Tự test |
| --- | --- | --- |
| M3-Y1 | Hàng đợi batch trong SQLite (đã che mới được ghi), retry backoff tối đa 30 phút, giới hạn 500 MB, xử lý `426` | Tắt API rồi bật lại: không mất, không trùng |
| M3-Y2 | `tl daemon`: named mutex, watch file (`notify`), quét lại 10 phút | Dùng Claude Code và thấy session tự lên |
| M3-Y3 | Heartbeat: CLI gửi 15 phút một lần + API cập nhật trạng thái `devices`; `tl pause`/`resume`; `tl status` đầy đủ | Pause → dashboard thấy "tạm dừng" |
| M3-Y4 | Web bảng trạng thái thành viên: online, offline N ngày, tạm dừng, đã rút đồng ý | Xem trên trang thành viên |

**Demo mốc 3:** người mới nhận link invite → `tl join` → đồng ý → làm việc bình thường, session tự lên dashboard.

---

## Mốc 4 · Dashboard cho leader và member

**X: số liệu và xếp hạng** (`overview/`, `members/[userId]`, `leaderboard/`, `apps/api/src/modules/stats`) · **Y: rule, tìm kiếm, minh bạch** (`rules/`, `me/`, `admin/` phần audit, `apps/api/src/modules/{rules,sessions}`)

| # | X | Tự test |
| --- | --- | --- |
| M4-X1 | Tổng quan project: session, token, chi phí ước tính theo tuần, phân bố agent/model, thống kê không tính điểm (RULES.md mục 2), top anti-pattern | Dữ liệu seed + dữ liệu thật |
| M4-X2 | Hồ sơ thành viên: radar 5 nhóm, xu hướng theo tuần, anti-pattern hay mắc kèm ví dụ và lời khuyên | Xem hồ sơ member1 |
| M4-X3 | Leaderboard: tuần/tháng, ngưỡng 5 session, công tắc theo project, chế độ công khai cho member | Đăng nhập bằng leader và member |

| # | Y | Tự test |
| --- | --- | --- |
| M4-Y1 | Màn hình quản lý rule: bật/tắt, chỉnh ngưỡng và mức độ, xem JSON, "Thử trên 50 session gần nhất", "Chạy lại"; seed 8 rule mức low | Đổi ngưỡng rồi chạy lại |
| M4-Y2 | Full-text search session (`tsvector`) | Tìm theo nội dung prompt |
| M4-Y3 | Trang "Của tôi": đồng ý đã cấp, thiết bị (thu hồi được), ai đã xem session của mình; trang audit cho admin | Đăng nhập 2 tài khoản |

**Demo mốc 4:** leader xem tổng quan, hồ sơ, leaderboard; member chỉ thấy dữ liệu của mình.

---

## Mốc 5 · Phát hành và nghiệm thu

**X: server** (`deploy/`, `apps/api/src/modules/{retention,admin}`) · **Y: CLI** (`deploy/install.ps1`, `.github/workflows/release.yml`, self-update trong `cli/`)

| # | X | Tự test |
| --- | --- | --- |
| M5-X1 | `deploy/docker-compose.yml` production (api, web, postgres, caddy) + `Caddyfile` + Dockerfile cho api/web + hướng dẫn cài | Cài trên VPS hoặc máy ảo sạch dưới 15 phút |
| M5-X2 | Job retention hằng đêm (drop partition `turns`, tạo partition mới) + cấu hình retention trong trang quản trị | Chạy với retention 1 ngày |
| M5-X3 | Admin xóa toàn bộ dữ liệu của một người (spec 6.4) | Xóa member2 rồi kiểm tra DB |

| # | Y | Tự test |
| --- | --- | --- |
| M5-Y1 | Workflow GitHub Release build `tl.exe` + SHA-256 | Tạo tag thử |
| M5-Y2 | `GET /install.ps1` + script: tải, kiểm SHA-256, đặt vào `%LOCALAPPDATA%\teamlens\bin`, thêm PATH, chạy `tl join` | Cài trên máy Windows khác |
| M5-Y3 | `self_update` từ GitHub Releases khi server trả `426` hoặc có bản mới | Hạ phiên bản rồi chạy |

**Nghiệm thu chung:** chạy đủ tiêu chí mục 12.3 của [SPEC.md](SPEC.md) (cài server < 15 phút, ngắt mạng 24 giờ, RAM daemon < 30 MB với > 1.000 session, 30 loại secret, session ngoài phạm vi không rời máy).
