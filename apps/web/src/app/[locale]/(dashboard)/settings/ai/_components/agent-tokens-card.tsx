"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { CopyField } from "@/components/copy-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentToken,
  type CreatedAgentToken,
  useAgentTokens,
  useCreateAgentToken,
  useRevokeAgentToken,
} from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { useErrorMessage } from "./error-message";

/** Lệnh mẫu thêm MCP của TeamLens vào Claude Code bằng token vừa tạo. */
export function claudeMcpCommand(origin: string, secret: string): string {
  return `claude mcp add --transport http teamlens ${origin}/api/v1/mcp --header "Authorization: Bearer ${secret}"`;
}

/** Thẻ "Token cho agent": tạo token `tlp_` (hiện một lần), danh sách, thu hồi. */
export function AgentTokensCard() {
  const t = useTranslations("aiSettings.tokens");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const tokens = useAgentTokens();
  const create = useCreateAgentToken();
  const revoke = useRevokeAgentToken();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  const [toRevoke, setToRevoke] = useState<AgentToken | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (res) => {
        setCreated(res);
        setName("");
      },
    });
  }

  const date = (value: string) =>
    format.dateTime(new Date(value), { dateStyle: "short", timeStyle: "short" });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onCreate}>
          <fieldset disabled={create.isPending} className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-0 flex-[1_1_14rem] gap-1 text-sm font-medium">
              {t("name")}
              <Input
                name="name"
                required
                maxLength={100}
                placeholder={t("namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Button type="submit">{create.isPending ? t("creating") : t("create")}</Button>
          </fieldset>
          {create.error && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              {errorMessage(create.error)}
            </p>
          )}
        </form>

        {created && (
          <div className="space-y-3 rounded-lg border border-primary/40 p-3">
            <h3 className="font-semibold">{t("createdTitle", { name: created.token.name })}</h3>
            <Alert>
              <AlertDescription>{t("onlyOnce")}</AlertDescription>
            </Alert>
            <CopyField label={t("secret")} value={created.secret} />
            <CopyField
              label={t("command")}
              value={claudeMcpCommand(window.location.origin, created.secret)}
            />
            <Button variant="outline" size="sm" onClick={() => setCreated(null)}>
              {t("dismiss")}
            </Button>
          </div>
        )}

        {tokens.isPending && <Skeleton className="h-12 w-full" />}
        {tokens.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("loadError")}
          </p>
        )}
        {tokens.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
        {revoke.error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(revoke.error)}
          </p>
        )}
        {tokens.data && tokens.data.length > 0 && (
          <ul aria-label={t("title")}>
            {tokens.data.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-center justify-between gap-3 border-t py-3"
              >
                <div className="min-w-0 space-y-0.5 text-sm">
                  <p className="font-medium break-words">{token.name}</p>
                  <p className="text-muted-foreground">
                    {t("createdAt", { date: date(token.createdAt) })}
                    {" · "}
                    {token.lastUsedAt
                      ? t("lastUsedAt", { date: date(token.lastUsedAt) })
                      : t("neverUsed")}
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => {
                    setToRevoke(token);
                    setConfirmOpen(true);
                  }}
                  aria-label={`${t("revoke")}: ${token.name}`}
                >
                  {t("revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={t("confirmRevokeTitle", { name: toRevoke?.name ?? "" })}
          description={t("confirmRevokeBody")}
          confirmLabel={t("confirmRevoke")}
          onConfirm={() => {
            if (!toRevoke) return;
            revoke.mutate(toRevoke.id, { onSuccess: () => toast.success(t("revoked")) });
          }}
        />
      </CardContent>
    </Card>
  );
}
