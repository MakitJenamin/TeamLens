"use client";

import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api/client";

const KNOWN_CODES = [
  "llm_key_missing",
  "llm_key_invalid",
  "llm_quota_exceeded",
  "llm_model_not_found",
  "llm_timeout",
  "llm_provider_error",
  "llm_bad_output",
  "not_found",
] as const;
type KnownCode = (typeof KNOWN_CODES)[number];

function isKnownCode(code: string): code is KnownCode {
  return (KNOWN_CODES as readonly string[]).includes(code);
}

/** Thông báo lỗi theo mã máy đọc (`llm_*`, `validation_error`...), dịch theo locale hiện tại. */
export function useErrorMessage() {
  const t = useTranslations("aiSettings.errors");
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      if (isKnownCode(error.code)) return t(error.code);
      if (error.code === "validation_error") return t("validation_error", { message: error.message });
      return t("unknown", { message: error.message });
    }
    return t("unknown", { message: error instanceof Error ? error.message : String(error) });
  };
}
