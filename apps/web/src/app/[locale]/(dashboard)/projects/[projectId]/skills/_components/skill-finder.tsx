"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, ChevronDownIcon, ChevronRightIcon, InboxIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import type { SkillCluster, SkillClusterList } from "@/lib/api/types";
import { ClusterAi, type ClusterFilters } from "./skill-ai";
import { CatalogSection } from "./skill-catalog";

export const RANGE_DAYS = [7, 30, 90] as const;
export const DEFAULT_DAYS = 30;
const LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemberOption {
  id: string;
  name: string;
}

const selectClass =
  "border-input bg-background dark:bg-input/30 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function clustersUrl(projectId: string, filters: { days: number; userId: string }) {
  const params = new URLSearchParams({
    limit: String(LIMIT),
    from: new Date(Date.now() - filters.days * DAY_MS).toISOString(),
  });
  if (filters.userId) params.set("userId", filters.userId);
  return `/projects/${projectId}/skill-clusters?${params.toString()}`;
}

/**
 * Skill Finder (M6.11): các cụm prompt lặp lại của project. Leader lọc theo người; member chỉ thấy prompt của mình
 * (`members` là `null`). Gom cụm bằng heuristic ở server, không gọi AI.
 */
export function SkillFinder({ projectId, members }: { projectId: string; members: MemberOption[] | null }) {
  const t = useTranslations("skills");
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [userId, setUserId] = useState("");
  const rangeId = useId();
  const userSelectId = useId();

  const query = useQuery({
    queryKey: ["skill-clusters", projectId, { days, userId }],
    queryFn: () => api.get<SkillClusterList>(clustersUrl(projectId, { days, userId })),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={rangeId} className="text-muted-foreground text-xs font-medium">
            {t("filters.range")}
          </label>
          <select id={rangeId} className={selectClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGE_DAYS.map((d) => (
              <option key={d} value={d}>
                {t("filters.days", { days: d })}
              </option>
            ))}
          </select>
        </div>
        {members && members.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={userSelectId} className="text-muted-foreground text-xs font-medium">
              {t("filters.user")}
            </label>
            <select id={userSelectId} className={selectClass} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{t("filters.allUsers")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t("errorTitle")}</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="text-muted-foreground flex flex-col gap-1 text-sm">
            <p>
              {t("summary", {
                analyzed: query.data.stats.promptsAnalyzed,
                clustered: query.data.stats.promptsClustered,
                clusters: query.data.stats.clusterCount,
              })}
            </p>
            <p className="text-xs">{t("heuristicNote")}</p>
          </div>
          {query.data.stats.truncated && (
            <Alert>
              <AlertCircleIcon />
              <AlertDescription>{t("truncated")}</AlertDescription>
            </Alert>
          )}
          <CatalogSection projectId={projectId} isLeader={members !== null} filters={{ days, userId }} />
          {query.data.clusters.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
                <InboxIcon className="size-6" />
                <span className="text-foreground font-medium">{t("emptyTitle")}</span>
                <span>{t("emptyHint")}</span>
              </CardContent>
            </Card>
          ) : (
            <ClusterTable
              projectId={projectId}
              clusters={query.data.clusters}
              showUsers={members !== null}
              filters={{ days, userId }}
            />
          )}
        </>
      )}
    </div>
  );
}

function ClusterTable({
  projectId,
  clusters,
  showUsers,
  filters,
}: {
  projectId: string;
  clusters: SkillCluster[];
  showUsers: boolean;
  filters: ClusterFilters;
}) {
  const t = useTranslations("skills");
  const format = useFormatter();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const columns = showUsers ? 4 : 3;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columns.prompt")}</TableHead>
          <TableHead className="text-right">{t("columns.count")}</TableHead>
          {showUsers && <TableHead className="hidden sm:table-cell">{t("columns.users")}</TableHead>}
          <TableHead className="hidden md:table-cell">{t("columns.lastSeen")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clusters.map((cluster) => {
          const expanded = open.has(cluster.id);
          const panelId = `cluster-${cluster.id}`;
          const nameOf = (userId: string) => cluster.users.find((u) => u.userId === userId)?.name;
          return (
            <Fragment key={cluster.id}>
              <TableRow>
                <TableCell className="max-w-xl align-top whitespace-normal">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-auto w-full justify-start gap-1 py-1 text-left font-normal whitespace-normal"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    aria-label={`${expanded ? t("collapse") : t("expand")}: ${cluster.label}`}
                    onClick={() => toggle(cluster.id)}
                  >
                    {expanded ? <ChevronDownIcon className="shrink-0" /> : <ChevronRightIcon className="shrink-0" />}
                    <span className="line-clamp-2 break-words">{cluster.label}</span>
                  </Button>
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  <Badge variant="secondary">{cluster.count}</Badge>
                </TableCell>
                {showUsers && (
                  <TableCell className="hidden align-top sm:table-cell">
                    <span className="block text-sm">{cluster.users.map((u) => u.name).join(", ")}</span>
                    {cluster.userCount > cluster.users.length && (
                      <span className="text-muted-foreground text-xs">{t("userCount", { count: cluster.userCount })}</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="hidden align-top whitespace-nowrap md:table-cell">
                  {format.dateTime(new Date(cluster.lastSeenAt), { dateStyle: "short", timeStyle: "short" })}
                </TableCell>
              </TableRow>
              {expanded && (
                <TableRow id={panelId} className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={columns} className="whitespace-normal">
                    <p className="text-muted-foreground mb-2 text-xs font-medium">{t("examples")}</p>
                    <ul className="flex flex-col gap-2">
                      {cluster.examples.map((e) => (
                        <li key={`${e.sessionId}-${e.turnSeq}`} className="text-sm">
                          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                            {showUsers && <span>{nameOf(e.userId) ?? ""}</span>}
                            <span>{format.dateTime(new Date(e.ts), { dateStyle: "short", timeStyle: "short" })}</span>
                            <Link
                              href={`/projects/${projectId}/sessions/${e.sessionId}#turn-${e.turnSeq}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {t("turn", { seq: e.turnSeq })}
                            </Link>
                          </div>
                          <p className="break-words">{e.excerpt}</p>
                        </li>
                      ))}
                    </ul>
                    <ClusterAi projectId={projectId} clusterId={cluster.id} filters={filters} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
