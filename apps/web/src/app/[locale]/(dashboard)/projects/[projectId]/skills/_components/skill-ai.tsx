"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiResult, SkillClusterAiResults, SkillContentResult, SkillTriageResult } from "@teamlens/schema";
import {
  AlertCircleIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  Loader2Icon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { api, ApiError } from "@/lib/api/client";
import { useLlmKeyStatus } from "../../sessions/_components/session-ai";

export type AiLocale = "vi" | "en";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClusterFilters {
  days: number;
  userId: string;
}

const queryKeyOf = (projectId: string, clusterId: string, locale: AiLocale) =>
  ["skill-clusters", projectId, clusterId, "ai", locale] as const;

/** Thân request: cùng bộ lọc với danh sách để server dựng lại đúng cụm. */
export function runBody(locale: AiLocale, filters: ClusterFilters) {
  return {
    locale,
    from: new Date(Date.now() - filters.days * DAY_MS).toISOString(),
    ...(filters.userId ? { userId: filters.userId } : {}),
  };
}

function useRun(projectId: string, clusterId: string, filters: ClusterFilters, step: "triage" | "skill") {
  const locale: AiLocale = useLocale() === "en" ? "en" : "vi";
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<AiResult>(`/projects/${projectId}/skill-clusters/${clusterId}/ai/${step}`, runBody(locale, filters)),
    onSuccess: (result) => {
      queryClient.setQueryData<SkillClusterAiResults>(queryKeyOf(projectId, clusterId, locale), (old) => {
        const base: SkillClusterAiResults = old ?? { triage: null, skill: null };
        return step === "triage" ? { ...base, triage: result } : { ...base, skill: result };
      });
    },
  });
}

export function AiError({ error }: { error: unknown }) {
  const t = useTranslations("skills.ai");
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

export function RunButton({
  pending,
  hasResult,
  label,
  onClick,
}: {
  pending: boolean;
  hasResult: boolean;
  label: string;
  onClick: () => void;
}) {
  const t = useTranslations("skills.ai");
  return (
    <Button
      variant={hasResult ? "outline" : "default"}
      size="sm"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={onClick}
    >
      {pending ? (
        <Loader2Icon data-icon="inline-start" className="animate-spin" />
      ) : hasResult ? (
        <RotateCcwIcon data-icon="inline-start" />
      ) : (
        <SparklesIcon data-icon="inline-start" />
      )}
      {pending ? t("running") : hasResult ? t("redo", { action: label }) : label}
    </Button>
  );
}

const VERDICT_CLASS: Record<SkillTriageResult["verdict"], string> = {
  strong: "border-emerald-500 text-emerald-700 dark:text-emerald-400",
  maybe: "border-amber-500 text-amber-700 dark:text-amber-400",
  skip: "text-muted-foreground",
};

function TriageView({ result }: { result: SkillTriageResult }) {
  const t = useTranslations("skills.ai");
  return (
    <div className="bg-background flex flex-col gap-2 rounded-md border p-3" data-testid="skill-triage">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={VERDICT_CLASS[result.verdict] ?? ""}>
          {t.has(`verdict.${result.verdict}`) ? t(`verdict.${result.verdict}`) : result.verdict}
        </Badge>
        <code className="bg-muted rounded px-1.5 py-0.5 text-xs break-all">{result.suggestedName}</code>
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{result.reason}</p>
      <p className="text-muted-foreground text-sm break-words">{result.summary}</p>
    </div>
  );
}

function SkillView({ result }: { result: SkillContentResult }) {
  const t = useTranslations("skills.ai");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "SKILL.md";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-background flex flex-col gap-2 rounded-md border p-3" data-testid="skill-content">
      <div className="flex flex-wrap items-center gap-2">
        <code className="bg-muted rounded px-1.5 py-0.5 text-xs break-all">{result.name}</code>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? t("copied") : t("copy")}
        </Button>
        <Button variant="outline" size="sm" onClick={download}>
          <DownloadIcon data-icon="inline-start" />
          {t("download")}
        </Button>
      </div>
      <pre className="bg-muted max-h-80 overflow-auto rounded p-2 text-xs break-words whitespace-pre-wrap">
        {result.markdown}
      </pre>
      <p className="text-muted-foreground text-xs">{t("skillHint")}</p>
    </div>
  );
}

/**
 * Hai nút AI của một cụm (M6.12): "Đánh giá" (S1) và "Soạn SKILL.md" (S2), bằng key của chính người xem.
 * Ẩn nút khi chưa có key; kết quả chỉ người bấm thấy. Chỉ gắn khi cụm được mở rộng nên không tốn request thừa.
 */
export function ClusterAi({
  projectId,
  clusterId,
  filters,
}: {
  projectId: string;
  clusterId: string;
  filters: ClusterFilters;
}) {
  const t = useTranslations("skills.ai");
  const locale: AiLocale = useLocale() === "en" ? "en" : "vi";
  const keyStatus = useLlmKeyStatus();
  const hasKey = keyStatus.data?.hasKey === true;
  const results = useQuery({
    queryKey: queryKeyOf(projectId, clusterId, locale),
    queryFn: () =>
      api.get<SkillClusterAiResults>(`/projects/${projectId}/skill-clusters/${clusterId}/ai?locale=${locale}`),
    enabled: hasKey,
    retry: false,
    staleTime: 60_000,
  });
  const triage = useRun(projectId, clusterId, filters, "triage");
  const skill = useRun(projectId, clusterId, filters, "skill");
  if (!keyStatus.data) return null;

  if (!hasKey) {
    return (
      <p className="text-muted-foreground mt-3 text-sm">
        <Link href="/settings/ai" className="text-primary underline underline-offset-4">
          {t("addKey")}
        </Link>
      </p>
    );
  }

  const triageResult = results.data?.triage ?? null;
  const skillResult = results.data?.skill ?? null;
  return (
    <div className="mt-4 flex flex-col gap-3" data-testid="cluster-ai">
      <div className="flex flex-wrap gap-2">
        <RunButton
          pending={triage.isPending}
          hasResult={triageResult !== null}
          label={t("triage")}
          onClick={() => triage.mutate()}
        />
        <RunButton
          pending={skill.isPending}
          hasResult={skillResult !== null}
          label={t("generate")}
          onClick={() => skill.mutate()}
        />
      </div>
      <p className="text-muted-foreground text-xs">{t("privateNote")}</p>
      {triage.isError && <AiError error={triage.error} />}
      {skill.isError && <AiError error={skill.error} />}
      {triageResult && <TriageView result={triageResult.result as unknown as SkillTriageResult} />}
      {skillResult && <SkillView result={skillResult.result as unknown as SkillContentResult} />}
    </div>
  );
}
