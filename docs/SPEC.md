# TeamLens — Đặc tả kỹ thuật (MVP)

> Cập nhật: 2026-11-26 · Bản gốc (có sơ đồ, comment): https://claude.ai/artifact/FNJegjsNGK6tjdhCcXHvnY

## 1. Tổng quan

TeamLens (lệnh `tl`) là công cụ open-source, tự host, giúp leader xem thành viên prompt gì và prompt như thế nào với AI coding agent trong các dự án mình quản lý, từ đó đánh giá kỹ năng và hiệu quả của từng người. Công cụ dành cho team, chạy bằng CLI riêng và không phụ thuộc vào IDE nào.

**Bài toán.** Có thành viên prompt kém, không hoàn thành task, nhưng leader không thấy được họ đã làm việc với agent như thế nào.

**Người dùng**

| Vai trò | Cần gì |
| --- | --- |
| Leader | Người tự host server và có toàn quyền: tạo project, khai báo repo, tạo link mời, xem prompt/session/diff của thành viên, điểm kỹ năng, anti-pattern, leaderboard, cấu hình LLM key và thời gian giữ dữ liệu |
| Member | Tham gia bằng một lệnh `tl join <link mời>`; xem dữ liệu và điểm của chính mình, biết cần cải thiện gì, kiểm soát việc đồng ý |

Không có vai trò Admin riêng: server do leader tự host nên leader là vai trò cao nhất (xem mục 11.1).

**Mục tiêu MVP**

- Thu thập tự động session của Claude Code và Codex CLI trên Windows (Copilot ở phase 2), chỉ những session thuộc repo của project.
- Leader đọc lại được toàn bộ session (prompt, câu trả lời, tool call, diff) trên web dashboard.
- Chấm điểm anti-pattern bằng rule trên server; chấm bằng LLM khi bấm nút.

**Không làm (non-goals)**

- Không theo dõi hoạt động ngoài các repo đã đăng ký, không chụp màn hình, không keylog.
- Không chống tắt: thành viên luôn có quyền tắt hoặc rút đồng ý; leader chỉ được báo trạng thái.
- Không làm extension IDE, không làm SaaS multi-org trong MVP.

## 2. Phạm vi và lộ trình

MVP chạy trên Windows với Claude Code và Codex; Copilot, chấm bằng LLM và Antigravity sang phase 2. Chưa đặt mốc ngày cụ thể cho từng phase.

| Phase | Nội dung | Cổng để sang phase sau |
| --- | --- | --- |
| Phase 0 · Nền móng (khoảng 1 tuần) | OpenAPI contract, schema session v1, monorepo + CI, log mẫu để test | Contract đã chốt |
| **Phase 1 · MVP** (Windows, 2 agent) | Adapter Claude Code, adapter Codex, đồng ý + che secret, hàng đợi + heartbeat, ingest/auth/rule, 5 màn hình dashboard | Đạt tiêu chí mục 12.3 |
| Phase 2 · Mở rộng | Adapter Copilot, chấm bằng LLM, Antigravity (beta), đọc log agent chạy trong WSL, bản macOS/Linux | Chạy ổn với team thật |
| Phase 3 · Trưởng thành | SSO, gắn với PR và issue, winget/scoop, Remote-SSH/Dev Container, có thể làm SaaS | — |

## 3. Kiến trúc tổng thể

Hệ thống gồm ba phần nối với nhau qua một contract OpenAPI: CLI Rust trên máy thành viên, API NestJS kèm Postgres, và web dashboard Next.js, tất cả trên một VPS tự host.

```
┌─ Máy thành viên · Windows ─────────────────────────────────────────────┐
│  Claude Code · JSONL     Codex CLI · JSONL     Copilot VS Code · JSON  │
│          │                     │                       │               │
│  ┌─ tl.exe · daemon Rust, chạy theo user ────────────────────────────┐ │
│  │ Adapter → [Lọc git remote] → Chuẩn hóa → [Che secret] → Hàng đợi  │ │
│  │                                                         SQLite    │ │
│  └───────────────────────────────────────────────────────────┬───────┘ │
└──────────────────────────────────────────────────────────────┼─────────┘
                     HTTPS · ingest theo batch + heartbeat 15 phút
┌─ VPS tự host · docker compose ───────────────────────────────┼─────────┐
│  Caddy · HTTPS  →  API · NestJS  →  Postgres 16  ←  Rule worker        │
│                        ↑                                 │             │
│                   Web · Next.js                          │             │
└────────────────────────┼─────────────────────────────────┼─────────────┘
              Trình duyệt leader/member           LLM provider (chỉ khi bấm nút)
```

Phần lọc theo git remote và che secret chạy trên máy thành viên, nên server không bao giờ nhận session ngoài dự án hay secret chưa che. Rule worker chạy nền sau mỗi lần ingest; LLM chỉ được gọi khi người dùng bấm nút.

## 4. CLI (Rust)

CLI là một file `tl.exe` duy nhất, viết bằng Rust, vừa là công cụ dòng lệnh vừa là daemon chạy nền. MVP chỉ hỗ trợ Windows 10/11 x64; code phải tách phần phụ thuộc hệ điều hành để sau này build thêm macOS và Linux.

### 4.1 Lệnh

