"use client";

import { CheckCircle2Icon, XCircleIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  type LlmKey,
  type LlmProvider,
  type PutLlmKeyRequest,
  useDeleteLlmKey,
  useLlmKey,
  useSaveLlmKey,
  useTestLlmKey,
} from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { useErrorMessage } from "./error-message";

const PROVIDERS: LlmProvider[] = ["anthropic", "openai_compatible"];

/** Gợi ý base URL cho OpenAI-compatible (datalist). */
export const BASE_URL_SUGGESTIONS = [
  "http://localhost:11434/v1",
  "https://api.openai.com/v1",
  "https://openrouter.ai/api/v1",
  "http://localhost:1234/v1",
];

/** Thẻ "API key của tôi": provider, base URL, model, key; Kiểm tra, Lưu, Xóa key. */
export function LlmKeyCard() {
  const t = useTranslations("aiSettings.llmKey");
  const key = useLlmKey();

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {key.isPending ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : key.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("loadError")}
          </p>
        ) : (
          // Đổi key (lưu/xóa) thì dựng lại form với giá trị mới.
          <LlmKeyForm key={key.data?.updatedAt ?? "none"} saved={key.data} />
        )}
      </CardContent>
    </Card>
  );
}

type Status = { kind: "ok"; message: string } | { kind: "error"; message: string } | null;

function LlmKeyForm({ saved }: { saved: LlmKey | null }) {
  const t = useTranslations("aiSettings.llmKey");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const id = useId();
  const [provider, setProvider] = useState<LlmProvider>(saved?.provider ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [model, setModel] = useState(saved?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const save = useSaveLlmKey();
  const test = useTestLlmKey();
  const remove = useDeleteLlmKey();
  const busy = save.isPending || test.isPending || remove.isPending;
  const isCompatible = provider === "openai_compatible";

  /**
   * Body chung cho Lưu và Kiểm tra. Ô key trống: đã có key thì giữ key cũ (bỏ trường);
   * chưa có key mà là OpenAI-compatible thì gửi chuỗi rỗng (Ollama không cần key).
   */
  function buildBody(): PutLlmKeyRequest | null {
    const trimmedKey = apiKey.trim();
    const body: PutLlmKeyRequest = {
      provider,
      baseUrl: isCompatible ? baseUrl.trim() : null,
      model: model.trim(),
    };
    if (trimmedKey) body.apiKey = trimmedKey;
    else if (!saved) {
      if (!isCompatible) {
        setStatus({ kind: "error", message: t("apiKeyRequired") });
        return null;
      }
      body.apiKey = "";
    }
    return body;
  }

  function onTest() {
    const body = buildBody();
    if (!body) return;
    setStatus(null);
    test.mutate(body, {
      onSuccess: (res) =>
        setStatus({
          kind: "ok",
          message: t("testOk", {
            model: res.model,
            provider: t(`providers.${res.provider}`),
            latency: res.latencyMs,
          }),
        }),
      onError: (error) => setStatus({ kind: "error", message: errorMessage(error) }),
    });
  }

  function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = buildBody();
    if (!body) return;
    setStatus(null);
    save.mutate(body, {
      onSuccess: () => toast.success(t("saved")),
      onError: (error) => setStatus({ kind: "error", message: errorMessage(error) }),
    });
  }

  function onDelete() {
    remove.mutate(undefined, {
      onSuccess: () => toast.success(t("deleted")),
      onError: (error) => setStatus({ kind: "error", message: errorMessage(error) }),
    });
  }

  const apiKeyHint = saved
    ? saved.keyHint
      ? t("apiKeySaved", { hint: saved.keyHint })
      : t("apiKeySavedNoHint")
    : isCompatible
      ? t("apiKeyOptional")
      : null;

  return (
    <form onSubmit={onSave} className="space-y-4">
      {!saved && <p className="text-sm text-muted-foreground">{t("notSaved")}</p>}

      <fieldset disabled={busy} className="space-y-4">
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{t("provider")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDERS.map((value) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-focus-visible:ring-2 has-focus-visible:ring-ring",
                  provider === value && "border-primary bg-primary/5",
                )}
              >
                <input
                  type="radio"
                  name="provider"
                  value={value}
                  checked={provider === value}
                  onChange={() => {
                    setProvider(value);
                    setStatus(null);
                  }}
                  className="mt-0.5 accent-primary"
                />
                <span className="grid content-start gap-0.5">
                  <span className="font-medium">{t(`providers.${value}`)}</span>
                  <span className="text-muted-foreground">{t(`providerHint.${value}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {isCompatible && (
          <label className="grid gap-1 text-sm font-medium">
            {t("baseUrl")}
            <Input
              name="baseUrl"
              type="url"
              required
              list={`${id}-base-urls`}
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <datalist id={`${id}-base-urls`}>
              {BASE_URL_SUGGESTIONS.map((url) => (
                <option key={url} value={url} />
              ))}
            </datalist>
            <span className="text-xs font-normal text-muted-foreground">{t("baseUrlHint")}</span>
          </label>
        )}

        <label className="grid gap-1 text-sm font-medium">
          {t("model")}
          <Input
            name="model"
            required
            placeholder={t(`modelPlaceholder.${provider}`)}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>

        <label className="grid gap-1 text-sm font-medium">
          {t("apiKey")}
          <Input
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={saved?.keyHint || undefined}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {apiKeyHint && <span className="text-xs font-normal text-muted-foreground">{apiKeyHint}</span>}
        </label>
      </fieldset>

      {status && (
        <p
          role={status.kind === "error" ? "alert" : "status"}
          className={cn(
            "flex items-start gap-2 text-sm",
            status.kind === "error" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400",
          )}
        >
          {status.kind === "error" ? (
            <XCircleIcon className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
          )}
          {status.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onTest}>
          {test.isPending ? t("testing") : t("test")}
        </Button>
        <Button type="submit" disabled={busy}>
          {save.isPending ? t("saving") : t("save")}
        </Button>
        {saved && (
          <Button
            type="button"
            variant="destructive"
            className="sm:ml-auto"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            {t("delete")}
          </Button>
        )}
      </div>
      {saved && (
        <p className="text-xs text-muted-foreground">
          {t("savedAt", {
            date: format.dateTime(new Date(saved.updatedAt), { dateStyle: "short", timeStyle: "short" }),
          })}
        </p>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirmDeleteTitle")}
        description={t("confirmDeleteBody")}
        confirmLabel={t("confirmDelete")}
        onConfirm={onDelete}
      />
    </form>
  );
}
