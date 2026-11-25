# TeamLens — kế hoạch việc

Mỗi người **sở hữu trọn một nhóm tính năng từ CLI tới DB tới web** (kiểu *stream-aligned team* trong Team Topologies) và giữ vùng đó suốt dự án. Các nguyên tắc đi kèm:

- **Mốc 1 chạy hết luồng trước, các mốc sau nâng cấp từng khúc.** Giống làm đường: mở con đường đất nối hai đầu trước (session thật đi từ máy lên dashboard, mỗi khúc ở mức tối thiểu), rồi mới trải nhựa từng đoạn. Lỗi ghép nối lộ ra ngay tuần đầu.
- **Contract trước:** task ghi "PR contract" thì merge trước để người kia code theo.
- **Mỗi mốc kết thúc bằng demo chung** trên máy thật. Mỗi người cập nhật phần mình trong [FLOW.md](FLOW.md) và giải thích cho người kia.
- **Mỗi người tự test được phần mình** nhờ dữ liệu seed, server local (`pnpm dev`), device login thật và file mẫu `packages/schema/examples/`. Mỗi ô có dòng "Tự test" ghi cách làm.
- **Mỗi task là một nhánh** `feat/<mã>-<tên-ngắn>` (ví dụ `feat/m1.3-claude-adapter`) và một PR; CI phải xanh cả `validate` và `rust-windows` mới merge.

## Hai người, hai nhóm tính năng

| | **Người 1 · Session của tôi lên dashboard** | **Người 2 · Giá trị cho leader** |
| --- | --- | --- |
| Tính năng | Thu thập (adapter, lọc phạm vi, che secret, hàng đợi, daemon, heartbeat) · Xem session (danh sách, chi tiết, diff, session con, ghi chú, tìm kiếm, trạng thái thiết bị) · Phân phối CLI (release, `install.ps1`, self-update) | Quản trị và onboarding (project, thành viên, invite, `tl join`, đồng ý, Task Scheduler, trang "Của tôi", audit) · Chấm điểm (rule engine, worker, điểm, quản lý rule) · Báo cáo (tổng quan, hồ sơ, leaderboard) · Vận hành server (compose production, retention, xóa dữ liệu) |

Vùng file chi tiết của từng người nằm ở [AGENTS.md](../AGENTS.md) mục 3.

## Giai đoạn nền — xong

Monorepo, contract, API (auth, project, quyền, audit, device login), web (login/setup/device, layout), CLI (`tl login`/`logout`/`status`), CI. Chi tiết ở PR #1.

---

## Cách đọc bảng

Mỗi mốc là một bảng hai cột: **Người 1 và Người 2 làm song song**, mỗi người đi từ trên xuống trong cột của mình. Các ô cùng hàng chỉ để so tiến độ, không bắt buộc xong cùng lúc. Ô trống nghĩa là người đó đã hết việc của mốc này và **được làm trước task mốc sau trong vùng của mình**. Task có 📜 là PR contract, merge sớm để người kia code theo.

---

## Mốc 1 · Gửi session lên và xem lại

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | **M1.1** 📜 Thêm 4 trường tùy chọn vào `session.v1.schema.json` ([RULES.md](RULES.md) mục 4) + `examples/`; viết `openapi/agent.yaml` (`POST /agent/v1/ingest`: `IngestBatch`, `202`, `426`) và `openapi/sessions.yaml` (`GET /api/v1/projects/{projectId}/sessions`, `GET /api/v1/sessions/{sessionId}`)<br>**Tự test:** `pnpm --filter @teamlens/schema build test` | **M1.9** 📜 `openapi/rules.yaml` cho `GET /api/v1/sessions/{sessionId}/findings`<br>**Tự test:** `pnpm --filter @teamlens/schema build` |
| 2 | **M1.2** `tl-core`: struct `serde` cho session v1<br>**Tự test:** serialize mọi file `examples/` khớp JSON Schema | **M1.10** Rule engine lõi: phạm vi `session`, đếm/ngưỡng/regex/chuỗi liên tiếp, chạy `tests` nội tuyến (RULES.md mục 5); 3 rule: `repeated-correction`, `mega-session`, `no-test-after-edit`<br>**Tự test:** unit test mọi `tests` của rule |
| 3 | **M1.3** Adapter Claude Code bản đầu: tìm file, đọc cả file, chuẩn hóa prompt/reply/tool_call/tool_result/diff, usage đếm một lần theo `message.id`. Fixtures từ máy mình, **che hết secret và đường dẫn cá nhân** trước khi commit<br>**Tự test:** snapshot test | **M1.11** Worker `session.ingested` → `findings` + `session_scores`; lệnh dev `pnpm --filter @teamlens/api rules:run [--session <id>]`; API findings của M1.9<br>**Tự test:** `rules:run` trên session seed → curl API findings |
| 4 | **M1.4** Lọc phạm vi theo git remote (mọi remote, chuẩn hóa, khớp pattern từ `whoami`)<br>**Tự test:** repo giả; test "session ngoài phạm vi không bao giờ vào payload" | **M1.12** Web quản trị: project, thành viên, repo pattern, user (API đã có từ giai đoạn nền)<br>**Tự test:** thao tác trên UI bằng tài khoản admin seed |
| 5 | **M1.5** Che secret cơ bản (khoảng 10 loại) + cắt output theo spec 6.3 + đổi đường dẫn tuyệt đối thành tương đối<br>**Tự test:** unit test | _Làm trước M2.6, M2.7_ |
| 6 | **M1.6** API ingest: validate `ajv`, idempotent theo `batch_id`, upsert session/turn, kiểm tra repo thuộc project (pattern cụ thể nhất), phát job `session.ingested`<br>**Tự test:** gửi `examples/*.json` bằng curl hai lần, không trùng | |
| 7 | **M1.7** `tl preview [file]` + `tl sync --once`: lọc → chuẩn hóa → che → cắt → gửi batch gzip (chưa có hàng đợi)<br>**Tự test:** dùng Claude Code trong repo TeamLens → `tl sync --once` | |
| 8 | **M1.8** API + web xem session: danh sách theo project, trang chi tiết (prompt, reply, tool call thu gọn, diff dạng text), hiển thị finding qua API của M1.9; `AccessService` + audit khi xem người khác<br>**Tự test:** mở web thấy session vừa gửi | |

