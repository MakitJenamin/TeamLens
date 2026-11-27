import { z } from 'zod';
import type { UntrustedBlock } from '../llm/llm.types.js';

/**
 * Prompt, schema đầu ra và cách dựng đầu vào cho A1 (tóm tắt), A5 (đánh giá kết quả),
 * A4 (giải thích finding). Đổi chỉ dẫn hoặc cách dựng đầu vào thì tăng số phiên bản.
 */
export const PROMPT_VERSIONS = {
  summary: 'session_summary@1',
  outcome: 'session_outcome@1',
  explain: 'finding_explain@1',
} as const;

/** Ngân sách ký tự cho phần turn của A1, A5 (giữ đầu và cuối, cắt giữa). */
export const TURN_BUDGET_CHARS = 60_000;
/** Giới hạn ký tự cho một turn sau khi tóm gọn. */
const TURN_MAX_CHARS = 2_000;
/** Giới hạn ký tự cho phần patch của một diff. */
const PATCH_MAX_CHARS = 600;
/** Giới hạn ký tự cho output của tool. */
const OUTPUT_MAX_CHARS = 300;
/** A4: số turn mỗi bên quanh turn dính finding. */
export const EXPLAIN_CONTEXT_TURNS = 3;

const turnRef = z.object({
  seq: z.number().int().min(0),
  note: z.string(),
});

export const sessionSummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  workType: z.enum([
    'bugfix',
    'feature',
    'refactor',
    'question',
    'ops',
    'docs',
    'test',
    'other',
  ]),
  outcome: z.string(),
  filesTouched: z.array(z.string()),
  keyTurns: z.array(turnRef),
});

export const sessionOutcomeSchema = z.object({
  status: z.enum(['completed', 'abandoned', 'stuck_loop', 'unclear']),
  explanation: z.string(),
  evidence: z.array(turnRef),
});

export const findingExplainSchema = z.object({
  why: z.string(),
  advice: z.string(),
  turns: z.array(turnRef),
});

const TURN_FORMAT_NOTE = `Each turn in the data starts with "[seq N]" where N is the turn number. When you cite a turn, use exactly that number as "seq". Never invent a seq that does not appear in the data.`;

export const SUMMARY_SYSTEM = `You review one AI coding-agent session (a developer working with an agent such as Claude Code or Codex) and write a short summary for the people on the team.
${TURN_FORMAT_NOTE}
Fields:
- title: one line (max ~80 characters) naming what the session was about.
- summary: 2-5 sentences: the goal, what the agent did, how it went.
- workType: the kind of work, one of bugfix, feature, refactor, question, ops, docs, test, other.
- outcome: one sentence on how the session ended (done, partially done, abandoned, unclear).
- filesTouched: file paths the agent edited or created (at most 15, most important first; empty if none).
- keyTurns: 3-8 turns that matter most (the request, key decisions, problems, the end), each with a short note.
Findings listed in the data are automatic rule checks on the session; mention them only if relevant.`;

export const OUTCOME_SYSTEM = `You judge how one AI coding-agent session ended, based only on its turns.
${TURN_FORMAT_NOTE}
Fields:
- status: "completed" (the user's request was done and the user accepted or moved on), "abandoned" (the user stopped before the work was done), "stuck_loop" (the user and agent went round in circles: repeated corrections, the same error again and again), "unclear" (not enough signal).
- explanation: 2-4 sentences explaining the judgement.
- evidence: 1-6 turns that support the judgement, each with a short note.
If the middle of the session was cut, judge from what is shown and say so when it matters.`;

export const EXPLAIN_SYSTEM = `A rule engine flagged one finding on an AI coding-agent session. Explain it to the developer in plain words.
The data contains the rule (its JSON definition, message and advice), the finding evidence, and the turns around where the finding was detected.
${TURN_FORMAT_NOTE}
Fields:
- why: 2-4 sentences: why the rule fired on this session, pointing at what actually happened in the turns.
- advice: 1-3 concrete, actionable sentences on what to do differently next time, specific to this session (not just repeating the rule advice).
- turns: 1-5 turns that show the problem, each with a short note.`;

