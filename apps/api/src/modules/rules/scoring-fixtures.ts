import type { IngestTurn } from '@teamlens/schema';

type Turn = Omit<IngestTurn, 'seq' | 'ts'>;
const file = 'src/total.ts';
const prompt = (text: string): Turn => ({
  role: 'user',
  kind: 'prompt',
  text,
});
const reply = (text: string): Turn => ({
  role: 'assistant',
  kind: 'reply',
  text,
  usage: { input: 110, output: 35 },
});
/** Như adapter CLI: cờ ngắt gắn vào turn assistant đang trả lời khi người dùng ngắt. */
const interrupted = (turn: Turn): Turn => ({ ...turn, interrupted: true });
const shell = (
  command: string,
  status: 'ok' | 'error',
  name = 'Bash',
): Turn => ({
  role: 'assistant',
  kind: 'tool_call',
  tool: { name, input: { command }, status },
});

function edit(lines: number, reverse = false): Turn {
  const oldValue = reverse ? 1 : 0;
  const newValue = 1 - oldValue;
  const block = (sign: string, n: number) =>
    Array.from(
      { length: lines },
      (_, i) => sign + 'export const item' + i + ' = ' + n + ';',
    );
  const patch = [
    `@@ -1,${lines} +1,${lines} @@`,
    ...block('-', oldValue),
    ...block('+', newValue),
  ].join('\n');
  return {
    role: 'assistant',
    kind: 'tool_call',
    tool: { name: 'Edit', input: { file_path: file }, status: 'ok' },
    diff: { path: file, patch, added: lines, removed: lines },
  };
}

function longSession(): Turn[] {
  const result: Turn[] = [prompt('fix')];
  // Cùng một prompt sinh nhiều lần gọi tool, có ít nhất năm lần thất bại.
  for (let i = 0; i < 40; i++)
    result.push(shell('pnpm test', i < 5 ? 'error' : 'ok'));
  for (let i = 0; i < 4; i++)
    result.push(interrupted(edit(12, i % 2 === 1)), prompt('sai rồi'));
  result.push(
    { role: 'system', kind: 'compaction' },
    { role: 'system', kind: 'compaction' },
  );
  for (let i = 0; i < 40; i++)
    result.push(
      prompt('Giải thích cách bộ tính tổng xử lý trường hợp dữ liệu rỗng?'),
      i % 2 === 0
        ? interrupted(reply('Tổng của danh sách rỗng là 0.'))
        : reply('Tổng của danh sách rỗng là 0.'),
    );
  result.push(
    prompt(
      Array.from({ length: 42 }, (_, i) => 'Error: demo stack frame ' + i).join(
        '\n',
      ),
    ),
  );
  for (let i = 0; i < 10; i++) result.push(prompt('fix'), reply('Đã thử lại.'));
  return result;
}

function uncheckedEdit(): Turn[] {
  return [
    prompt('sửa đi'),
    interrupted(edit(12)),
    prompt('tiếp đi'),
    reply('Đang thử cách khác.'),
    prompt('sai rồi'),
    edit(250),
  ];
}

function reviewedEdit(): Turn[] {
  return [
    prompt(
      'Theo docs/spec.md, sửa src/total.ts. Yêu cầu: danh sách rỗng phải trả về 0.',
    ),
    { ...edit(12), tool: { name: 'apply_patch', status: 'ok' } },
    shell('pnpm test', 'ok', 'shell'),
    reply('Các kiểm thử của src/total.ts đều đạt.'),
    prompt('Đối chiếu src/total.ts với tiêu chí trong docs/spec.md.'),
    reply('Đã kiểm tra trường hợp rỗng.'),
  ];
}

/** Ba tuần UTC đã kết thúc; khóa dữ liệu ổn định kể cả khi chạy lại vào tuần khác. */
export function scoringFixtures(now: Date) {
  const monday = new Date(now);
  monday.setUTCHours(9, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 21);
  const fixtures = [];
  for (let member = 1; member <= 2; member++) {
    for (let week = 0; week < 3; week++) {
      const needsReview =
        (member === 1 && week < 2) || (member === 2 && week === 2);
      for (let day = 0; day < 6; day++) {
        const long = needsReview && day === 0;
        const scenario = long
          ? longSession()
          : needsReview
            ? uncheckedEdit()
            : reviewedEdit();
        const startedAt = new Date(
          monday.getTime() + (week * 7 + day) * 86_400_000 + member * 3_600_000,
        );
        const model = needsReview ? 'claude-opus-4-6' : 'gpt-5-codex';
        fixtures.push({
          // Từ Mốc 1.5 member không có email; seed chung đặt tên "Thành viên 1", "Thành viên 2".
          memberName: `Thành viên ${member}`,
          sourceId: `scoring-demo:v1:m${member}:w${week + 1}:d${day + 1}`,
          agent: needsReview ? 'claude_code' : 'codex',
          startedAt,
          permissionMode: needsReview
            ? ('bypass' as const)
            : ('default' as const),
          instructionFiles: long
            ? [{ path: 'CLAUDE.md', bytes: 5200 }]
            : needsReview
              ? []
              : [{ path: 'AGENTS.md', bytes: 600 }],
          turns: scenario.map((turn, seq) => ({
            ...turn,
            seq,
            model,
            ts: new Date(
              startedAt.getTime() + seq * (needsReview ? 5000 : 60_000),
            ),
          })),
        });
      }
    }
  }
  return fixtures;
}
