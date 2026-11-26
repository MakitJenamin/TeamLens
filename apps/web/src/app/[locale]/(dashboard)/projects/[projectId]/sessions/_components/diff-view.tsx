"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { Decoration, Diff, Hunk, parseDiff, type FileData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type { SessionTurn } from "@/lib/api/types";
import { classifyDiffLine } from "./format";

type TurnDiff = NonNullable<SessionTurn["diff"]>;

/** Diff có quá số dòng này thì thu gọn mặc định (diff lớn tới 256 KB không render ngay khi mở trang). */
export const DIFF_AUTO_OPEN_LINES = 40;

/**
 * Patch của CLI chỉ có các hunk (`@@ ... @@`), thiếu phần đầu file mà `gitdiff-parser` cần,
 * nên ghép thêm phần đầu giả theo `path`. Trả null nếu không đọc được hunk nào.
 */
export function parsePatch(diff: Pick<TurnDiff, "path" | "patch">): FileData | null {
  const path = diff.path.replace(/\s/g, "_") || "file";
  const body = /^(diff --git |--- )/m.test(diff.patch)
    ? diff.patch
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff.patch}`;
  try {
    const [file] = parseDiff(body.endsWith("\n") ? body : `${body}\n`);
    return file && file.hunks.length > 0 ? file : null;
  } catch {
    return null;
  }
}

/** Màu diff theo theme sáng/tối (ghi đè biến CSS của react-diff-view). */
const diffTheme = [
  "[--diff-font-family:var(--font-mono,ui-monospace,monospace)]",
  "[--diff-code-insert-background-color:rgb(34_197_94/0.12)]",
  "[--diff-gutter-insert-background-color:rgb(34_197_94/0.22)]",
  "[--diff-code-delete-background-color:rgb(239_68_68/0.12)]",
  "[--diff-gutter-delete-background-color:rgb(239_68_68/0.22)]",
  "[--diff-code-insert-edit-background-color:rgb(34_197_94/0.35)]",
  "[--diff-code-delete-edit-background-color:rgb(239_68_68/0.35)]",
  "[--diff-selection-background-color:rgb(59_130_246/0.25)]",
  "[--diff-text-color:inherit]",
  "[--diff-background-color:transparent]",
].join(" ");

/** Bản dự phòng khi patch không đọc được: tô màu từng dòng đơn giản. */
function PlainPatch({ patch }: { patch: string }) {
  const lineClass = {
    add: "bg-green-500/10 text-green-800 dark:text-green-300",
    remove: "bg-red-500/10 text-red-800 dark:text-red-300",
    hunk: "text-sky-700 dark:text-sky-300",
    context: "",
  } as const;
  return (
    <pre className="py-1 font-mono text-xs leading-5" data-testid="diff-plain">
      {patch.split("\n").map((line, i) => {
        const kind = classifyDiffLine(line);
        return (
          <div key={i} data-kind={kind} className={`px-3 whitespace-pre ${lineClass[kind]}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function DiffBody({ diff }: { diff: TurnDiff }) {
  const file = useMemo(() => parsePatch(diff), [diff]);
  if (!file) return <PlainPatch patch={diff.patch} />;
  return (
    <Diff viewType="unified" diffType={file.type} hunks={file.hunks} className={`text-xs ${diffTheme}`}>
      {(hunks) =>
        hunks.flatMap((hunk) => [
          <Decoration key={`d-${hunk.content}`} className="bg-muted/60 text-sky-700 dark:text-sky-300">
            <span className="px-2 font-mono text-xs">{hunk.content}</span>
          </Decoration>,
          <Hunk key={`h-${hunk.content}`} hunk={hunk} />,
        ])
      }
    </Diff>
  );
}

/**
 * Diff của một turn, tô màu bằng react-diff-view. Diff ngắn mở sẵn; diff dài thu gọn, chỉ render khi bấm mở
 * để trang không bị treo với patch lớn.
 */
export function DiffView({ diff }: { diff: TurnDiff }) {
  const t = useTranslations("sessions.detail");
  const lineCount = useMemo(() => diff.patch.split("\n").length, [diff.patch]);
  const [open, setOpen] = useState(lineCount <= DIFF_AUTO_OPEN_LINES);
  const contentId = useId();

  return (
    <div className="overflow-hidden rounded-md border" data-testid="diff">
      <div className="bg-muted flex flex-wrap items-center justify-between gap-2 px-2 py-1 font-mono text-xs">
        <button
          type="button"
          className="hover:bg-background/60 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
          <span className="break-all">{diff.path}</span>
          <span className="sr-only">{open ? t("hideDiff") : t("showDiff")}</span>
        </button>
        <span className="flex items-center gap-2">
          {!open && <span className="text-muted-foreground font-sans">{t("diffLines", { count: lineCount })}</span>}
          <span aria-hidden>
            <span className="text-green-700 dark:text-green-400">+{diff.added}</span>{" "}
            <span className="text-red-700 dark:text-red-400">−{diff.removed}</span>
          </span>
          <span className="sr-only">{t("diffStats", { added: diff.added, removed: diff.removed })}</span>
        </span>
      </div>
      {open && (
        <div id={contentId} className="max-h-[32rem] overflow-auto">
          <DiffBody diff={diff} />
        </div>
      )}
    </div>
  );
}