/** Turn như đọc từ DB (jsonb dạng session.v1, snake_case). */
export interface PromptTurn {
  seq: number;
  role: string;
  kind: string;
  text: string | null;
  tool: unknown;
  output: unknown;
  diff: unknown;
  interrupted: boolean;
}

export interface PromptFinding {
  ruleKey: string;
  message: string | null;
  turnSeq: number | null;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}… [cắt ${text.length - max} ký tự]`
    : text;
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath'];

/** Tên tool kèm đường dẫn file hoặc lệnh (rút gọn), không đưa toàn bộ input. */
export function summarizeTool(tool: unknown): string | null {
  const obj = asObject(tool);
  if (!obj || typeof obj.name !== 'string') return null;
  const input = asObject(obj.input);
  let detail = '';
  if (input) {
    const path = PATH_KEYS.map((key) => input[key]).find(
      (value): value is string => typeof value === 'string',
    );
    const command = Array.isArray(input.command)
      ? input.command.filter((part) => typeof part === 'string').join(' ')
      : input.command;
    if (path) detail = path;
    else if (typeof command === 'string') detail = clip(command, 200);
    else if (typeof input.pattern === 'string')
      detail = clip(input.pattern, 100);
    else if (typeof input.url === 'string') detail = clip(input.url, 200);
  }
  const status = obj.status === 'error' ? ' (lỗi)' : '';
  return `${obj.name}${detail ? ` ${detail}` : ''}${status}`;
}

/** Một turn thành vài dòng văn bản, mở đầu bằng `[seq N]`. */
export function formatTurn(turn: PromptTurn): string {
  const parts: string[] = [];
  if (turn.text) parts.push(turn.text.trim());
  const tool = summarizeTool(turn.tool);
  if (tool) parts.push(`tool: ${tool}`);
  const diff = asObject(turn.diff);
  if (diff && typeof diff.path === 'string') {
    const added = typeof diff.added === 'number' ? diff.added : 0;
    const removed = typeof diff.removed === 'number' ? diff.removed : 0;
    let line = `diff: ${diff.path} (+${added} -${removed})`;
    if (typeof diff.patch === 'string' && diff.patch)
      line += `\n${clip(diff.patch, PATCH_MAX_CHARS)}`;
    parts.push(line);
  }
  const output = asObject(turn.output);
  if (output && typeof output.text === 'string' && output.text)
    parts.push(`output: ${clip(output.text.trim(), OUTPUT_MAX_CHARS)}`);
  if (turn.interrupted) parts.push('(người dùng ngắt lượt này)');
  const body = clip(parts.join('\n') || '(trống)', TURN_MAX_CHARS);
  return `[seq ${turn.seq}] ${turn.role}/${turn.kind}: ${body}`;
}

/**
 * Ghép các turn trong ngân sách ký tự: vượt thì giữ đầu và cuối (mỗi bên khoảng một nửa),
 * thay phần giữa bằng một dòng ghi rõ đã cắt bao nhiêu turn.
 */
export function formatTurns(
  turns: readonly PromptTurn[],
  budget = TURN_BUDGET_CHARS,
): string {
  const lines = turns.map(formatTurn);
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= budget) return lines.join('\n');

  const half = Math.floor(budget / 2);
  const head: string[] = [];
  let used = 0;
  let i = 0;
  while (i < lines.length && used + lines[i].length + 1 <= half) {
    used += lines[i].length + 1;
    head.push(lines[i]);
    i += 1;
  }
  const tail: string[] = [];
  used = 0;
  let j = lines.length - 1;
  while (j >= i && used + lines[j].length + 1 <= half) {
    used += lines[j].length + 1;
    tail.unshift(lines[j]);
    j -= 1;
  }
  const dropped = j - i + 1;
  const marker =
    dropped > 0
      ? `[... đã cắt ${dropped} turn ở giữa (seq ${turns[i].seq}–${turns[j].seq}) vì session quá dài ...]`
      : '';
  return [...head, marker, ...tail].filter(Boolean).join('\n');
}

export function formatFindings(findings: readonly PromptFinding[]): string {
  if (findings.length === 0) return '(không có)';
  return findings
    .map(
      (f) =>
        `- ${f.ruleKey}${f.turnSeq !== null ? ` [seq ${f.turnSeq}]` : ''}: ${f.message ?? ''}`,
    )
    .join('\n');
}

export interface SessionMeta {
  agent: string;
  repoRemote: string;
  branch: string | null;
  turnCount: number;
}

/** Đầu vào chung của A1, A5: thông tin session, các turn (đã cắt), danh sách finding. */
export function sessionBlocks(
  meta: SessionMeta,
  turns: readonly PromptTurn[],
  findings: readonly PromptFinding[],
): UntrustedBlock[] {
  return [
    {
      label: 'session',
      content: `agent: ${meta.agent}\nrepo: ${meta.repoRemote}\nbranch: ${meta.branch ?? '(không rõ)'}\nturns: ${meta.turnCount}`,
    },
    { label: 'turns', content: formatTurns(turns) },
    { label: 'findings', content: formatFindings(findings) },
  ];
}

/** Các turn quanh `turnSeq` (±`EXPLAIN_CONTEXT_TURNS`); không có `turnSeq` thì vài turn đầu và cuối. */
export function turnsAround(
  turns: readonly PromptTurn[],
  turnSeq: number | null,
  radius = EXPLAIN_CONTEXT_TURNS,
): PromptTurn[] {
  const sorted = [...turns].sort((a, b) => a.seq - b.seq);
  const index =
    turnSeq === null ? -1 : sorted.findIndex((t) => t.seq === turnSeq);
  if (index === -1) {
    const n = radius + 1;
    if (sorted.length <= n * 2) return sorted;
    return [...sorted.slice(0, n), ...sorted.slice(-n)];
  }
  return sorted.slice(Math.max(0, index - radius), index + radius + 1);
}

export interface ExplainInput {
  ruleKey: string;
  definition: unknown;
  message: string | null;
  advice: string | null;
  evidence: unknown;
  turnSeq: number | null;
}

/** Đầu vào A4: rule (bỏ phần test mẫu), finding và các turn quanh chỗ dính. */
export function explainBlocks(
  input: ExplainInput,
  turns: readonly PromptTurn[],
): UntrustedBlock[] {
  const definition = asObject(input.definition);
  const ruleJson = definition
    ? Object.fromEntries(
        Object.entries(definition).filter(([key]) => key !== 'tests'),
      )
    : input.definition;
  return [
    {
      label: 'rule',
      content: `key: ${input.ruleKey}\nmessage: ${input.message ?? ''}\nadvice: ${input.advice ?? ''}\ndefinition: ${JSON.stringify(ruleJson ?? null)}`,
    },
    {
      label: 'finding',
      content: `turn: ${input.turnSeq ?? '(cả session)'}\nevidence: ${JSON.stringify(input.evidence ?? null)}`,
    },
    {
      label: 'turns',
      content: formatTurns(turnsAround(turns, input.turnSeq)),
    },
  ];
}

type WithRefs = Record<string, unknown>;

/** Hậu kiểm: bỏ trích dẫn `seq` không có trong session (LLM bịa). Giữ nguyên trường khác. */
export function dropUnknownSeqs<T extends WithRefs>(
  result: T,
  validSeqs: ReadonlySet<number>,
): T {
  const out: WithRefs = { ...result };
  for (const key of ['keyTurns', 'evidence', 'turns']) {
    const value = out[key];
    if (Array.isArray(value))
      out[key] = value.filter(
        (ref) =>
          typeof ref === 'object' &&
          ref !== null &&
          validSeqs.has((ref as { seq?: unknown }).seq as number),
      );
  }
  return out as T;
}