**Điểm chạm:** M1.8 gọi API findings (contract M1.9 merge từ bước 1); job `session.ingested` đã chốt sẵn ở `apps/api/src/queue/jobs.ts`.
**Demo chung:** Người 1 gửi session thật → trang xem session hiện finding do rule của Người 2 chấm.

---

## Mốc 2 · Bảo vệ dữ liệu và chấm điểm đầy đủ

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | **M2.1** Che secret đầy đủ: ≥ 30 loại theo gitleaks + entropy sau từ khóa + bỏ output file `.env*`/`*.pem`/`*.key`; nhận thêm pattern từ `GET /agent/v1/config`<br>**Tự test:** bộ ≥ 30 secret mẫu bị che 100% | **M2.6** Seed riêng cho chấm điểm (nhiều người, nhiều tuần, đủ loại anti-pattern), tách khỏi seed chung<br>**Tự test:** chạy seed rồi `rules:run` |
| 2 | **M2.2** API `GET /agent/v1/config`: pattern remote, pattern redaction (đọc từ `settings`), ngưỡng cắt, phiên bản văn bản đồng ý, phiên bản CLI tối thiểu<br>**Tự test:** curl bằng device token | **M2.7** Rule engine: phạm vi `user_week`, `aggregate: ratio`, `min_sample`; 16 rule mức high/medium của RULES.md<br>**Tự test:** unit test `tests` nội tuyến |
| 3 | **M2.3** Đọc tăng dần theo offset lưu trong SQLite `state.db`; session ổn định khi file không đổi 2 phút<br>**Tự test:** thêm dòng vào log → chỉ phần mới được gửi | **M2.8** Điểm 5 nhóm + `user_weekly_stats` (chỉ session gốc) + API "chạy lại rule"<br>**Tự test:** test với seed chấm điểm |
| 4 | **M2.4** Claude Code đầy đủ: subagent thành session con, `permission_mode`, `instruction_files`, `interrupted`, compaction<br>**Tự test:** snapshot test có subagent | **M2.9** Trang tổng quan project: session, token, chi phí ước tính theo tuần, phân bố agent/model, thống kê không tính điểm, top anti-pattern<br>**Tự test:** xem trên web với seed |
| 5 | **M2.5** Adapter Codex (fixtures, đọc, chuẩn hóa, `reasoning_effort`)<br>**Tự test:** snapshot test; `tl sync --once` với session Codex thật | **M2.10** Hồ sơ thành viên (`members/[userId]`): radar 5 nhóm, xu hướng theo tuần, anti-pattern hay mắc kèm ví dụ và lời khuyên<br>**Tự test:** xem hồ sơ member1 |

**Demo chung:** session Claude Code (có subagent) và Codex lên dashboard, secret đã che, tổng quan và hồ sơ có điểm.

---