| Lệnh | Việc làm |
| --- | --- |
| `tl join <invite-url>` | **Lệnh duy nhất thành viên cần chạy.** Đọc địa chỉ server và mã mời từ link, hiển thị màn hình đồng ý (hỏi tên hiển thị), đổi mã mời lấy device token, đăng ký daemon (mục 4.3, 7.1). `tl login <invite-url>` là tên gọi khác của cùng lệnh |
| `tl open` | Mở dashboard trên trình duyệt, đã đăng nhập sẵn bằng device token của máy này (member không có mật khẩu, mục 7.1) |
| `tl logout` | Thu hồi token của máy này; muốn dùng lại thì chạy `tl join` với một link mời còn hạn |
| `tl status` | Trạng thái daemon, agent phát hiện được, số session đang chờ gửi, lần sync cuối, lỗi parse |
| `tl preview [session]` | Hiển thị chính xác payload sẽ gửi (sau khi che secret và cắt output) |
| `tl sync` | Ép quét và gửi ngay |
| `tl pause` / `tl resume` | Tạm dừng thu thập; server ghi nhận trạng thái `paused` |
| `tl consent revoke` | Rút đồng ý: dừng daemon, xóa hàng đợi local, báo server `consent_revoked` |
| `tl daemon` | Chế độ nền (được Task Scheduler gọi, người dùng không gọi trực tiếp) |
| `tl uninstall` | Gỡ task khởi động, xóa config và hàng đợi, báo server |

### 4.2 Daemon trên Windows

- Đăng ký bằng Task Scheduler, trigger "At log on" của user hiện tại, không cần quyền admin. Chạy không có cửa sổ console.
- Chỉ một instance chạy tại một thời điểm (named mutex).
- Theo dõi thư mục log bằng `notify` (ReadDirectoryChangesW), kèm quét lại toàn bộ mỗi 10 phút để không sót sự kiện.
- Session coi là "đã ổn định" khi file không đổi trong 2 phút; gửi tăng dần theo offset, không chờ session kết thúc.
- Heartbeat mỗi 15 phút, kèm phiên bản CLI, agent phát hiện được và số lỗi parse.
- Giới hạn tài nguyên mục tiêu: dưới 30 MB RAM khi rảnh, dưới 2% CPU trung bình.

### 4.3 Luồng đồng ý khi `tl join`

Màn hình đồng ý là một phần của `tl join`, chạy trong terminal, không cần trình duyệt.

1. Hiển thị tên server, project và danh sách repo sẽ được thu thập (lấy từ `GET /agent/v1/invites/{code}`).
2. Liệt kê dữ liệu sẽ gửi: toàn bộ prompt, câu trả lời, tool call, diff code; output bị cắt; secret bị che.
3. Hỏi tên hiển thị (để leader biết ai là ai; không hỏi email, không đặt mật khẩu).
4. Hỏi riêng: có gửi toàn bộ lịch sử session cũ trên máy không (kèm số lượng và khoảng ngày).
5. Người dùng gõ `yes`. Từ chối thì CLI thoát, không gọi server lần nào nữa, không cài daemon, không gửi gì.
6. Bản ghi đồng ý (phiên bản văn bản, thời điểm, lựa chọn backfill) được gửi cùng request `POST /agent/v1/join`, nên không có trạng thái "đã có token nhưng chưa đồng ý".

Khi văn bản đồng ý thay đổi trên server, daemon dừng gửi cho tới khi người dùng đồng ý lại qua `tl consent` (ghi bằng `POST /agent/v1/consent`).

### 4.4 Hàng đợi offline và lưu trữ local

- SQLite tại `%LOCALAPPDATA%\teamlens\state.db`: offset đã đọc của từng file, batch chờ gửi, lỗi parse.
- Batch đã chuẩn hóa và đã che secret mới được ghi vào hàng đợi; không bao giờ lưu nội dung chưa che.
- Mất mạng thì retry với exponential backoff (tối đa 30 phút); hàng đợi giới hạn 500 MB, đầy thì bỏ batch cũ nhất và báo qua heartbeat.
- Vì Claude Code tự xóa transcript sau 30 ngày, daemon phải đọc session trước thời điểm đó; batch đã vào hàng đợi thì không phụ thuộc file gốc.

### 4.5 Crate dự kiến

`clap` (CLI), `tokio` (async), `reqwest` + `rustls` (HTTPS), `notify` (watch file), `rusqlite` (state + đọc DB của agent), `serde_json`, `regex`, `git2` hoặc gọi `git` (đọc remote), `windows` (Task Scheduler, mutex), `self_update` (tự cập nhật từ GitHub Releases).

Crate đặt tên `teamlens` (còn trống trên crates.io; `tl` đã có người dùng), khai báo `[[bin]] name = "tl"` để build ra `tl.exe`.

## 5. Adapter agent và schema chuẩn hóa

Mỗi agent có một adapter riêng chuyển log gốc thành một schema chung; server và rule chỉ biết schema chung này, nên thêm agent mới không phải sửa server. Toàn bộ định dạng log đều là nội bộ, không có tài liệu chính thức; thông tin dưới đây từ reverse-engineering của cộng đồng và các parser mã nguồn mở, cần kiểm chứng lại khi code.

### 5.1 Adapter

