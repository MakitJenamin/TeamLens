"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiResult,
  PromptCandidate,
  PromptCandidatesResult,
  PromptCandidatesSaved,
  PromptLibraryItem,
  PromptLibraryList,
} from "@teamlens/schema";
import {
  AlertCircleIcon,
  CheckIcon,
  CopyIcon,
  InboxIcon,
  Loader2Icon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { api, ApiError } from "@/lib/api/client";
import { useLlmKeyStatus } from "../../sessions/_components/session-ai";

type AiLocale = "vi" | "en";
const RANGE_DAYS = [7, 30, 90] as const;
const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const selectClass =
  "border-input bg-background dark:bg-input/30 h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const libraryKey = (projectId: string) => ["prompt-library", projectId] as const;

/** Thông báo lỗi dễ hiểu theo mã lỗi của API; lỗi về key gợi ý vào Cài đặt AI. */
function ApiMessage({ error }: { error: unknown }) {
  const t = useTranslations("promptLibrary");
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

function CopyButton({ text }: { text: string }) {
  const t = useTranslations("promptLibrary");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}

function ItemCard({ projectId, item, isLeader }: { projectId: string; item: PromptLibraryItem; isLeader: boolean }) {
  const t = useTranslations("promptLibrary");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/projects/${projectId}/prompt-library/${item.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKey(projectId) }),
  });
  const author = item.author ? item.author.name : t("anonymous");

  return (
    <li data-testid="library-item">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span>{author}</span>
            {isLeader && item.hideAuthor && <Badge variant="outline">{t("hiddenFromMembers")}</Badge>}
            {item.workType && <Badge variant="secondary">{t(`workType.${item.workType}`)}</Badge>}
            <time dateTime={item.createdAt}>
              {format.dateTime(new Date(item.createdAt), { dateStyle: "short", timeStyle: "short" })}
            </time>
            {isLeader && item.sessionId && (
              <Link
                href={`/projects/${projectId}/sessions/${item.sessionId}${item.turnSeq !== null ? `#turn-${item.turnSeq}` : ""}`}
                className="underline-offset-4 hover:underline"
              >
                {t("openSession")}
              </Link>
            )}
          </div>
          {item.note && <p className="text-sm break-words whitespace-pre-wrap">{item.note}</p>}
          <pre className="bg-muted rounded-md p-3 text-sm break-words whitespace-pre-wrap">{item.prompt}</pre>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={item.prompt} />
            {isLeader && (
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                aria-label={t("removeLabel")}
                onClick={() => remove.mutate()}
              >
                <Trash2Icon data-icon="inline-start" />
                {t("remove")}
              </Button>
            )}
          </div>
          {remove.isError && <ApiMessage error={remove.error} />}
        </CardContent>
      </Card>
    </li>
  );
}

function Library({ projectId, isLeader }: { projectId: string; isLeader: boolean }) {
  const t = useTranslations("promptLibrary");
  const query = useQuery({
    queryKey: libraryKey(projectId),
    queryFn: () => api.get<PromptLibraryList>(`/projects/${projectId}/prompt-library`),
  });

  if (query.isPending)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  if (query.isError)
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>{t("errorTitle")}</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    );
  if (query.data.items.length === 0)
    return (
      <Card className="border-dashed">
        <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
          <InboxIcon className="size-6" />
          <span className="text-foreground font-medium">{t("emptyTitle")}</span>
          <span>{isLeader ? t("emptyHintLeader") : t("emptyHint")}</span>
        </CardContent>
      </Card>
    );
  return (
    <ul className="flex flex-col gap-3">
      {query.data.items.map((item) => (
        <ItemCard key={item.id} projectId={projectId} item={item} isLeader={isLeader} />
      ))}
    </ul>
  );
}

