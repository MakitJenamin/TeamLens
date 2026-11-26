# apps/api — hướng dẫn cho agent

Đọc [AGENTS.md ở gốc repo](../../AGENTS.md) trước. File này chỉ ghi phần riêng của API.

## Lệnh

```bash
cp .env.example .env                       # lần đầu
pnpm db:up                                 # (ở gốc repo) Postgres dev :5433
pnpm --filter @teamlens/api db:migrate     # chạy migration + tạo partition `turns`
pnpm --filter @teamlens/api db:seed        # dữ liệu mẫu, chạy lại nhiều lần an toàn
pnpm --filter @teamlens/api dev            # http://localhost:3001
pnpm --filter @teamlens/api test           # unit test (không cần DB)
pnpm --filter @teamlens/api test:e2e       # e2e, cần Postgres dev (dùng DB riêng `teamlens_test`)
pnpm --filter @teamlens/api lint && pnpm --filter @teamlens/api typecheck && pnpm --filter @teamlens/api build
pnpm --filter @teamlens/api db:generate    # sinh migration sau khi sửa src/db/schema/
```

## Cấu trúc

| Đường dẫn | Nội dung |
| --- | --- |
| `src/app.module.ts` | Đăng ký **mọi** module. Không cần sửa khi làm task trong một module. |
| `src/setup-app.ts` | Cookie parser, `StandardSchemaValidationPipe` (zod), filter lỗi `{ error, message }`. Dùng cho cả `main.ts` và e2e. |
| `src/config/env.ts` | Schema env (zod). |
| `src/common/` | `ApiError`, filter lỗi, `@Public()`, `@CurrentUser()`, `@CurrentDevice()`, hash mật khẩu, token, `normalizeRemotePattern`. |
| `src/db/schema/` | Drizzle schema, mỗi nhóm bảng một file. `drizzle/` là migration SQL. |
| `src/queue/` | pg-boss (`QueueService.send`), tên job ở `jobs.ts`. |
| `src/modules/auth` | setup, login, logout, me; `SessionAuthGuard` toàn cục. |
| `src/modules/device` | device login cho CLI; `DeviceAuthGuard` toàn cục cho `/agent/*`. |
| `src/modules/access` | `AccessService`, `AuditService`, `@ProjectRoles(...)`. |
| `src/modules/projects` | project, thành viên, repo pattern, user. |
| `src/modules/{agent,sessions,invites,consent,rules,stats,admin,retention}` | Module rỗng, xem `README.md` trong từng thư mục. |

## Quy ước

- **Không có global prefix.** Mỗi controller ghi rõ `api/v1/...` hoặc `agent/v1/...`.
- Mặc định mọi route cần đăng nhập: `/agent/*` cần `Authorization: Bearer tld_...`, còn lại cần cookie `tl_session`. Route công khai đánh dấu `@Public()`.
- Quyền theo project: `@ProjectRoles('leader')` (leader hoặc admin) hoặc `@ProjectRoles('leader', 'member')` (mọi thành viên hoặc admin), đọc `:projectId`. Xem dữ liệu của người khác: `AccessService.canViewUserData` rồi `AuditService.record`. **Sắp đổi (Mốc 1.5, task J.4, SPEC 11.1):** bỏ admin và vai trò theo project; chỉ còn `users.role` (`leader` làm mọi thứ, `member` chỉ dữ liệu của mình). Code mới không thêm phụ thuộc vào `isAdmin` hay `@ProjectRoles`.
- Validate body bằng zod: `@Body({ schema }) body: z.infer<typeof schema>`. Lỗi validate trả 400 `validation_error`.
- Lỗi nghiệp vụ: `throw new ApiError(status, 'ma_loi', 'Thông báo tiếng Việt')`.
- JSON REST dùng camelCase; DB dùng snake_case.
- Bảng `turns` partition theo tháng của `ts` (SQL tay trong `drizzle/0001_turns_partitioned.sql`), PK `(session_id, seq, ts)`. Trước khi ghi turn của tháng cũ, gọi `SELECT ensure_turns_partitions(<ts>, 0)`.
- Phát job: `queue.send(JOBS.sessionIngested, { sessionId })`. Muốn enqueue cùng transaction với ingest thì truyền `options.db` (adapter `IDatabase` của pg-boss bọc transaction hiện tại, M1.6 sẽ làm).

## NestJS 12

Bản Nest này mới hơn những gì agent thường biết; tài liệu: https://docs.nestjs.com/llms.txt.
Package là ESM: import tương đối phải có đuôi `.js`, không có `__dirname` (dùng `import.meta.dirname`).
Test chạy bằng Vitest (mặc định của Nest CLI hiện tại, API giống Jest): mock bằng `vi.fn()`.
