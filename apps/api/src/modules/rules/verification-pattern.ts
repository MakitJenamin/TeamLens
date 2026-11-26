import type { RuleTurn } from './session-engine.js';
export const verificationPattern = [
  String.raw`(?:^|&&|\|\||[;|\n])\s*(?:`,
  String.raw`(?:npm|pnpm|yarn|bun)(?:\s+--filter\s+[^\s;&|]+)*(?:\s+(?:run|exec))?\s+(?:test|build|lint|jest|vitest|tsc)`,
  String.raw`|(?:npx\s+)?(?:jest|vitest|tsc|eslint)|(?:python3?\s+-m\s+)?pytest`,
  String.raw`|go\s+(?:test|build)|cargo\s+(?:test|build|check|clippy)`,
  String.raw`|(?:\.\/)?(?:mvnw?|gradlew?)\s+(?:test|build|check|verify|package)|test|build|lint`,
  String.raw`)(?=$|[\s:;&|])`,
].join('');

export function verificationCommand(turn: RuleTurn): string | undefined {
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
