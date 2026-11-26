import type { SessionSummary } from "@/lib/api/types";

/** Khóa dịch (namespace `sessions.duration`) và tham số cho thời lượng session. */
export type DurationLabel =
  | { key: "seconds"; values: { s: number } }
  | { key: "minutes"; values: { m: number } }
  | { key: "hours"; values: { h: number; m: number } };

/** Thời lượng từ `startedAt` tới `endedAt`; null khi session còn chạy hoặc dữ liệu lạ. */
export function sessionDuration(session: Pick<SessionSummary, "startedAt" | "endedAt">): DurationLabel | null {
  if (!session.endedAt) return null;
  const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return { key: "seconds", values: { s: totalSeconds } };
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return { key: "minutes", values: { m: totalMinutes } };
  return { key: "hours", values: { h: Math.floor(totalMinutes / 60), m: totalMinutes % 60 } };
}

/** Tổng token hiển thị trong bảng: input + output (cache tính riêng trong tooltip). */
export function totalTokens(usage: SessionSummary["usage"]): number {
  return usage.input + usage.output;
}

export type DiffLineKind = "add" | "remove" | "hunk" | "context";

/** Phân loại từng dòng unified diff để tô màu đơn giản. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  return "context";
}

/** Tóm tắt input của tool trong một dòng (đường dẫn, lệnh...), tối đa `max` ký tự. */
export function summarizeToolInput(input: Record<string, unknown> | null, max = 120): string {
  if (!input) return "";
  const preferred = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];
  // Codex ghi lệnh dạng mảng (["pytest", "-q"]) nên ghép lại thành một chuỗi.
  const asText = (value: unknown): string | null =>
    typeof value === "string"
      ? value
      : Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")
        ? value.join(" ")
        : null;
  const key = preferred.find((k) => asText(input[k]) !== null) ?? Object.keys(input).find((k) => typeof input[k] === "string");
  const raw = key ? (asText(input[key]) ?? "") : JSON.stringify(input);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Finding tối thiểu đọc từ `GET /sessions/{id}/findings` (contract M1.9 chưa chốt nên đọc phòng thủ). */
export interface SessionFinding {
  id: string;
  ruleId: string;
  severity: string;
  message: string;
  turnSeq: number | null;
}

/**
 * Đọc kết quả findings mà không tin cấu trúc: nhận mảng hoặc `{ items: [...] }`,
 * bỏ phần tử thiếu trường bắt buộc. Trả `null` nếu không nhận ra dạng nào.
 */
export function parseFindings(body: unknown): SessionFinding[] | null {
  const list = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as { items?: unknown }).items)
      ? (body as { items: unknown[] }).items
      : null;
  if (!list) return null;
  return list.flatMap((item, index) => {
    if (typeof item !== "object" || item === null) return [];
    const f = item as Record<string, unknown>;
    const ruleId = typeof f.ruleId === "string" ? f.ruleId : typeof f.ruleKey === "string" ? f.ruleKey : null;
    const message = typeof f.message === "string" ? f.message : null;
    if (!ruleId || !message) return [];
    return [
      {
        id: typeof f.id === "string" ? f.id : `${ruleId}-${index}`,
        ruleId,
        severity: typeof f.severity === "string" ? f.severity : "info",
        message,
        turnSeq: typeof f.turnSeq === "number" ? f.turnSeq : null,
      },
    ];
  });
}
