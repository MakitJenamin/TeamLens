"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircleIcon, BotIcon, InboxIcon, SearchIcon, SearchXIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import type { AgentKind, SessionPage, SessionSummary } from "@/lib/api/types";
import { sessionDuration, totalTokens } from "./format";

export const AGENT_KINDS: AgentKind[] = ["claude_code", "codex", "copilot_vscode", "antigravity"];
const PAGE_SIZE = 50;
/** Chờ người dùng ngừng gõ rồi mới tìm (Enter tìm ngay). */
const SEARCH_DEBOUNCE_MS = 300;
/** Khớp giới hạn `q` của API (1–200 ký tự sau trim). */
const SEARCH_MAX_LENGTH = 200;

export interface SnippetPart {
  text: string;
  highlight: boolean;
}

/**
 * Tách đoạn trích của API (từ khớp bao bởi «…») thành các phần thường và phần đánh dấu.
 * Chỉ tạo text node, không render HTML từ dữ liệu.
 */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let last = 0;
  for (const m of snippet.matchAll(/«([^«»]*)»/g)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), highlight: false });
    if (m[1]) parts.push({ text: m[1], highlight: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), highlight: false });
  return parts;
}

export interface MemberOption {
  id: string;
  name: string;
}

export const WORK_TYPES = ["bugfix", "feature", "refactor", "question", "ops", "docs", "test", "other"] as const;

function sessionsUrl(
  projectId: string,
  filters: { agent: string; workType: string; userId: string; q: string },
  cursor?: string,
) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.workType) params.set("workType", filters.workType);
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  return `/projects/${projectId}/sessions?${params.toString()}`;
}

const selectClass =
  "border-input bg-background dark:bg-input/30 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** Bảng session của project, tìm full-text, lọc agent/người và "Tải thêm" theo cursor. */
