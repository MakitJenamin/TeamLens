"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { CopyField } from "@/components/copy-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks";
import type { CreatedInvite, CreateInviteRequest, Invite, InviteStatus } from "@/lib/api/types";

const STATUS_VARIANT: Record<InviteStatus, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  expired: "secondary",
  used_up: "secondary",
  revoked: "destructive",
};

/**
 * Quản lý link mời chung của project (SPEC 7.1, J.7): danh sách, tạo link mới
 * (mã chỉ hiện một lần), thu hồi. Chỉ leader vào được trang Quản trị.
 */
export function InvitesPanel({ projectId }: { projectId: string }) {
  const t = useTranslations("admin.invites");
  const format = useFormatter();
  const client = useQueryClient();
  const path = `/projects/${projectId}/invites`;
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const invites = useQuery({
    queryKey: queryKeys.invites(projectId),
    queryFn: () => api.get<Invite[]>(path),
  });
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.invites(projectId) });

  const create = useMutation({
    mutationFn: (body: CreateInviteRequest) => api.post<CreatedInvite>(path, body),
    onSuccess: (res) => {
      setCreated(res);
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => api.delete<void>(`${path}/${inviteId}`),
    onSuccess: () => {
      toast.success(t("revoked"));
      void refresh();
    },
  });

  function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const days = Number(data.get("expiresInDays"));
    const maxUses = String(data.get("maxUses") ?? "").trim();
    create.mutate({
      expiresInDays: Number.isInteger(days) && days > 0 ? days : 7,
      maxUses: maxUses ? Number(maxUses) : null,
    });
  }

  const date = (value: string) =>
    format.dateTime(new Date(value), { dateStyle: "short", timeStyle: "short" });

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="invites-title">
      <h2 id="invites-title" className="text-lg font-semibold">
        {t("title")}
      </h2>

      <form onSubmit={onCreate}>
        <fieldset disabled={create.isPending} className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-[1_1_9rem] gap-1 text-sm font-medium">
            {t("expiresInDays")}
            <Input name="expiresInDays" type="number" min={1} max={30} defaultValue={7} required />
          </label>
          <label className="grid min-w-0 flex-[1_1_9rem] gap-1 text-sm font-medium">
            {t("maxUses")}
            <Input name="maxUses" type="number" min={1} max={1000} placeholder={t("maxUsesPlaceholder")} />
          </label>
          <Button type="submit">{t("create")}</Button>
        </fieldset>
        {create.error && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {create.error.message}
          </p>
        )}
      </form>

      {created && (
        <div className="space-y-3 rounded-lg border border-primary/40 p-3">
          <h3 className="font-semibold">{t("createdTitle")}</h3>
          <Alert>
            <AlertDescription>{t("onlyOnce")}</AlertDescription>
          </Alert>
          <CopyField label={t("url")} value={created.url} />
          <Button variant="outline" size="sm" onClick={() => setCreated(null)}>
            {t("dismiss")}
          </Button>
        </div>
      )}

      {invites.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      )}
      {revoke.error && (
        <p role="alert" className="text-sm text-destructive">
          {revoke.error.message}
        </p>
      )}
      <ul>
        {invites.data?.map((invite) => (
          <li
            key={invite.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t py-3"
          >
            <div className="min-w-0 space-y-1 text-sm">
              <Badge variant={STATUS_VARIANT[invite.status]}>{t(`status.${invite.status}`)}</Badge>
              <p className="text-muted-foreground">
                {t("expiresAt", { date: date(invite.expiresAt) })}
                {" · "}
                {invite.maxUses === null
                  ? t("usesUnlimited", { used: invite.usedCount })
                  : t("uses", { used: invite.usedCount, max: invite.maxUses })}
              </p>
            </div>
            {invite.status === "active" && (
              <Button
                variant="destructive"
                size="sm"
                disabled={revoke.isPending}
                onClick={() => {
                  if (window.confirm(t("confirmRevoke"))) revoke.mutate(invite.id);
                }}
              >
                {t("revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
