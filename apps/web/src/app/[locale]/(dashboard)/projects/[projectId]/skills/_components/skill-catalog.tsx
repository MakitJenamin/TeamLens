"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiResult,
  CatalogPicksSaved,
  SkillCatalogPicksResult,
  SkillCatalogSource,
  SkillCatalogSourceList,
} from "@teamlens/schema";
import { ExternalLinkIcon, PackageSearchIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { api, ApiError } from "@/lib/api/client";
import { useLlmKeyStatus } from "../../sessions/_components/session-ai";
import { AiError, type AiLocale, type ClusterFilters, RunButton, runBody } from "./skill-ai";

const SOURCES_KEY = ["skill-catalog-sources"] as const;

/** `acme/skills` từ `https://github.com/acme/skills`. */
const repoName = (url: string) => url.replace(/^https:\/\/github\.com\//, "");

function useSources(enabled: boolean) {
  return useQuery({
    queryKey: SOURCES_KEY,
    queryFn: () => api.get<SkillCatalogSourceList>("/skill-catalog-sources"),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

function SourceRow({ source, isLeader }: { source: SkillCatalogSource; isLeader: boolean }) {
  const t = useTranslations("skills.catalog");
  const queryClient = useQueryClient();
  const toggleId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch<SkillCatalogSource>(`/skill-catalog-sources/${source.id}`, { enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/skill-catalog-sources/${source.id}`),
    onSuccess: refresh,
  });
  const failed = toggle.isError || remove.isError;

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 text-sm break-all underline-offset-4 hover:underline"
        >
          {repoName(source.url)}
        </a>
        {isLeader ? (
          <>
            <label htmlFor={toggleId} className="flex items-center gap-1.5 text-xs">
              <input
                id={toggleId}
                type="checkbox"
                checked={source.enabled}
                disabled={toggle.isPending}
                onChange={(e) => toggle.mutate(e.target.checked)}
              />
              {t("enabled")}
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              aria-label={t("remove", { name: repoName(source.url) })}
              onClick={() => remove.mutate()}
            >
              <Trash2Icon data-icon="inline-start" />
              {t("removeShort")}
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground text-xs">{source.enabled ? t("enabled") : t("disabled")}</span>
        )}
      </div>
      {failed && <p className="text-destructive text-xs">{t("sourceError")}</p>}
    </li>
  );
}

function AddSource() {
  const t = useTranslations("skills.catalog");
  const queryClient = useQueryClient();
  const inputId = useId();
  const [url, setUrl] = useState("");
  const add = useMutation({
    mutationFn: () => api.post<SkillCatalogSource>("/skill-catalog-sources", { url: url.trim() }),
    onSuccess: () => {
      setUrl("");
      return queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
  const code = add.error instanceof ApiError ? add.error.code : "unknown";
  const message = add.isError
    ? code === "source_exists"
      ? t("errors.source_exists")
      : code === "validation_error"
        ? t("errors.invalid_url")
        : t("errors.unknown")
    : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) add.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-muted-foreground text-xs font-medium">
        {t("addLabel")}
      </label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={url}
          placeholder="https://github.com/owner/repo"
          inputMode="url"
          autoComplete="off"
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={add.isPending || url.trim() === ""}>
          <PlusIcon data-icon="inline-start" />
          {t("add")}
        </Button>
      </div>
      {message && <p className="text-destructive text-xs">{message}</p>}
    </form>
  );
}

function Sources({ isLeader }: { isLeader: boolean }) {
  const t = useTranslations("skills.catalog");
  const sources = useSources(true);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">{isLeader ? t("sourcesHintLeader") : t("sourcesHint")}</p>
      {sources.isPending ? (
        <p className="text-muted-foreground text-sm">{t("loading")}</p>
      ) : sources.isError ? (
        <p className="text-destructive text-sm">{t("sourcesLoadError")}</p>
      ) : sources.data.sources.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noSources")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.data.sources.map((s) => (
            <SourceRow key={s.id} source={s} isLeader={isLeader} />
          ))}
        </ul>
      )}
      {isLeader && <AddSource />}
    </div>
  );
}

function Picks({ result }: { result: AiResult }) {
  const t = useTranslations("skills.catalog");
  const r = result.result as unknown as SkillCatalogPicksResult;
  return (
    <div className="flex flex-col gap-3" data-testid="catalog-picks">
      {r.picks.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("nothingFits", { count: r.candidatesConsidered })}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {r.picks.map((pick) => (
            <li key={pick.skillUrl} className="bg-background flex flex-col gap-1 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={pick.skillUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-semibold break-all underline-offset-4 hover:underline"
                >
                  {pick.name}
                  <ExternalLinkIcon className="size-3.5 shrink-0" />
                </a>
                <span className="text-muted-foreground text-xs break-all">{repoName(pick.sourceUrl)}</span>
              </div>
              <p className="text-muted-foreground text-sm break-words">{pick.description}</p>
              <p className="text-sm break-words">{pick.reason}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">{t("picksNote", { count: r.candidatesConsidered })}</p>
    </div>
  );
}

/**
 * S3 (M6.13): "Gợi ý skill có sẵn" từ catalog cộng đồng (AI, key của người xem) và danh sách nguồn catalog
 * (leader thêm, bật, tắt, xóa). Dùng cùng bộ lọc với danh sách cụm.
 */
export function CatalogSection({
  projectId,
  isLeader,
  filters,
}: {
  projectId: string;
  isLeader: boolean;
  filters: ClusterFilters;
}) {
  const t = useTranslations("skills.catalog");
  const locale: AiLocale = useLocale() === "en" ? "en" : "vi";
  const queryClient = useQueryClient();
  const keyStatus = useLlmKeyStatus();
  const hasKey = keyStatus.data?.hasKey === true;
  const picksKey = ["skill-catalog-picks", projectId, locale] as const;
  const saved = useQuery({
    queryKey: picksKey,
    queryFn: () => api.get<CatalogPicksSaved>(`/projects/${projectId}/ai/catalog-picks?locale=${locale}`),
    enabled: hasKey,
    retry: false,
    staleTime: 60_000,
  });
  const run = useMutation({
    mutationFn: () => api.post<AiResult>(`/projects/${projectId}/ai/catalog-picks`, runBody(locale, filters)),
    onSuccess: (result) => queryClient.setQueryData<CatalogPicksSaved>(picksKey, { result }),
  });
  const [showSources, setShowSources] = useState(false);
  const sourcesPanelId = useId();
  const result = saved.data?.result ?? null;

  return (
    <Card data-testid="catalog-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageSearchIcon className="size-4" />
          {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("description")}</p>
        {keyStatus.data &&
          (hasKey ? (
            <div className="flex flex-col gap-3">
              <div>
                <RunButton
                  pending={run.isPending}
                  hasResult={result !== null}
                  label={t("run")}
                  onClick={() => run.mutate()}
                />
              </div>
              <p className="text-muted-foreground text-xs">{t("privateNote")}</p>
              {run.isError && <AiError error={run.error} />}
              {result && <Picks result={result} />}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              <Link href="/settings/ai" className="text-primary underline underline-offset-4">
                {t("addKey")}
              </Link>
            </p>
          ))}
        <div className="flex flex-col gap-3">
          <div>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showSources}
              aria-controls={sourcesPanelId}
              onClick={() => setShowSources((v) => !v)}
            >
              {showSources ? t("hideSources") : t("showSources")}
            </Button>
          </div>
          {showSources && (
            <div id={sourcesPanelId}>
              <Sources isLeader={isLeader} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
