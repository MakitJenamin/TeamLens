"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, InboxIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useId, useState } from "react";
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
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import type { SessionPage } from "@/lib/api/types";
import { rangeFrom, RANGE_WEEKS } from "../../../overview/_components/overview-range";
import { SCORE_CATEGORIES } from "../../../overview/_components/overview-types";
import { VIZ_VARS } from "../../../overview/_components/viz-colors";
import { ScoresChart } from "../../../overview/_components/weekly-charts";
import { type MemberProfile, PROFILE_DEFAULT_WEEKS, RECENT_SESSIONS } from "./profile-types";
import { ProfileRadar } from "./profile-radar";
import { WeeklyReportCard } from "./weekly-report";

const selectClass =
  "border-input bg-background dark:bg-input/30 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const SEVERITY_VARIANT = { low: "outline", medium: "secondary", high: "destructive" } as const;

/** Hồ sơ thành viên (M2.10). Một request `GET /users/{id}/profile`, thêm 5 session gần nhất từ API session. */
export function ProfileDashboard({ projectId, userId }: { projectId: string; userId: string }) {
  const t = useTranslations("profile");
  const format = useFormatter();
  const [weeks, setWeeks] = useState<number>(PROFILE_DEFAULT_WEEKS);
  // Cố định thời điểm mở trang để query key và `from` không đổi theo từng lần render.
  const [now] = useState(() => new Date());
  const rangeId = useId();

  const query = useQuery({
    queryKey: ["profile", projectId, userId, weeks],
    queryFn: () =>
      api.get<MemberProfile>(
        `/users/${userId}/profile?project=${projectId}&from=${encodeURIComponent(rangeFrom(weeks, now))}`,
      ),
  });

  const compact = (value: number) => format.number(value, { notation: "compact", maximumFractionDigits: 1 });
  const weekLabel = (week: string) =>
    format.dateTime(new Date(`${week}T00:00:00Z`), { day: "2-digit", month: "2-digit", timeZone: "UTC" });

  const profile = query.data;
  const hasData = profile !== undefined && (profile.totals.sessions > 0 || profile.patterns.length > 0);
  const hasScores = profile !== undefined && Object.keys(profile.scores).length > 0;

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

      {query.isPending && <ProfileSkeleton />}

      {query.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t("error.title")}</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}

      {profile && !hasData && (
        <Card className="border-dashed">
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <InboxIcon className="size-6" />
            <p className="text-foreground font-medium">{t("empty.title")}</p>
          </CardContent>
        </Card>
      )}

      {profile && hasData && (
        <div className={`flex flex-col gap-6 ${VIZ_VARS}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label={t("totals.sessions")}
              value={format.number(profile.totals.sessions)}
            />
            <StatCard label={t("totals.tokens")} value={compact(profile.totals.tokens)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("radar.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                {hasScores ? (
                  <ProfileRadar
                    data={SCORE_CATEGORIES.map((key) => ({
                      label: t(`categories.${key}`),
                      member: profile.scores[key],
                      team: profile.teamScores[key],
                    }))}
                    memberName={profile.user.name}
                    teamName={t("radar.team")}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">{t("radar.noScore")}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("trend.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ScoresChart
                  data={profile.weeks.map((w) => ({ label: weekLabel(w.week), ...w.scores }))}
                  series={SCORE_CATEGORIES.map((key) => ({ key, name: t(`categories.${key}`) }))}
                />
              </CardContent>
            </Card>
          </div>

          <TrendTable profile={profile} weekLabel={weekLabel} compact={compact} />

          <WeeklyReportCard projectId={projectId} userId={userId} weeks={profile.weeks} />

          <Card>
            <CardHeader>
              <CardTitle>{t("patterns.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              {profile.patterns.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("patterns.empty")}</p>
              ) : (
                <ol className="flex flex-col divide-y">
                  {profile.patterns.map((pattern) => (
                    <li key={pattern.ruleKey} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-col gap-0.5">
                          <code className="text-sm font-medium">{pattern.ruleKey}</code>
                          <span className="text-muted-foreground text-xs">{t(`categories.${pattern.category}`)}</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          <Badge variant={SEVERITY_VARIANT[pattern.severity]}>
                            {t(`patterns.severity.${pattern.severity}`)}
                          </Badge>
                          <span className="tabular-nums">{t("patterns.count", { count: pattern.count })}</span>
                        </div>
                      </div>
                      {pattern.advice && (
                        <p className="text-sm">
                          <span className="font-medium">{t("patterns.advice")}:</span> {pattern.advice}
                        </p>
                      )}
                      {pattern.examples.length > 0 && (
                        <div className="flex flex-col gap-1">
                          <span className="text-muted-foreground text-xs font-medium">{t("patterns.examples")}</span>
                          <ul className="flex flex-col gap-1.5">
                            {pattern.examples.map((example) => (
                              <li
                                key={`${example.sessionId}-${example.turnSeq ?? "session"}`}
                                className="bg-muted/50 flex flex-wrap items-baseline justify-between gap-2 rounded-lg px-3 py-2 text-sm"
                              >
                                <span className="flex min-w-0 flex-col gap-0.5">
                                  {example.excerpt ? (
                                    <q className="font-mono text-xs break-words">{example.excerpt}</q>
                                  ) : (
                                    <span className="text-muted-foreground text-xs italic">{t("patterns.noExcerpt")}</span>
                                  )}
                                  {example.message && (
                                    <span className="text-muted-foreground text-xs">{example.message}</span>
                                  )}
                                </span>
                                <Link
                                  href={`/projects/${projectId}/sessions/${example.sessionId}`}
                                  className="text-xs font-medium underline-offset-4 hover:underline"
                                >
                                  {t("patterns.openSession")}
                                  {example.turnSeq !== null && ` (${t("patterns.turn", { seq: example.turnSeq })})`}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <RecentSessions projectId={projectId} userId={userId} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

/** Bảng số liệu theo tuần: điểm của thành viên, kèm trung bình team (số nhỏ bên dưới), để đọc chính xác. */
function TrendTable({
  profile,
  weekLabel,
  compact,
}: {
  profile: MemberProfile;
  weekLabel: (week: string) => string;
  compact: (value: number) => string;
}) {
  const t = useTranslations("profile");
  const cell = (own: number | undefined, team: number | undefined) => (
    <TableCell className="text-right tabular-nums">
      <div>{own ?? t("trend.noValue")}</div>
      {team !== undefined && (
        <div className="text-muted-foreground text-xs">{t("trend.team", { value: team })}</div>
      )}
    </TableCell>
  );
  return (
    <Card>
      <CardContent>
        <Table>
          <TableCaption>{t("trend.tableCaption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("trend.columns.week")}</TableHead>
              <TableHead className="text-right">{t("trend.columns.sessions")}</TableHead>
              <TableHead className="text-right">{t("trend.columns.tokens")}</TableHead>
              {SCORE_CATEGORIES.map((key) => (
                <TableHead key={key} className="text-right">
                  {t(`categories.${key}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {profile.weeks.map((w) => (
              <TableRow key={w.week}>
                <TableCell>{weekLabel(w.week)}</TableCell>
                <TableCell className="text-right tabular-nums">{w.sessions}</TableCell>
                <TableCell className="text-right tabular-nums">{compact(w.tokens)}</TableCell>
                {SCORE_CATEGORIES.map((key) => (
                  <Fragment key={key}>{cell(w.scores[key], w.teamScores[key])}</Fragment>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** 5 session gần nhất của thành viên, dùng API session (Người 1) với `userId`. */
function RecentSessions({ projectId, userId }: { projectId: string; userId: string }) {
  const t = useTranslations("profile");
  const tSessions = useTranslations("sessions");
  const format = useFormatter();
  const query = useQuery({
    queryKey: ["profile-sessions", projectId, userId],
    queryFn: () =>
      api.get<SessionPage>(`/projects/${projectId}/sessions?userId=${userId}&limit=${RECENT_SESSIONS}`),
  });
  const items = query.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("recent.title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {query.isPending && <Skeleton className="h-24 rounded-lg" />}
        {query.isError && <p className="text-muted-foreground text-sm">{t("recent.error")}</p>}
        {query.data && items.length === 0 && <p className="text-muted-foreground text-sm">{t("recent.empty")}</p>}
        {items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("recent.columns.startedAt")}</TableHead>
                <TableHead>{t("recent.columns.agent")}</TableHead>
                <TableHead>{t("recent.columns.title")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link
                      href={`/projects/${projectId}/sessions/${session.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {format.dateTime(new Date(session.startedAt), { dateStyle: "short", timeStyle: "short" })}
                    </Link>
                  </TableCell>
                  <TableCell>{tSessions(`agents.${session.agent}`)}</TableCell>
                  <TableCell className="max-w-xs truncate">{session.title ?? tSessions("list.untitled")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Link
          href={`/projects/${projectId}/sessions`}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t("recent.viewAll")}
        </Link>
      </CardContent>
    </Card>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}
