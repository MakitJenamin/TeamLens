# apps/web — Dashboard TeamLens

Next.js 16 (App Router, Turbopack), shadcn/ui (style `base-nova`, dùng Base UI), Tailwind v4, next-intl, TanStack Query.

> **Next.js 16 khác bản bạn quen:** middleware đổi tên thành `src/proxy.ts`; `params`/`searchParams` là Promise; type `PageProps<"/[locale]/...">`, `LayoutProps` được sinh bởi `next typegen`. Trước khi dùng API lạ, đọc `node_modules/next/dist/docs/`.
>
> **shadcn base-nova dùng Base UI, không phải Radix:** thay `asChild` bằng prop `render`, ví dụ `<Button render={<Link href="/" />}>`.

## Lệnh

```bash
pnpm --filter @teamlens/web dev        # http://localhost:3000 (cần API :3001 để đăng nhập)
pnpm --filter @teamlens/web build      # output standalone cho Docker
pnpm --filter @teamlens/web lint
pnpm --filter @teamlens/web typecheck  # next typegen && tsc --noEmit
pnpm --filter @teamlens/web test       # Vitest + Testing Library
pnpm dlx shadcn@latest add <component> # chạy trong apps/web
```

Biến môi trường: `API_INTERNAL_URL` (mặc định `http://localhost:3001`), xem `.env.example`.

## Cấu trúc

```
messages/<locale>/<namespace>.json   # file dịch tách theo khu vực
src/proxy.ts                         # next-intl + chặn trang cần đăng nhập khi thiếu cookie tl_session
src/i18n/                            # routing (vi mặc định, en; localePrefix as-needed), loader gộp file dịch
src/lib/api/                         # client fetch, hooks TanStack Query, serverApi (server component), types
src/components/ui/                   # shadcn (sinh ra, hạn chế sửa tay)
src/components/{auth,dashboard}/     # form login/setup/tl open, sidebar, placeholder
src/app/[locale]/(auth)/             # login, setup, i/[code] (link mời), auth/cli (tl open)
src/app/[locale]/(dashboard)/        # layout có sidebar + các màn hình
```

## Quy ước

- **Dịch:** mỗi khu vực một namespace, một file trong `messages/vi/` và `messages/en/`. Thêm namespace mới chỉ cần thêm file JSON (loader tự gộp theo tên file). Test `src/i18n/messages.test.ts` bắt buộc vi và en có cùng bộ khóa.
- **Gọi API phía client:** `api.get/post/...` trong `src/lib/api/client.ts` (cùng origin `/api/v1/...`, `credentials: "include"`); lỗi `{ error, message }` thành `ApiError` (`status`, `code`, `message`). Dùng TanStack Query (`src/lib/api/hooks.ts`).
- **Gọi API phía server:** `serverApi`/`serverApiOrNull` trong `src/lib/api/server.ts` (qua `API_INTERNAL_URL`, chuyển tiếp cookie `tl_session`).
- **Type API:** `src/lib/api/types.ts` chỉ là alias của type sinh từ `@teamlens/schema` (`Schemas`, `RequestBody<op>`, `ResponseBody<op, status>`). Cần kiểu mới thì sửa contract ở `packages/schema` (PR riêng) rồi thêm alias.
- **Điều hướng:** dùng `Link`, `redirect`, `useRouter`, `usePathname` từ `@/i18n/navigation` để giữ locale. Không dùng `useRouter`/`redirect` của `next/navigation` hay tự ghép prefix locale. Với `?next=` (đã chứa prefix locale do proxy tạo) dùng `resolveNextPath(next)` để lấy `{ href, locale }` rồi truyền cho router/redirect của `@/i18n/navigation`. `localizePath` chỉ dùng trong `proxy.ts`.
- **Màn hình chưa làm:** dùng `PagePlaceholder` (tiêu đề + mô tả + mã task). Người làm task thay nội dung `page.tsx` tương ứng; sidebar đã có đủ link, không cần sửa.
- Dark mode theo hệ thống (`next-themes`, class `.dark`); giao diện phải dùng được ở màn hình hẹp.

## Vùng sở hữu

Vùng sở hữu của Người 1 và Người 2: bảng ở `AGENTS.md` gốc, mục 3. Layout, sidebar, `(auth)/{login,setup,auth}`, `src/lib/api`, `src/i18n`, `proxy.ts`, `next.config.ts` là vùng nền — sửa bằng PR riêng, nhỏ.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
