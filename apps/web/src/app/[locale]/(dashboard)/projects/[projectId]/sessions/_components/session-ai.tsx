"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiResult,
  FindingExplainResult,
  LlmKey,
  SessionAiResults,
  SessionOutcomeResult,
  SessionSummaryResult,
} from "@teamlens/schema";
import { AlertCircleIcon, LightbulbIcon, Loader2Icon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { api, ApiError } from "@/lib/api/client";

type AiLocale = "vi" | "en";
type TurnRef = { seq: number; note: string };

/** Key AI của người xem (chỉ đọc, trang Cài đặt AI quản lý). Lỗi thì `undefined` để ẩn thẻ AI. */
export function useLlmKeyStatus() {
  return useQuery({
    queryKey: ["me", "llm-key"],
    queryFn: async () => {
      const body = await api.get<{ key?: LlmKey | null }>("/me/llm-key");
      return { hasKey: Boolean(body && typeof body === "object" && body.key) };
    },
    retry: false,
    staleTime: 60_000,
  });
}

function useAiLocale(): AiLocale {
  return useLocale() === "en" ? "en" : "vi";
}

const aiQueryKey = (sessionId: string, locale: AiLocale) => ["sessions", sessionId, "ai", locale] as const;

/** Kết quả AI đã lưu của chính người xem cho session (và các finding), theo ngôn ngữ giao diện. */
export function useSessionAi(sessionId: string, enabled: boolean) {
  const locale = useAiLocale();
  return useQuery({
    queryKey: aiQueryKey(sessionId, locale),
    queryFn: () => api.get<SessionAiResults>(`/sessions/${sessionId}/ai?locale=${locale}`),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

type RunTarget = { kind: "summary" } | { kind: "outcome" } | { kind: "explain"; findingId: string };

/** Chạy một nút AI rồi ghi đè kết quả vào cache của `GET .../ai`. */
function useRunAi(sessionId: string, target: RunTarget) {
  const locale = useAiLocale();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const path =
        target.kind === "explain"
          ? `/findings/${target.findingId}/ai/explain`
          : `/sessions/${sessionId}/ai/${target.kind}`;
      return api.post<AiResult>(path, { locale });
    },
    onSuccess: (result) => {
      queryClient.setQueryData<SessionAiResults>(aiQueryKey(sessionId, locale), (old) => {
        const base: SessionAiResults = old ?? { summary: null, outcome: null, findingExplains: [] };
        if (result.kind === "session_summary") return { ...base, summary: result };
        if (result.kind === "session_outcome") return { ...base, outcome: result };
        return {
          ...base,
          findingExplains: [...base.findingExplains.filter((r) => r.subjectId !== result.subjectId), result],
        };
      });
    },
  });
}

/** Thông báo lỗi dễ hiểu theo mã `llm_*`; lỗi về key gợi ý vào Cài đặt AI. */
function AiError({ error }: { error: unknown }) {
  const t = useTranslations("sessions.ai");
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

function TurnLinks({ refs }: { refs: TurnRef[] }) {
  const t = useTranslations("sessions.ai");
  if (refs.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {refs.map((ref, i) => (
        <li key={`${ref.seq}-${i}`} className="flex gap-2 text-sm">
          <a
            href={`#turn-${ref.seq}`}
            className="text-primary shrink-0 font-mono text-xs leading-5 underline-offset-4 hover:underline"
          >
            {t("turn", { seq: ref.seq })}
          </a>
          <span className="min-w-0 break-words">{ref.note}</span>
        </li>
      ))}
    </ul>
  );
}

/** Ghi chú cuối kết quả: chỉ người xem thấy, model và thời điểm tạo. */
function ResultFooter({ result }: { result: AiResult }) {
  const t = useTranslations("sessions.ai");
  const format = useFormatter();
  return (
    <p className="text-muted-foreground text-xs">
      {t("privateNote")} · {result.model} ·{" "}
      <time dateTime={result.createdAt}>
        {format.dateTime(new Date(result.createdAt), { dateStyle: "short", timeStyle: "short" })}
      </time>
    </p>
  );
}

function RunButton({
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
  const t = useTranslations("sessions.ai");
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

function SummaryView({ result }: { result: AiResult }) {
  const t = useTranslations("sessions.ai");
  const r = result.result as unknown as SessionSummaryResult;
  return (
    <div className="flex flex-col gap-3" data-testid="ai-summary">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold break-words">{r.title}</h3>
        <Badge variant="outline">{t(`workType.${r.workType}`)}</Badge>
      </div>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{r.summary}</p>
      {r.outcome && (
        <p className="text-sm break-words">
          <span className="text-muted-foreground">{t("outcomeLabel")}: </span>
          {r.outcome}
        </p>
      )}
      {r.filesTouched.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{t("filesTouched")}</span>
          <ul className="flex flex-wrap gap-1">
            {r.filesTouched.map((file) => (
              <li key={file}>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs break-all">{file}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.keyTurns.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{t("keyTurns")}</span>
          <TurnLinks refs={r.keyTurns} />
        </div>
      )}
      <ResultFooter result={result} />
    </div>
  );
}

const STATUS_CLASS: Record<SessionOutcomeResult["status"], string> = {
  completed: "border-emerald-500 text-emerald-700 dark:text-emerald-400",
  abandoned: "border-amber-500 text-amber-700 dark:text-amber-400",
  stuck_loop: "border-destructive text-destructive",
  unclear: "",
};

function OutcomeView({ result }: { result: AiResult }) {
  const t = useTranslations("sessions.ai");
  const r = result.result as unknown as SessionOutcomeResult;
  return (
    <div className="flex flex-col gap-3" data-testid="ai-outcome">
      <div>
        <Badge variant="outline" className={STATUS_CLASS[r.status] ?? ""}>
          {t.has(`status.${r.status}`) ? t(`status.${r.status}`) : r.status}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{r.explanation}</p>
      {r.evidence.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{t("evidence")}</span>
          <TurnLinks refs={r.evidence} />
        </div>
      )}
      <ResultFooter result={result} />
    </div>
  );
}

function AiSection({
  sessionId,
  kind,
  label,
  result,
}: {
  sessionId: string;
  kind: "summary" | "outcome";
  label: string;
  result: AiResult | null;
}) {
  const run = useRunAi(sessionId, { kind });
  return (
    <section className="flex flex-col gap-3">
      <div>
        <RunButton pending={run.isPending} hasResult={result !== null} label={label} onClick={() => run.mutate()} />
      </div>
      {run.isError && <AiError error={run.error} />}
      {result && (kind === "summary" ? <SummaryView result={result} /> : <OutcomeView result={result} />)}
    </section>
  );
}

/** Thẻ "AI" trên trang session: A1 tóm tắt, A5 đánh giá kết quả, bằng key của chính người xem. */
export function SessionAiCard({ sessionId }: { sessionId: string }) {
  const t = useTranslations("sessions.ai");
  const keyStatus = useLlmKeyStatus();
  const hasKey = keyStatus.data?.hasKey === true;
  const results = useSessionAi(sessionId, hasKey);
  if (!keyStatus.data) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4" />
          {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!hasKey ? (
          <p className="text-muted-foreground text-sm">
            <Link href="/settings/ai" className="text-primary underline underline-offset-4">
              {t("addKey")}
            </Link>
          </p>
        ) : (
          <>
            <AiSection
              sessionId={sessionId}
              kind="summary"
              label={t("summarize")}
              result={results.data?.summary ?? null}
            />
            <AiSection
              sessionId={sessionId}
              kind="outcome"
              label={t("evaluate")}
              result={results.data?.outcome ?? null}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Nút "Giải thích" (A4) cho một finding và kết quả ngay bên dưới. Ẩn khi người xem chưa có key. */
export function FindingExplain({ sessionId, findingId }: { sessionId: string; findingId: string }) {
  const t = useTranslations("sessions.ai");
  const keyStatus = useLlmKeyStatus();
  const hasKey = keyStatus.data?.hasKey === true;
  const results = useSessionAi(sessionId, hasKey);
  const run = useRunAi(sessionId, { kind: "explain", findingId });
  if (!hasKey) return null;
  const result = results.data?.findingExplains.find((r) => r.subjectId === findingId) ?? null;
  const r = result ? (result.result as unknown as FindingExplainResult) : null;

  return (
    <div className="flex w-full flex-col gap-2">
      <div>
        <RunButton pending={run.isPending} hasResult={result !== null} label={t("explain")} onClick={() => run.mutate()} />
      </div>
      {run.isError && <AiError error={run.error} />}
      {result && r && (
        <div className="bg-muted/40 flex flex-col gap-2 rounded-md border p-3" data-testid="ai-explain">
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{r.why}</p>
          <p className="flex gap-2 text-sm break-words">
            <LightbulbIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <span className="min-w-0 whitespace-pre-wrap">{r.advice}</span>
          </p>
          <TurnLinks refs={r.turns} />
          <ResultFooter result={result} />
        </div>
      )}
    </div>
  );
}
