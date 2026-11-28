"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "@/lib/api/client";
import type { Device, MyConsent, SessionViewPage } from "@/lib/api/types";

export function MyDataPanel({ name, role }: { name: string; role: "leader" | "member" }) {
  const t = useTranslations("me");
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<SessionViewPage["items"]>([]);
  const devices = useQuery({ queryKey: ["my-devices"], queryFn: () => api.get<Device[]>("/devices") });
  const consents = useQuery({ queryKey: ["my-consents"], queryFn: () => api.get<MyConsent[]>("/me/consents") });
  const views = useQuery({
    queryKey: ["my-session-views", cursor],
    queryFn: () => api.get<SessionViewPage>(`/me/session-views?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  });
  const allViews = cursor ? [...pages, ...(views.data?.items ?? [])] : (views.data?.items ?? []);
  const date = (value: string) => new Date(value).toLocaleString();
  return <div className="space-y-6">
    <section className="rounded-xl border p-5"><h2 className="text-lg font-semibold">{name}</h2><p className="text-muted-foreground text-sm">{role === "leader" ? t("leader") : t("member")}</p></section>
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border p-5"><h2 className="text-lg font-semibold">{t("devices")}</h2>
        {devices.isPending && <p className="text-muted-foreground mt-3 text-sm">{t("loading")}</p>}
        {devices.error && <p className="text-destructive mt-3 text-sm">{devices.error.message}</p>}
        {devices.data?.length === 0 && <p className="text-muted-foreground mt-3 text-sm">{t("noDevices")}</p>}
        <ul className="mt-3 divide-y">{devices.data?.map((device) => <li key={device.id} className="py-3 text-sm"><strong>{device.name}</strong><p className="text-muted-foreground">{device.os} · {device.status} · {device.cliVersion}</p></li>)}</ul>
      </section>
      <section className="rounded-xl border p-5"><h2 className="text-lg font-semibold">{t("consents")}</h2>
        {consents.isPending && <p className="text-muted-foreground mt-3 text-sm">{t("loading")}</p>}
        {consents.error && <p className="text-destructive mt-3 text-sm">{consents.error.message}</p>}
        {consents.data?.length === 0 && <p className="text-muted-foreground mt-3 text-sm">{t("noConsents")}</p>}
        <ul className="mt-3 divide-y">{consents.data?.map((consent) => <li key={consent.id} className="py-3 text-sm"><strong>{consent.deviceName ?? t("removedDevice")}</strong>
          <p className="text-muted-foreground">v{consent.textVersion} · {date(consent.grantedAt)} · {consent.revokedAt ? t("revoked") : t("granted")}</p>
          <p className="text-muted-foreground">{consent.backfill ? t("backfillYes") : t("backfillNo")}</p></li>)}</ul>
      </section>
    </div>
    <section className="rounded-xl border p-5"><h2 className="text-lg font-semibold">{t("views")}</h2>
      {views.isPending && <p className="text-muted-foreground mt-3 text-sm">{t("loading")}</p>}
      {views.error && <p className="text-destructive mt-3 text-sm">{views.error.message}</p>}
      {allViews.length === 0 && !views.isPending && <p className="text-muted-foreground mt-3 text-sm">{t("noViews")}</p>}
      <ul className="mt-3 divide-y">{allViews.map((view) => <li key={view.id} className="py-3 text-sm"><strong>{view.actorName ?? t("deletedAccount")}</strong>
        <p className="text-muted-foreground">{date(view.at)} · {t("session")} {view.sessionId} ({date(view.sessionStartedAt)})</p></li>)}</ul>
      {views.data?.nextCursor && <button className="mt-3 rounded-md border px-3 py-2 text-sm" onClick={() => { setPages(allViews); setCursor(views.data!.nextCursor); }}>{t("more")}</button>}
    </section>
  </div>;
}
