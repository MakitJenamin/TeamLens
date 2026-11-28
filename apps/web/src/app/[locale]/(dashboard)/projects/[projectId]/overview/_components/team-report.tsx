"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiResult, TeamReportResult, TeamReportSaved } from "@teamlens/schema";
import { AlertCircleIcon, LightbulbIcon, Loader2Icon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { api, ApiError } from "@/lib/api/client";
import { useLlmKeyStatus } from "../../sessions/_components/session-ai";
import type { OverviewWeek } from "./overview-types";

type AiLocale = "vi" | "en";

const SEVERITY_VARIANT = { low: "outline", medium: "secondary", high: "destructive" } as const;

const selectClass =
  "border-input bg-background dark:bg-input/30 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function ApiMessage({ error }: { error: unknown }) {
  const t = useTranslations("teamReport");
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

function Report({ result }: { result: AiResult }) {
  const t = useTranslations("teamReport");
  const tProfile = useTranslations("profile");
  const format = useFormatter();
  const r = result.result as unknown as TeamReportResult;
  return (
    <div className="flex flex-col gap-4" data-testid="team-report">
      <p className="text-sm leading-relaxed break-words">{r.headline}</p>
      {r.vsLastWeek && (
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">{t("vsLastWeek")}</h4>
          <p className="text-sm break-words">{r.vsLastWeek}</p>
        </div>
      )}
      {r.topIssues.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{t("topIssues")}</h4>
          <ul className="flex flex-col gap-2">
            {r.topIssues.map((issue) => (
              <li key={issue.ruleKey} className="flex flex-col gap-1 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <code className="bg-muted rounded px-1.5 py-0.5 break-all">{issue.ruleKey}</code>
                  <Badge variant={SEVERITY_VARIANT[issue.severity]}>{tProfile(`patterns.severity.${issue.severity}`)}</Badge>
                  <span className="text-muted-foreground">
                    {t("issueStats", { count: issue.count, members: issue.memberCount })}
                  </span>
                </div>
                <p className="text-sm break-words">{issue.comment}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.improved.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{t("improved")}</h4>
          <ul className="flex flex-col gap-2">
            {r.improved.map((m) => (
              <li key={m.userId} className="flex flex-col gap-1 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium break-words">{m.name}</span>
                  {m.change !== null && (
                    <Badge variant="secondary">
                      {t("change", { change: format.number(m.change, { signDisplay: "exceptZero" }) })}
                    </Badge>
                  )}
                </div>
                <p className="text-sm break-words">{m.comment}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="bg-muted/40 flex flex-col gap-1 rounded-md border p-3" data-testid="team-sharing">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <LightbulbIcon className="size-4" />
          {t("sharing")}: {r.sharingSession.topic}
        </h4>
        <p className="text-sm break-words">{r.sharingSession.detail}</p>
      </div>
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
 * Báo cáo tuần của team do AI viết (B2, M6.9), chỉ leader, bằng key của chính leader. Chọn tuần trong các tuần có
 * session của Tổng quan. AI chỉ nhận số liệu tổng hợp ẩn danh (không prompt, không tên); tên người trong kết quả do
 * server điền.
 */
export function TeamReportCard({ projectId, weeks }: { projectId: string; weeks: OverviewWeek[] }) {
  const t = useTranslations("teamReport");
  const format = useFormatter();
  const locale: AiLocale = useLocale() === "en" ? "en" : "vi";
  const queryClient = useQueryClient();
  const weekId = useId();
  const withData = weeks.filter((w) => w.sessions > 0).sort((a, b) => (a.week < b.week ? 1 : -1));
  const [chosen, setChosen] = useState<string | null>(null);
  const week = chosen ?? withData[0]?.week;
  const keyStatus = useLlmKeyStatus();
  const hasKey = keyStatus.data?.hasKey === true;
  const queryKey = ["team-report", projectId, week, locale] as const;
  const saved = useQuery({
    queryKey,
    queryFn: () => api.get<TeamReportSaved>(`/projects/${projectId}/ai/weekly-report?week=${week}&locale=${locale}`),
    enabled: hasKey && week !== undefined,
    retry: false,
    staleTime: 60_000,
  });
  const run = useMutation({
    mutationFn: () => api.post<AiResult>(`/projects/${projectId}/ai/weekly-report`, { week, locale }),
    onSuccess: (result) => queryClient.setQueryData<TeamReportSaved>(queryKey, { result }),
  });
  if (withData.length === 0 || week === undefined) return null;
  const result = saved.data?.result ?? null;

  return (
    <Card data-testid="team-report-card">
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
              {result && <Report result={result} />}
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
