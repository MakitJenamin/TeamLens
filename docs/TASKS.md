# TeamLens — kế hoạch việc

Mỗi người **sở hữu trọn một nhóm tính năng từ CLI tới DB tới web** (kiểu *stream-aligned team* trong Team Topologies) và giữ vùng đó suốt dự án. Các nguyên tắc đi kèm:

- **Mốc 1 chạy hết luồng trước, các mốc sau nâng cấp từng khúc.** Giống làm đường: mở con đường đất nối hai đầu trước (session thật đi từ máy lên dashboard, mỗi khúc ở mức tối thiểu), rồi mới trải nhựa từng đoạn. Lỗi ghép nối lộ ra ngay tuần đầu.
- **Contract trước:** task ghi "PR contract" thì merge trước để người kia code theo.
- **Mỗi mốc kết thúc bằng demo chung** trên máy thật. Mỗi người cập nhật phần mình trong [FLOW.md](FLOW.md) và giải thích cho người kia.
- **Mỗi người tự test được phần mình** nhờ dữ liệu seed, server local (`pnpm dev`), `tl join http://localhost:3000/i/seed-invite-teamlens` (link mời có sẵn trong seed) và file mẫu `packages/schema/examples/`. Mỗi ô có dòng "Tự test" ghi cách làm.
- **Mỗi task là một nhánh** `feat/<mã>-<tên-ngắn>` (ví dụ `feat/m1.3-claude-adapter`) và một PR; CI phải xanh cả `validate` và `rust-windows` mới merge.

## Trạng thái (cập nhật 2026-11-27)

