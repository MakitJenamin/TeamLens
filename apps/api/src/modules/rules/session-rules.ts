import type { RuleTurn, SessionRule } from './session-engine.js';

const prompt = (seq: number, text: string): RuleTurn => ({
  seq,
  text,
  role: 'user',
  kind: 'prompt',
});
const edit = (seq: number, added: number, removed: number): RuleTurn => ({
  seq,
  role: 'assistant',
  kind: 'tool_call',
  diff: { path: 'main.ts', added, removed },
});
const shell = (seq: number, command: string | string[]): RuleTurn => ({
  seq,
  role: 'assistant',
  kind: 'tool_call',
  tool: { name: 'shell', input: { command } },
});
const root = (...turns: RuleTurn[]) => ({ turns, parentSourceId: null });
const prompts = (n: number) =>
  Array.from({ length: n }, (_, i) => prompt(i, 'Tiếp tục.'));

export const sessionRules: SessionRule[] = [
  {
    key: 'repeated-correction',
    category: 'correction_loop',
    severity: 'high',
    scope: 'session',
    thresholds: { min: 3 },
    match: {
      op: 'consecutive',
      source: 'prompts',
      textRegex:
        "không đúng|vẫn lỗi|vẫn sai|sai rồi|chưa được|still (broken|wrong|failing)|doesn't work|not working",
    },
    message: 'Có {{count}} prompt liên tiếp báo kết quả vẫn sai.',
    advice: 'Mô tả kết quả mong đợi và cung cấp ví dụ tái hiện lỗi.',
    tests: [
      {
        name: 'ba lần phản bác xen kẽ phản hồi',
        input: root(
          prompt(0, 'Vẫn lỗi'),
          { seq: 1, role: 'assistant', kind: 'reply' },
          prompt(2, 'Still failing'),
          prompt(3, 'CHƯA ĐƯỢC'),
        ),
        expect: 'triggered',
      },
      {
        name: 'prompt bình thường ngắt chuỗi',
        input: root(
          prompt(0, 'vẫn sai'),
          prompt(1, 'sai rồi'),
          prompt(2, 'xong'),
          prompt(3, 'vẫn lỗi'),
        ),
        expect: 'clean',
      },
    ],
  },
  {
    key: 'mega-session',
    category: 'session_management',
    severity: 'medium',
    scope: 'session',
    thresholds: { min: 50 },
    match: { op: 'count', source: 'prompts' },
    message: 'Session có {{count}} prompt của người dùng.',
    advice:
      'Tách công việc tiếp theo sang session mới và tóm tắt ngữ cảnh cần giữ.',
    tests: [
      {
        name: 'đủ 50 prompt',
        input: root(...prompts(50)),
        expect: 'triggered',
      },
      {
        name: '49 prompt và một tool result',
        input: root(...prompts(49), {
          seq: 49,
          role: 'user',
          kind: 'tool_result',
        }),
        expect: 'clean',
      },
    ],
  },
  {
    key: 'no-test-after-edit',
    category: 'verification',
    severity: 'high',
    scope: 'session',
    thresholds: { min: 20 },
    match: {
      op: 'sumDiffWithoutCommand',
      // Nhận lệnh kiểm chứng ở đầu câu lệnh shell, kể cả sau cd ... &&.
      commandRegex: [
        String.raw`(?:^|&&|\|\||[;|\n])\s*(?:`,
        String.raw`(?:npm|pnpm|yarn|bun)(?:\s+--filter\s+[^\s;&|]+)*(?:\s+(?:run|exec))?\s+(?:test|build|lint|jest|vitest|tsc)`,
        String.raw`|(?:npx\s+)?(?:jest|vitest|tsc|eslint)|(?:python3?\s+-m\s+)?pytest`,
        String.raw`|go\s+(?:test|build)|cargo\s+(?:test|build|check|clippy)`,
        String.raw`|(?:\.\/)?(?:mvnw?|gradlew?)\s+(?:test|build|check|verify|package)|test|build|lint`,
        String.raw`)(?=$|[\s:;&|])`,
      ].join(''),
    },
    message:
      'Session sửa {{count}} dòng nhưng chưa ghi nhận lệnh test, build hoặc lint.',
    advice: 'Chạy lệnh kiểm chứng phù hợp và xem kết quả.',
    tests: [
      {
        name: 'cộng dòng thêm và xóa qua hai diff',
        input: root(edit(1, 8, 2), edit(2, 3, 7)),
        expect: 'triggered',
      },
      { name: '19 dòng', input: root(edit(1, 8, 11)), expect: 'clean' },
      {
        name: 'chạy pytest dạng argv',
        input: root(edit(1, 20, 0), shell(2, ['pytest', '-q'])),
        expect: 'clean',
      },
      {
        name: 'có build trong cùng phiên',
        input: root(shell(1, 'cd app && npm run build'), edit(2, 20, 0)),
        expect: 'clean',
      },
      {
        name: 'test package qua shell của Codex',
        input: root(
          edit(1, 20, 0),
          shell(2, ['bash', '-lc', 'pnpm --filter @teamlens/api test']),
        ),
        expect: 'clean',
      },
      {
        name: 'in chữ test không phải chạy test',
        input: root(edit(1, 20, 0), shell(2, 'echo test')),
        expect: 'triggered',
      },
    ],
  },
];