| Agent | Vị trí trên Windows | Định dạng | Lấy cwd từ | Ghi chú |
| --- | --- | --- | --- | --- |
| Claude Code | `%USERPROFILE%\.claude\projects\<cwd-mã-hóa>\<uuid>.jsonl` (đổi root qua `CLAUDE_CONFIG_DIR`) | JSONL, mỗi dòng một event | Trường `cwd` trên từng dòng | Usage lặp lại trên mỗi content block, phải đếm một lần theo `message.id`; có transcript subagent |
| Codex CLI | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` + `archived_sessions\` (đổi root qua `CODEX_HOME`) | JSONL `{type, timestamp, payload}` | `session_meta.payload.cwd` | Token từ event `token_count`; có thể có store riêng của bản desktop và WSL |
| GitHub Copilot (VS Code) — phase 2 | `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\*.json[l]` (+ `Code - Insiders`) | JSON cũ, hoặc JSONL dạng patch log (`kind` 0/1/2) cần replay | `workspace.json` cùng thư mục hash | Token không đáng tin, gắn nhãn "ước tính" |
| Antigravity — phase 2, thử nghiệm | `%USERPROFILE%\.gemini\antigravity\conversations\` | `.pb` cũ có vẻ bị mã hóa; `.db` mới là SQLite chứa protobuf không schema | Blob `trajectory_metadata_blob` (chưa chắc) | Chỉ đọc `.db`, best-effort |

Thứ tự làm: Claude Code → Codex → Copilot (Copilot khó nhất vì phải replay patch log).

**Subagent của Claude Code** được gửi thành session con: mỗi transcript subagent là một session riêng, `parent_source_id` trỏ về session cha. Dashboard hiển thị session con lồng trong session cha.

**WSL, Remote-SSH, Dev Container:** MVP chỉ đọc log nằm trên Windows. Agent chạy trong WSL ghi log vào ổ WSL nên MVP không thấy; `tl status` cảnh báo khi phát hiện có distro WSL. Phase 2 đọc log WSL qua `\\wsl.localhost\<distro>\home\...` (CLI vẫn chạy trên Windows). Remote-SSH và Dev Container để phase 3.

### 5.2 Interface adapter (Rust)

```rust
pub trait Adapter {
    fn id(&self) -> AgentKind;                       // claude_code | codex | copilot_vscode | ...
    fn discover(&self) -> Vec<SourceFile>;           // tìm file log trên máy
    fn read_incremental(&self, f: &SourceFile, from: Offset)
        -> Result<(Vec<RawEvent>, Offset), ParseError>;
    fn normalize(&self, events: Vec<RawEvent>) -> Vec<NormalizedSession>;
}
```

Quy tắc: gặp bản ghi không nhận ra thì bỏ qua và đếm vào `parse_warnings`, không crash; dòng quá 10 MB (ảnh base64) bị cắt; mỗi adapter ghi lại `agent_version` đọc được từ log. Mỗi adapter có bộ test snapshot bằng log mẫu theo từng phiên bản agent.

### 5.3 Schema session chuẩn hóa (v1)

```json
{
  "schema_version": 1,
  "session": {
    "source_id": "claude_code:5e1c...",
    "agent": "claude_code",
    "agent_version": "2.1.4",
    "repo_remote": "github.com/org/repo",
    "branch": "feat/x",
    "cwd_relative": "apps/api",
    "started_at": "2026-11-26T08:00:00Z",
    "ended_at": "2026-11-26T08:42:10Z",
    "parent_source_id": null
  },
  "turns": [
    {
      "seq": 0,
      "role": "user | assistant | system",
      "kind": "prompt | reply | tool_call | tool_result | compaction",
      "ts": "2026-11-26T08:00:03Z",
      "model": "claude-opus-5-5",
      "text": "...",
      "tool": { "name": "Edit", "input": {}, "status": "ok | error" },
      "output": { "text": "...", "truncated": true, "original_bytes": 48211 },
      "diff": { "path": "src/a.ts", "patch": "@@ ...", "added": 12, "removed": 3 },
      "usage": { "input": 1200, "output": 340, "cache_read": 9000, "cache_write": 0, "estimated": false },
      "attachments": [{ "type": "image", "count": 1 }],
      "redactions": [{ "type": "aws_access_key", "count": 1 }]
    }
  ]
}
```

- `source_id` = agent + id gốc của session, dùng để upsert và chống trùng khi gửi tăng dần.
- `parent_source_id` khác `null` khi session là subagent (session con).
- `repo_remote` được chuẩn hóa: bỏ `https://`, `git@`, `.git`, chữ thường. `cwd` tuyệt đối không gửi lên, chỉ gửi đường dẫn tương đối trong repo.
- Ảnh không gửi lên trong MVP, chỉ đếm số lượng.

## 6. Quyền riêng tư và xử lý dữ liệu trước khi gửi

Mọi bước lọc và che đều chạy trên máy thành viên, trước khi dữ liệu rời máy; server không bao giờ nhận nội dung ngoài phạm vi hoặc secret chưa che. Thứ tự xử lý: lọc phạm vi → chuẩn hóa → che secret → cắt output → đưa vào hàng đợi.

### 6.1 Lọc phạm vi theo git remote

1. Khi khởi động và mỗi 1 giờ, CLI tải danh sách pattern remote của các project mà user là thành viên (ví dụ `github.com/org/*`).
2. Với mỗi session, lấy `cwd`, đi ngược lên tìm thư mục `.git`, đọc tất cả remote (kể cả worktree và submodule). Kết quả cache theo đường dẫn.
3. Khớp với pattern: có thì gắn `project_id` và xử lý tiếp. Không khớp, hoặc không phải git repo, thì bỏ hoàn toàn, không gửi cả metadata hay số đếm.
4. Session mà `cwd` đổi giữa chừng (agent `cd` sang repo khác) được xét theo `cwd` lúc bắt đầu.

### 6.2 Che secret

- Bộ pattern có sẵn theo kiểu gitleaks: AWS key, GitHub/GitLab token, Slack token, khóa API của OpenAI/Anthropic/Google, JWT, private key PEM, connection string có mật khẩu, `password=` trong URL và file `.env`.
- Thêm kiểm tra entropy cho chuỗi dài từ 20 ký tự, chỉ áp dụng khi đứng sau từ khóa như `key`, `secret`, `token`, `password` để tránh che nhầm hash commit.
- Thay bằng `[REDACTED:<loại>]`, ghi số lượng vào `redactions`. Nội dung file `.env*`, `*.pem`, `*.key` mà agent đọc thì bỏ toàn bộ output.
- Leader thêm được pattern riêng trên server; CLI tải về cùng danh sách remote.