function CandidateCard({ projectId, candidate }: { projectId: string; candidate: PromptCandidate }) {
  const t = useTranslations("promptLibrary");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const hideId = useId();
  const [hideAuthor, setHideAuthor] = useState(false);
  const add = useMutation({
    mutationFn: () =>
      api.post<PromptLibraryItem>(`/projects/${projectId}/prompt-library`, {
        sessionId: candidate.sessionId,
        turnSeq: candidate.turnSeq,
        note: candidate.why,
        hideAuthor,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKey(projectId) }),
  });
  const alreadyThere = add.error instanceof ApiError && add.error.code === "already_in_library";
  const added = add.isSuccess || alreadyThere;

  return (
    <li className="bg-background flex flex-col gap-2 rounded-md border p-3" data-testid="candidate">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="font-semibold break-words">{candidate.title}</h3>
        <Badge variant="secondary">{t("score", { score: candidate.score })}</Badge>
        {candidate.workType && <Badge variant="outline">{t(`workType.${candidate.workType}`)}</Badge>}
      </div>
      <p className="text-muted-foreground text-xs">
        {candidate.userName} ·{" "}
        {format.dateTime(new Date(candidate.startedAt), { dateStyle: "short", timeStyle: "short" })} ·{" "}
        <Link
          href={`/projects/${projectId}/sessions/${candidate.sessionId}#turn-${candidate.turnSeq}`}
          className="underline-offset-4 hover:underline"
        >
          {t("openSession")}
        </Link>
      </p>
      <p className="text-sm break-words">{candidate.why}</p>
      <pre className="bg-muted rounded-md p-3 text-sm break-words whitespace-pre-wrap">{candidate.prompt}</pre>
      {added ? (
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <CheckIcon className="mr-1 inline size-4" />
          {alreadyThere ? t("alreadyAdded") : t("added")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={hideId} className="flex items-center gap-1.5 text-sm">
            <input id={hideId} type="checkbox" checked={hideAuthor} onChange={(e) => setHideAuthor(e.target.checked)} />
            {t("hideAuthor")}
          </label>
          <Button size="sm" disabled={add.isPending} aria-busy={add.isPending || undefined} onClick={() => add.mutate()}>
            {add.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <PlusIcon data-icon="inline-start" />}
            {t("addToLibrary")}
          </Button>
        </div>
      )}
      {add.isError && !alreadyThere && <ApiMessage error={add.error} />}
    </li>
  );
}

/** C2 bước 1 (leader): tìm prompt mẫu bằng heuristic rồi AI (key của leader) viết tiêu đề và lý do. */
function Finder({ projectId }: { projectId: string }) {
  const t = useTranslations("promptLibrary");
  const locale: AiLocale = useLocale() === "en" ? "en" : "vi";
  const queryClient = useQueryClient();
  const rangeId = useId();
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const keyStatus = useLlmKeyStatus();
  const hasKey = keyStatus.data?.hasKey === true;
  const key = ["prompt-candidates", projectId, locale] as const;
  const saved = useQuery({
    queryKey: key,
    queryFn: () => api.get<PromptCandidatesSaved>(`/projects/${projectId}/ai/prompt-candidates?locale=${locale}`),
    enabled: hasKey,
    retry: false,
    staleTime: 60_000,
  });
  const run = useMutation({
    mutationFn: () =>
      api.post<AiResult>(`/projects/${projectId}/ai/prompt-candidates`, {
        locale,
        from: new Date(Date.now() - days * DAY_MS).toISOString(),
      }),
    onSuccess: (result) => queryClient.setQueryData<PromptCandidatesSaved>(key, { result }),
  });
  const result = saved.data?.result ?? null;
  const parsed = result ? (result.result as unknown as PromptCandidatesResult) : null;

  return (
    <Card data-testid="candidate-finder">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4" />
          {t("finderTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("finderDescription")}</p>
        {keyStatus.data &&
          (hasKey ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor={rangeId} className="text-muted-foreground text-xs font-medium">
                    {t("range")}
                  </label>
                  <select id={rangeId} className={selectClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {RANGE_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {t("days", { days: d })}
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
                  {run.isPending ? t("running") : result ? t("redo") : t("find")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{t("privateNote")}</p>
              {run.isError && <ApiMessage error={run.error} />}
              {parsed &&
                (parsed.candidates.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("noneWorthy", { count: parsed.considered })}</p>
                ) : (
                  <>
                    <p className="text-muted-foreground text-xs">{t("considered", { count: parsed.considered })}</p>
                    <ul className="flex flex-col gap-3">
                      {parsed.candidates.map((c) => (
                        <CandidateCard key={`${c.sessionId}-${c.turnSeq}`} projectId={projectId} candidate={c} />
                      ))}
                    </ul>
                  </>
                ))}
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

/**
 * Thư viện prompt mẫu (M6.14, C2): các prompt leader đã duyệt, mọi thành viên của project xem được. Leader có thêm
 * khu tìm ứng viên (AI) và nút gỡ. Nội dung prompt chỉ hiển thị dạng chữ.
 */
export function PromptLibrary({ projectId, isLeader }: { projectId: string; isLeader: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {isLeader && <Finder projectId={projectId} />}
      <Library projectId={projectId} isLeader={isLeader} />
    </div>
  );
}
