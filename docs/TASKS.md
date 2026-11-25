# TeamLens — kế hoạch việc

Mỗi người **sở hữu trọn một nhóm tính năng từ CLI tới DB tới web** (kiểu *stream-aligned team* trong Team Topologies) và giữ vùng đó suốt dự án. Các nguyên tắc đi kèm:

- **Mốc 1 chạy hết luồng trước, các mốc sau nâng cấp từng khúc.** Giống làm đường: mở con đường đất nối hai đầu trước (session thật đi từ máy lên dashboard, mỗi khúc ở mức tối thiểu), rồi mới trải nhựa từng đoạn. Lỗi ghép nối lộ ra ngay tuần đầu.
- **Contract trước:** task ghi "PR contract" thì merge trước để người kia code theo.
- **Mỗi mốc kết thúc bằng demo chung** trên máy thật. Mỗi người cập nhật phần mình trong [FLOW.md](FLOW.md) và giải thích cho người kia.
- **Mỗi người tự test được phần mình** nhờ dữ liệu seed, server local (`pnpm dev`), device login thật và file mẫu `packages/schema/examples/`. Cột "Tự test" ghi cách làm.
- **Mỗi task là một nhánh** `feat/<mã>-<tên-ngắn>` (ví dụ `feat/m1.3-claude-adapter`) và một PR; CI phải xanh cả `validate` và `rust-windows` mới merge.

## Hai người, hai nhóm tính năng

| | **Người 1 · Session của tôi lên dashboard** | **Người 2 · Giá trị cho leader** |
| --- | --- | --- |
| Tính năng | Thu thập (adapter, lọc phạm vi, che secret, hàng đợi, daemon, heartbeat) · Xem session (danh sách, chi tiết, diff, session con, ghi chú, tìm kiếm, trạng thái thiết bị) · Phân phối CLI (release, `install.ps1`, self-update) | Quản trị và onboarding (project, thành viên, invite, `tl join`, đồng ý, Task Scheduler, trang "Của tôi", audit) · Chấm điểm (rule engine, worker, điểm, quản lý rule) · Báo cáo (tổng quan, hồ sơ, leaderboard) · Vận hành server (compose production, retention, xóa dữ liệu) |

Vùng file chi tiết của từng người nằm ở [AGENTS.md](../AGENTS.md) mục 3.

## Giai đoạn nền — xong

Monorepo, contract, API (auth, project, quyền, audit, device login), web (login/setup/device, layout), CLI (`tl login`/`logout`/`status`), CI. Chi tiết ở PR #1.

---

## Mốc 1 · Gửi session lên và xem lại

| # | Người | Việc | Tự test |
| --- | --- | --- | --- |
| M1.1 | 1 | **PR contract:** thêm 4 trường tùy chọn vào `session.v1.schema.json` ([RULES.md](RULES.md) mục 4) + `examples/`; viết `openapi/agent.yaml` (`POST /agent/v1/ingest`: `IngestBatch`, `202`, `426`) và `openapi/sessions.yaml` (`GET /api/v1/projects/{projectId}/sessions`, `GET /api/v1/sessions/{sessionId}`) | `pnpm --filter @teamlens/schema build test` |
| M1.2 | 1 | `tl-core`: struct `serde` cho session v1 | Serialize mọi file `examples/` khớp JSON Schema |
| M1.3 | 1 | Adapter Claude Code bản đầu: tìm file, đọc cả file, chuẩn hóa prompt/reply/tool_call/tool_result/diff, usage đếm một lần theo `message.id`. Fixtures từ máy mình, **che hết secret và đường dẫn cá nhân** trước khi commit | Snapshot test |
| M1.4 | 1 | Lọc phạm vi theo git remote (mọi remote, chuẩn hóa, khớp pattern từ `whoami`) | Test repo giả; test "session ngoài phạm vi không bao giờ vào payload" |
| M1.5 | 1 | Che secret cơ bản (khoảng 10 loại) + cắt output theo spec 6.3 + đổi đường dẫn tuyệt đối thành tương đối | Unit test |
| M1.6 | 1 | API ingest: validate `ajv`, idempotent theo `batch_id`, upsert session/turn, kiểm tra repo thuộc project (pattern cụ thể nhất), phát job `session.ingested` | Gửi `examples/*.json` bằng curl hai lần, không trùng |
| M1.7 | 1 | `tl preview [file]` + `tl sync --once`: lọc → chuẩn hóa → che → cắt → gửi batch gzip (chưa có hàng đợi) | Dùng Claude Code trong repo TeamLens → `tl sync --once` |
| M1.8 | 1 | API + web xem session: danh sách theo project, trang chi tiết (prompt, reply, tool call thu gọn, diff dạng text), hiển thị finding qua API của M1.11; `AccessService` + audit khi xem người khác | Mở web thấy session vừa gửi |
| M1.9 | 2 | **PR contract:** `openapi/rules.yaml` cho `GET /api/v1/sessions/{sessionId}/findings` | `pnpm --filter @teamlens/schema build` |
| M1.10 | 2 | Rule engine lõi: phạm vi `session`, đếm/ngưỡng/regex/chuỗi liên tiếp, chạy `tests` nội tuyến (RULES.md mục 5); 3 rule: `repeated-correction`, `mega-session`, `no-test-after-edit` | Unit test mọi `tests` của rule |
| M1.11 | 2 | Worker `session.ingested` → `findings` + `session_scores`; lệnh dev `pnpm --filter @teamlens/api rules:run [--session <id>]` chạy rule trên session có sẵn; API findings của M1.9 | `rules:run` trên session seed → curl API findings |
| M1.12 | 2 | Web quản trị: project, thành viên, repo pattern, user (API đã có từ giai đoạn nền) | Thao tác trên UI bằng tài khoản admin seed |

