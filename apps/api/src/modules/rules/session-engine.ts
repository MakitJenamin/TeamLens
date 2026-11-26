import type { IngestTurn } from '@teamlens/schema';
import type { RuleSeverity } from '../../db/schema/scoring.js';

export type RuleTurn = Pick<IngestTurn, 'seq' | 'role' | 'kind'> & {
  text?: string | null;
  diff?: { added: number; removed: number; path: string } | null;
  tool?: { name: string; input?: Record<string, unknown> | null } | null;
};

export interface RuleSession {
  parentSourceId: string | null;
  turns: readonly RuleTurn[];
}

type Match =
  | { op: 'consecutive'; source: 'prompts'; textRegex: string }
  | { op: 'count'; source: 'prompts' }
  | { op: 'sumDiffWithoutCommand'; commandRegex: string };

export interface SessionRule {
  key: string;
  scope: 'session';
  category: string;
  severity: RuleSeverity;
  thresholds: { min: number };
  match: Match;
  message: string;
  advice: string;
  tests: { name: string; input: RuleSession; expect: 'triggered' | 'clean' }[];
}

interface Measurement {
  count: number;
  turn: RuleTurn;
}

function verificationCommand(turn: RuleTurn): string | undefined {
  if (
    turn.kind !== 'tool_call' ||
    !turn.tool ||
    !/^(bash|shell|shell_command|exec_command|powershell)$/i.test(
      turn.tool.name,
    )
  )
    return;
  const input = turn.tool.input;
  const command = input?.command ?? input?.cmd;
  if (typeof command === 'string') return command;
  if (
    Array.isArray(command) &&
    command.every((arg) => typeof arg === 'string')
  ) {
    // Dạng argv của Codex, có thể được bọc bởi bash -lc hoặc pwsh -Command.
    if (
      /^(?:.*[\\/])?(?:bash|sh|pwsh|powershell)(?:\.exe)?$/i.test(
        command[0] ?? '',
      ) &&
      /^(?:-lc|-c|-command)$/i.test(command[1] ?? '')
    )
      return command[2];
    return command.join(' ');
  }
}

function measure(
  match: Match,
  turns: readonly RuleTurn[],
): Measurement | undefined {
  if (match.op === 'sumDiffWithoutCommand') {
    const pattern = new RegExp(match.commandRegex, 'i');
    let count = 0;
    let lastDiff: RuleTurn | undefined;
    for (const turn of turns) {
      const command = verificationCommand(turn);
      if (command && pattern.test(command)) return;
      if (turn.diff && turn.diff.added + turn.diff.removed > 0) {
        count += turn.diff.added + turn.diff.removed;
        lastDiff = turn;
      }
    }
    return lastDiff && { count, turn: lastDiff };
  }

  const prompts = turns.filter(
    (turn) => turn.role === 'user' && turn.kind === 'prompt',
  );
  const last = prompts.at(-1);
  if (match.op === 'count')
    return last && { count: prompts.length, turn: last };

  const pattern = new RegExp(match.textRegex, 'iu');
  let streak = 0;
  let longest: Measurement | undefined;
  for (const turn of prompts) {
    streak = pattern.test(turn.text ?? '') ? streak + 1 : 0;
    if (streak > (longest?.count ?? 0)) longest = { count: streak, turn };
  }
  return longest;
}

/** Chấm các lượt đã chuẩn hóa và che secret; mỗi rule trả tối đa một finding. */
export function evaluateSession(
  session: RuleSession,
  rules: readonly SessionRule[],
) {
  if (session.parentSourceId !== null) return [];
  const turns = [...session.turns].sort((a, b) => a.seq - b.seq);
  return rules.flatMap((rule) => {
    const result = measure(rule.match, turns);
    if (!result || result.count < rule.thresholds.min) return [];
    const { count, turn } = result;
    return [
      {
        ruleKey: rule.key,
        category: rule.category,
        severity: rule.severity,
        message: rule.message.replaceAll('{{count}}', String(count)),
        advice: rule.advice,
        turnSeq: turn.seq,
        evidenceExcerpt:
          (turn.text || turn.diff?.path || '').slice(0, 160) || null,
        count,
      },
    ];
  });
}
