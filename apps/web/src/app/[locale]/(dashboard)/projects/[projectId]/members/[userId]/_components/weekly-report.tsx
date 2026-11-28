"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiResult, WeeklyReportResult, WeeklyReportSaved } from "@teamlens/schema";
import { AlertCircleIcon, Loader2Icon, RotateCcwIcon, SparklesIcon, TargetIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { api, ApiError } from "@/lib/api/client";
import { useLlmKeyStatus } from "../../../sessions/_components/session-ai";
import type { ProfileWeek } from "./profile-types";

type AiLocale = "vi" | "en";

const selectClass =
  "border-input bg-background dark:bg-input/30 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function ApiMessage({ error }: { error: unknown }) {
  const t = useTranslations("weeklyReport");
  const code = error instanceof ApiError ? error.code : "unknown";
  const key = `errors.${code}`;
  const keyProblem = code === "llm_key_missing" || code === "llm_key_invalid" || code === "llm_model_not_found";
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertDescription>
        <p>{t.has(key) ? t(key) : t("errors.unknown")}</p>
        {keyProblem && (
          <Link href="/settings/ai" className="underline underline-offset-4">
            {t("openSettings")}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">{title}</h4>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={`${i}-${item}`} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Report({ projectId, result }: { projectId: string; result: AiResult }) {
  const t = useTranslations("weeklyReport");
  const format = useFormatter();
  const r = result.result as unknown as WeeklyReportResult;
  return (
    <div className="flex flex-col gap-4" data-testid="weekly-report">
      <p className="text-sm leading-relaxed break-words">{r.headline}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <List title={t("strengths")} items={r.strengths} />
        <List title={t("weaknesses")} items={r.weaknesses} />
      </div>
      {r.vsLastWeek && (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">{t("vsLastWeek")}</h4>
          <p className="text-sm break-words">{r.vsLastWeek}</p>
        </div>
      )}
      <div className="bg-muted/40 flex flex-col gap-1 rounded-md border p-3" data-testid="weekly-focus">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <TargetIcon className="size-4" />
          {t("focus")}: {r.focus.title}
        </h4>
        <p className="text-sm break-words">{r.focus.detail}</p>
      </div>
      {r.examples.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{t("examples")}</h4>
          <ul className="flex flex-col gap-3">
            {r.examples.map((e) => (
              <li key={`${e.sessionId}-${e.turnSeq}`} className="flex flex-col gap-1 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={e.kind === "good" ? "secondary" : "outline"}>{t(`kind.${e.kind}`)}</Badge>
                  <Link
                    href={`/projects/${projectId}/sessions/${e.sessionId}#turn-${e.turnSeq}`}
                    className="text-muted-foreground underline-offset-4 hover:underline"
                  >
                    {t("openTurn", { seq: e.turnSeq })}
                  </Link>
                </div>
                <pre className="bg-muted rounded p-2 text-xs break-words whitespace-pre-wrap">{e.excerpt}</pre>
                <p className="text-sm break-words">{e.comment}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        {t("footer")} · {result.model} ·{" "}
        <time dateTime={result.createdAt}>
          {format.dateTime(new Date(result.createdAt), { dateStyle: "short", timeStyle: "short" })}
        </time>
      </p>
    </div>
  );
}

/**
 * Báo cáo tuần của một thành viên do AI viết (B1, M6.8), bằng key của chính người xem. Chọn tuần trong các tuần có
 * session của hồ sơ; kết quả chỉ người bấm thấy. Ví dụ prompt trong báo cáo do server chọn và điền.
 */
export function WeeklyReportCard({
  projectId,
  userId,
  weeks,
}: {
  projectId: string;
  userId: string;
  weeks: ProfileWeek[];
}) {
  const t = useTranslations("weeklyReport");
  const format = useFormatter();
  const locale: AiLocale = useLocale() === "en" ? "en" : "vi";
  const queryClient = useQueryClient();
  const weekId = useId();
  const withData = weeks.filter((w) => w.sessions > 0).sort((a, b) => (a.week < b.week ? 1 : -1));
  const [chosen, setChosen] = useState<string | null>(null);
  const week = chosen ?? withData[0]?.week;
  const keyStatus = useLlmKeyStatus();
  const hasKey = keyStatus.data?.hasKey === true;
  const queryKey = ["weekly-report", projectId, userId, week, locale] as const;
  const saved = useQuery({
    queryKey,
    queryFn: () =>
      api.get<WeeklyReportSaved>(`/users/${userId}/ai/weekly-report?project=${projectId}&week=${week}&locale=${locale}`),
    enabled: hasKey && week !== undefined,
    retry: false,
    staleTime: 60_000,
  });
  const run = useMutation({
    mutationFn: () => api.post<AiResult>(`/users/${userId}/ai/weekly-report`, { project: projectId, week, locale }),
    onSuccess: (result) => queryClient.setQueryData<WeeklyReportSaved>(queryKey, { result }),
  });
  if (withData.length === 0 || week === undefined) return null;
  const result = saved.data?.result ?? null;

  return (
    <Card data-testid="weekly-report-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4" />
          {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("description")}</p>
        {keyStatus.data &&
          (hasKey ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor={weekId} className="text-muted-foreground text-xs font-medium">
                    {t("week")}
                  </label>
                  <select id={weekId} className={selectClass} value={week} onChange={(e) => setChosen(e.target.value)}>
                    {withData.map((w) => (
                      <option key={w.week} value={w.week}>
                        {t("weekOption", {
                          date: format.dateTime(new Date(`${w.week}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                          sessions: w.sessions,
                        })}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  variant={result ? "outline" : "default"}
                  size="sm"
                  disabled={run.isPending}
                  aria-busy={run.isPending || undefined}
                  onClick={() => run.mutate()}
                >
                  {run.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : result ? (
                    <RotateCcwIcon data-icon="inline-start" />
                  ) : (
                    <SparklesIcon data-icon="inline-start" />
                  )}
                  {run.isPending ? t("running") : result ? t("redo") : t("write")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{t("privateNote")}</p>
              {run.isError && <ApiMessage error={run.error} />}
              {result && <Report projectId={projectId} result={result} />}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              <Link href="/settings/ai" className="text-primary underline underline-offset-4">
                {t("addKey")}
              </Link>
            </p>
          ))}
      </CardContent>
    </Card>
  );
}