### 6.3 Giữ gì, cắt gì

| Loại dữ liệu | Xử lý |
| --- | --- |
| Prompt của user, câu trả lời của agent | Giữ nguyên (sau khi che secret) |
| Thinking/reasoning của model | Giữ, tối đa 8 KB mỗi block |
| Tên tool và input | Giữ, input quá 4 KB thì cắt |
| Diff code (Edit, Write, apply_patch) | Giữ đầy đủ, tối đa 256 KB mỗi diff |
| Output đọc file, chạy lệnh, tìm kiếm | Giữ 2 KB đầu và 1 KB cuối, ghi `original_bytes` |
| Ảnh đính kèm | Chỉ đếm số lượng |
| Đường dẫn tuyệt đối, tên máy, tên user Windows | Thay bằng đường dẫn tương đối trong repo hoặc `~` |

Các ngưỡng trên là mặc định, leader chỉnh được trên server.

### 6.4 Minh bạch

- `tl preview` cho thành viên xem đúng payload sẽ gửi.
- Mỗi lần leader mở một session của người khác, server ghi audit log (ai, lúc nào, session nào). Thành viên xem được audit log liên quan tới mình (qua `tl open`).
- Thành viên rút đồng ý thì dữ liệu cũ vẫn nằm trên server theo retention; leader xóa được toàn bộ dữ liệu của một người khi có yêu cầu.

## 7. Server API

Server NestJS có hai nhóm API: `/agent/v1/*` cho CLI (xác thực bằng device token, trừ hai endpoint đọc/dùng link mời) và `/api/v1/*` cho dashboard (xác thực bằng session cookie). Contract viết bằng OpenAPI trước khi code; CLI Rust sinh client từ spec này.

### 7.1 Danh tính và tham gia bằng link mời

**Nguyên tắc:** link mời là thứ duy nhất thành viên cần. Mã mời được đổi trực tiếp lấy device token; device token là danh tính của thành viên. Thành viên không có email, không có mật khẩu và không phải qua lại giữa trình duyệt với CLI. Chỉ leader có email + mật khẩu (để vào dashboard từ bất kỳ máy nào).

**Leader chuẩn bị (một lần):**

1. `docker compose up -d` trên VPS, mở web lần đầu.
2. Trang `/setup` là một wizard: tạo tài khoản leader (email + mật khẩu) → tạo project đầu tiên + repo pattern → hiện ngay link mời và câu lệnh cài để copy.
3. Leader gửi link (hoặc câu lệnh) cho cả nhóm qua kênh chat.

**Link mời** (`https://teamlens.congty.com/i/<code>`): dùng chung cho cả nhóm, gắn với một project. Mặc định hết hạn sau 7 ngày; leader đặt được giới hạn số lượt dùng (`max_uses`) và thu hồi bất cứ lúc nào. Mã sinh ngẫu nhiên 32 byte, DB chỉ lưu SHA-256. Mở link bằng trình duyệt thì trang `/i/<code>` chỉ hiện hướng dẫn cài và câu lệnh cần chạy.

**Thành viên tham gia (một lệnh):**

```
tl join https://teamlens.congty.com/i/<code>
# hoặc, khi chưa cài tl.exe:
irm https://teamlens.congty.com/install.ps1?code=<code> | iex
```

1. CLI gọi `GET /agent/v1/invites/{code}` (công khai): nhận tên project, repo pattern, văn bản đồng ý và phiên bản. Link sai, hết hạn, hết lượt hay đã thu hồi thì báo lỗi và dừng.
2. Màn hình đồng ý trong terminal (mục 4.3): hỏi tên hiển thị, hỏi backfill, người dùng gõ `yes`.
3. CLI gọi `POST /agent/v1/join` với `{ code, name, deviceName, os, cliVersion, consent: { textVersion, backfill } }`. Trong một transaction, server: khóa dòng invite và kiểm tra lại → tạo `users` (role `member`, không email, không mật khẩu) → `project_members` → `devices` (kèm `token_hash`) → `consents` → tăng `invites.used_count` → ghi audit `member.join`. Trả device token đúng một lần.
4. CLI lưu token vào Windows Credential Manager, lưu địa chỉ server vào config, đăng ký `tl daemon` bằng Task Scheduler.

**Máy đã tham gia, dùng link của project khác:** `tl join <link khác>` gửi kèm device token hiện có; server không tạo user/thiết bị mới mà chỉ thêm `project_members` và `consents` cho user đó.

**Thành viên xem dashboard:** `tl open` gọi `POST /agent/v1/web-login` (bằng device token), nhận URL `/auth/cli?ticket=<ticket>` sống 60 giây, dùng một lần, rồi mở trình duyệt. Web đổi ticket qua `POST /api/v1/auth/ticket` lấy cookie `tl_session` như đăng nhập thường. DB chỉ lưu SHA-256 của ticket.

**Thu hồi:** mỗi máy một token, không hết hạn theo thời gian. Token mất hiệu lực khi thành viên chạy `tl logout`, khi leader hoặc chính thành viên thu hồi thiết bị trên dashboard, hoặc khi user bị xóa.

**Máy thứ hai, cài lại Windows, mất token:** thành viên chạy lại `tl join` với link mời còn hạn. Server không nhận ra đó là cùng một người nên tạo một user mới; leader vào trang Thành viên bấm **"Gộp vào…"** để nhập user mới vào user cũ (mục 10). Gộp là chuyển `devices`, `sessions`, `consents`, `project_members` sang user cũ, ghi audit `member.merge`, xóa user thừa, rồi chấm lại điểm và tính lại `user_weekly_stats` của các tuần bị ảnh hưởng. Nếu hai user có session trùng `source_id` thì giữ bản có `updated_at` mới hơn.

