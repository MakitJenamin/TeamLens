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

/**
 * Các trang công khai (không cần cookie). Còn lại thuộc (dashboard).
 * `/i/<mã>`: link mời gửi cho thành viên; `/auth/cli`: đổi ticket của `tl open` lấy phiên.
 */
const PUBLIC_PATHS = ["/login", "/setup", "/i", "/auth/cli"];

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

/**
 * Tách ?next= (đã có prefix locale do proxy tạo) thành đường dẫn không prefix + locale,
 * để điều hướng bằng router/redirect của @/i18n/navigation: "/en/me" → { href: "/me", locale: "en" }.
 */
export function resolveNextPath(next: string | null | undefined): { href: string; locale: string } {
  const { locale, path } = splitLocale(safeNextPath(next));
  return { href: path, locale };
}

/** Thêm prefix locale theo quy tắc as-needed (vi không có prefix). Chỉ dùng trong proxy. */
export function localizePath(path: string, locale: string): string {
  if (locale === defaultLocale) return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}
