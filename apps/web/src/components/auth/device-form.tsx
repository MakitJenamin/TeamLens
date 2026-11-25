"use client";

import { CircleCheckIcon, LaptopIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api/client";
import { useApproveDevice } from "@/lib/api/hooks";

// Bảng chữ của userCode theo contract: XXXX-XXXX, chỉ gồm các phụ âm này.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_RE = new RegExp(`^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`);

/** Chuẩn hóa mã người dùng nhập: viết hoa, bỏ ký tự lạ, tự chèn dấu gạch. */
export function normalizeUserCode(input: string): string {
  const chars = input.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

export function isValidUserCode(code: string): boolean {
  return USER_CODE_RE.test(code);
}

type Result =
  | { kind: "idle" }
  | { kind: "success"; deviceName: string }
  | { kind: "error"; message: string };

export function DeviceForm({ initialCode = "" }: { initialCode?: string }) {
  const t = useTranslations("device");
  const tc = useTranslations("common");
  const approve = useApproveDevice();
  const [code, setCode] = useState(() => normalizeUserCode(initialCode));
  const [formatError, setFormatError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult({ kind: "idle" });
    if (!isValidUserCode(code)) {
      setFormatError(t("codeInvalidFormat"));
      return;
    }
    setFormatError(null);
    try {
      const res = await approve.mutateAsync({ userCode: code });
      setResult({ kind: "success", deviceName: res.device.name });
    } catch (err) {
      let message = tc("errors.generic");
      if (err instanceof ApiError) {
        if (err.code === "expired_code") message = t("expired");
        else if (err.code === "invalid_code") message = t("invalid");
        else if (err.code === "network_error") message = tc("errors.network");
        else message = err.message;
      }
      setResult({ kind: "error", message });
    }
  }

  if (result.kind === "success") {
    return (
      <Card>
        <CardHeader>
          <CircleCheckIcon className="mb-2 size-8 text-emerald-600 dark:text-emerald-400" />
          <CardTitle className="text-xl">{t("successTitle")}</CardTitle>
          <CardDescription>{t("successDescription", { name: result.deviceName })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row">
          <Button render={<Link href="/" />} className="flex-1">
            {t("goToDashboard")}
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => {
              setCode("");
              setResult({ kind: "idle" });
            }}
          >
            {t("approveAnother")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <LaptopIcon className="text-muted-foreground mb-2 size-8" />
        <CardTitle className="text-xl">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            {result.kind === "error" && (
              <Alert variant="destructive" role="alert">
                <AlertTitle>{result.message}</AlertTitle>
              </Alert>
            )}
            <Field data-invalid={!!formatError}>
              <FieldLabel htmlFor="userCode">{t("codeLabel")}</FieldLabel>
              <Input
                id="userCode"
                name="userCode"
                value={code}
                onChange={(e) => setCode(normalizeUserCode(e.target.value))}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                aria-invalid={!!formatError}
                className="h-11 text-center font-mono text-lg tracking-[0.3em]"
              />
              {formatError ? (
                <FieldError>{formatError}</FieldError>
              ) : (
                <FieldDescription>{t("codeHint")}</FieldDescription>
              )}
            </Field>
            <Button type="submit" className="w-full" disabled={approve.isPending}>
              {approve.isPending ? t("submitting") : t("submit")}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
