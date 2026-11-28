"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { RedactionPattern, ServerSettings } from "@/lib/api/types";

const inputClass = "h-9 rounded-md border bg-background px-2";
const buttonClass = "bg-primary text-primary-foreground h-9 rounded-md px-4 disabled:opacity-50";
const MAX_PATTERNS = 50;

function errorText(cause: unknown, fallback: string, t: (key: string) => string) {
  if (cause instanceof ApiError) {
    if (cause.code === "consent_version_conflict") return t("settingsConflict");
    if (cause.code === "pattern_invalid") return `${t("settingsPatternInvalid")} ${cause.message}`;
    return cause.message;
  }
  return fallback;
}

export function SettingsPanel() {
  const t = useTranslations("admin");
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["server-settings"], queryFn: () => api.get<ServerSettings>("/admin/settings") });
  if (query.isPending) return <p className="text-muted-foreground text-sm">{t("settingsLoading")}</p>;
  if (query.error || !query.data) return <p className="text-destructive text-sm" role="alert">{query.error?.message}</p>;
  // `key` buộc form nạp lại giá trị sau mỗi lần lưu thành công (phiên bản đồng ý mới).
  return (
    <div className="space-y-8">
      <RedactionSection key={`r-${JSON.stringify(query.data.redactionPatterns)}`} settings={query.data} onSaved={() => client.invalidateQueries({ queryKey: ["server-settings"] })} />
      <RetentionSection key={`t-${query.data.retentionDays}`} settings={query.data} onSaved={() => client.invalidateQueries({ queryKey: ["server-settings"] })} />
      <ConsentSection key={`c-${query.data.consentText.version}`} settings={query.data} onSaved={() => client.invalidateQueries({ queryKey: ["server-settings"] })} />
    </div>
  );
}

type SectionProps = { settings: ServerSettings; onSaved: () => Promise<unknown> };