**Bảo mật của link chung:** ai có link còn hạn đều tham gia được. Người lạ tham gia chỉ gửi được dữ liệu của chính họ và không xem được dữ liệu của ai khác (member chỉ thấy dữ liệu của mình). Leader thấy ngay người mới trên trang Thành viên để xóa, và thu hồi link khi lộ. Hai endpoint công khai giới hạn 10 request/phút mỗi IP.

### 7.2 Endpoint cho CLI

| Method + path | Mô tả |
| --- | --- |
| `GET /agent/v1/invites/{code}` | Công khai. Xem trước link mời: project, repo pattern, văn bản đồng ý, phiên bản |
| `POST /agent/v1/join` | Công khai (hoặc kèm device token nếu máy đã tham gia). Đổi mã mời + đồng ý lấy device token |
| `POST /agent/v1/web-login` | Xin ticket đăng nhập dashboard một lần cho `tl open` |
| `GET /agent/v1/whoami` | User, thiết bị và các project kèm repo pattern |
| `POST /agent/v1/logout` | Thu hồi token của chính máy đang gọi |
| `GET /agent/v1/config` | Danh sách pattern remote, pattern redaction, ngưỡng cắt, phiên bản văn bản đồng ý, phiên bản CLI tối thiểu |
| `POST /agent/v1/consent` | Ghi nhận đồng ý hoặc rút đồng ý |
| `POST /agent/v1/ingest` | Gửi một batch session (định dạng mục 5.3), nén gzip, tối đa 10 MB |
| `POST /agent/v1/heartbeat` | Trạng thái daemon, phiên bản, agent phát hiện được, lỗi parse, kích thước hàng đợi |

### 7.3 Ngữ nghĩa ingest

- Mỗi batch có `batch_id` (UUID do CLI sinh); server lưu lại để gửi lại không bị trùng (idempotent).
- Session upsert theo `(user_id, source_id)`; turn upsert theo `(session_id, seq)`, nên gửi tăng dần và gửi lại đều an toàn.
- Server kiểm tra lại `repo_remote` thuộc project mà user là thành viên; không thuộc thì từ chối session đó.
- Trả về `202 Accepted`; việc chạy rule được đẩy vào hàng đợi job `pg-boss` (chạy trên chính Postgres, không cần Redis). Job được enqueue cùng transaction với ingest.
- `schema_version` không hỗ trợ thì trả `426` kèm phiên bản CLI tối thiểu; CLI tự cập nhật.
- Giới hạn tốc độ: 60 request/phút mỗi thiết bị.

### 7.4 Endpoint cho dashboard (rút gọn)

`/auth/*` (leader đăng nhập email + mật khẩu; `POST /auth/ticket` đổi ticket của `tl open`; SSO để phase 3) · `/projects` · `/projects/:id/members` · `/projects/:id/invites` (tạo, liệt kê, thu hồi) · `/users/:id/merge` (POST, gộp user) · `/projects/:id/overview` · `/projects/:id/leaderboard` · `/projects/:id/rules` · `/users/:id/profile?project=` · `/sessions?project=&user=&agent=&from=&to=&q=` · `/sessions/:id` · `/sessions/:id/llm-review` (POST) · `/sessions/:id/notes` · `/audit` · `/settings`.

## 8. Data model (Postgres)

Postgres 16 là nơi lưu duy nhất; nội dung prompt dùng full-text search sẵn có, không cần Elasticsearch ở MVP. Bảng `turns` lớn nhất nên được partition theo tháng để xóa theo retention bằng cách drop partition.

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| `users` | id, name, role, email, password_hash, created_at, deleted_at | role: `leader`, `member`. `email` và `password_hash` chỉ leader có (null với member) |
| `devices` | id, user_id, name, os, cli_version, token_hash, last_seen_at, status, revoked_at | status: online, offline, paused, consent_revoked |
| `projects` | id, name, slug, settings (jsonb), created_at | settings: bật leaderboard, ngưỡng cắt output |
| `project_repos` | id, project_id, remote_pattern | ví dụ `github.com/org/*` |
| `project_members` | project_id, user_id | Chỉ ghi ai thuộc project nào; vai trò nằm ở `users.role` |
| `invites` | id, project_id, code_hash, expires_at, max_uses, used_count, revoked_at, created_by | Link chung, chỉ tạo member; `max_uses` null = không giới hạn |
| `web_login_tickets` | id (SHA-256 của ticket), user_id, device_id, expires_at, used_at | Ticket 60 giây cho `tl open` |
| `consents` | id, user_id, device_id, text_version, backfill, granted_at, revoked_at | |
| `sessions` | id, user_id, project_id, device_id, source_id, agent, agent_version, repo_remote, branch, started_at, ended_at, turn_count, token totals, parent_session_id | unique (user_id, source_id) |
| `turns` | session_id, seq, role, kind, ts, model, text, tool (jsonb), output (jsonb), diff (jsonb), usage (jsonb), redactions (jsonb), tsv (tsvector) | PK (session_id, seq), partition theo `ts` |
| `rules` | id, project_id (null = mặc định toàn instance), key, category, severity, definition (jsonb), enabled, version | |
| `findings` | id, session_id, rule_id, rule_version, turn_seq, evidence (jsonb), created_at | |
| `session_scores` | session_id, category, score, computed_at | 5 nhóm kỹ năng, mục 9 |
| `llm_reviews` | id, session_id, requested_by, provider, model, rubric_version, result (jsonb), cost_usd, created_at | |
| `user_weekly_stats` | user_id, project_id, week, sessions, tokens, scores (jsonb) | Bảng tổng hợp, giữ lâu dài sau khi nội dung thô bị xóa |
| `notes` | id, session_id, author_id, turn_seq, body, created_at | Ghi chú của leader |
| `audit_log` | id, actor_id, action, target_type, target_id, at | |
| `settings` | key, value (jsonb) | LLM key (mã hóa), retention, pattern redaction |

