import {
  verificationCommand,
  verificationPattern,
} from './verification-pattern.js';
import type { RuleSession, RuleTurn } from './session-engine.js';

export const hasCriteria = (text: string) =>
  /(?:^|\n)\s*(?:[-*]|\d+[.)])\s|\b(?:acceptance|must|expected|should return)\b|tiêu chí|yêu cầu|phải|kết quả mong muốn/iu.test(
    text,
  );
export const humanPrompts = (turns: readonly RuleTurn[]) =>
  turns.filter((t) => t.role === 'user' && t.kind === 'prompt');
export const loc = (t: RuleTurn) =>
  (t.diff?.added ?? 0) + (t.diff?.removed ?? 0);

function mostFrequent(entries: { key: string; turn: RuleTurn }[]) {
  const counts = new Map<string, number>();
  let best: { count: number; turn: RuleTurn } | undefined;
  for (const { key, turn } of entries) {
    if (!key) continue;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (!best || count > best.count) best = { count, turn };
  }
  return best;
}

/** Ghép kết quả với lời gọi đang chờ theo tên tool và thứ tự trong transcript. */
function failedCalls(turns: readonly RuleTurn[]) {
  const pending = new Map<string, RuleTurn[]>();
  const failed = new Set<RuleTurn>();
  for (const t of turns) {
    if (!t.tool) continue;
    const name = t.tool.name.toLowerCase();
    if (t.kind === 'tool_call') {
      const calls = pending.get(name) ?? [];
      calls.push(t);
      pending.set(name, calls);
      if (t.tool.status === 'error') failed.add(t);
    } else if (t.kind === 'tool_result') {
      const call = pending.get(name)?.shift();
      if (call && t.tool.status === 'error') failed.add(call);
    }
  }
  return failed;
}

export type Signal =
  | 'shortFirst'
  | 'missingInstructions'
  | 'duplicates'
  | 'failedCommand'
  | 'churn'
  | 'loop'
  | 'compactions'
  | 'unreviewed'
  | 'vibe'
  | 'bypass';
export function measureSignal(
  signal: Signal,
  session: RuleSession,
  turns: readonly RuleTurn[],
  limits: Record<string, number>,
) {
  const prompts = humanPrompts(turns);
  const first = prompts[0];
  const last = turns.at(-1);
  if (!last) return;
  switch (signal) {
    case 'shortFirst': {
      const text = first?.text?.trim();
      if (
        text &&
        text.split(/\s+/u).length < limits.minWords &&
        !/(?:@\S+|[\w.-]+[/\\][\w.-]+|\b[\w-]+\.[a-z]{1,8}\b)/iu.test(text)
      )
        return { count: 1, turn: first };
      break;
    }
    case 'missingInstructions':
      if (session.instructionFiles?.length === 0)
        return { count: 1, turn: first ?? last };
      break;
    case 'duplicates':
      return mostFrequent(
        prompts.map((turn) => ({
          turn,
          key: (turn.text ?? '')
            .toLowerCase()
            .replace(/\p{P}/gu, '')
            .replace(/\s+/gu, ' ')
            .trim(),
        })),
      );
    case 'failedCommand': {
      const pattern = new RegExp(verificationPattern, 'i');
      const entries = [];
      for (const turn of failedCalls(turns)) {
        const command = verificationCommand(turn)?.trim().replace(/\s+/g, ' ');
        if (command && pattern.test(command))
          entries.push({ key: command, turn });
      }
      return mostFrequent(entries);
    }
    case 'churn': {
      const files = new Map<
        string,
        { count: number; added: Set<string>; reversed: boolean }
      >();
      let best;
      for (const turn of turns) {
        if (!turn.diff) continue;
        const { path, patch } = turn.diff;
        const state = files.get(path) ?? {
          count: 0,
          added: new Set<string>(),
          reversed: false,
        };
        const lines = (patch ?? '').split(/\r?\n/);
        if (
          lines.some(
            (l) =>
              l.startsWith('-') &&
              !l.startsWith('---') &&
              state.added.has(l.slice(1)),
          )
        )
          state.reversed = true;
        state.added = new Set(
          lines
            .filter(
              (l) =>
                l.startsWith('+') && !l.startsWith('+++') && l.slice(1).trim(),
            )
            .map((l) => l.slice(1)),
        );
        state.count++;
        files.set(path, state);
        if (state.reversed && state.count > (best?.count ?? 0))
          best = { count: state.count, turn };
      }
      return best;
    }
    case 'loop': {
      const failed = failedCalls(turns);
      let prompt: RuleTurn | undefined,
        calls = 0,
        errors = 0,
        best;
      for (const t of turns) {
        if (t.role === 'user' && t.kind === 'prompt') {
          prompt = t;
          calls = 0;
          errors = 0;
        }
        if (prompt && t.kind === 'tool_call') {
          calls++;
          if (failed.has(t)) errors++;
          if (errors >= limits.minErrors && calls > (best?.count ?? 0))
            best = { count: calls, turn: prompt };
        }
      }
      return best;
    }
    case 'compactions': {
      const cuts = turns.filter((t) => t.kind === 'compaction');
      if (cuts.length)
        return { count: cuts.length, turn: cuts[cuts.length - 1] };
      break;
    }
    case 'unreviewed':
    case 'vibe': {
      const count = turns.reduce((n, t) => n + loc(t), 0);
      const edit = turns.findLast((t) => loc(t) > 0);
      if (!edit) break;
      if (signal === 'unreviewed' && !prompts.some((t) => t.seq > edit.seq))
        return { count, turn: edit };
      if (
        signal === 'vibe' &&
        prompts.length > 0 &&
        prompts.length <= limits.maxPrompts &&
        !prompts.some(
          (t) =>
            hasCriteria(t.text ?? '') ||
            /\b(?:spec|plan)\b|đặc tả|kế hoạch/iu.test(t.text ?? ''),
        )
      )
        return { count, turn: edit };
      break;
    }
    case 'bypass': {
      const command = turns.find((t) => verificationCommand(t));
      if (session.permissionMode === 'bypass' && command)
        return { count: 1, turn: command };
      break;
    }
  }
}
