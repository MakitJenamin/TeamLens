import { verificationCommand } from './verification-pattern.js';
import type { IngestTurn } from '@teamlens/schema';
import type { RuleSeverity } from '../../db/schema/scoring.js';
import { measureSignal, type Signal } from './session-signals.js';

export type RuleTurn = Pick<IngestTurn, 'seq' | 'role' | 'kind'> & {
  text?: string | null;
  ts?: string;
  model?: string | null;
  interrupted?: boolean | null;
  diff?: {
    added: number;
    removed: number;
    path: string;
    patch?: string;
  } | null;
  tool?: {
    name: string;
    input?: Record<string, unknown> | null;
    status?: string;
  } | null;
};

export interface RuleSession {
  parentSourceId: string | null;
  permissionMode?: string | null;
  instructionFiles?: readonly { path: string; bytes: number }[] | null;
  turns: readonly RuleTurn[];
}

type Match =
  | { op: 'signal'; signal: Signal }
  | { op: 'consecutive'; source: 'prompts'; textRegex: string }
  | { op: 'count'; source: 'prompts' }
  | { op: 'sumDiffWithoutCommand'; commandRegex: string };

export interface SessionRule {
  key: string;
  scope: 'session';
  category: string;
  severity: RuleSeverity;
  thresholds: { min: number; [key: string]: number };
  match: Match;
  message: string;
  advice: string;
  tests: { name: string; input: RuleSession; expect: 'triggered' | 'clean' }[];
}

interface Measurement {
  count: number;
  turn: RuleTurn;
}

function measure(
  match: Exclude<Match, { op: 'signal' }>,
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
    const result =
      rule.match.op === 'signal'
        ? measureSignal(rule.match.signal, session, turns, rule.thresholds)
        : measure(rule.match, turns);
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