LLM API key được mã hóa bằng AES-GCM với khóa lấy từ biến môi trường `TEAMLENS_SECRET_KEY`. ORM: Drizzle; migration là file SQL, phần partition và full-text search viết SQL tay.

## 9. Rule engine và chấm bằng LLM

Rule chạy tự động trên server sau mỗi lần ingest và cho ra điểm 0–100 theo 5 nhóm kỹ năng; LLM chỉ chạy khi người dùng bấm nút. Khi rule thay đổi, leader bấm "Chạy lại" để tính lại trên dữ liệu cũ còn trong retention.

### 9.1 Nhóm kỹ năng và rule khởi đầu

Danh mục đầy đủ (24 rule MVP, ngưỡng, nguồn, rule bị loại và lý do) nằm ở [RULES.md](RULES.md); bảng dưới chỉ là ví dụ.

| Nhóm | Ví dụ rule |
| --- | --- |
| Chất lượng prompt | Prompt đầu session dưới 15 từ mà không tham chiếu file; prompt chỉ có "fix", "làm tiếp", "sai rồi"; không nêu tiêu chí hoàn thành |
| Cung cấp context | Không có file hướng dẫn (CLAUDE.md, AGENTS.md, copilot-instructions) trong repo; dán log lỗi dài thay vì chỉ đường dẫn; không đính file liên quan |
| Vòng sửa lỗi | Từ 3 lượt liên tiếp user phản bác ("không đúng", "vẫn lỗi"); cùng một file bị sửa rồi hoàn tác nhiều lần; cùng lệnh test fail từ 3 lần |
| Quản lý session | Session kéo dài qua nhiều chủ đề không liên quan; bị compaction từ 2 lần; dùng model đắt tiền cho việc vặt |
| Kiểm chứng kết quả | Agent sửa code nhưng session không chạy test hay build; chấp nhận diff lớn (trên 500 dòng) mà không có lượt review nào |

Điểm nhóm = 100 trừ tổng trọng số các finding theo mức độ (low 5, medium 10, high 20), tối thiểu 0. Điểm theo tuần của một người là trung bình có trọng số theo số turn của các session trong tuần.

Prompt trong session con (subagent) do agent chính viết, không phải người viết. Vì vậy rule nhóm "Chất lượng prompt" chỉ chạy trên session gốc; session con chỉ dùng cho thống kê token, chi phí và tool call. Điểm tuần và leaderboard chỉ tính session gốc.

### 9.2 Định nghĩa rule

Rule là JSON khai báo, lưu trong DB, không chạy code tùy ý. MVP hỗ trợ các phép: đếm, so sánh ngưỡng, regex trên text, chuỗi lượt liên tiếp. Rule có phạm vi `session` (finding cho từng session) hoặc `user_week` (tỉ lệ trên các session của một người trong tuần, có `min_sample`), và kèm ca kiểm thử nội tuyến (`tests`), xem RULES.md mục 5.

```json
{
  "key": "repeated-correction",
  "category": "correction_loop",
  "severity": "high",
  "scope": "session",
  "match": {
    "consecutive": {
      "where": { "role": "user", "kind": "prompt", "text_regex": "(?i)(không đúng|vẫn lỗi|still (broken|wrong)|doesn't work)" },
      "min": 3
    }
  },
  "message": "Phải sửa đi sửa lại {{count}} lượt liên tiếp",
  "advice": "Dừng lại, mô tả lại yêu cầu kèm tiêu chí đúng/sai và file liên quan, hoặc mở session mới."
}
```

Leader bật/tắt rule và chỉnh ngưỡng theo project; màn hình rule có nút "Thử trên 50 session gần nhất".

### 9.3 Chấm bằng LLM

- Kích hoạt: nút "Chấm bằng LLM" trên trang session. Chỉ hiện khi leader đã cấu hình provider. Không chạy tự động.
- Provider: Anthropic, OpenAI, Gemini, hoặc endpoint tương thích OpenAI (Ollama, vLLM). Leader nhập key và chọn model.
- Đầu vào: các turn của session (đã cắt gọn theo ngân sách token cấu hình được, mặc định 60k token) cùng các finding từ rule.
- Đầu ra JSON có schema cố định: điểm 1–5 cho mỗi nhóm kỹ năng, lý do kèm số thứ tự turn làm bằng chứng, 3 gợi ý cải thiện, và một phiên bản prompt viết lại cho prompt kém nhất.
- Rubric có phiên bản (`rubric_version`) để so sánh được kết quả qua thời gian. Lưu chi phí ước tính của mỗi lần chấm.
- Điểm LLM hiển thị tách biệt với điểm rule và không tính vào leaderboard (vì chỉ một số session được chấm).

## 10. Web dashboard (Next.js)

MVP có 5 màn hình cho leader và các màn hình quản trị tối thiểu; member dùng chung các màn hình này nhưng chỉ thấy dữ liệu của mình, và vào dashboard bằng `tl open` thay vì mật khẩu. Mọi màn hình có bộ lọc chung: project, khoảng ngày, agent.