**Demo chung:** Người 1 gửi session thật → trang xem session hiện finding do rule của Người 2 chấm.

---

## Mốc 2 · Bảo vệ dữ liệu và chấm điểm đầy đủ

| # | Người | Việc | Tự test |
| --- | --- | --- | --- |
| M2.1 | 1 | Che secret đầy đủ: ≥ 30 loại theo gitleaks + entropy sau từ khóa + bỏ output file `.env*`/`*.pem`/`*.key`; nhận thêm pattern từ `GET /agent/v1/config` | Bộ test ≥ 30 secret mẫu bị che 100% |
| M2.2 | 1 | API `GET /agent/v1/config`: pattern remote, pattern redaction (đọc từ `settings`), ngưỡng cắt, phiên bản văn bản đồng ý, phiên bản CLI tối thiểu | curl bằng device token |
| M2.3 | 1 | Đọc tăng dần theo offset lưu trong SQLite `state.db`; session ổn định khi file không đổi 2 phút | Thêm dòng vào log → chỉ phần mới được gửi |
| M2.4 | 1 | Claude Code đầy đủ: subagent thành session con, `permission_mode`, `instruction_files`, `interrupted`, compaction | Snapshot test có subagent |
| M2.5 | 1 | Adapter Codex (fixtures, đọc, chuẩn hóa, `reasoning_effort`) | Snapshot test; `tl sync --once` với session Codex thật |
| M2.6 | 2 | Seed riêng cho chấm điểm (nhiều người, nhiều tuần, đủ loại anti-pattern), tách khỏi seed chung | Chạy seed rồi `rules:run` |
| M2.7 | 2 | Rule engine: phạm vi `user_week`, `aggregate: ratio`, `min_sample`; 16 rule mức high/medium của RULES.md | Unit test `tests` nội tuyến |
| M2.8 | 2 | Điểm 5 nhóm + `user_weekly_stats` (chỉ session gốc) + API "chạy lại rule" | Test với seed chấm điểm |
| M2.9 | 2 | Trang tổng quan project: session, token, chi phí ước tính theo tuần, phân bố agent/model, thống kê không tính điểm, top anti-pattern | Xem trên web với seed |
| M2.10 | 2 | Hồ sơ thành viên (`members/[userId]`): radar 5 nhóm, xu hướng theo tuần, anti-pattern hay mắc kèm ví dụ và lời khuyên | Xem hồ sơ member1 |

**Demo chung:** session Claude Code (có subagent) và Codex lên dashboard, secret đã che, tổng quan và hồ sơ có điểm.

---

## Mốc 3 · Tự chạy nền và mời thành viên

