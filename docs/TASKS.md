# TeamLens — kế hoạch việc

Mỗi người **sở hữu trọn một nhóm tính năng từ CLI tới DB tới web** (kiểu *stream-aligned team* trong Team Topologies) và giữ vùng đó suốt dự án. Các nguyên tắc đi kèm:

- **Mốc 1 chạy hết luồng trước, các mốc sau nâng cấp từng khúc.** Giống làm đường: mở con đường đất nối hai đầu trước (session thật đi từ máy lên dashboard, mỗi khúc ở mức tối thiểu), rồi mới trải nhựa từng đoạn. Lỗi ghép nối lộ ra ngay tuần đầu.
- **Contract trước:** task ghi "PR contract" thì merge trước để những người khác code theo.
- **Mỗi mốc kết thúc bằng demo chung** trên máy thật. Mỗi người cập nhật phần mình trong [FLOW.md](FLOW.md) và giải thích cho những người còn lại.
- **Mỗi người tự test được phần mình** nhờ dữ liệu seed, server local (`pnpm dev`), `tl join http://localhost:3000/i/seed-invite-teamlens` (link mời có sẵn trong seed) và file mẫu `packages/schema/examples/`. Mỗi ô có dòng "Tự test" ghi cách làm.
- **Mỗi task là một nhánh** `feat/<mã>-<tên-ngắn>` (ví dụ `feat/m1.3-claude-adapter`) và một PR; CI phải xanh cả `validate` và `rust-windows` mới merge.

## Trạng thái (cập nhật 2026-11-28)