| Màn hình | Nội dung | Ai xem |
| --- | --- | --- |
| Tổng quan project | Số session, token và chi phí ước tính theo tuần; phân bố agent và model; điểm trung bình 5 nhóm theo tuần; top anti-pattern; bảng trạng thái thành viên (online, offline N ngày, tạm dừng, đã rút đồng ý) | Leader |
| Hồ sơ thành viên | Radar 5 nhóm kỹ năng; xu hướng điểm theo tuần; anti-pattern hay mắc kèm ví dụ và lời khuyên; danh sách session | Leader; member xem của mình |
| Xem lại session | Dòng hội thoại: prompt, câu trả lời, tool call thu gọn, diff tô màu, đánh dấu turn dính finding; nút "Chấm bằng LLM"; ghi chú của leader theo turn; tìm kiếm trong session | Leader; member xem của mình |
| Leaderboard | Xếp hạng theo điểm rule tổng và từng nhóm, trong tuần/tháng; chỉ tính người có từ 5 session trong kỳ; có công tắc bật/tắt theo project | Leader; member thấy khi leader bật chế độ công khai |
| Quản lý rule | Danh sách rule, bật/tắt, chỉnh ngưỡng và mức độ, xem JSON, thử trên dữ liệu gần đây, chạy lại | Leader |
| Thành viên | Danh sách thành viên kèm thiết bị và trạng thái (online, offline N ngày, tạm dừng, đã rút đồng ý); người mới tham gia; thu hồi thiết bị; xóa thành viên; **"Gộp vào…"** để nhập user trùng (máy thứ hai, cài lại Windows) vào user cũ | Leader |
| Quản trị | Project, repo pattern, link mời (tạo, giới hạn lượt, thu hồi), thêm leader, LLM provider, retention, pattern redaction, audit log | Leader |
| Của tôi | Đồng ý đã cấp, thiết bị, audit log ai đã xem session của mình | Mọi người |

Gợi ý thư viện: shadcn/ui + Tailwind, TanStack Query, Recharts hoặc ECharts cho biểu đồ, `react-diff-view` cho diff, `next-intl` cho tiếng Việt và tiếng Anh (dự án open-source nên có i18n từ đầu).

## 11. Phân quyền, retention và triển khai

Một server do một leader (hoặc một nhóm leader) tự host cho team của mình và chứa không giới hạn số project. Chỉ có hai vai trò, áp dụng cho toàn server (`users.role`): **Leader** làm được mọi thứ, **Member** chỉ đụng tới dữ liệu của mình. Project chỉ dùng để nhóm repo và gom thành viên, không mang vai trò riêng.

### 11.1 Ma trận quyền

| Hành động | Leader | Member |
| --- | --- | --- |
| Xem session và điểm của mình | Có | Có (qua `tl open`) |
| Xem session của người khác | Có, mọi project (ghi audit) | Không |
| Xem leaderboard | Có | Khi leader bật chế độ công khai |
| Chấm bằng LLM | Có | Session của mình, nếu leader cho phép |
| Quản lý rule | Có | Không |
| Tạo project, repo pattern, link mời | Có | Không |
| Quản lý thành viên: thu hồi thiết bị, gộp, xóa | Có | Thu hồi thiết bị của chính mình |
| Thêm leader khác (nhập email + mật khẩu tạm, hoặc nâng một member lên leader rồi đặt email + mật khẩu) | Có | Không |
| Cấu hình LLM key, retention, pattern redaction | Có | Không |
| Xóa toàn bộ dữ liệu của một người | Có | Yêu cầu leader |

Server luôn phải còn ít nhất một leader: không cho xóa hay hạ quyền leader cuối cùng.

Một session chỉ thuộc một project. Nếu một repo khớp pattern của nhiều project, lấy project có pattern cụ thể hơn; bằng nhau thì leader phải sửa pattern (server cảnh báo khi lưu).

### 11.2 Retention

- Nội dung thô (`turns`, `llm_reviews`, `notes`): mặc định 90 ngày, leader chỉnh từ 7 tới 730 ngày hoặc vô hạn.
- Metadata session, finding, điểm và `user_weekly_stats`: giữ lâu dài để xem xu hướng.
- Job chạy hằng đêm: drop partition `turns` quá hạn, xóa bản ghi liên quan.
- Audit log giữ ít nhất 1 năm.

### 11.3 Triển khai self-host

