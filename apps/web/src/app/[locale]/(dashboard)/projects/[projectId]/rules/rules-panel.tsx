"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { ProjectRule, RuleRerunAccepted, RuleRerunStatus, RuleTestResult } from "@/lib/api/types";

const statusActive = (status: RuleRerunStatus | null | undefined) => status?.status === "queued" || status?.status === "running";

export function RulesPanel({ projectId }: { projectId: string }) {
  const t = useTranslations("rules");
  const client = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [trial, setTrial] = useState<RuleTestResult | null>(null);
  const rules = useQuery({ queryKey: ["rules", projectId], queryFn: () => api.get<ProjectRule[]>(`/projects/${projectId}/rules`) });
  const rerun = useQuery({
    queryKey: ["rules-rerun", projectId],
    queryFn: () => api.get<RuleRerunStatus | null>(`/projects/${projectId}/rules/rerun/status`),
    refetchInterval: (query) => statusActive(query.state.data) ? 1000 : false,
  });
  const selected = rules.data?.find((item) => item.key === selectedKey) ?? rules.data?.[0];

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["rules", projectId] }),
      client.invalidateQueries({ queryKey: ["rules-rerun", projectId] }),
    ]);
  }

  async function run() {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.post<RuleRerunAccepted>(`/projects/${projectId}/rules/rerun`);
      setNotice(t("queued"));
      await refresh();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "rescore_in_progress" ? t("alreadyRunning") : cause instanceof Error ? cause.message : t("error"));
    } finally { setBusy(false); }
  }

  async function restore() {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.delete<RuleRerunAccepted>(`/projects/${projectId}/rules/${selected.key}/override`);
      setNotice(t("restoredQueued"));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error"));
    } finally { setBusy(false); }
  }

  async function testRule() {
    if (!selected) return;
    setBusy(true); setError(""); setTrial(null);
    try { setTrial(await api.post<RuleTestResult>(`/projects/${projectId}/rules/${selected.key}/test`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("error")); }
    finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div><p className="font-medium">{t("rescoreTitle")}</p>
        <p className="text-muted-foreground text-sm">{rerun.data ? t(`statuses.${rerun.data.status}`) + ` · ${rerun.data.processedSessions}/${rerun.data.totalSessions}` : t("neverRun")}</p>
        {rerun.data?.errorCode && <p className="text-destructive text-sm">{rerun.data.errorCode}</p>}
      </div>
      <button className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm disabled:opacity-50" disabled={busy || statusActive(rerun.data)} onClick={() => void run()}>{t("rerun")}</button>
    </div>
    {notice && <p className="text-sm" role="status">{notice}</p>}
    {rerun.data?.status === "succeeded" && <p className="text-sm" role="status">{t("finished")}</p>}
    {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
    {rules.isPending && <p>{t("loading")}</p>}
    {rules.error && <p className="text-destructive">{rules.error.message}</p>}
    {rules.data && <div className="grid gap-5 lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
      <div className="max-h-[36rem] overflow-auto rounded-lg border">
        {rules.data.map((rule) => <button key={rule.key} type="button" onClick={() => { setSelectedKey(rule.key); setTrial(null); setNotice(""); }}
          className={`flex w-full items-center justify-between gap-2 border-b px-4 py-3 text-left text-sm last:border-b-0 ${selected?.key === rule.key ? "bg-muted" : "hover:bg-muted/50"}`}>
          <span><span className="block font-medium">{rule.key}</span><span className="text-muted-foreground">{rule.category} · {rule.severity}</span></span>
          <span className="text-muted-foreground">{rule.enabled ? t("on") : t("off")}</span>
        </button>)}
      </div>
      {selected && <div className="space-y-4 rounded-lg border p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{selected.key}</h2>
          <p className="text-muted-foreground text-sm">{selected.scope} · {t(selected.source === "project" ? "projectOverride" : "serverDefault")} · v{selected.version}</p></div>
          {selected.needsRerun && <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">{t("needsRerun")}</span>}
        </div>
        <RuleEditor key={`${selected.key}/${selected.version}`} rule={selected} projectId={projectId} onSaved={refresh} />
        <div className="flex flex-wrap gap-2">
          <button className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => void testRule()}>{t("try50")}</button>
          {selected.source === "project" && <button className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || statusActive(rerun.data)} onClick={() => void restore()}>{t("restore")}</button>}
        </div>
        {trial && <div className="rounded-lg bg-muted/50 p-4 text-sm"><p>{t("trialResult", { matched: trial.matchedSessions, total: trial.sampledSessions })}</p>
          {trial.approximate && <p className="text-muted-foreground">{t("approximate")}</p>}
          {trial.examples.map((item) => <p key={`${item.sessionId}/${item.turnSeq}`} className="mt-2 break-all">{item.sessionId} · turn {item.turnSeq ?? "—"}{item.excerpt ? ` · ${item.excerpt}` : ""}</p>)}
        </div>}
        <details><summary className="cursor-pointer text-sm">{t("viewJson")}</summary><pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(selected.definition, null, 2)}</pre></details>
      </div>}
    </div>}
  </div>;
}

function RuleEditor({ rule, projectId, onSaved }: { rule: ProjectRule; projectId: string; onSaved: () => Promise<void> }) {
  const t = useTranslations("rules");
  const [enabled, setEnabled] = useState(rule.enabled);
  const [severity, setSeverity] = useState(rule.severity);
  const [thresholds, setThresholds] = useState(JSON.stringify(rule.thresholds, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setError(""); setSaving(true);
    try {
      const parsed: unknown = JSON.parse(thresholds);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("invalidJson"));
      await api.patch<ProjectRule>(`/projects/${projectId}/rules/${rule.key}`, { enabled, severity, thresholds: parsed });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("error")); }
    finally { setSaving(false); }
  }
  return <div className="space-y-3">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("enabled")}</label>
    <label className="block text-sm">{t("severity")}
      <select className="border-input bg-background mt-1 block rounded-md border px-3 py-2" value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}>
        <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
      </select>
    </label>
    <label className="block text-sm">{t("thresholds")}
      <textarea className="border-input bg-background mt-1 block min-h-32 w-full rounded-md border p-3 font-mono text-xs" value={thresholds} onChange={(event) => setThresholds(event.target.value)} />
    </label>
    {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
    <button className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm disabled:opacity-50" disabled={saving} onClick={() => void save()}>{saving ? t("saving") : t("save")}</button>
  </div>;
}
