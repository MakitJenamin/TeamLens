# Fixtures log mẫu

Log mẫu của từng agent, dùng cho snapshot test của adapter. Mỗi agent một thư mục con,
đặt tên theo phiên bản agent đã sinh ra log, ví dụ:

```
fixtures/
├── claude_code/2.1.332/<tên-tình-huống>.jsonl
└── codex/0.50.0/<tên-tình-huống>.jsonl
```

**Bắt buộc trước khi commit** (AGENTS.md gốc, mục 5):

- Che hết secret (API key, token, mật khẩu, connection string...).
- Thay đường dẫn cá nhân (`C:\Users\<tên>`), tên máy, email thật bằng giá trị giả.
- Không đưa log thật chưa che vào repo, kể cả tạm thời.

Fixtures Claude Code thuộc task M1.3, Codex thuộc task M2.5.

## Claude Code (task M1.3)

| File | Nguồn | Tình huống |
| --- | --- | --- |
| `claude_code/2.1.332/teamlens-worker.jsonl` | Session thật làm task M1.2 trong repo TeamLens (repo public) | Bash, Write cập nhật file (diff từ `structuredPatch`), Monitor lỗi (`is_error`), usage lặp theo `message.id`, `task-notification` (role `system`), `bypassPermissions`, nhánh đổi giữa chừng, `cwd` đổi giữa chừng |
| `claude_code/2.1.326/rejected-tool-interrupt.jsonl` | Session thật ở dự án khác, **mọi nội dung tự do đã thay** (`--neutral`) | `/clear` + caveat `isMeta`, người dùng từ chối tool (`is_error`) rồi `[Request interrupted by user for tool use]`, `permissionMode: auto` (→ `unknown`) |
| `claude_code/2.1.219/accept-edits-interrupt.jsonl` | Session thật ở dự án khác, chỉ giữ dòng 0–17, 36–44, 119–152, **mọi nội dung tự do và tên file đã thay** | Bản Claude Code cũ, `acceptEdits`, nhiều tool_use song song trong một message, Write tạo file mới (`type: create`) và ghi đè (`structuredPatch`), `[Request interrupted by user]` ngay sau tool_result, `gitBranch: HEAD` (detached → `null`) |

### Bổ sung ở task M2.4

| File | Nguồn | Tình huống |
| --- | --- | --- |
| `claude_code/2.1.322/subagent-compaction.jsonl` | Session thật ở dự án khác, chỉ giữ dòng 0–12, 1093–1128, 1138–1150, 2296–2313, 3199–3225, **mọi nội dung tự do và tên file đã thay** | Session cha: tool `Agent` gọi subagent, `task-notification`, `[Request interrupted by user]` ngay sau reply, `system`/`compact_boundary` + dòng `isCompactSummary` (→ turn `compaction`), `bypassPermissions` |
| `claude_code/2.1.322/subagent-compaction/subagents/agent-ac4847d3842e4829c.jsonl` | Transcript subagent của chính session trên (cùng cấu trúc thư mục thật), chỉ giữ dòng 0–25, 295–303, đã thay như trên | Mọi dòng có `sessionId` = id session cha, `agentId`, `isSidechain: true`, không có `permissionMode` → session con `claude_code:<sessionId>:<agentId>`, `parent_source_id` = session cha |

```bash
P=~/.claude/projects/<thư-mục>
python sanitize.py "$P/24d35887-....jsonl" 2.1.322/subagent-compaction.jsonl \
  --neutral --map <tên-dự-án>=demo-app --select 0-12,1093-1128,1138-1150,2296-2313,3199-3225
python sanitize.py "$P/24d35887-.../subagents/agent-ac4847d3842e4829c.jsonl" \
  2.1.322/subagent-compaction/subagents/agent-ac4847d3842e4829c.jsonl \
  --neutral --map <tên-dự-án>=demo-app --select 0-25,295-303
```

`sanitize.py` từ M2.4 giữ thêm hai khóa `agentId`, `isCompactSummary` trên dòng `user`/`assistant`.

