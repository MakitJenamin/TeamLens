# TeamLens — hướng dẫn cho agent và người đóng góp

File này dành cho mọi AI coding agent (Claude Code đọc qua `CLAUDE.md`, Codex đọc trực tiếp) và cho người. Đọc hết trước khi sửa code.

- Đặc tả đầy đủ: [docs/SPEC.md](docs/SPEC.md). Danh sách việc và người phụ trách: [docs/TASKS.md](docs/TASKS.md).
- Mỗi thư mục con (`cli/`, `apps/api/`, `apps/web/`, `packages/schema/`) có `AGENTS.md` riêng với lệnh và quy ước chi tiết.

## 1. Cấu trúc repo

| Thư mục | Nội dung | Công nghệ |
| --- | --- | --- |
| `packages/schema` | Contract: OpenAPI (tách file theo nhóm) + JSON Schema session v1 + JSON mẫu | OpenAPI 3.1, redocly, openapi-typescript |
| `cli/` | `tl.exe`: CLI + daemon trên máy thành viên | Rust (Cargo workspace) |
| `apps/api` | API cho CLI (`/agent/v1`) và dashboard (`/api/v1`) | NestJS, Drizzle, Postgres 16, pg-boss |
| `apps/web` | Dashboard | Next.js (App Router), shadcn/ui, Tailwind, next-intl |
| `deploy/` | Docker compose, Caddyfile, `install.ps1` | |
| `docs/` | Spec, task, quyết định | |

## 2. Lệnh thường dùng

