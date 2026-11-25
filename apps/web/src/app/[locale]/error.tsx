"use client";

import { ServerCrashIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Lỗi khi tải dữ liệu (thường là API không chạy). */
export default function LocaleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("common");
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <ServerCrashIcon className="text-muted-foreground mx-auto mb-2 size-10" />
          <CardTitle className="text-xl">{t("errors.dashboardTitle")}</CardTitle>
          <CardDescription>{t("errors.dashboardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={reset}>{t("retry")}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