function RedactionSection({ settings, onSaved }: SectionProps) {
  const t = useTranslations("admin");
  const [items, setItems] = useState<RedactionPattern[]>(settings.redactionPatterns);
  const [sample, setSample] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const update = (index: number, patch: Partial<RedactionPattern>) =>
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  async function test(item: RedactionPattern) {
    setError("");
    try {
      const res = await api.post<{ matches: number; redacted: string }>("/admin/settings/redaction-test", { id: item.id || "test", regex: item.regex, sample });
      setResults({ ...results, [item.id]: `${t("settingsMatches", { count: res.matches })}: ${res.redacted}` });
    } catch (cause) {
      setError(errorText(cause, t("settingsError"), t));
    }
  }

  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const redactionPatterns = items.map(({ id, name, description, regex }) => ({ id, name, regex, ...(description ? { description } : {}) }));
      await api.patch("/admin/settings", { redactionPatterns });
      setMessage(t("saved"));
      await onSaved();
    } catch (cause) {
      setError(errorText(cause, t("settingsError"), t));
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-3" aria-labelledby="settings-redaction">
      <h2 id="settings-redaction" className="text-lg font-semibold">{t("settingsRedaction")}</h2>
      <p className="text-muted-foreground text-sm">{t("settingsRedactionHelp")}</p>
      <label className="grid gap-1 text-sm">{t("settingsSample")}
        <textarea className="min-h-16 rounded-md border bg-background p-2" maxLength={4096} value={sample} onChange={(event) => setSample(event.target.value)} />
      </label>
      {items.map((item, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1">{t("settingsPatternId")}<input className={inputClass} value={item.id} pattern="[a-z0-9_]+" onChange={(event) => update(index, { id: event.target.value })} /></label>
            <label className="grid gap-1">{t("name")}<input className={inputClass} maxLength={100} value={item.name} onChange={(event) => update(index, { name: event.target.value })} /></label>
          </div>
          <label className="grid gap-1">{t("settingsPatternDescription")}<input className={inputClass} value={item.description ?? ""} onChange={(event) => update(index, { description: event.target.value })} /></label>
          <label className="grid gap-1">{t("settingsPatternRegex")}<input className={`${inputClass} font-mono`} value={item.regex} onChange={(event) => update(index, { regex: event.target.value })} /></label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="rounded-md border px-3 py-1.5" disabled={!item.regex || !sample} onClick={() => test(item)}>{t("settingsTest")}</button>
            <button type="button" className="rounded-md border px-3 py-1.5" onClick={() => setItems(items.filter((_, i) => i !== index))}>{t("settingsRemove")}</button>
            {results[item.id] && <span className="text-muted-foreground break-all">{results[item.id]}</span>}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-md border px-3 py-2 text-sm" disabled={items.length >= MAX_PATTERNS} onClick={() => setItems([...items, { id: "", name: "", regex: "" }])}>{t("settingsAddPattern")}</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={save}>{t("settingsSave")}</button>
      </div>
      <p className="text-muted-foreground text-xs">{t("settingsRedactionNote")}</p>
      {message && <p className="text-sm" role="status">{message}</p>}
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
    </section>
  );
}

function RetentionSection({ settings, onSaved }: SectionProps) {
  const t = useTranslations("admin");
  const [forever, setForever] = useState(settings.retentionDays === null);
  const [days, setDays] = useState(String(settings.retentionDays ?? 90));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const value = Number(days);
  const valid = forever || (Number.isInteger(value) && value >= 7 && value <= 730);

  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      await api.patch("/admin/settings", { retentionDays: forever ? null : value });
      setMessage(t("saved"));
      await onSaved();
    } catch (cause) {
      setError(errorText(cause, t("settingsError"), t));
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-3" aria-labelledby="settings-retention">
      <h2 id="settings-retention" className="text-lg font-semibold">{t("settingsRetention")}</h2>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={forever} onChange={(event) => setForever(event.target.checked)} />{t("settingsForever")}</label>
      {!forever && (
        <label className="grid max-w-48 gap-1 text-sm">{t("settingsDays")}
          <input className={inputClass} type="number" min={7} max={730} value={days} onChange={(event) => setDays(event.target.value)} />
        </label>
      )}
      {!valid && <p className="text-destructive text-sm" role="alert">{t("settingsDaysRange")}</p>}
      <p className="text-muted-foreground text-xs">{t("settingsRetentionNote")}</p>
      <button type="button" className={buttonClass} disabled={busy || !valid} onClick={save}>{t("settingsSave")}</button>
      {message && <p className="text-sm" role="status">{message}</p>}
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
    </section>
  );
}

function ConsentSection({ settings, onSaved }: SectionProps) {
  const t = useTranslations("admin");
  const [text, setText] = useState(settings.consentText.text);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const changed = text !== settings.consentText.text;

  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      await api.patch("/admin/settings", { consentText: text, expectedConsentVersion: settings.consentText.version });
      setMessage(t("saved"));
      setConfirming(false);
      await onSaved();
    } catch (cause) {
      setConfirming(false);
      setError(errorText(cause, t("settingsError"), t));
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-3" aria-labelledby="settings-consent">
      <h2 id="settings-consent" className="text-lg font-semibold">{t("settingsConsent")}</h2>
      <p className="text-muted-foreground text-sm">{t("settingsConsentVersion", { version: settings.consentText.version })}</p>
      <textarea className="min-h-48 w-full rounded-md border bg-background p-2 text-sm" aria-label={t("settingsConsent")} value={text} onChange={(event) => { setText(event.target.value); setConfirming(false); }} />
      {!confirming ? (
        <button type="button" className={buttonClass} disabled={!changed || !text.trim()} onClick={() => setConfirming(true)}>{t("settingsSave")}</button>
      ) : (
        <div className="space-y-2 rounded-md border border-destructive p-3 text-sm" role="alertdialog" aria-label={t("settingsConsentConfirmTitle")}>
          <p className="font-medium">{t("settingsConsentConfirmTitle")}</p>
          <p>{t("settingsConsentConfirm", { count: settings.affectedDevices })}</p>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={save}>{t("settingsConsentConfirmYes")}</button>
            <button type="button" className="rounded-md border px-3 py-2" onClick={() => setConfirming(false)}>{t("settingsCancel")}</button>
          </div>
        </div>
      )}
      {message && <p className="text-sm" role="status">{message}</p>}
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
    </section>
  );
}