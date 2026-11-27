"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, InboxIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api/client";
import { type OverviewWeek, type ProjectOverview, SCORE_CATEGORIES } from "./overview-types";
import { barPercent, DEFAULT_RANGE_WEEKS, RANGE_WEEKS, rangeFrom } from "./overview-range";
import { VIZ_VARS } from "./viz-colors";
import { ScoresChart, TokensChart } from "./weekly-charts";

const selectClass =
  "border-input bg-background dark:bg-input/30 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const SEVERITY_VARIANT = { low: "outline", medium: "secondary", high: "destructive" } as const;

/** Trang tổng quan project cho leader (M2.9). Một request `GET /projects/{id}/overview`, chọn khoảng theo số tuần. */
export function OverviewDashboard({ projectId }: { projectId: string }) {
  const t = useTranslations("overview");
  const tSessions = useTranslations("sessions");
  const format = useFormatter();
  const [weeks, setWeeks] = useState<number>(DEFAULT_RANGE_WEEKS);
  // Cố định thời điểm mở trang để query key và `from` không đổi theo từng lần render.
  const [now] = useState(() => new Date());
  const rangeId = useId();

  const query = useQuery({
    queryKey: ["overview", projectId, weeks],
    queryFn: () =>
      api.get<ProjectOverview>(`/projects/${projectId}/overview?from=${encodeURIComponent(rangeFrom(weeks, now))}`),
  });

  const compact = (value: number) => format.number(value, { notation: "compact", maximumFractionDigits: 1 });
  const usd = (value: number | null) =>
    value === null
      ? t("weekly.noValue")
      : format.number(value, { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 3 : 2 });
  const percent = (value: number | null) =>
    value === null ? t("usage.noValue") : format.number(value, { style: "percent", maximumFractionDigits: 0 });
  const weekLabel = (week: string) =>
    format.dateTime(new Date(`${week}T00:00:00Z`), { day: "2-digit", month: "2-digit", timeZone: "UTC" });

  const data = query.data;
  const isEmpty = data !== undefined && data.totals.sessions === 0 && data.totals.tokens === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <label htmlFor={rangeId} className="text-muted-foreground text-xs font-medium">
          {t("range.label")}
        </label>
        <select
          id={rangeId}
          className={`${selectClass} w-fit`}
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value))}
        >
          {RANGE_WEEKS.map((count) => (
            <option key={count} value={count}>
              {t("range.weeks", { count })}
            </option>
          ))}
        </select>
      </div>

      {query.isPending && <OverviewSkeleton />}

      {query.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t("error.title")}</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}

      {isEmpty && (
        <Card className="border-dashed">
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <InboxIcon className="size-6" />
            <p className="text-foreground font-medium">{t("empty.title")}</p>
            <p className="max-w-md">{t("empty.description")}</p>
          </CardContent>
        </Card>
      )}

      {data && !isEmpty && (
        <div className={`flex flex-col gap-6 ${VIZ_VARS}`}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t("totals.sessions")} value={format.number(data.totals.sessions)} hint={t("totals.sessionsHint")} />
            <StatCard
              label={t("totals.members")}
              value={format.number(data.totals.activeMembers)}
              hint={t("totals.membersHint")}
            />
            <StatCard label={t("totals.tokens")} value={compact(data.totals.tokens)} hint={t("totals.tokensHint")} />
            <StatCard
              label={t("totals.cost")}
              value={usd(data.totals.estimatedCostUsd)}
              hint={data.totals.estimatedCostUsd === null ? t("totals.costUnavailable") : t("totals.costHint")}
            />
          </div>

          <section aria-labelledby="overview-weekly" className="flex flex-col gap-4">
            <h2 id="overview-weekly" className="text-lg font-semibold tracking-tight">
              {t("weekly.title")}
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t("weekly.tokensChart")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <TokensChart
                    data={data.weeks.map((w) => ({ label: weekLabel(w.week), tokens: w.tokens }))}
                    seriesName={t("totals.tokens")}
                    formatValue={compact}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("weekly.scoresChart")}</CardTitle>
                  <CardDescription>{t("weekly.scoresHint")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScoresChart
                    data={data.weeks.map((w) => ({ label: weekLabel(w.week), ...w.scores }))}
                    series={SCORE_CATEGORIES.map((key) => ({ key, name: t(`categories.${key}`) }))}
                  />
                </CardContent>
              </Card>
            </div>
            <WeeklyTable weeks={data.weeks} weekLabel={weekLabel} compact={compact} usd={usd} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("distribution.agentTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {data.byAgent.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("distribution.empty")}</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {data.byAgent.map((row) => (
                      <li key={row.agent} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="font-medium">{tSessions(`agents.${row.agent}`)}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {t("distribution.agentColumns.sessions")}: {format.number(row.sessions)} ·{" "}
                            {t("distribution.agentColumns.tokens")}: {compact(row.tokens)}
                          </span>
                        </div>
                        <div className="bg-muted h-2 overflow-hidden rounded-full">
                          <div
                            className="h-full rounded-full bg-(--viz-1)"
                            style={{ width: `${barPercent(row.tokens, data.byAgent[0].tokens)}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("distribution.modelTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {data.byModel.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("distribution.empty")}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("distribution.modelColumns.model")}</TableHead>
                        <TableHead className="text-right">{t("distribution.modelColumns.turns")}</TableHead>
                        <TableHead className="text-right">{t("distribution.modelColumns.tokens")}</TableHead>
                        <TableHead className="text-right">{t("distribution.modelColumns.cost")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byModel.map((row) => (
                        <TableRow key={row.model ?? "unknown"}>
                          <TableCell className="font-mono text-xs">{row.model ?? t("distribution.unknownModel")}</TableCell>
                          <TableCell className="text-right tabular-nums">{format.number(row.turns)}</TableCell>
                          <TableCell className="text-right tabular-nums">{compact(row.tokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.estimatedCostUsd !== null ? (
                              usd(row.estimatedCostUsd)
                            ) : row.model !== null ? (
                              <Badge variant="outline">{t("distribution.noPrice")}</Badge>
                            ) : (
                              t("weekly.noValue")
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <section aria-labelledby="overview-usage" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="overview-usage" className="text-lg font-semibold tracking-tight">
                {t("usage.title")}
              </h2>
              <p className="text-muted-foreground max-w-3xl text-sm">{t("usage.note")}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={t("usage.cacheHitRate")}
                value={percent(data.usageStats.cacheHitRate)}
                hint={t("usage.cacheHitRateHint")}
              />
              <StatCard
                label={t("usage.premiumModelRate")}
                value={percent(data.usageStats.premiumModelRate)}
                hint={t("usage.premiumModelRateHint")}
              />
              <StatCard
                label={t("usage.highReasoningRate")}
                value={percent(data.usageStats.highReasoningRate)}
                hint={t("usage.highReasoningRateHint")}
              />
              <StatCard
                label={t("usage.avgOutputTokens")}
                value={
                  data.usageStats.avgOutputTokensPerTurn === null
                    ? t("usage.noValue")
                    : format.number(Math.round(data.usageStats.avgOutputTokensPerTurn))
                }
                hint={t("usage.avgOutputTokensHint")}
              />
            </div>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>{t("findings.title")}</CardTitle>
              <CardDescription>{t("findings.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              {data.topFindings.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("findings.empty")}</p>
              ) : (
                <ol className="flex flex-col divide-y">
                  {data.topFindings.map((finding) => (
                    <li
                      key={`${finding.ruleKey}-${finding.severity}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="flex flex-col gap-0.5">
                        <code className="text-sm font-medium">{finding.ruleKey}</code>
                        <span className="text-muted-foreground text-xs">{t(`categories.${finding.category}`)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-sm">
                        <Badge variant={SEVERITY_VARIANT[finding.severity]}>{t(`findings.severity.${finding.severity}`)}</Badge>
                        <span className="tabular-nums">{t("findings.count", { count: finding.count })}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {t("findings.members", { count: finding.memberCount })}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">{hint}</CardContent>
    </Card>
  );
}

/** Bảng số liệu theo tuần: bản chữ của hai biểu đồ, để đọc chính xác từng giá trị. */
function WeeklyTable({
  weeks,
  weekLabel,
  compact,
  usd,
}: {
  weeks: OverviewWeek[];
  weekLabel: (week: string) => string;
  compact: (value: number) => string;
  usd: (value: number | null) => string;
}) {
  const t = useTranslations("overview");
  return (
    <Card>
      <CardContent>
        <Table>
          <TableCaption>{t("weekly.tableCaption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("weekly.columns.week")}</TableHead>
              <TableHead className="text-right">{t("weekly.columns.sessions")}</TableHead>
              <TableHead className="text-right">{t("weekly.columns.tokens")}</TableHead>
              <TableHead className="text-right">{t("weekly.columns.cost")}</TableHead>
              {SCORE_CATEGORIES.map((key) => (
                <TableHead key={key} className="text-right">
                  {t(`categories.${key}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {weeks.map((w) => (
              <TableRow key={w.week}>
                <TableCell>{weekLabel(w.week)}</TableCell>
                <TableCell className="text-right tabular-nums">{w.sessions}</TableCell>
                <TableCell className="text-right tabular-nums">{compact(w.tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{usd(w.estimatedCostUsd)}</TableCell>
                {SCORE_CATEGORIES.map((key) => (
                  <TableCell key={key} className="text-right tabular-nums">
                    {w.scores[key] ?? t("weekly.noValue")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}
