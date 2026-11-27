"use client";

import { useQuery } from "@tanstack/react-query";
import type { SessionChild, SessionNote } from "@teamlens/schema";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FlagIcon,
  ScissorsIcon,
  ZapOffIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import type { SessionDetail, SessionTurn } from "@/lib/api/types";
import { placeChildSessions } from "./child-sessions";
import { DiffView } from "./diff-view";
import { FindingExplain, SessionAiCard } from "./session-ai";
import { parseFindings, sessionDuration, summarizeToolInput, type SessionFinding } from "./format";
import { groupNotes, type NoteViewer, TurnNotes, useSessionNotes } from "./session-notes";

/**
 * Finding của session (API của Người 2, contract M1.9). Lỗi, 404 hay dạng lạ đều trả null để ẩn khu vực,
 * không làm hỏng trang.
 */
function useSessionFindings(sessionId: string) {
  return useQuery({
    queryKey: ["sessions", sessionId, "findings"],
    queryFn: async () => {
      try {
        return parseFindings(await api.get<unknown>(`/sessions/${sessionId}/findings`));
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

/** Chi tiết session con khi mở khối lồng trong session cha. */
function useChildSession(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["sessions", sessionId],
    queryFn: () => api.get<SessionDetail>(`/sessions/${sessionId}`),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** Thông tin để gắn ghi chú vào turn; null với session con lồng trong trang cha (ghi chú xem ở trang riêng). */
interface NotesContext {
  sessionId: string;
  viewer: NoteViewer | null;
  byTurn: Map<number | null, SessionNote[]>;
}

export function SessionDetailView({ session, viewer = null }: { session: SessionDetail; viewer?: NoteViewer | null }) {
  const t = useTranslations("sessions");
  const findings = useSessionFindings(session.id).data ?? null;
  const findingsByTurn = new Map<number, SessionFinding[]>();
  for (const f of findings ?? []) {
    if (f.turnSeq === null) continue;
    findingsByTurn.set(f.turnSeq, [...(findingsByTurn.get(f.turnSeq) ?? []), f]);
  }
  const notesQuery = useSessionNotes(session.id);
  const notes: NotesContext = {
    sessionId: session.id,
    viewer,
    byTurn: groupNotes(notesQuery.data?.items ?? []),
  };
  const placement = placeChildSessions(session.turns, session.children);
  const sessionNotes = notes.byTurn.get(null) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
          nativeButton={false}
          render={<Link href={`/projects/${session.projectId}/sessions`} />}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          {t("detail.back")}
        </Button>
        <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">
          {session.title ?? t("detail.untitled")}
        </h1>
      </div>

      <SessionMeta session={session} />

      <SessionAiCard sessionId={session.id} />

      {findings && <FindingsPanel sessionId={session.id} findings={findings} />}

      {(sessionNotes.length > 0 || viewer?.isLeader) && (
        <Card>
          <CardHeader>
            <CardTitle>{t("notes.sessionTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TurnNotes sessionId={session.id} turnSeq={null} notes={sessionNotes} viewer={viewer} />
          </CardContent>
        </Card>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className="text-lg font-semibold">
          {t("detail.timeline")}
        </h2>
        {session.turns.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("detail.noTurns")}</p>
        ) : (
          <TurnTimeline
            projectId={session.projectId}
            turns={session.turns}
            findingsByTurn={findingsByTurn}
            childrenByTurn={placement.byTurn}
            notes={notes}
          />
        )}
      </section>

      {placement.unplaced.length > 0 && (
        <section id="child-sessions" className="flex scroll-mt-16 flex-col gap-3" aria-labelledby="children-heading">
          <h2 id="children-heading" className="text-lg font-semibold">
            {t("detail.childrenSection")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("detail.childrenUnplaced")}</p>
          {placement.unplaced.map((child) => (
            <ChildSessionBlock key={child.id} child={child} projectId={session.projectId} />
          ))}
        </section>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function SessionMeta({ session }: { session: SessionDetail }) {
  const t = useTranslations("sessions");
  const format = useFormatter();
  const duration = sessionDuration(session);
  const tokens = session.usage;

  return (
    <Card>
      <CardContent>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetaRow label={t("detail.meta.user")}>{session.user.name}</MetaRow>
          <MetaRow label={t("detail.meta.agent")}>
            {t(`agents.${session.agent}`)}
            {session.agentVersion && <span className="text-muted-foreground"> {session.agentVersion}</span>}
          </MetaRow>
          <MetaRow label={t("detail.meta.model")}>
            <span className="font-mono text-xs">{session.model ?? "—"}</span>
          </MetaRow>
          <MetaRow label={t("detail.meta.startedAt")}>
            {format.dateTime(new Date(session.startedAt), { dateStyle: "medium", timeStyle: "short" })}
          </MetaRow>
          <MetaRow label={t("detail.meta.repo")}>
            <span className="font-mono text-xs">{session.repoRemote}</span>
          </MetaRow>
          <MetaRow label={t("detail.meta.branch")}>
            <span className="font-mono text-xs">{session.branch ?? "—"}</span>
          </MetaRow>
          <MetaRow label={t("detail.meta.cwd")}>
            <span className="font-mono text-xs">
              {session.cwdRelative === null ? "—" : session.cwdRelative || t("detail.meta.cwdRoot")}
            </span>
          </MetaRow>
          <MetaRow label={t("detail.meta.duration")}>
            {duration ? t(`duration.${duration.key}`, duration.values) : t("list.running")}
          </MetaRow>
          <MetaRow label={t("detail.meta.turns")}>{session.turnCount}</MetaRow>
          <MetaRow label={t("detail.meta.tokens")}>
            {t("list.tokensDetail", {
              input: format.number(tokens.input),
              output: format.number(tokens.output),
              cacheRead: format.number(tokens.cacheRead),
              cacheWrite: format.number(tokens.cacheWrite),
            })}
          </MetaRow>
          {session.device && <MetaRow label={t("detail.meta.device")}>{session.device.name}</MetaRow>}
          {session.permissionMode && (
            <MetaRow label={t("detail.meta.permissionMode")}>
              <Badge variant={session.permissionMode === "bypass" ? "destructive" : "secondary"}>
                {t(`permissionModes.${session.permissionMode}`)}
              </Badge>
            </MetaRow>
          )}
          {session.instructionFiles && (
            <MetaRow label={t("detail.meta.instructionFiles")}>
              {session.instructionFiles.length === 0 ? (
                t("detail.meta.noInstructionFiles")
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {session.instructionFiles.map((f) => (
                    <li key={f.path} className="font-mono text-xs">
                      {f.path}{" "}
                      <span className="text-muted-foreground">({t("detail.meta.bytes", { bytes: format.number(f.bytes) })})</span>
                    </li>
                  ))}
                </ul>
              )}
            </MetaRow>
          )}
          {session.parentSessionId && (
            <MetaRow label={t("detail.meta.parent")}>
              <Link
                href={`/projects/${session.projectId}/sessions/${session.parentSessionId}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {t("detail.openParent")}
              </Link>
            </MetaRow>
          )}
          {session.children.length > 0 && (
            <MetaRow label={t("detail.meta.children")}>
              <ul className="flex flex-col gap-0.5">
                {session.children.map(({ id }, index) => (
                  <li key={id}>
                    <Link
                      href={`/projects/${session.projectId}/sessions/${id}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {t("detail.openChild", { index: index + 1 })}
                    </Link>
                  </li>
                ))}
              </ul>
            </MetaRow>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const t = useTranslations("sessions.findings");
  const key = `severity.${severity}`;
  const danger = severity === "high" || severity === "critical";
  return <Badge variant={danger ? "destructive" : "outline"}>{t.has(key) ? t(key) : severity}</Badge>;
}

function FindingsPanel({ sessionId, findings }: { sessionId: string; findings: SessionFinding[] }) {
  const t = useTranslations("sessions.findings");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {findings.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {findings.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                <SeverityBadge severity={f.severity} />
                <span className="font-mono text-xs">{f.ruleId}</span>
                <span className="min-w-0 flex-1 break-words">{f.message}</span>
                {f.turnSeq !== null && (
                  <a href={`#turn-${f.turnSeq}`} className="text-primary text-xs underline-offset-4 hover:underline">
                    {t("turn", { seq: f.turnSeq })}
                  </a>
                )}
                <FindingExplain sessionId={sessionId} findingId={f.id} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Văn bản thô giữ xuống dòng (không render HTML từ nội dung session). */
function PlainText({ text }: { text: string }) {
  return <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{text}</div>;
}

function OutputBlock({ output }: { output: NonNullable<SessionTurn["output"]> }) {
  const t = useTranslations("sessions.detail");
  const format = useFormatter();
  return (
    <div className="flex flex-col gap-1">
      <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-words">
        {output.text}
      </pre>
      {output.truncated && (
        <p className="text-muted-foreground flex items-center gap-1 text-xs">
          <ScissorsIcon className="size-3.5" />
          {output.originalBytes !== null
            ? t("truncatedBytes", { bytes: format.number(output.originalBytes) })
            : t("truncated")}
        </p>
      )}
    </div>
  );
}

/** Tool call / tool result: thu gọn mặc định, hiện tên tool + tóm tắt input. */
function ToolTurnBody({ turn }: { turn: SessionTurn }) {
  const t = useTranslations("sessions.detail");
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const tool = turn.tool;
  const summary = summarizeToolInput(tool?.input ?? null);
  const hasDetails = Boolean(tool?.input || turn.output || turn.text);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {hasDetails ? (
          <button
            type="button"
            className="hover:bg-muted -ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-left"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
            <span className="font-mono text-sm font-medium">{tool?.name ?? "?"}</span>
            <span className="sr-only">{open ? t("hideDetails") : t("showDetails")}</span>
          </button>
        ) : (
          <span className="font-mono text-sm font-medium">{tool?.name ?? "?"}</span>
        )}
        {summary && <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{summary}</span>}
        {tool?.status === "error" && <Badge variant="destructive">{t("toolError")}</Badge>}
        {turn.output?.truncated && !open && <ScissorsIcon className="text-muted-foreground size-3.5" aria-label={t("truncated")} />}
      </div>
      {open && (
        <div id={contentId} className="flex flex-col gap-2">
          {turn.text && <PlainText text={turn.text} />}
          {tool?.input && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium">{t("input")}</span>
              <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {turn.output && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium">{t("output")}</span>
              <OutputBlock output={turn.output} />
            </div>
          )}
        </div>
      )}
      {turn.diff && <DiffView diff={turn.diff} />}
    </div>
  );
}

/** Danh sách turn; session con ghép được thì lồng ngay dưới turn tool đã sinh ra nó. */
function TurnTimeline({
  projectId,
  turns,
  findingsByTurn,
  childrenByTurn,
  notes,
}: {
  projectId: string;
  turns: SessionTurn[];
  findingsByTurn?: Map<number, SessionFinding[]>;
  childrenByTurn: Map<number, SessionChild[]>;
  notes: NotesContext | null;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {turns.map((turn) => (
        <li key={turn.seq}>
          <TurnItem
            turn={turn}
            findings={findingsByTurn?.get(turn.seq) ?? []}
            footer={
              <>
                {(childrenByTurn.get(turn.seq) ?? []).map((child) => (
                  <ChildSessionBlock key={child.id} child={child} projectId={projectId} />
                ))}
                {notes && (
                  <TurnNotes
                    sessionId={notes.sessionId}
                    turnSeq={turn.seq}
                    notes={notes.byTurn.get(turn.seq) ?? []}
                    viewer={notes.viewer}
                  />
                )}
              </>
            }
          />
        </li>
      ))}
    </ol>
  );
}

/** Session con (subagent) lồng trong session cha: thu gọn mặc định, mở thì tải turn của session con. */
export function ChildSessionBlock({ child, projectId }: { child: SessionChild; projectId: string }) {
  const t = useTranslations("sessions.detail");
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const detail = useChildSession(child.id, open);
  const placement = detail.data ? placeChildSessions(detail.data.turns, detail.data.children) : null;

  return (
    <div className="mt-2 rounded-lg border border-violet-500/30 bg-violet-500/5" data-testid="child-session">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="hover:bg-background/60 -ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
          <BotIcon className="size-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
          <span className="shrink-0 text-xs font-medium">{t("childLabel")}</span>
          <span className="min-w-0 truncate text-sm">{child.title ?? t("untitled")}</span>
        </button>
        <span className="text-muted-foreground text-xs">{t("childTurns", { count: child.turnCount })}</span>
        <Link
          href={`/projects/${projectId}/sessions/${child.id}`}
          className="text-primary flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {t("openChildPage")}
          <ExternalLinkIcon className="size-3" aria-hidden />
        </Link>
      </div>
      {open && (
        <div id={contentId} className="border-t border-violet-500/20 p-2 sm:p-3">
          {detail.isPending ? (
            <p className="text-muted-foreground text-sm">{t("childLoading")}</p>
          ) : detail.isError || !detail.data || !placement ? (
            <p className="text-destructive text-sm">{t("childError")}</p>
          ) : detail.data.turns.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("noTurns")}</p>
          ) : (
            <TurnTimeline projectId={projectId} turns={detail.data.turns} childrenByTurn={placement.byTurn} notes={null} />
          )}
        </div>
      )}
    </div>
  );
}

export function TurnItem({
  turn,
  findings = [],
  footer,
}: {
  turn: SessionTurn;
  findings?: SessionFinding[];
  footer?: React.ReactNode;
}) {
  const t = useTranslations("sessions");
  const format = useFormatter();
  const isTool = turn.kind === "tool_call" || turn.kind === "tool_result";
  const isUserPrompt = turn.role === "user" && turn.kind === "prompt";
  const redacted = turn.redactions.reduce((n, r) => n + r.count, 0);
  const attached = turn.attachments.reduce((n, a) => n + a.count, 0);

  return (
    <article
      id={`turn-${turn.seq}`}
      data-interrupted={turn.interrupted || undefined}
      className={[
        "scroll-mt-16 rounded-lg border p-3 sm:p-4",
        isUserPrompt ? "bg-primary/5 border-primary/20" : "",
        isTool ? "bg-muted/30 py-2 sm:py-2" : "",
        turn.interrupted ? "border-l-4 border-l-amber-500" : "",
        findings.length > 0 ? "ring-destructive/40 ring-2" : "",
      ].join(" ")}
    >
      <header className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-mono">#{turn.seq}</span>
        <span className="text-foreground font-medium">{t(`detail.roles.${turn.role}`)}</span>
        <span>· {t(`detail.kinds.${turn.kind}`)}</span>
        <time dateTime={turn.ts}>· {format.dateTime(new Date(turn.ts), { timeStyle: "medium" })}</time>
        {turn.model && !isTool && <span className="font-mono">· {turn.model}</span>}
        {turn.reasoningEffort && <span>· {t("detail.reasoningEffort", { effort: turn.reasoningEffort })}</span>}
        {turn.interrupted && (
          <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
            <ZapOffIcon />
            {t("detail.interrupted")}
          </Badge>
        )}
        {redacted > 0 && <Badge variant="outline">{t("detail.redactions", { count: redacted })}</Badge>}
        {attached > 0 && <Badge variant="outline">{t("detail.attachments", { count: attached })}</Badge>}
        {findings.length > 0 && (
          <Badge variant="destructive">
            <FlagIcon />
            {t("findings.flagged")}
          </Badge>
        )}
      </header>
      {isTool ? (
        <ToolTurnBody turn={turn} />
      ) : (
        <div className="flex flex-col gap-2">
          {turn.text && <PlainText text={turn.text} />}
          {turn.output && <OutputBlock output={turn.output} />}
          {turn.diff && <DiffView diff={turn.diff} />}
        </div>
      )}
      {findings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {findings.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs">
              <SeverityBadge severity={f.severity} />
              <span className="break-words">{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      {footer}
    </article>
  );
}