## Mốc 3 · Tự chạy nền và mời thành viên

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | **M3.1** Hàng đợi batch trong SQLite (đã che mới được ghi), retry backoff tối đa 30 phút, giới hạn 500 MB, xử lý `426`; trước khi gửi, hỏi module `consent` của Người 2<br>**Tự test:** tắt API rồi bật lại: không mất, không trùng | **M3.5** 📜 `openapi/invites.yaml`, `openapi/consent.yaml` (`POST /agent/v1/consent`); chốt cùng Người 1 hàm của module `consent` trong CLI<br>**Tự test:** `pnpm --filter @teamlens/schema build` |
| 2 | **M3.2** `tl daemon`: named mutex, watch file (`notify`), quét lại 10 phút<br>**Tự test:** chạy `tl daemon`, dùng Claude Code, session tự lên | **M3.6** Invite: API tạo/thu hồi + trang `/i/[code]` (tạo tài khoản hoặc đăng nhập rồi vào project)<br>**Tự test:** mở link bằng trình duyệt ẩn danh |
| 3 | **M3.3** Heartbeat (CLI 15 phút + API cập nhật `devices`); `tl pause`/`resume`; `tl status` đầy đủ<br>**Tự test:** `tl pause` → trạng thái thiết bị đổi | **M3.7** `tl join <url>`: lưu server → device login (dùng lại `login`) → màn hình đồng ý (spec 4.3, hỏi backfill) → `POST /agent/v1/consent`; module `consent` trong CLI; `tl consent revoke`, `tl uninstall`<br>**Tự test:** `tl join` với invite local; kiểm tra bản ghi đồng ý trong DB |
| 4 | **M3.4** Xem session nâng cao: diff tô màu (`react-diff-view`), session con lồng trong session cha, ghi chú của leader theo turn<br>**Tự test:** xem session có subagent và diff lớn | **M3.8** Task Scheduler "At log on" trong `tl-platform`; `tl join` đăng ký `tl daemon`, `uninstall` gỡ<br>**Tự test:** đăng xuất Windows rồi đăng nhập lại, task tồn tại |

**Điểm chạm:** module `consent` trong CLI — Người 2 viết (M3.7), Người 1 gọi (M3.1); chốt chữ ký hàm ở bước 1.
**Demo chung:** người mới nhận link invite → `tl join` → đồng ý → làm việc bình thường, session tự lên dashboard.

---

## Mốc 4 · Báo cáo cho leader, minh bạch cho member

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | **M4.1** Full-text search session (`tsvector`)<br>**Tự test:** tìm theo nội dung prompt | **M4.3** Leaderboard: tuần/tháng, ngưỡng 5 session, công tắc theo project, chế độ công khai cho member<br>**Tự test:** đăng nhập bằng leader và member |
| 2 | **M4.2** Trang thành viên (`members/`): danh sách kèm trạng thái thiết bị (online, offline N ngày, tạm dừng, đã rút đồng ý)<br>**Tự test:** `tl pause`, `tl consent revoke` rồi xem | **M4.4** Màn hình quản lý rule: bật/tắt, chỉnh ngưỡng và mức độ, xem JSON, "Thử trên 50 session", "Chạy lại"; 8 rule mức low<br>**Tự test:** đổi ngưỡng rồi chạy lại |
| 3 | _Làm trước M5.1, M5.2_ | **M4.5** Trang "Của tôi" (đồng ý đã cấp, thiết bị, ai đã xem session của mình) + trang audit cho admin<br>**Tự test:** đăng nhập 2 tài khoản |
| 4 | | **M4.6** Cài đặt server trong trang quản trị: pattern redaction riêng, retention, LLM provider (chỉ lưu, chấm bằng LLM ở phase 2)<br>**Tự test:** thêm pattern → `GET /agent/v1/config` trả về |

**Demo chung:** leader xem tổng quan, hồ sơ, leaderboard, tìm kiếm; member chỉ thấy dữ liệu của mình.

---

## Mốc 5 · Cài đặt và phát hành

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | **M5.1** Workflow GitHub Release build `tl.exe` + SHA-256<br>**Tự test:** tạo tag thử | **M5.4** `deploy/docker-compose.yml` production (api, web, postgres, caddy) + `Caddyfile` + Dockerfile + hướng dẫn cài<br>**Tự test:** cài trên máy ảo sạch dưới 15 phút |
| 2 | **M5.2** `GET /install.ps1` + script: tải, kiểm SHA-256, đặt vào `%LOCALAPPDATA%\teamlens\bin`, thêm PATH, chạy `tl join`<br>**Tự test:** cài trên máy Windows khác | **M5.5** Job retention hằng đêm (drop partition `turns`, tạo partition mới)<br>**Tự test:** chạy với retention 1 ngày |
| 3 | **M5.3** `self_update` từ GitHub Releases khi server trả `426` hoặc có bản mới<br>**Tự test:** hạ phiên bản rồi chạy | **M5.6** Admin xóa toàn bộ dữ liệu của một người (spec 6.4)<br>**Tự test:** xóa member2 rồi kiểm tra DB |

**Nghiệm thu chung:** chạy đủ tiêu chí mục 12.3 của [SPEC.md](SPEC.md) (cài server < 15 phút, ngắt mạng 24 giờ, RAM daemon < 30 MB với > 1.000 session, 30 loại secret, session ngoài phạm vi không rời máy).