export function SessionList({ projectId, members }: { projectId: string; members: MemberOption[] | null }) {
  const t = useTranslations("sessions");
  const [agent, setAgent] = useState("");
  const [workType, setWorkType] = useState("");
  const [userId, setUserId] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const agentId = useId();
  const workTypeId = useId();
  const userSelectId = useId();
  const searchId = useId();

  useEffect(() => {
    const next = searchInput.trim();
    if (next === q) return;
    const timer = setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, q]);

  const query = useInfiniteQuery({
    queryKey: ["sessions", projectId, { agent, workType, userId, q }],
    queryFn: ({ pageParam }) =>
      api.get<SessionPage>(sessionsUrl(projectId, { agent, workType, userId, q }, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const sessions = query.data?.pages.flatMap((p) => p.items) ?? [];
  const nextPageError = query.isFetchNextPageError ? query.error : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <form
          role="search"
          className="flex min-w-56 flex-1 flex-col gap-1 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(searchInput.trim());
          }}
        >
          <label htmlFor={searchId} className="text-muted-foreground text-xs font-medium">
            {t("list.filters.search")}
          </label>
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input
              id={searchId}
              type="search"
              className="pl-8"
              value={searchInput}
              maxLength={SEARCH_MAX_LENGTH}
              placeholder={t("list.filters.searchPlaceholder")}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </form>
        <div className="flex flex-col gap-1">
          <label htmlFor={agentId} className="text-muted-foreground text-xs font-medium">
            {t("list.filters.agent")}
          </label>
          <select id={agentId} className={selectClass} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{t("list.filters.allAgents")}</option>
            {AGENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`agents.${kind}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={workTypeId} className="text-muted-foreground text-xs font-medium">
            {t("list.filters.workType")}
          </label>
          <select id={workTypeId} className={selectClass} value={workType} onChange={(e) => setWorkType(e.target.value)}>
            <option value="">{t("list.filters.allWorkTypes")}</option>
            {WORK_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`workTypes.${type}`)}
              </option>
            ))}
          </select>
        </div>
        {members && members.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={userSelectId} className="text-muted-foreground text-xs font-medium">
              {t("list.filters.user")}
            </label>
            <select id={userSelectId} className={selectClass} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{t("list.filters.allUsers")}</option>
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
          <AlertTitle>{t("list.errorTitle")}</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : sessions.length === 0 && q ? (
        <Card className="border-dashed">
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <SearchXIcon className="size-6" />
            <span className="text-foreground font-medium">{t("list.noResultsTitle")}</span>
          </CardContent>
        </Card>
      ) : sessions.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <InboxIcon className="size-6" />
            <span className="text-foreground font-medium">{t("list.emptyTitle")}</span>
          </CardContent>
        </Card>
      ) : (
        <>
          <SessionTable projectId={projectId} sessions={sessions} />
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? t("list.loadingMore") : t("list.loadMore")}
              </Button>
            </div>
          )}
          {nextPageError && (
            <p role="alert" className="text-destructive text-center text-sm">
              {nextPageError.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SessionTable({ projectId, sessions }: { projectId: string; sessions: SessionSummary[] }) {
  const t = useTranslations("sessions");
  const format = useFormatter();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("list.columns.startedAt")}</TableHead>
          <TableHead>{t("list.columns.user")}</TableHead>
          <TableHead className="hidden sm:table-cell">{t("list.columns.agent")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("list.columns.workType")}</TableHead>
          <TableHead className="hidden lg:table-cell">{t("list.columns.model")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("list.columns.repo")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("list.columns.duration")}</TableHead>
          <TableHead className="text-right">{t("list.columns.turns")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("list.columns.tokens")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((s) => {
          const duration = sessionDuration(s);
          return (
            <TableRow key={s.id}>
              <TableCell className="max-w-72 align-top whitespace-normal">
                <Link
                  href={`/projects/${projectId}/sessions/${s.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {format.dateTime(new Date(s.startedAt), { dateStyle: "short", timeStyle: "short" })}
                </Link>
                <p className="text-muted-foreground line-clamp-2 text-xs break-words">{s.title ?? t("list.untitled")}</p>
                {s.match && (
                  <Link
                    href={`/projects/${projectId}/sessions/${s.id}#turn-${s.match.turnSeq}`}
                    className="hover:bg-muted mt-1 block rounded text-xs break-words"
                  >
                    <span className="text-muted-foreground">{t("list.matchTurn", { seq: s.match.turnSeq })} </span>
                    <SnippetText snippet={s.match.snippet} />
                  </Link>
                )}
                {s.childCount > 0 && (
                  <Badge variant="outline" className="mt-1">
                    <BotIcon />
                    {t("list.children", { count: s.childCount })}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="align-top">{s.user.name}</TableCell>
              <TableCell className="hidden align-top sm:table-cell">
                <Badge variant="secondary">{t(`agents.${s.agent}`)}</Badge>
              </TableCell>
              <TableCell className="hidden align-top md:table-cell">
                {s.workType ? <Badge variant="outline">{t(`workTypes.${s.workType}`)}</Badge> : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="hidden align-top font-mono text-xs lg:table-cell">{s.model ?? "—"}</TableCell>
              <TableCell className="hidden max-w-56 align-top md:table-cell">
                <span className="block truncate font-mono text-xs" title={s.repoRemote}>
                  {s.repoRemote}
                </span>
                {s.branch && <span className="text-muted-foreground block truncate font-mono text-xs">{s.branch}</span>}
              </TableCell>
              <TableCell className="hidden align-top md:table-cell">
                {duration ? t(`duration.${duration.key}`, duration.values) : t("list.running")}
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">{s.turnCount}</TableCell>
              <TableCell
                className="hidden text-right align-top tabular-nums sm:table-cell"
                title={t("list.tokensDetail", {
                  input: format.number(s.usage.input),
                  output: format.number(s.usage.output),
                  cacheRead: format.number(s.usage.cacheRead),
                  cacheWrite: format.number(s.usage.cacheWrite),
                })}
              >
                {format.number(totalTokens(s.usage), { notation: "compact" })}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Đoạn trích có từ khớp đánh dấu bằng `<mark>`; toàn bộ là text node, không render HTML từ API. */
function SnippetText({ snippet }: { snippet: string }) {
  return (
    <span>
      {splitSnippet(snippet).map((part, i) =>
        part.highlight ? (
          <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-500/40">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
