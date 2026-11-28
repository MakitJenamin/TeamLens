"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "@/lib/api/client";
import type { AuditPage } from "@/lib/api/types";

type Filters = { action: string; actorId: string; from: string; to: string };
const empty: Filters = { action: "", actorId: "", from: "", to: "" };

export function AuditPanel() {
  const t = useTranslations("admin");
  const [draft, setDraft] = useState<Filters>(empty);
  const [filters, setFilters] = useState<Filters>(empty);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<AuditPage["items"]>([]);
  const query = useQuery({
    queryKey: ["audit", filters, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);
      if (filters.action) params.set("action", filters.action);
      if (filters.actorId) params.set("actorId", filters.actorId);
      if (filters.from) params.set("from", new Date(filters.from).toISOString());
      if (filters.to) params.set("to", new Date(filters.to).toISOString());
      return api.get<AuditPage>(`/audit?${params}`);
    },
  });
  const rows = cursor ? [...previous, ...(query.data?.items ?? [])] : (query.data?.items ?? []);
  function apply() { setPrevious([]); setCursor(null); setFilters({ ...draft }); }
  return <section className="space-y-4 rounded-xl border p-5">
    <h2 className="text-lg font-semibold">{t("audit")}</h2>
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="grid gap-1">{t("auditAction")}<input className="h-9 rounded-md border bg-background px-2" value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} /></label>
      <label className="grid gap-1">{t("auditActor")}<input className="h-9 rounded-md border bg-background px-2" value={draft.actorId} onChange={(event) => setDraft({ ...draft, actorId: event.target.value })} placeholder="UUID" /></label>
      <label className="grid gap-1">{t("auditFrom")}<input className="h-9 rounded-md border bg-background px-2" type="datetime-local" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label className="grid gap-1">{t("auditTo")}<input className="h-9 rounded-md border bg-background px-2" type="datetime-local" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <button className="bg-primary text-primary-foreground h-9 rounded-md px-4" onClick={apply}>{t("auditFilter")}</button>
    </div>
    {query.isPending && <p className="text-muted-foreground text-sm">{t("auditLoading")}</p>}
    {query.error && <p className="text-destructive text-sm" role="alert">{query.error.message}</p>}
    {rows.length === 0 && !query.isPending && <p className="text-muted-foreground text-sm">{t("auditEmpty")}</p>}
    <div className="overflow-x-auto"><table className="w-full min-w-xl text-sm"><thead><tr className="border-b text-left"><th className="py-2 pr-3">{t("auditTime")}</th><th className="py-2 pr-3">{t("auditActor")}</th><th className="py-2 pr-3">{t("auditAction")}</th><th className="py-2">{t("auditTarget")}</th></tr></thead>
      <tbody>{rows.map((item) => <tr className="border-b" key={item.id}><td className="py-2 pr-3 whitespace-nowrap">{new Date(item.at).toLocaleString()}</td><td className="py-2 pr-3">{item.actorName ?? t("auditDeleted")}</td><td className="py-2 pr-3">{item.action}</td><td className="py-2 break-all">{item.targetType}: {item.targetId}</td></tr>)}</tbody></table></div>
    {query.data?.nextCursor && <button className="rounded-md border px-3 py-2 text-sm" onClick={() => { setPrevious(rows); setCursor(query.data!.nextCursor); }}>{t("auditMore")}</button>}
  </section>;
}
