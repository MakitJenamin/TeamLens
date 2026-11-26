"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateSessionNoteRequest, SessionNote, SessionNoteList } from "@teamlens/schema";
import { MessageSquarePlusIcon, StickyNoteIcon, Trash2Icon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api/client";

/** Người đang xem trang: quyết định có hiện nút thêm/xóa ghi chú hay không (API vẫn kiểm tra lại). */
export interface NoteViewer {
  id: string;
  isLeader: boolean;
}

/** Độ dài tối đa của ghi chú (khớp contract `CreateSessionNoteRequest.body`). */
export const NOTE_MAX_LENGTH = 4000;

const notesKey = (sessionId: string) => ["sessions", sessionId, "notes"] as const;

export function useSessionNotes(sessionId: string) {
  return useQuery({
    queryKey: notesKey(sessionId),
    queryFn: () => api.get<SessionNoteList>(`/sessions/${sessionId}/notes`),
    retry: false,
    staleTime: 30_000,
  });
}

/** Nhóm ghi chú theo `turnSeq` (null là ghi chú chung cho cả session). */
export function groupNotes(notes: SessionNote[]): Map<number | null, SessionNote[]> {
  const map = new Map<number | null, SessionNote[]>();
  for (const note of notes) map.set(note.turnSeq, [...(map.get(note.turnSeq) ?? []), note]);
  return map;
}

function useCreateNote(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSessionNoteRequest) => api.post<SessionNote>(`/sessions/${sessionId}/notes`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notesKey(sessionId) }),
  });
}

function useDeleteNote(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => api.delete<void>(`/sessions/${sessionId}/notes/${noteId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notesKey(sessionId) }),
  });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

function NoteItem({ note, sessionId, viewer }: { note: SessionNote; sessionId: string; viewer: NoteViewer | null }) {
  const t = useTranslations("sessions.notes");
  const format = useFormatter();
  const remove = useDeleteNote(sessionId);
  const canDelete = Boolean(viewer?.isLeader && note.author?.id === viewer.id);

  return (
    <li className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm" data-testid="note">
      <StickyNoteIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
          <span className="text-foreground font-medium">{note.author?.name ?? t("deletedAuthor")}</span>
          <time dateTime={note.createdAt}>
            {format.dateTime(new Date(note.createdAt), { dateStyle: "medium", timeStyle: "short" })}
          </time>
        </div>
        <p className="break-words whitespace-pre-wrap">{note.body}</p>
      </div>
      {canDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("delete")}
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(note.id, {
              onError: (err) => toast.error(errorMessage(err, t("deleteFailed"))),
            })
          }
        >
          <Trash2Icon />
        </Button>
      )}
    </li>
  );
}

function NoteForm({ sessionId, turnSeq, onDone }: { sessionId: string; turnSeq: number | null; onDone: () => void }) {
  const t = useTranslations("sessions.notes");
  const [body, setBody] = useState("");
  const create = useCreateNote(sessionId);
  const fieldId = useId();
  const trimmed = body.trim();

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        create.mutate(
          { turnSeq, body: trimmed },
          {
            onSuccess: () => {
              setBody("");
              onDone();
            },
            onError: (err) => toast.error(errorMessage(err, t("createFailed"))),
          },
        );
      }}
    >
      <label htmlFor={fieldId} className="sr-only">
        {turnSeq === null ? t("sessionLabel") : t("turnLabel", { seq: turnSeq })}
      </label>
      <textarea
        id={fieldId}
        autoFocus
        rows={3}
        maxLength={NOTE_MAX_LENGTH}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("placeholder")}
        className="border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-3"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!trimmed || create.isPending}>
          {create.isPending ? t("saving") : t("save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Ghi chú gắn với một turn (hoặc cả session khi `turnSeq` null): danh sách + nút thêm cho leader.
 * Member chỉ xem.
 */
export function TurnNotes({
  sessionId,
  turnSeq,
  notes,
  viewer,
}: {
  sessionId: string;
  turnSeq: number | null;
  notes: SessionNote[];
  viewer: NoteViewer | null;
}) {
  const t = useTranslations("sessions.notes");
  const [adding, setAdding] = useState(false);
  const canAdd = Boolean(viewer?.isLeader);
  if (notes.length === 0 && !canAdd) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={t("listLabel")}>
          {notes.map((note) => (
            <NoteItem key={note.id} note={note} sessionId={sessionId} viewer={viewer} />
          ))}
        </ul>
      )}
      {canAdd &&
        (adding ? (
          <NoteForm sessionId={sessionId} turnSeq={turnSeq} onDone={() => setAdding(false)} />
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground w-fit"
            onClick={() => setAdding(true)}
            aria-label={turnSeq === null ? t("addSession") : t("addTurn", { seq: turnSeq })}
          >
            <MessageSquarePlusIcon data-icon="inline-start" />
            {t("add")}
          </Button>
        ))}
    </div>
  );
}
