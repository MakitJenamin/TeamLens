import type { AgentKind, PermissionMode, SessionTurn } from '@teamlens/schema';
import { ApiError } from '../../common/api-error.js';

/** Vị trí trong danh sách đã sắp `startedAt` giảm dần, `id` giảm dần. */
export interface SessionCursor {
  /** `started_at` dạng ISO đủ micro giây (lấy từ Postgres, tránh mất độ chính xác của Date). */
  startedAt: string;
  id: string;
}

const ISO_MICROS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mã hóa cursor thành chuỗi mờ (base64url của JSON). */
export function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(
    JSON.stringify({ s: cursor.startedAt, i: cursor.id }),
  ).toString('base64url');
}

/** Giải mã cursor; chuỗi không hợp lệ ném 400 `validation_error`. */
export function decodeCursor(raw: string): SessionCursor {
  const invalid = () =>
    new ApiError(400, 'validation_error', 'Dữ liệu không hợp lệ: cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { s, i } = parsed as { s?: unknown; i?: unknown };
  if (typeof s !== 'string' || !ISO_MICROS_RE.test(s)) throw invalid();
  if (typeof i !== 'string' || !UUID_RE.test(i)) throw invalid();
  return { startedAt: s, id: i };
}

export const AGENT_KINDS = [
  'claude_code',
  'codex',
  'copilot_vscode',
  'antigravity',
] as const satisfies readonly AgentKind[];

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'accept_edits',
  'plan',
  'bypass',
  'unknown',
];

/** Giá trị không nằm trong enum của contract coi như không có. */
export function toPermissionMode(value: string | null): PermissionMode | null {
  return value !== null && PERMISSION_MODES.includes(value as PermissionMode)
    ? (value as PermissionMode)
    : null;
}

export function toAgentKind(value: string): AgentKind {
  return value as AgentKind;
}

/** Dòng `turns` như đọc từ DB: jsonb lưu nguyên dạng session.v1 (snake_case). */
export interface TurnRow {
  seq: number;
  role: SessionTurn['role'];
  kind: SessionTurn['kind'];
  ts: Date;
  model: string | null;
  text: string | null;
  tool: unknown;
  output: unknown;
  diff: unknown;
  usage: unknown;
  attachments: unknown;
  redactions: unknown;
  interrupted: boolean;
  reasoningEffort: string | null;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function mapCounts(value: unknown): SessionTurn['redactions'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const obj = asObject(item);
    if (!obj || typeof obj.type !== 'string') return [];
    return [{ type: obj.type, count: Math.max(1, asInt(obj.count, 1)) }];
  });
}

/** Đổi một turn từ DB (snake_case trong jsonb) sang `SessionTurn` (camelCase) của contract. */
export function mapTurn(row: TurnRow): SessionTurn {
  const tool = asObject(row.tool);
  const output = asObject(row.output);
  const diff = asObject(row.diff);
  const usage = asObject(row.usage);
  return {
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    ts: row.ts.toISOString(),
    model: row.model,
    text: row.text,
    tool:
      tool && typeof tool.name === 'string'
        ? {
            name: tool.name,
            input: asObject(tool.input),
            status:
              tool.status === 'ok' || tool.status === 'error'
                ? tool.status
                : null,
          }
        : null,
    output:
      output && typeof output.text === 'string'
        ? {
            text: output.text,
            truncated: output.truncated === true,
            originalBytes:
              typeof output.original_bytes === 'number'
                ? asInt(output.original_bytes, 0)
                : null,
          }
        : null,
    diff:
      diff && typeof diff.path === 'string' && typeof diff.patch === 'string'
        ? {
            path: diff.path,
            patch: diff.patch,
            added: asInt(diff.added, 0),
            removed: asInt(diff.removed, 0),
          }
        : null,
    usage: usage
      ? {
          input: asInt(usage.input, 0),
          output: asInt(usage.output, 0),
          cacheRead: asInt(usage.cache_read, 0),
          cacheWrite: asInt(usage.cache_write, 0),
          estimated: usage.estimated === true,
        }
      : null,
    attachments: mapCounts(row.attachments),
    redactions: mapCounts(row.redactions),
    interrupted: row.interrupted,
    reasoningEffort: row.reasoningEffort,
  };
}