| Mốc | Trạng thái | Ghi chú |
| --- | --- | --- |
| Giai đoạn nền | ✅ xong | PR #1 |
| Mốc 1 · Gửi session lên và xem lại | ✅ xong | M1.1–M1.12 |
| Mốc 1.5 · Tối giản tham gia | ✅ xong | PR #29–#37 |
| Mốc 2 · Bảo vệ dữ liệu và chấm điểm đầy đủ | ✅ xong | Người 1 xong M2.1–M2.5 (PR #39–#44). Người 2 xong M2.6–M2.10 (PR #27, #28, #55–#64) |
| Mốc 3 · Tự chạy nền | 🔄 đang làm | Người 1 xong M3.1–M3.4 (PR #46–#53). Người 2 còn M3.5–M3.8; phần mời thành viên đã xong ở Mốc 1.5 |
| Mốc 4 · Báo cáo và minh bạch | ⏳ chưa làm | |
| Mốc 5 · Cài đặt và phát hành | ⏳ chưa làm | |

**Việc nên làm tiếp theo (theo thứ tự ưu tiên):**
1. Người 1: hết việc Mốc 2 và Mốc 3, làm trước **M4.1** (full-text search) → **M4.2** (trang thành viên kèm trạng thái thiết bị, dùng `devices.last_heartbeat` của M3.3) → M5.1 → M5.2 → M5.3.
2. Người 2: hết việc Mốc 2. Làm **M3.5** (contract consent, merge trước) → **M3.7** (`tl consent`, `tl consent revoke`, `tl uninstall`) → **M3.6** (`GET /install.ps1?code=`). `user_weekly_stats` của M2.8 đã sẵn cho M4.3 (leaderboard).
3. Người 2: **M3.8** (Task Scheduler) đăng ký `tl daemon --background` (M3.2 đã có). Lưu ý: `tl.exe` là ứng dụng console, nên đăng ký kiểu ẩn (vd. `conhost.exe --headless`) hoặc gọi `FreeConsole` để không hiện cửa sổ.

## Hai người, hai nhóm tính năng

| | **Người 1 · Session của tôi lên dashboard** | **Người 2 · Giá trị cho leader** |
| --- | --- | --- |
| Tính năng | Thu thập (adapter, lọc phạm vi, che secret, hàng đợi, daemon, heartbeat) · Xem session (danh sách, chi tiết, diff, session con, ghi chú, tìm kiếm, trạng thái thiết bị) · Phân phối CLI (release, `install.ps1`, self-update) | Quản trị và onboarding (project, thành viên, invite, `tl join`, đồng ý, Task Scheduler, trang "Của tôi", audit) · Chấm điểm (rule engine, worker, điểm, quản lý rule) · Báo cáo (tổng quan, hồ sơ, leaderboard) · Vận hành server (compose production, retention, xóa dữ liệu) |

Vùng file chi tiết của từng người nằm ở [AGENTS.md](../AGENTS.md) mục 3.

## Giai đoạn nền — xong

Monorepo, contract, API (auth, project, quyền, audit, device login), web (login/setup/device, layout), CLI (`tl login`/`logout`/`status`), CI. Chi tiết ở PR #1. Device login và vai trò admin của giai đoạn này được thay ở Mốc 1.5.

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

## Mốc 1.5 · Tối giản tham gia — ✅ xong

Thay device login qua trình duyệt bằng một lệnh `tl join <link mời>`, gộp Admin vào Leader (SPEC 7.1, 11.1). Quyết định đã chốt: link mời dùng chung cho cả nhóm; user trùng (máy thứ hai, cài lại Windows) do leader gộp trên web.

| Task | Nội dung | PR |
| --- | --- | --- |
| J.2 + J.4 | Hai vai trò toàn server `users.role`; `@LeaderOnly()`, `@ProjectAccess()`; thêm leader, đổi vai trò (giữ ít nhất một leader) | #30 |
| J.1 📜 | Contract: link mời, `join`, `web-login`, `auth/ticket`, `merge`, wizard setup | #31 |
| J.3 + J.6 + J.9 | API link mời (tạo/thu hồi, xem trước, `join` một transaction, 10 request/phút/IP), `tl open` (ticket 60 giây), wizard setup trả link mời, ingest bắt buộc có đồng ý | #34 |
| J.5 + J.6 | CLI `tl join`/`tl login <link>` với màn hình đồng ý trong terminal, module consent, `tl open`, `TL_DATA_DIR` | #33 |
| J.7 + J.6 | Web: wizard `/setup` 3 bước, quản lý link mời, trang `/i/[code]`, `/auth/cli` | #32 |
| J.8 | Gộp user trùng: API + nút "Gộp vào…" trong Quản trị | #35 |
| J.10 | Xóa luồng cũ: `device_codes`, `is_admin`, vai trò theo project, endpoint và trang `/device`; seed mới (chỉ `leader@teamlens.local` có mật khẩu, token member in ra console) | #36 |
| Sửa sau chạy thử | Chuyển IP thật của người xem `/i/[code]` sang API (`X-Forwarded-For`) cho giới hạn tần suất; văn bản đồng ý đúng hiện trạng (phiên bản `2026-11-27.2`); gộp user giữ người thực hiện trong `audit_log`; sửa `tl sync` lỗi kết nối bị đóng (os error 10053); chạy thử nối liền `/setup` → `tl join` → `tl sync` → `tl open` → member và leader xem session | #37 |

**Còn để lại cho mốc sau:** đăng ký chạy nền khi `tl join` (M3.8), `tl consent`/`tl consent revoke` (M3.7), endpoint `install.ps1` (M3.6/M5.2), văn bản đồng ý chỉnh được trên web (M4.6). Mã mời chỉ hiện một lần lúc tạo; muốn gửi lại thì tạo link mới.

---

## Mốc 2 · Bảo vệ dữ liệu và chấm điểm đầy đủ — ✅ xong (M2.1–M2.10)

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | ✅ **M2.1** Che secret đầy đủ: ≥ 30 loại theo gitleaks + entropy sau từ khóa + bỏ output file `.env*`/`*.pem`/`*.key`; nhận thêm pattern từ `GET /agent/v1/config`<br>**Tự test:** bộ ≥ 30 secret mẫu bị che 100% (#43) | ✅ **M2.6** Seed riêng cho chấm điểm (nhiều người, nhiều tuần, đủ loại anti-pattern), tách khỏi seed chung (#27) |
| 2 | ✅ **M2.2** API `GET /agent/v1/config`: pattern remote, pattern redaction (đọc từ `settings`), ngưỡng cắt, phiên bản văn bản đồng ý (lấy từ `apps/api/src/modules/consent/consent-text.ts`, khác phiên bản thì CLI ngừng gửi và nhắc đồng ý lại), phiên bản CLI tối thiểu<br>**Tự test:** curl bằng device token (#39, #42) | ✅ **M2.7** Rule engine: phạm vi `user_week`, `aggregate: ratio`, `min_sample`; 16 rule mức high/medium của RULES.md (#28) |
| 3 | ✅ **M2.3** Đọc tăng dần theo offset lưu trong SQLite `state.db`; session ổn định khi file không đổi 2 phút<br>**Tự test:** thêm dòng vào log → chỉ phần mới được gửi (#41) | ✅ **M2.8** Điểm 5 nhóm + `user_weekly_stats` (điểm và số session chỉ tính session gốc; token tính cả session con; finding tuần trừ vào điểm tuần) + API "chạy lại rule" chạy nền (`POST /projects/{id}/rules/rerun`)<br>**Tự test:** test với seed chấm điểm (e2e `weekly-stats`) (#55, #56) |
| 4 | ✅ **M2.4** Claude Code đầy đủ: subagent thành session con, `permission_mode`, `instruction_files`, `interrupted`, compaction<br>**Tự test:** snapshot test có subagent (#40) | ✅ **M2.9** Trang tổng quan project (chỉ leader, mọi project): session, token, chi phí ước tính theo tuần, phân bố agent/model, thống kê không tính điểm, top anti-pattern<br>**Tự test:** xem trên web với seed (#57–#59, #61) |
| 5 | ✅ **M2.5** Adapter Codex (fixtures, đọc, chuẩn hóa, `reasoning_effort`)<br>**Tự test:** snapshot test; `tl sync --once` với session Codex thật (#44) | ✅ **M2.10** Hồ sơ thành viên (`members/[userId]`; leader xem mọi người có audit, member xem của mình qua `tl open`): radar 5 nhóm, xu hướng theo tuần, anti-pattern hay mắc kèm ví dụ và lời khuyên<br>**Tự test:** xem hồ sơ một member seed bằng leader và bằng chính member đó (#62–#64) |

**Demo chung:** session Claude Code (có subagent) và Codex lên dashboard, secret đã che, tổng quan và hồ sơ có điểm.

---

## Mốc 3 · Tự chạy nền — 🔄 đang làm (Người 1 xong M3.1–M3.4)

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | ✅ **M3.1** Hàng đợi batch trong SQLite (đã che mới được ghi), retry backoff tối đa 30 phút, giới hạn 500 MB, xử lý `426`; trước khi gửi, hỏi module `consent` (đã có từ J.5)<br>**Tự test:** tắt API rồi bật lại: không mất, không trùng (#50) | **M3.5** 📜 `openapi/consent.yaml`: `POST /agent/v1/consent` (đồng ý lại khi văn bản đổi, rút đồng ý). Ghi đồng ý lần đầu đã nằm trong `POST /agent/v1/join`<br>**Tự test:** `pnpm --filter @teamlens/schema build` |
| 2 | ✅ **M3.2** `tl daemon`: named mutex, watch file (`notify`), quét lại 10 phút<br>**Tự test:** chạy `tl daemon`, dùng Claude Code, session tự lên (#53) | **M3.6** `GET /install.ps1?code=<code>` phía server sinh script gọi `tl join` (câu lệnh này đã hiện trong wizard và trang `/i/[code]` nhưng endpoint chưa có; phần tải và kiểm SHA-256 làm ở M5.2)<br>**Tự test:** chạy script trên máy Windows khác |
| 3 | ✅ **M3.3** Heartbeat (CLI 15 phút + API cập nhật `devices`); `tl pause`/`resume`; `tl status` đầy đủ<br>**Tự test:** `tl pause` → trạng thái thiết bị đổi (#47, #48, #52) | **M3.7** `tl consent` (đồng ý lại khi văn bản đổi), `tl consent revoke`, `tl uninstall`; cập nhật văn bản đồng ý (`consent-text.ts`) nhắc tới các lệnh này và tăng phiên bản<br>**Tự test:** rút đồng ý → daemon dừng, `devices.status` = `consent_revoked`, ingest trả 403 |
| 4 | ✅ **M3.4** Xem session nâng cao: diff tô màu (`react-diff-view`), session con lồng trong session cha, ghi chú của leader theo turn<br>**Tự test:** xem session có subagent và diff lớn (#46, #49, #51) | **M3.8** Task Scheduler "At log on" trong `tl-platform`; `tl join` (đã có) gọi đăng ký `tl daemon` sau khi đồng ý, `uninstall` gỡ<br>**Tự test:** đăng xuất Windows rồi đăng nhập lại, task tồn tại |

**Điểm chạm:** module `consent` trong CLI — Người 2 viết (J.5, M3.7), Người 1 gọi (M3.1).
**Demo chung:** người mới nhận link mời → một lệnh cài (`install.ps1?code=`) → đồng ý → làm việc bình thường, session tự lên dashboard mà không phải chạy `tl sync`.

---

## Mốc 4 · Báo cáo cho leader, minh bạch cho member

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | **M4.1** Full-text search session (`tsvector`)<br>**Tự test:** tìm theo nội dung prompt | **M4.3** Leaderboard: tuần/tháng, ngưỡng 5 session, công tắc theo project, chế độ công khai cho member<br>**Tự test:** đăng nhập bằng leader và member |
| 2 | **M4.2** Trang thành viên (`members/`, chỉ leader): danh sách kèm thiết bị và trạng thái (online, offline N ngày, tạm dừng, đã rút đồng ý), người mới tham gia gần đây, thu hồi thiết bị, nút "Gộp vào…" (dùng lại `admin/merge-user.tsx`)<br>**Tự test:** `tl pause`, `tl consent revoke` rồi xem | **M4.4** Màn hình quản lý rule: bật/tắt, chỉnh ngưỡng và mức độ, xem JSON, "Thử trên 50 session", "Chạy lại"; 8 rule mức low<br>**Tự test:** đổi ngưỡng rồi chạy lại |
| 3 | _Làm trước M5.1, M5.2_ | **M4.5** Trang "Của tôi" (đồng ý đã cấp, thiết bị, ai đã xem session của mình; member vào bằng `tl open`) + trang audit cho leader<br>**Tự test:** leader đăng nhập bằng mật khẩu, member vào bằng `tl open` |
| 4 | | **M4.6** Cài đặt server trong trang quản trị: pattern redaction riêng, retention, văn bản đồng ý (sửa thì tăng phiên bản, chuyển nguồn từ `consent-text.ts` sang bảng `settings`), LLM provider (chỉ lưu, chấm bằng LLM ở phase 2)<br>**Tự test:** thêm pattern → `GET /agent/v1/config` trả về; sửa văn bản đồng ý → CLI ngừng gửi tới khi đồng ý lại |

**Demo chung:** leader xem tổng quan, hồ sơ, leaderboard, tìm kiếm; member chỉ thấy dữ liệu của mình.

---

## Mốc 5 · Cài đặt và phát hành

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | **M5.1** Workflow GitHub Release build `tl.exe` + SHA-256<br>**Tự test:** tạo tag thử | **M5.4** `deploy/docker-compose.yml` production (api, web, postgres, caddy) + `Caddyfile` + Dockerfile + hướng dẫn cài. Chỉ mở cổng Caddy ra ngoài: web/API sau proxy tin `X-Forwarded-For` cho giới hạn tần suất của link mời, mở thẳng cổng web thì người ngoài giả được header này<br>**Tự test:** cài trên máy ảo sạch dưới 15 phút |
| 2 | **M5.2** `GET /install.ps1` + script: tải, kiểm SHA-256, đặt vào `%LOCALAPPDATA%\teamlens\bin`, thêm PATH, chạy `tl join`<br>**Tự test:** cài trên máy Windows khác | **M5.5** Job retention hằng đêm (drop partition `turns`, tạo partition mới)<br>**Tự test:** chạy với retention 1 ngày |
| 3 | **M5.3** `self_update` từ GitHub Releases khi server trả `426` hoặc có bản mới<br>**Tự test:** hạ phiên bản rồi chạy | **M5.6** Leader xóa toàn bộ dữ liệu của một người (spec 6.4)<br>**Tự test:** xóa member2 rồi kiểm tra DB |

**Nghiệm thu chung:** chạy đủ tiêu chí mục 12.3 của [SPEC.md](SPEC.md) (cài server < 15 phút, ngắt mạng 24 giờ, RAM daemon < 30 MB với > 1.000 session, 30 loại secret, session ngoài phạm vi không rời máy).
