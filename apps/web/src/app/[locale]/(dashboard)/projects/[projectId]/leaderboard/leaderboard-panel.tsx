"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { Leaderboard, Project } from "@/lib/api/types";
import { leaderboardRange } from "./leaderboard-range";

const categories = ["overall", "prompt_quality", "context", "correction_loop", "session_management", "verification"] as const;

export function LeaderboardPanel({ projectId, isLeader }: { projectId: string; isLeader: boolean }) {
  const t = useTranslations("leaderboard");
  const [period, setPeriod] = useState<"week" | "month">("week");
  const [category, setCategory] = useState<(typeof categories)[number]>("overall");
  const [at, setAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const query = useQuery({
    queryKey: ["leaderboard", projectId, period, category, at],
    queryFn: () => api.get<Leaderboard>(`/projects/${projectId}/leaderboard?period=${period}&category=${category}${at ? `&at=${at}` : ""}`),
  });
  const data = query.data;

  async function setSetting(key: "leaderboardEnabled" | "leaderboardPublic", value: boolean) {
    setSaving(true);
    setSaveError("");
    try {
      await api.patch<Project>(`/projects/${projectId}`, { settings: { [key]: value } });
      await query.refetch();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("error"));
    } finally {
      setSaving(false);
    }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-sm"><span className="block">{t("period")}</span>
        <select className="border-input bg-background h-9 rounded-md border px-3" value={period} onChange={(event) => setPeriod(event.target.value as "week" | "month")}>
          <option value="week">{t("week")}</option><option value="month">{t("month")}</option>
        </select>
      </label>
      <label className="space-y-1 text-sm"><span className="block">{t("at")}</span>
        <input className="border-input bg-background h-9 rounded-md border px-3" type="date" value={at} onChange={(event) => setAt(event.target.value)} />
      </label>
      <label className="space-y-1 text-sm"><span className="block">{t("categoryLabel")}</span>
        <select className="border-input bg-background h-9 rounded-md border px-3" value={category} onChange={(event) => setCategory(event.target.value as typeof category)}>
          {categories.map((item) => <option key={item} value={item}>{t(`categories.${item}`)}</option>)}
        </select>
      </label>
    </div>

    {isLeader && data && <div className="border-border flex flex-wrap gap-6 rounded-lg border p-4 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={data.leaderboardEnabled} disabled={saving} onChange={(event) => void setSetting("leaderboardEnabled", event.target.checked)} />{t("enabled")}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={data.leaderboardPublic} disabled={saving} onChange={(event) => void setSetting("leaderboardPublic", event.target.checked)} />{t("public")}</label>
      <span className="text-muted-foreground">{data.leaderboardEnabled && data.leaderboardPublic ? t("memberVisible") : t("memberHidden")}</span>
    </div>}
    {saveError && <p className="text-destructive" role="alert">{saveError}</p>}
    {query.isPending && <p className="text-muted-foreground">{t("loading")}</p>}
    {query.error && <p className="text-destructive" role="alert">{query.error instanceof ApiError && query.error.code === "leaderboard_disabled" ? t("private") : query.error.message}</p>}
    {data && <>
      <p className="text-muted-foreground text-sm">{t("range", leaderboardRange(data.from, data.to))}</p>
      {!data.leaderboardEnabled ? <p>{t("disabled")}</p> : <>
        {data.sessionsNeeded > 0 && <p className="rounded-lg border p-4">{t("progress", { count: data.mySessions, needed: data.sessionsNeeded })}</p>}
        {data.entries.length === 0 ? <p className="rounded-lg border p-6 text-center">{t("empty")}</p> :
          <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-lg text-sm">
            <thead className="bg-muted/50"><tr><th className="px-4 py-3 text-left">{t("rank")}</th><th className="px-4 py-3 text-left">{t("member")}</th><th className="px-4 py-3 text-right">{t("sessions")}</th><th className="px-4 py-3 text-right">{t("score")}</th></tr></thead>
            <tbody>{data.entries.map((entry) => <tr key={entry.rank} className="border-t"><td className="px-4 py-3">{entry.rank}</td><td className="px-4 py-3">{entry.name ?? t("anonymous")}{entry.isSelf ? ` (${t("you")})` : ""}</td><td className="px-4 py-3 text-right">{entry.sessions}</td><td className="px-4 py-3 text-right font-medium">{category === "overall" ? entry.overall : entry.scores[category] ?? "—"}</td></tr>)}</tbody>
          </table></div>}
      </>}
    </>}
  </div>;
}