| # | Người | Việc | Tự test |
| --- | --- | --- | --- |
| M3.1 | 1 | Hàng đợi batch trong SQLite (đã che mới được ghi), retry backoff tối đa 30 phút, giới hạn 500 MB, xử lý `426`; **trước khi gửi, kiểm tra trạng thái đồng ý** qua module `consent` của Người 2 | Tắt API rồi bật lại: không mất, không trùng |
| M3.2 | 1 | `tl daemon`: named mutex, watch file (`notify`), quét lại 10 phút | Chạy `tl daemon`, dùng Claude Code, session tự lên |
| M3.3 | 1 | Heartbeat (CLI 15 phút + API cập nhật `devices`); `tl pause`/`resume`; `tl status` đầy đủ | `tl pause` → trạng thái thiết bị đổi |
| M3.4 | 1 | Xem session nâng cao: diff tô màu (`react-diff-view`), session con lồng trong session cha, ghi chú của leader theo turn | Xem session có subagent và diff lớn |
| M3.5 | 2 | **PR contract:** `openapi/invites.yaml`, `openapi/consent.yaml` (`POST /agent/v1/consent`) | `pnpm --filter @teamlens/schema build` |
| M3.6 | 2 | Invite: API tạo/thu hồi + trang `/i/[code]` (tạo tài khoản hoặc đăng nhập rồi vào project) | Mở link bằng trình duyệt ẩn danh |
| M3.7 | 2 | `tl join <url>`: lưu server → device login (dùng lại `login`) → màn hình đồng ý (spec 4.3, hỏi backfill) → `POST /agent/v1/consent`; module `consent` trong CLI cho Người 1 đọc; `tl consent revoke`, `tl uninstall` | `tl join` với invite local; kiểm tra bản ghi đồng ý trong DB |
| M3.8 | 2 | Task Scheduler "At log on" trong `tl-platform`; `tl join` đăng ký `tl daemon`, `uninstall` gỡ | Đăng xuất Windows rồi đăng nhập lại, task tồn tại |

**Điểm chạm:** đầu mốc, hai người thống nhất API của module `consent` trong CLI (Người 2 viết, Người 1 gọi).
**Demo chung:** người mới nhận link invite → `tl join` → đồng ý → làm việc bình thường, session tự lên dashboard.

---

## Mốc 4 · Báo cáo cho leader, minh bạch cho member

| # | Người | Việc | Tự test |
| --- | --- | --- | --- |
| M4.1 | 1 | Full-text search session (`tsvector`) | Tìm theo nội dung prompt |
| M4.2 | 1 | Trang thành viên (`members/`): danh sách kèm trạng thái thiết bị (online, offline N ngày, tạm dừng, đã rút đồng ý) | `tl pause`, `tl consent revoke` rồi xem |
| M4.3 | 2 | Leaderboard: tuần/tháng, ngưỡng 5 session, công tắc theo project, chế độ công khai cho member | Đăng nhập bằng leader và member |
| M4.4 | 2 | Màn hình quản lý rule: bật/tắt, chỉnh ngưỡng và mức độ, xem JSON, "Thử trên 50 session", "Chạy lại"; 8 rule mức low | Đổi ngưỡng rồi chạy lại |
| M4.5 | 2 | Trang "Của tôi" (đồng ý đã cấp, thiết bị, ai đã xem session của mình) + trang audit cho admin | Đăng nhập 2 tài khoản |
| M4.6 | 2 | Cài đặt server trong trang quản trị: pattern redaction riêng, retention, LLM provider (chỉ lưu, chấm bằng LLM ở phase 2) | Thêm pattern → `GET /agent/v1/config` trả về |

**Demo chung:** leader xem tổng quan, hồ sơ, leaderboard, tìm kiếm; member chỉ thấy dữ liệu của mình.

---

## Mốc 5 · Cài đặt và phát hành

| # | Người | Việc | Tự test |
| --- | --- | --- | --- |
| M5.1 | 1 | Workflow GitHub Release build `tl.exe` + SHA-256 | Tạo tag thử |
| M5.2 | 1 | `GET /install.ps1` + script: tải, kiểm SHA-256, đặt vào `%LOCALAPPDATA%\teamlens\bin`, thêm PATH, chạy `tl join` | Cài trên máy Windows khác |
| M5.3 | 1 | `self_update` từ GitHub Releases khi server trả `426` hoặc có bản mới | Hạ phiên bản rồi chạy |
| M5.4 | 2 | `deploy/docker-compose.yml` production (api, web, postgres, caddy) + `Caddyfile` + Dockerfile + hướng dẫn cài | Cài trên máy ảo sạch dưới 15 phút |
| M5.5 | 2 | Job retention hằng đêm (drop partition `turns`, tạo partition mới) | Chạy với retention 1 ngày |
| M5.6 | 2 | Admin xóa toàn bộ dữ liệu của một người (spec 6.4) | Xóa member2 rồi kiểm tra DB |

**Nghiệm thu chung:** chạy đủ tiêu chí mục 12.3 của [SPEC.md](SPEC.md) (cài server < 15 phút, ngắt mạng 24 giờ, RAM daemon < 30 MB với > 1.000 session, 30 loại secret, session ngoài phạm vi không rời máy).
