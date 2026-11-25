import { defaultLocale, locales } from "@/i18n/routing";

export const SESSION_COOKIE = "tl_session";

/** Tách prefix locale khỏi pathname: "/en/me" → { locale: "en", path: "/me" }. */
export function splitLocale(pathname: string): { locale: string; path: string } {
  const segments = pathname.split("/");
  const first = segments[1];
  if (first && (locales as readonly string[]).includes(first)) {
    const rest = "/" + segments.slice(2).join("/");
    return { locale: first, path: rest === "/" ? "/" : rest.replace(/\/$/, "") };
  }
  return { locale: defaultLocale, path: pathname || "/" };
}

/** Các trang công khai (không cần cookie). Còn lại thuộc (dashboard) hoặc /device. */
const PUBLIC_PATHS = ["/login", "/setup"];

export function isProtectedPath(pathWithoutLocale: string): boolean {
  return !PUBLIC_PATHS.some(
    (p) => pathWithoutLocale === p || pathWithoutLocale.startsWith(`${p}/`),
  );
}

/** Chỉ chấp nhận đường dẫn nội bộ cho tham số ?next= (chặn open redirect). */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}

/** Thêm prefix locale theo quy tắc as-needed (vi không có prefix). */
export function localizePath(path: string, locale: string): string {
  if (locale === defaultLocale) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}
