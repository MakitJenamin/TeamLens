import { defineRouting } from "next-intl/routing";

export const locales = ["vi", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "vi";

export const routing = defineRouting({
  locales,
  defaultLocale,
  // URL tiếng Việt không có prefix, tiếng Anh dùng /en/...
  localePrefix: "as-needed",
  // Không tự đoán theo Accept-Language: URL không prefix luôn là tiếng Việt.
  localeDetection: false,
});