```bash
pnpm install                 # cài toàn bộ JS/TS
pnpm db:up                   # Postgres dev (localhost:5433)
pnpm --filter @teamlens/api db:migrate && pnpm --filter @teamlens/api db:seed
pnpm dev                     # api :3001 + web :3000
pnpm lint && pnpm typecheck && pnpm test
cd cli && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Tài khoản seed (mật khẩu đều là `teamlens123`): `admin@teamlens.local` (admin), `leader@teamlens.local`, `member1@teamlens.local`, `member2@teamlens.local`.

## 3. Vùng sở hữu (quan trọng nhất)

Mỗi người sở hữu trọn một nhóm tính năng từ CLI tới DB tới web và giữ vùng đó suốt dự án (danh sách việc: [docs/TASKS.md](docs/TASKS.md)). **Chỉ sửa file trong vùng của mình.** Cần sửa ngoài vùng thì dừng lại, hỏi người dùng; nếu được đồng ý thì tách thành PR riêng thật nhỏ.

| | Người 1 · Session của tôi lên dashboard | Người 2 · Giá trị cho leader |
| --- | --- | --- |
| CLI | `cli/crates/tl-core`, `cli/crates/tl-adapters`, `cli/crates/teamlens/src/{pipeline,queue,daemon,sync}/`, lệnh `status`, `preview`, `sync`, `daemon`, `pause`, `resume` | `cli/crates/tl-platform` (phần Task Scheduler), `cli/crates/teamlens/src/consent/`, lệnh `join`, `consent`, `uninstall` |
| API (`apps/api/src/modules/`) | `agent/` (ingest, config, heartbeat), `sessions/` | `invites/`, `consent/`, `rules/`, `stats/`, `admin/`, `retention/` |
| Web (`apps/web/src/app/[locale]/`) | `(dashboard)/projects/[projectId]/sessions/`, `(dashboard)/projects/[projectId]/members/page.tsx` | `(auth)/i/[code]/`, `(dashboard)/projects/[projectId]/{overview,leaderboard,rules}/`, `(dashboard)/projects/[projectId]/members/[userId]/`, `(dashboard)/{admin,me}/` |
| Schema | `session.v1.schema.json`, `examples/`, `openapi/agent.yaml`, `openapi/sessions.yaml` | `openapi/{invites,consent,rules,stats,admin}.yaml` |
| Phát hành | `deploy/install.ps1`, `.github/workflows/release.yml` | `deploy/docker-compose.yml`, `deploy/Caddyfile`, Dockerfile của api/web |

**Điểm chạm giữa hai vùng** (chốt bằng contract, không sửa code của nhau):
- Trang xem session (Người 1) gọi API findings (Người 2, `GET /api/v1/sessions/{sessionId}/findings`).
- Pipeline gửi của CLI (Người 1) hỏi module `consent` (Người 2) trước khi gửi.
- `tl join` (Người 2) dùng lại `login` và `config` của vùng nền.

Luồng chính và code của từng khúc: [docs/FLOW.md](docs/FLOW.md). Hết mỗi mốc, mỗi người cập nhật phần ghi chú khúc của mình trong file đó.

**Vùng nền (dùng chung, đã làm xong ở giai đoạn nền):** `auth`, `device`, `projects`, `access` (phân quyền + audit) trong API; trang login/setup/device và layout/sidebar trong web; lệnh `login`/`logout` và HTTP client cơ sở trong CLI; `apps/api/src/db/`, migration, seed; mọi file cấu hình gốc (`package.json`, lockfile, `Cargo.toml` workspace, `turbo.json`, `app.module.ts`, `next.config.*`, CI).

Sửa vùng nền: PR riêng, nhỏ, merge sớm rồi báo người kia `git pull`. Các trường hợp hay gặp:
- **Thêm thư viện:** sửa `package.json`/`Cargo.toml` của đúng app, PR riêng. Conflict ở `pnpm-lock.yaml` thì lấy bản trên `main` rồi chạy lại `pnpm install`, không sửa tay.
- **Đổi bảng DB:** sửa schema Drizzle + `pnpm --filter @teamlens/api db:generate`, PR riêng chỉ có migration. Pull `main` ngay trước khi generate để số thứ tự migration không trùng.
- **Đổi contract:** PR riêng chỉ sửa `packages/schema`, rồi mới code theo.

## 4. Quy ước kỹ thuật đã chốt

**Cổng và định tuyến**
- API `:3001`, web `:3000`. Web proxy `/api/*` và `/agent/*` sang API (rewrite trong `next.config`), nên trình duyệt luôn gọi cùng origin. Production: Caddy làm việc này.
- Dashboard: prefix `/api/v1`, xác thực bằng cookie `tl_session` (httpOnly, SameSite=Lax, Secure khi HTTPS).
- CLI: prefix `/agent/v1`, header `Authorization: Bearer <device token>`.
- `GET /health` không cần xác thực.

**Bảo mật**
- Mật khẩu hash bằng argon2id (`@node-rs/argon2`).
- Cookie session, device token, mã invite: sinh ngẫu nhiên 32 byte, DB chỉ lưu SHA-256. Device token có tiền tố `tld_`.
- Không log nội dung prompt, token hay mật khẩu.

**DB**
- `DATABASE_URL=postgres://teamlens:teamlens@localhost:5433/teamlens` khi dev.
- Schema Drizzle ở `apps/api/src/db/schema/` (mỗi nhóm bảng một file), migration SQL ở `apps/api/drizzle/`. Phần partition `turns` và `tsvector` viết SQL tay.
- Mọi thao tác xem dữ liệu người khác đi qua `AccessService` và ghi audit qua `AuditService`.

**Contract**
- `packages/schema` là nguồn chân lý. API và web dùng type sinh ra từ OpenAPI (`@teamlens/schema`); CLI viết tay struct `serde` và có test so với JSON Schema.
- Lỗi API theo dạng `{ "error": "<mã_máy_đọc>", "message": "<mô tả>" }`.

**CLI**
- Cấu hình và state ở `%LOCALAPPDATA%\teamlens\`; token trong Windows Credential Manager (crate `keyring`), không bao giờ ghi ra file.
- Thông báo cho người dùng viết tiếng Việt.

## 5. Quyền riêng tư (không được vi phạm)

- Không bao giờ ghi nội dung chưa che secret ra đĩa hoặc gửi lên mạng.
- Session ngoài repo đã đăng ký không được rời máy, kể cả metadata.
- Log mẫu đưa vào `fixtures/` phải che hết secret, đường dẫn cá nhân, tên máy trước khi commit.

## 6. Quy ước làm việc

- Mỗi task một nhánh `feat/<mã-task>-<tên-ngắn>` (ví dụ `feat/a3-claude-normalize`) và một PR vào `main`. CI xanh mới merge, dùng squash merge.
- Commit theo Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Tên biến, hàm, file bằng tiếng Anh; comment, tài liệu và thông báo người dùng bằng tiếng Việt.
- Mỗi PR phải kèm test hoặc ghi rõ cách đã tự test.
- Không commit `.env`, `.codegraph/`, log thật chưa che.
