import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { SESSION_COOKIE, isProtectedPath, localizePath, splitLocale } from "@/lib/auth-paths";

const intlMiddleware = createMiddleware(routing);

/**
 * Proxy (tên mới của middleware từ Next 16):
 * - chưa có cookie `tl_session` mà vào trang dashboard hoặc /device → /login?next=...
 * - còn lại để next-intl xử lý locale.
 * Cookie chỉ được kiểm tra "lạc quan"; server component vẫn gọi /auth/me để xác thực thật.
 */
export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { locale, path } = splitLocale(pathname);

  if (isProtectedPath(path) && !request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = localizePath("/login", locale);
    url.search = "";
    if (path !== "/") {
      url.searchParams.set("next", `${pathname}${search}`);
    }
    return NextResponse.redirect(url);
  }

  return intlMiddleware(request);
}

export const config = {
  // Bỏ qua API (rewrite sang backend), file tĩnh và nội bộ Next.
  matcher: ["/((?!api|agent|_next|_vercel|.*\\..*).*)"],
};