| Mốc | Trạng thái | Ghi chú |
| --- | --- | --- |
| Giai đoạn nền | ✅ xong | PR #1 |
| Mốc 1 · Gửi session lên và xem lại | ✅ xong | M1.1–M1.12 |
| Mốc 1.5 · Tối giản tham gia | ✅ xong | PR #29–#37 |
| Mốc 2 · Bảo vệ dữ liệu và chấm điểm đầy đủ | ✅ xong | Người 1 xong M2.1–M2.5 (PR #39–#44). Người 2 xong M2.6–M2.10 (PR #27, #28, #55–#64) |
| Mốc 3 · Tự chạy nền | ✅ xong | Người 1 xong M3.1–M3.4 (PR #46–#53). Người 2 xong M3.5 (#65), M3.6 (#73, #74, #75), M3.7 (API #66, api_client #67, CLI #69, văn bản đồng ý #70) và M3.8 (#68); phần mời thành viên đã xong ở Mốc 1.5 |
| Mốc 4 · Báo cáo và minh bạch | ✅ xong | Người 1 xong M4.1 (#77, #78) và M4.2 (#76, #79). Người 2 xong M4.3 (#137–#139), M4.4 (#140–#142), M4.5 (#143, #144), M4.6 (#145–#149). Lỗi sau review đã sửa (#155–#164, xem dưới) |
| Mốc 5 · Cài đặt và phát hành | ✅ xong | Người 1 xong M5.1 (#81), M5.2 (#83, #85), M5.3 (#82, #84); đã phát hành `tl` 0.2.0 (#87) đến 0.3.0 (#111), bản mới nhất 0.4.0 có `tl mcp`. M5.4 do Người 1 làm thay (#106). M5.5 (#152) và M5.6 (#153) leader làm thay Người 2, contract #151 |
| Mốc 6 · Tính năng AI và MCP | 🚧 đang làm | Người 1 xong M6.0 (#97, #98), M6.1 (#99, #101), M6.2 (#103, #104), M6.5 + M6.6 (#102). Người 3 xong M6.3 (#112, #113), M6.4 (#115), M6.15 (#117, #118), M6.16 (#120, #121, #122), M6.11 (#124, #125), M6.12 (#127, #128), M6.13 (#130, #131), M6.14 (#133, #134), xong hết phần của Người 3 ở Mốc 6. Người 2 xong M6.7 (#167), M6.8 (#169, #170), M6.9 (#172, #173), còn M6.10. Thiết kế: [AI_PLAN.md](AI_PLAN.md) |

**Việc nên làm tiếp theo (theo thứ tự ưu tiên):**
1. Người 2: lỗi review Mốc 4 đã sửa hết (#155–#164). Làm phần Mốc 6: ✅ M6.7 (#167) → ✅ M6.8 (#169, #170) → ✅ M6.9 (#172, #173) → M6.10. Lưu ý từ M5.5:
   - Số ngày retention đọc bằng `readRetentionDays` (`retention/retention-settings.ts`): không có dòng là 90, jsonb `null` là vô hạn. Đừng tự đọc `settings`.
   - Turn của session cũ có thể đã bị xóa. Code nào chấm hay tóm tắt trên turn phải bỏ qua session có `turns.length < turn_count` (như `scoreSession`, `RuleConfigService.test`).
   - E2e luôn tắt job hằng đêm (`TEAMLENS_RETENTION_JOB=off` trong `test/setup-env.ts`). Thử retention bằng `pnpm --filter @teamlens/api retention:run --days N`.
2. Người 3: phần Mốc 6 đã xong. Còn **`get_leaderboard`**, giờ làm được vì M4.3 đã có (`LeaderboardService` ở `stats/`, cùng quyền với `GET /projects/{id}/leaderboard`).
3. Người 1: hết việc Mốc 4, 5, 6. Bản `tl` mới nhất là 0.4.0 (GitHub Release `v0.4.0`, có `tl mcp`). Còn lại: nghiệm thu chung (SPEC 12.3) và M6.17 khi Người 2, 3 xong.

Nhắc chung:
- Job retention (M5.5) chạy mỗi đêm lúc 02:15 UTC và **xóa thật** prompt cũ hơn số ngày cài đặt (mặc định 90). DB dev có dữ liệu mẫu cũ muốn giữ thì đặt `TEAMLENS_RETENTION_JOB=off` trong `apps/api/.env`. DB dev cũ nhớ chạy `db:migrate`: thiếu cột `audit_log.details` (migration 0008) thì job lỗi và rollback.
- Văn bản đồng ý giờ nằm ở bảng `settings` (khóa `consent_text`) và leader sửa trên trang Quản trị (M4.6). Mỗi lần lưu, phiên bản tự tăng và **mọi thiết bị phải chạy `tl consent` một lần**. Phiên bản hiện tại là `2026-11-28.1`.
- Lưu pattern redaction cần helper Rust `apps/api/tools/regex-validator`. Dev build bằng `pnpm --filter @teamlens/api build:regex-validator`. Image Docker **chưa có helper này** (lỗi 1 bên dưới).

### Lỗi sau review Mốc 4: đã sửa (2026-11-28)

| PR | Lỗi |
| --- | --- |
| #158 | Image Docker build `regex-validator` (`/usr/local/bin/regex-validator`); CI có job `api-e2e` (Postgres 16 + helper) chạy toàn bộ e2e API |
| #159 | `high-interruption` tính prompt bị ngắt khi nó hoặc turn nào trước prompt kế tiếp có cờ `interrupted` |
| #157, #160, #164 | Khôi phục mặc định chuyển finding sang rule mặc định rồi mới xóa bản riêng; rescore không cập nhật 5 phút thì `failed` (`rescore_stale`); `needsRerun` so với `startedAt`; dashboard và MCP dùng chung `RulesWriteService.update` (khóa dòng, test nội tuyến trên bản sau khi sửa, cùng cách đánh phiên bản, audit vào `details`, MCP cũng tạo `project_rescore_runs`); rule đổi giữa lúc chạy thì tự xếp thêm một lần chấm; contract `rerun/status` dùng `oneOf` |
| #155, #162 | Cursor audit giữ micro giây; "Ai đã xem" tính `session.view`, `session.ai`, `profile.view` và session đã xóa (audit mới lưu `metadata.ownerId`); mở session chỉ ghi 1 dòng |
| #161 | Điểm tháng trừ phạt từng tuần rồi mới gộp; chỉ xếp thành viên còn trong project; web hiện đúng ngày cuối kỳ |
| #156, #163 | Id pattern theo quy tắc CLI; chặn pattern quá rộng (`pattern_too_broad`: che ≥ 20% byte hoặc khớp dày hơn 1/40 byte trên bộ văn bản mẫu); "Thử" che giống CLI; PATCH cài đặt gửi phiên bản đã đọc, lệch thì 409 |

Còn lại, cần biết:
- Quy tắc che và id trong `apps/api/tools/regex-validator/src/main.rs` là bản chép từ CLI. Đổi `Redactor` của CLI thì sửa cả file này.
- Pattern đã lưu trước #163 mà sai quy tắc mới làm lần lưu pattern sau trả 400 tới khi leader sửa.
- Dòng audit cũ của session đã xóa không có `ownerId` nên không hiện ở "Ai đã xem". Sau khi gộp user (J.8), `ownerId` và `profile.view` vẫn trỏ user cũ.
- DB dev cũ nhớ chạy `db:migrate` (tới 0009).

Quy trình (nhắc cho các PR sau):
- AGENTS.md quy định squash merge.
- Sửa vùng của người khác (#148 đụng `agent/` của Người 1) hoặc vùng nền thì hỏi trước và tách PR.
- Cập nhật TASKS.md và FLOW.md khi xong mốc.

## Ba người, ba nhóm tính năng

| | **Người 1 · Session của tôi lên dashboard** | **Người 2 · Giá trị cho leader** | **Người 3 · MCP + tri thức team** (từ Mốc 6) |
| --- | --- | --- | --- |
| Tính năng | Thu thập (adapter, lọc phạm vi, che secret, hàng đợi, daemon, heartbeat) · Xem session (danh sách, chi tiết, diff, session con, ghi chú, tìm kiếm, trạng thái thiết bị) · Phân phối CLI (release, `install.ps1`, self-update) · **Mốc 6:** lõi AI (`llm`, key BYO, token `tlp_`, trang Cài đặt AI), AI trên trang session | Quản trị và onboarding (project, thành viên, invite, `tl join`, đồng ý, Task Scheduler, trang "Của tôi", audit) · Chấm điểm (rule engine, worker, điểm, quản lý rule) · Báo cáo (tổng quan, hồ sơ, leaderboard) · Vận hành server (compose production, retention, xóa dữ liệu) · **Mốc 6:** phân loại việc (heuristic), báo cáo tuần bằng AI, đề xuất file hướng dẫn | MCP (`/api/v1/mcp`, `tl mcp`, tool đọc và ghi) · Skill Finder · Thư viện prompt |

Vùng file chi tiết của từng người nằm ở [AGENTS.md](../AGENTS.md) mục 3.

## Giai đoạn nền — xong

Monorepo, contract, API (auth, project, quyền, audit, device login), web (login/setup/device, layout), CLI (`tl login`/`logout`/`status`), CI. Chi tiết ở PR #1. Device login và vai trò admin của giai đoạn này được thay ở Mốc 1.5.

---

## Cách đọc bảng

Mỗi mốc là một bảng nhiều cột (hai cột tới Mốc 5, ba cột từ Mốc 6): **mọi người làm song song**, mỗi người đi từ trên xuống trong cột của mình. Các ô cùng hàng chỉ để so tiến độ, không bắt buộc xong cùng lúc. Ô trống nghĩa là người đó đã hết việc của mốc này và **được làm trước task mốc sau trong vùng của mình**. Task có 📜 là PR contract, merge sớm để người khác code theo.

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

**Còn để lại cho mốc sau:** văn bản đồng ý chỉnh được trên web (M4.6, đã xong ở #145–#149). (Phần tải và cài `tl.exe` trong `install.ps1` là M5.2 #83, đăng ký chạy nền khi `tl join` là M3.8 #68, `tl consent`/`tl consent revoke` là M3.7 #69, endpoint `install.ps1` là M3.6 #74, đều đã xong.) **Endpoint `GET /install.ps1?code=` sau đó đã gỡ**, thay bằng lệnh cài `tl` chung từ GitHub Releases (`irm https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.ps1 | iex`, hoặc bản CMD) và bước riêng `tl join <link>`; `installCommand` của API giữ nguyên tên/kiểu, giá trị là lệnh cài chung. Mã mời chỉ hiện một lần lúc tạo; muốn gửi lại thì tạo link mới.

---

## Mốc 2 · Bảo vệ dữ liệu và chấm điểm đầy đủ — ✅ xong (M2.1–M2.10)

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | ✅ **M2.1** Che secret đầy đủ: ≥ 30 loại theo gitleaks + entropy sau từ khóa + bỏ output file `.env*`/`*.pem`/`*.key`; nhận thêm pattern từ `GET /agent/v1/config`<br>**Tự test:** bộ ≥ 30 secret mẫu bị che 100% (#43) | ✅ **M2.6** Seed riêng cho chấm điểm (nhiều người, nhiều tuần, đủ loại anti-pattern), tách khỏi seed chung (#27) |
| 2 | ✅ **M2.2** API `GET /agent/v1/config`: pattern remote, pattern redaction (đọc từ `settings`), ngưỡng cắt, phiên bản văn bản đồng ý (lúc đầu lấy từ `apps/api/src/modules/consent/consent-text.ts`, từ M4.6 đọc từ `settings.consent_text`; khác phiên bản thì CLI ngừng gửi và nhắc đồng ý lại), phiên bản CLI tối thiểu<br>**Tự test:** curl bằng device token (#39, #42) | ✅ **M2.7** Rule engine: phạm vi `user_week`, `aggregate: ratio`, `min_sample`; 16 rule mức high/medium của RULES.md (#28) |
| 3 | ✅ **M2.3** Đọc tăng dần theo offset lưu trong SQLite `state.db`; session ổn định khi file không đổi 2 phút<br>**Tự test:** thêm dòng vào log → chỉ phần mới được gửi (#41) | ✅ **M2.8** Điểm 5 nhóm + `user_weekly_stats` (điểm và số session chỉ tính session gốc; token tính cả session con; finding tuần trừ vào điểm tuần) + API "chạy lại rule" chạy nền (`POST /projects/{id}/rules/rerun`)<br>**Tự test:** test với seed chấm điểm (e2e `weekly-stats`) (#55, #56) |
| 4 | ✅ **M2.4** Claude Code đầy đủ: subagent thành session con, `permission_mode`, `instruction_files`, `interrupted`, compaction<br>**Tự test:** snapshot test có subagent (#40) | ✅ **M2.9** Trang tổng quan project (chỉ leader, mọi project): session, token, chi phí ước tính theo tuần, phân bố agent/model, thống kê không tính điểm, top anti-pattern<br>**Tự test:** xem trên web với seed (#57–#59, #61) |
| 5 | ✅ **M2.5** Adapter Codex (fixtures, đọc, chuẩn hóa, `reasoning_effort`)<br>**Tự test:** snapshot test; `tl sync --once` với session Codex thật (#44) | ✅ **M2.10** Hồ sơ thành viên (`members/[userId]`; leader xem mọi người có audit, member xem của mình qua `tl open`): radar 5 nhóm, xu hướng theo tuần, anti-pattern hay mắc kèm ví dụ và lời khuyên<br>**Tự test:** xem hồ sơ một member seed bằng leader và bằng chính member đó (#62–#64) |

**Demo chung:** session Claude Code (có subagent) và Codex lên dashboard, secret đã che, tổng quan và hồ sơ có điểm.

---

## Mốc 3 · Tự chạy nền — ✅ xong (M3.1–M3.8)

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | ✅ **M3.1** Hàng đợi batch trong SQLite (đã che mới được ghi), retry backoff tối đa 30 phút, giới hạn 500 MB, xử lý `426`; trước khi gửi, hỏi module `consent` (đã có từ J.5)<br>**Tự test:** tắt API rồi bật lại: không mất, không trùng (#50) | ✅ **M3.5** 📜 `openapi/consent.yaml`: `GET` (văn bản hiện hành + trạng thái đồng ý của thiết bị) và `POST /agent/v1/consent` (đồng ý lại khi văn bản đổi hoặc sau khi đã rút, rút đồng ý) (#65). Ghi đồng ý lần đầu đã nằm trong `POST /agent/v1/join`<br>**Tự test:** `pnpm --filter @teamlens/schema build` |
| 2 | ✅ **M3.2** `tl daemon`: named mutex, watch file (`notify`), quét lại 10 phút<br>**Tự test:** chạy `tl daemon`, dùng Claude Code, session tự lên (#53) | ✅ **M3.6** (contract #73, API #74, rewrite web #75) `GET /install.ps1?code=<code>` phía server sinh script tìm `tl.exe` rồi gọi `tl join` (phần tải và kiểm SHA-256 làm ở M5.2, chèn vào chỗ ghi chú "M5.2" trong `install-script.ts`). **Đã gỡ sau đó**, thay bằng lệnh cài chung + `tl join <link>`<br>**Tự test:** chạy script trên máy Windows khác |
| 3 | ✅ **M3.3** Heartbeat (CLI 15 phút + API cập nhật `devices`); `tl pause`/`resume`; `tl status` đầy đủ<br>**Tự test:** `tl pause` → trạng thái thiết bị đổi (#47, #48, #52) | ✅ **M3.7** (API #66, api_client #67, CLI #69, văn bản đồng ý và phiên bản mới #70) `tl consent` (đồng ý lại khi văn bản đổi), `tl consent revoke`, `tl uninstall`; cập nhật văn bản đồng ý (`consent-text.ts`) nhắc tới các lệnh này và tăng phiên bản<br>**Tự test:** rút đồng ý → daemon dừng, `devices.status` = `consent_revoked`, ingest trả 403 |
| 4 | ✅ **M3.4** Xem session nâng cao: diff tô màu (`react-diff-view`), session con lồng trong session cha, ghi chú của leader theo turn<br>**Tự test:** xem session có subagent và diff lớn (#46, #49, #51) | ✅ **M3.8** (#68) Task Scheduler "At log on" trong `tl-platform`; `tl join` (đã có) gọi đăng ký `tl daemon` sau khi đồng ý; `uninstall` gỡ (gọi `unregister_autostart`, làm ở CLI của M3.7)<br>**Tự test:** đăng xuất Windows rồi đăng nhập lại, task tồn tại |

**Điểm chạm:** module `consent` trong CLI — Người 2 viết (J.5, M3.7), Người 1 gọi (M3.1).
**Demo chung:** người mới nhận link mời → cài `tl` bằng lệnh chung rồi `tl join <link>` (lúc làm M3.6 là một lệnh `install.ps1?code=`, nay đã gỡ) → đồng ý → làm việc bình thường, session tự lên dashboard mà không phải chạy `tl sync`.

---

## Mốc 4 · Báo cáo cho leader, minh bạch cho member — ✅ xong (M4.1–M4.6)

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | ✅ **M4.1** Full-text search session (`tsvector`): `?q=` cú pháp web search, đoạn trích và link tới turn khớp (#77, #78)<br>**Tự test:** tìm theo nội dung prompt | ✅ **M4.3** (#137 contract, #138, #139) Leaderboard: tuần/tháng, ngưỡng 5 session, công tắc theo project, chế độ công khai cho member<br>**Tự test:** đăng nhập bằng leader và member |
| 2 | ✅ **M4.2** (#76, #79) Trang thành viên (`members/`, chỉ leader): danh sách kèm thiết bị và trạng thái (online, offline N ngày, tạm dừng, đã rút đồng ý), người mới tham gia gần đây, thu hồi thiết bị, nút "Gộp vào…" (dùng lại `admin/merge-user.tsx`)<br>**Tự test:** `tl pause`, `tl consent revoke` rồi xem | ✅ **M4.4** (#140 contract, #141 migration `project_rescore_runs`, #142) Màn hình quản lý rule: bật/tắt, chỉnh ngưỡng và mức độ, xem JSON, "Thử trên 50 session", "Chạy lại"; 8 rule mức low<br>**Tự test:** đổi ngưỡng rồi chạy lại |
| 3 | _Làm trước M5.1, M5.2_ | ✅ **M4.5** (#143 contract, #144) Trang "Của tôi" (đồng ý đã cấp, thiết bị, ai đã xem session của mình; member vào bằng `tl open`) + trang audit cho leader<br>**Tự test:** leader đăng nhập bằng mật khẩu, member vào bằng `tl open` |
| 4 | | ✅ **M4.6** (#145 contract, #146 migration `consent_text`, #147, #148, #149) Cài đặt server trong trang quản trị: pattern redaction riêng, retention, văn bản đồng ý (sửa thì tăng phiên bản, chuyển nguồn từ `consent-text.ts` sang bảng `settings`), ~~LLM provider~~ (bỏ: AI là BYO theo từng người, key nằm ở trang "Cài đặt AI" của Mốc 6)<br>**Tự test:** thêm pattern → `GET /agent/v1/config` trả về; sửa văn bản đồng ý → CLI ngừng gửi tới khi đồng ý lại |

**Demo chung:** leader xem tổng quan, hồ sơ, leaderboard, tìm kiếm; member chỉ thấy dữ liệu của mình.

---

## Mốc 5 · Cài đặt và phát hành — ✅ xong (M5.1–M5.6)

| Bước | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| 1 | ✅ **M5.1** (#81) Workflow GitHub Release build `tl.exe` + SHA-256<br>**Tự test:** chạy tay không tag (chỉ build artifact), rồi tag `v0.2.0` tạo release thật | ✅ **M5.4** (#106, Người 1 làm thay) `deploy/docker-compose.yml` production (api, web, postgres, caddy) + `Caddyfile` + Dockerfile + hướng dẫn cài. Chỉ mở cổng Caddy ra ngoài: web/API sau proxy tin `X-Forwarded-For` cho giới hạn tần suất của link mời, mở thẳng cổng web thì người ngoài giả được header này<br>**Tự test:** cài trên máy ảo sạch dưới 15 phút |
| 2 | ✅ **M5.2** (#83, #85) `GET /install.ps1` + script: tải, kiểm SHA-256, đặt vào `%LOCALAPPDATA%\teamlens\bin`, thêm PATH, chạy `tl join`. **Endpoint đã gỡ sau đó**: script cài chung là asset `install.ps1`/`install.cmd` của GitHub Releases (nguồn `deploy/`), chỉ cài `tl`, tham gia bằng `tl join <link>` riêng<br>**Tự test:** cài trên máy Windows khác | ✅ **M5.5** (#151 contract, #152, leader làm thay) Job retention hằng đêm (drop partition `turns`, tạo partition mới)<br>**Tự test:** chạy với retention 1 ngày |
| 3 | ✅ **M5.3** (#82, #84) `tl update` và daemon tự cập nhật từ GitHub Releases khi server trả `426`, đòi bản mới, hoặc mỗi 24 giờ<br>**Tự test:** hạ phiên bản rồi chạy | ✅ **M5.6** (#151 contract, #153, leader làm thay) Leader xóa toàn bộ dữ liệu của một người (spec 6.4); nếu Mốc 6 đã có bảng AI thì xóa cả `ai_results`, `user_llm_keys`, `agent_tokens`, mục `prompt_library` liên quan<br>**Tự test:** xóa member2 rồi kiểm tra DB |

**Nghiệm thu chung:** chạy đủ tiêu chí mục 12.3 của [SPEC.md](SPEC.md) (cài server < 15 phút, ngắt mạng 24 giờ, RAM daemon < 30 MB với > 1.000 session, 30 loại secret, session ngoài phạm vi không rời máy).

---

## Mốc 6 · Tính năng AI và MCP

Thiết kế, nguyên tắc và bảng tool MCP: [AI_PLAN.md](AI_PLAN.md). Làm song song với phần còn lại của Mốc 4, 5. Mỗi người một cục lớn, không sửa code của nhau; điểm chạm duy nhất là `LlmService` (Người 1) và các service mà tool MCP import.

| Bước | Người 1 · Lõi AI + AI trên session | Người 2 · Báo cáo AI + rule | Người 3 · MCP + tri thức team |
| --- | --- | --- | --- |
| 1 | ✅ **M6.0** (#97, #98) 📜 PR contract (`ai.yaml`, `agent-tokens.yaml`, khung `mcp.yaml`, `skills.yaml`, `prompt-library.yaml`, `packages/schema/mcp/`) + PR migration **mọi** bảng AI (`user_llm_keys`, `ai_results`, `agent_tokens`, `prompt_library`, `skill_catalog_sources`, `sessions.work_type`), xóa bảng `llm_reviews` chưa dùng, sửa `user-merge.service.ts` cho bảng mới<br>**Tự test:** `pnpm --filter @teamlens/schema build`, `db:migrate` trên DB sạch | Mốc 4, 5 đã xong (M5.4–M5.6 làm thay) | ✅ **M6.3** (#112, #113) Khung MCP: `/api/v1/mcp` (Streamable HTTP, không giữ phiên), guard nhận `tld_`/`tlp_`, cửa ra che secret, tool `whoami`; audit do từng tool tự ghi (xem `modules/mcp/README.md`)<br>**Tự test:** MCP Inspector gọi `whoami` bằng device token của seed |
| 2 | ✅ **M6.1** (#99, #101) Module `llm`: tuần đầu merge interface `LlmService` + adapter giả; sau đó adapter Anthropic + OpenAI-compatible, JSON schema, timeout, phân loại lỗi, câu chặn injection, ghi/ghi đè `ai_results`, mã hóa key<br>**Tự test:** unit test với adapter giả; gọi thật bằng Ollama local | ✅ **M6.7** (#167, contract và code chung một PR) B4 phân loại việc bằng heuristic trong rule worker, lọc theo loại việc, thống kê ở Tổng quan<br>**Tự test:** e2e có đủ loại việc (chưa thử trên dữ liệu thật) | ✅ **M6.4** (#115) `tl mcp`: cầu nối stdio ↔ `/api/v1/mcp` bằng device token; tài liệu cài cho Claude Code, Codex (`cli/AGENTS.md`)<br>**Tự test:** `claude mcp add teamlens -- tl mcp` rồi hỏi "tuần này tôi bị finding gì" |
| 3 | ✅ **M6.2** (#103, #104) Trang "Cài đặt AI" `(dashboard)/settings/ai`: API key của tôi (nhập, kiểm tra, xóa) + token cho agent `tlp_` (tạo, liệt kê, thu hồi); link sidebar (PR vùng nền nhỏ)<br>**Tự test:** leader và member (qua `tl open`) cùng thêm key | ✅ **M6.8** (#169 contract, #170 code) B1 báo cáo tuần theo người (trang hồ sơ thành viên)<br>**Tự test:** e2e leader xem của member, member xem của mình, kết quả của người này người khác không thấy (chưa thử LLM thật) | ✅ **M6.15** (#117, #118) 10 tool MCP đọc (`whoami`, `list_projects`, `list_members`, `get_overview`, `get_member_profile`, `search_sessions`, `get_session`, `get_findings`, `list_rules`, `get_rule`, `get_my_ai_results`; còn thiếu `get_leaderboard` chờ M4.3, `get_skill_clusters` và `get_prompt_library` đã thêm ở M6.11 và M6.14); import service sẵn có, không sửa code module khác<br>**Tự test:** member chỉ thấy dữ liệu của mình, leader thấy tất cả, có audit |
| 4 | ✅ **M6.5** (#102) A1 tóm tắt + A5 đánh giá kết quả trên trang session<br>**Tự test:** bấm lại thì ghi đè; người khác mở cùng session không thấy kết quả | ✅ **M6.9** (#172 contract, #173 code) B2 báo cáo tuần của team (Tổng quan, chỉ leader)<br>**Tự test:** e2e nhiều tuần, AI chỉ thấy số liệu ẩn danh (chưa thử LLM thật) | ✅ **M6.16** (#120 migration `audit_log.details`, #121 contract, #122 code) Tool MCP ghi cho leader (`draft_rule`, `test_rule`, `save_rule`, `set_rule_enabled`, `add_session_note`) + MCP prompts `coach-me`, `weekly-review` (`find-skills`, `improve-agents-md` chờ M6.11 và C3). **Chỉ chỉnh rule session có sẵn** (ngưỡng, mức độ, thông điệp, lời khuyên), không đổi `match`, không tạo rule mới<br>**Tự test:** tắt rule qua MCP → audit có giá trị cũ/mới, điểm được tính lại |
| 5 | ✅ **M6.6** (#102) A4 giải thích finding<br>**Tự test:** finding của rule `repeated-correction` trong seed | **M6.10** C3 đề xuất bổ sung CLAUDE.md/AGENTS.md từ finding lặp lại của project<br>**Tự test:** seed có nhiều session không chạy test | ✅ **M6.11** (#124 contract, #125 code) S0 gom cụm prompt (hỗ trợ tiếng Việt) + trang Skill Finder `projects/[projectId]/skills` + tool MCP `get_skill_clusters`; gom bằng dấu vân tay 4 từ khóa nên chỉ gần đúng (S1 lọc lại ở M6.12)<br>**Tự test:** prompt tiếng Việt có dấu gom đúng cụm |
| 6 | | | ✅ **M6.12** (#127 contract, #128 code) S1 triage + S2 sinh `SKILL.md` + prompt MCP `find-skills`<br>**Tự test:** nút AI của cụm (chưa thử LLM thật) → ✅ **M6.13** (#130 contract, #131 code) S3 catalog nhiều nguồn cấu hình được + AI chọn skill có sẵn<br>**Tự test:** đọc catalog thật từ GitHub (320 skill, 2 giây); chưa thử LLM thật → ✅ **M6.14** (#133 contract, #134 code) C2 thư viện prompt (tìm ứng viên, duyệt, trang cho member, tool MCP `get_prompt_library`)<br>**Tự test:** leader duyệt một prompt có ẩn tên, member thấy mà không thấy tên (đã có e2e; chưa thử LLM thật) |

**Điểm chạm:** `LlmService` (Người 1) được Người 2, 3 dùng; tool MCP (Người 3) import service của `sessions`, `stats`, `rules`, `projects`; tool bật/tắt rule gọi service của `rules` (Người 2). Link sidebar, đăng ký module trong `app.module.ts`, lệnh `mcp` trong bộ phân tích lệnh của CLI là vùng nền: PR nhỏ, merge sớm.
**Nghiệm thu chung (M6.17):** nút AI chạy với key Anthropic và với Ollama; MCP chạy với Claude Code và Codex, đăng nhập bằng member (`tl mcp`) và leader (token `tlp_`); kết quả AI của người này người khác không thấy.