Snapshot kỳ vọng ở `../snapshots/` (crate `insta`); test ở `../claude_code.rs` còn kiểm tra
output với `packages/schema/session.v1.schema.json`.

### Cách đã che

Cả ba file sinh bằng [`claude_code/sanitize.py`](claude_code/sanitize.py) (Python 3.9+, không
cần thư viện ngoài), chạy trên máy có log gốc:

```bash
P=~/.claude/projects
cd cli/crates/tl-adapters/tests/fixtures/claude_code
python sanitize.py "$P/<thư-mục>/87bb336f-....jsonl" 2.1.332/teamlens-worker.jsonl \
  --replace-text "4=Làm task M1.2: viết struct serde cho session v1 trong cli/crates/tl-core/src/session.rs, kèm test so với packages/schema/examples. Xong thì mở PR."
python sanitize.py "$P/<thư-mục>/69d67677-....jsonl" 2.1.326/rejected-tool-interrupt.jsonl \
  --neutral --map <tên-dự-án>=demo-app
python sanitize.py "$P/<thư-mục>/bb54c3a6-....jsonl" 2.1.219/accept-edits-interrupt.jsonl \
  --neutral --select 0-17,36-44,119-152 --map <tên-dự-án>=demo-app
```

Script làm các bước sau (chi tiết trong docstring):

1. **Dòng meta** (`api-request*`, `attachment`, `session-owner`, `queue-operation`...) rút
   về khung `{type, sessionId, timestamp?}`: bỏ prompt hệ thống, account/organization id,
   nội dung đính kèm. Test vẫn thấy các dòng này để kiểm tra adapter bỏ qua đúng.
2. **Dòng `user`/`assistant`** chỉ giữ khóa adapter cần; `usage` chỉ giữ 4 số token;
   `thinking` xóa nội dung, chữ ký thay bằng `SIG_FIXTURE`; ảnh thay bằng base64 giả;
   `toolUseResult` chỉ giữ `type`, `filePath`, tối đa 3 hunk × 12 dòng của
   `structuredPatch`, và 12 dòng đầu của `content` khi tạo file mới (bỏ `originalFile`,
   `stdout`...). Header hunk giữ nguyên nên số dòng trong header có thể lớn hơn số dòng
   còn lại; adapter đếm `added`/`removed` từ chính các dòng, không từ header.
3. **Cắt** mọi chuỗi dài hơn 300 ký tự (thêm đuôi `…[cắt khi làm fixture]`).
4. **`--neutral`** (log của dự án ngoài TeamLens): thay prompt, reply, mọi giá trị chuỗi
   trong input tool, output tool, dòng diff bằng chuỗi giữ chỗ
   `(… đã thay khi làm fixture #n)`; đổi tên file thành `file<n>.<đuôi>`. Chỉ giữ nguyên
   các chuỗi do chính Claude Code sinh (`[Request interrupted…`,
   `The user doesn't want to proceed…`, `<command-name>`, `<local-command-caveat>`).
5. **Thay trên toàn dòng**: `C:\Users\<tên>` (mọi dạng: `\\`, `/`, `/c/Users/<tên>`,
   `C--Users-<tên>`) → `C:\Users\dev`; tên máy (`COMPUTERNAME`) → `DEV-PC`; email →
   `dev@example.com`; token (`sk-`, `ghp_`/`gho_`/..., `github_pat_`, `AKIA`, `xox?-`, JWT)
   → `[REDACTED]`; các cặp `--map`. Tên người dùng và tên máy lấy từ biến môi trường.
6. **Tự kiểm tra** trước khi ghi: còn tên người dùng, tên máy, email lạ hay mẫu token thì
   không ghi file và thoát mã 1.
7. **Thay tay**: prompt đầu của `teamlens-worker` (lời dặn của công cụ điều phối, có id
   phiên làm việc) thay bằng một câu mô tả task (`--replace-text`).

Sau khi sinh, đã grep lại toàn bộ `tests/` với tên người dùng Windows thật, email, tên máy,
`sk-`, `ghp_`, `gho_`, `AKIA` và tên các dự án khác: không còn kết quả nào (ngoài chính
danh sách mẫu trong `sanitize.py`).
