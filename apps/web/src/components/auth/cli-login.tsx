"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api/client";
import { useExchangeTicket } from "@/lib/api/hooks";

type State = "loading" | "invalid" | "missing" | "error";

/**
 * Đổi ticket một lần của `tl open` lấy cookie phiên rồi vào dashboard.
 * Ticket chỉ dùng được một lần nên chỉ gửi đúng một request (kể cả khi StrictMode chạy effect hai lần).
 */
export function CliLogin({ ticket }: { ticket: string }) {
  const t = useTranslations("auth.cli");
  const tc = useTranslations("common");
  const router = useRouter();
  const exchange = useExchangeTicket();
  const [state, setState] = useState<State>(ticket ? "loading" : "missing");
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);
  const { mutateAsync } = exchange;

  useEffect(() => {
    if (!ticket || started.current) return;
    started.current = true;
    mutateAsync({ ticket })
      .then(() => {
        router.replace("/");
        router.refresh();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.code === "invalid_ticket" || err.code === "validation_error")) {
          setState("invalid");
        } else {
          setState("error");
          setMessage(
            err instanceof ApiError && err.code === "network_error"
              ? tc("errors.network")
              : err instanceof ApiError
                ? err.message
                : tc("errors.generic"),
          );
        }
      });
  }, [ticket, mutateAsync, router, tc]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {state === "loading" ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t("loading")}
          </p>
        ) : (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {state === "invalid"
                ? t("invalidTicket")
                : state === "missing"
                  ? t("missingTicket")
                  : message}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