- `docker compose up -d` với 4 container: `api` (NestJS, kèm worker pg-boss), `web` (Next.js), `postgres`, `caddy` (reverse proxy, tự cấp HTTPS Let's Encrypt).
- Cấu hình qua `.env`: `TEAMLENS_PUBLIC_URL`, `DATABASE_URL`, `TEAMLENS_SECRET_KEY`, SMTP (tùy chọn, để gửi invite qua email).
- Lần chạy đầu: wizard `/setup` tạo tài khoản leader đầu tiên, project đầu tiên và repo pattern, rồi hiện link mời + câu lệnh cài cho thành viên (mục 7.1).
- Cấu hình tối thiểu ước tính cho team 20 người: VPS 2 vCPU, 4 GB RAM, 40 GB SSD (cần đo lại khi có dữ liệu thật).
- Server phục vụ `GET /install.ps1?code=<code>`: script tải `tl.exe` từ GitHub Releases, kiểm tra SHA-256, đặt vào `%LOCALAPPDATA%\teamlens\bin`, thêm vào PATH của user, rồi chạy `tl join` với link mời tương ứng.
- Backup: hướng dẫn `pg_dump` định kỳ trong tài liệu vận hành.

### 11.4 Repo và cách làm việc

- Monorepo: `cli/` (Rust, Cargo workspace), `apps/api` (NestJS), `apps/web` (Next.js), `packages/schema` (OpenAPI + JSON Schema của session chuẩn hóa, là nguồn chân lý duy nhất), `deploy/` (compose, Caddyfile).
- Phân công: mỗi người sở hữu trọn một nhóm tính năng từ CLI tới DB tới web (stream-aligned), giữ suốt dự án; chia sẻ hiểu biết qua demo cuối mốc và `docs/FLOW.md` (xem `docs/TASKS.md`, `AGENTS.md` mục 3).
- CI trên GitHub Actions: test adapter bằng log mẫu, build `tl.exe` trên `windows-latest`, kiểm tra API khớp OpenAPI, build image Docker.
- License AGPL-3.0 (file `LICENSE`). Người đóng góp ký CLA từ PR đầu tiên, để sau này vẫn có thể bán license thương mại hoặc làm SaaS.

## 12. Rủi ro, câu hỏi mở và tiêu chí hoàn thành

Rủi ro lớn nhất là định dạng log của agent thay đổi không báo trước và việc lưu toàn bộ prompt cùng code của cả team.

### 12.1 Rủi ro

| Rủi ro | Ảnh hưởng | Cách giảm |
| --- | --- | --- |
| Agent đổi định dạng log | Mất dữ liệu im lặng | Bỏ qua bản ghi lạ, báo lỗi parse qua heartbeat, cảnh báo trên dashboard, test snapshot theo phiên bản, CLI tự cập nhật |
| Server bị xâm nhập | Lộ mã nguồn và prompt của cả team | Che secret trên máy, mã hóa LLM key, HTTPS bắt buộc, retention ngắn mặc định, hướng dẫn hardening |
| Che secret bỏ sót | Secret nằm trong DB | Pattern cập nhật được từ server; leader có công cụ quét lại và xóa secret trong dữ liệu đã lưu |
| Link mời chung bị lộ | Người lạ tham gia và gửi dữ liệu rác | Link hết hạn 7 ngày, giới hạn lượt dùng, thu hồi được; người lạ không xem được dữ liệu của ai khác; người mới hiện ngay trên trang Thành viên để xóa |
| Một người có nhiều user (máy thứ hai, cài lại Windows) | Điểm và lịch sử bị chia đôi | Leader gộp user trên trang Thành viên (mục 7.1) |
| Leaderboard bị lách số | Điểm không phản ánh kỹ năng thật | Ngưỡng tối thiểu 5 session, công tắc tắt theo project, phase 3 gắn với kết quả PR/issue |
| Pháp lý (GDPR, Nghị định 13/2023/NĐ-CP) | Tổ chức dùng tool vi phạm quy định dữ liệu cá nhân | Đồng ý rõ ràng có phiên bản, audit log, xóa theo yêu cầu, tài liệu PRIVACY.md cho người triển khai |
| Session rất lớn (hàng trăm MB) | Daemon tốn RAM, request quá lớn | Đọc dạng stream, chia batch 10 MB, cắt dòng vượt 10 MB |
| Windows Defender/SmartScreen chặn `tl.exe` | Thành viên không cài được | Ký code khi có ngân sách; trước đó cài qua script và hướng dẫn rõ |

### 12.2 Quyết định đã chốt và câu hỏi còn mở

Đã chốt ngày 2026-11-26:

- [x] License AGPL-3.0 cho cả repo, có CLA cho người đóng góp.
- [x] Copilot ở phase 2, không đưa vào MVP.
- [x] Hàng đợi job: `pg-boss` (không dùng BullMQ + Redis).
- [x] ORM: Drizzle.
- [x] Subagent Claude Code gửi thành session con; rule chất lượng prompt và leaderboard chỉ tính session gốc.
- [x] WSL ở phase 2, Remote-SSH và Dev Container ở phase 3; MVP cảnh báo trong `tl status`.
- [x] Gộp Admin vào Leader: chỉ còn hai vai trò toàn server, leader làm mọi thứ (mục 11.1).
- [x] Thành viên tham gia bằng một lệnh `tl join <link mời>`: link chung cho cả nhóm, mã mời đổi thẳng lấy device token, bỏ device login qua trình duyệt (`device_codes`, `/device`); member không có email/mật khẩu, vào dashboard bằng `tl open`; user trùng do máy thứ hai hoặc cài lại máy thì leader gộp (mục 7.1).

Còn mở:

- [ ] Tên TeamLens: kiểm tra nhãn hiệu, tạo GitHub org, giữ crate `teamlens` khi publish bản đầu. Code gom tên sản phẩm vào ít chỗ (tên crate, tiền tố `TEAMLENS_`, thư mục `%LOCALAPPDATA%\teamlens`) để dễ đổi.
- [ ] Trọng số điểm và ngưỡng của 24 rule MVP ([RULES.md](RULES.md)): dùng giá trị hiện tại làm điểm khởi đầu, chỉnh sau khi chạy thử trên log thật của team ở cuối Phase 1.

### 12.3 Tiêu chí hoàn thành MVP

- [ ] Leader cài server bằng `docker compose` trên VPS mới và có link mời trong dưới 15 phút.
- [ ] Thành viên cài CLI, đồng ý và bắt đầu gửi bằng một lệnh, không cần mở trình duyệt.
- [ ] Session Claude Code và Codex trong repo đã đăng ký xuất hiện trên dashboard trong vòng 5 phút sau khi ổn định.
- [ ] Session ngoài repo đăng ký không bao giờ rời máy (có test tự động).
- [ ] Bộ test secret mẫu (ít nhất 30 loại) bị che 100% trước khi gửi.
- [ ] Tắt mạng 24 giờ rồi bật lại: không mất và không trùng session.
- [ ] Leader xem được 5 màn hình MVP; member chỉ thấy dữ liệu của mình; mọi lần xem session của người khác đều có audit log.
- [ ] Daemon dưới 30 MB RAM khi rảnh trên máy có hơn 1.000 session.
