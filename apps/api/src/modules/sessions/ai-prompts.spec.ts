import {
  dropUnknownSeqs,
  explainBlocks,
  formatTurn,
  formatTurns,
  type PromptTurn,
  sessionBlocks,
  summarizeTool,
  turnsAround,
} from './ai-prompts.js';

const turn = (seq: number, extra: Partial<PromptTurn> = {}): PromptTurn => ({
  seq,
  role: 'user',
  kind: 'prompt',
  text: `prompt ${seq}`,
  tool: null,
  output: null,
  diff: null,
  interrupted: false,
  ...extra,
});

describe('ai-prompts', () => {
  it('tóm gọn tool: tên kèm đường dẫn hoặc lệnh, không đưa cả input', () => {
    expect(
      summarizeTool({
        name: 'Edit',
        input: { file_path: 'src/a.ts', old_string: 'bí mật dài' },
      }),
    ).toBe('Edit src/a.ts');
    expect(
      summarizeTool({
        name: 'shell',
        input: { command: ['pnpm', 'test'] },
        status: 'error',
      }),
    ).toBe('shell pnpm test (lỗi)');
    expect(summarizeTool(null)).toBeNull();
  });

  it('mỗi turn mở đầu bằng [seq N], diff tóm gọn', () => {
    const line = formatTurn(
      turn(4, {
        role: 'assistant',
        kind: 'tool_call',
        text: null,
        tool: { name: 'Edit', input: { file_path: 'a.ts' } },
        diff: { path: 'a.ts', added: 3, removed: 1, patch: 'x'.repeat(2000) },
      }),
    );
    expect(
      line.startsWith('[seq 4] assistant/tool_call: tool: Edit a.ts'),
    ).toBe(true);
    expect(line).toContain('diff: a.ts (+3 -1)');
    expect(line).toContain('[cắt 1400 ký tự]');
  });

  it('cắt theo ngân sách: giữ đầu và cuối, ghi rõ đã cắt', () => {
    const turns = Array.from({ length: 100 }, (_, i) =>
      turn(i, { text: 'y'.repeat(90) }),
    );
    const text = formatTurns(turns, 2_000);
    expect(text.length).toBeLessThanOrEqual(2_200);
    expect(text).toContain('[seq 0]');
    expect(text).toContain('[seq 99]');
    expect(text).toMatch(/đã cắt \d+ turn ở giữa \(seq \d+–\d+\)/);
    expect(formatTurns(turns.slice(0, 3))).not.toContain('đã cắt');
  });

  it('A1/A5: ba khối session, turns, findings', () => {
    const blocks = sessionBlocks(
      {
        agent: 'codex',
        repoRemote: 'github.com/a/b',
        branch: null,
        turnCount: 1,
      },
      [turn(0)],
      [{ ruleKey: 'mega-session', message: 'Nhiều prompt', turnSeq: 0 }],
    );
    expect(blocks.map((b) => b.label)).toEqual([
      'session',
      'turns',
      'findings',
    ]);
    expect(blocks[2].content).toBe('- mega-session [seq 0]: Nhiều prompt');
  });

  it('A4: turn quanh turnSeq, không có thì đầu và cuối', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(i));
    expect(turnsAround(turns, 10).map((t) => t.seq)).toEqual([
      7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(turnsAround(turns, 1).map((t) => t.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(turnsAround(turns, null).map((t) => t.seq)).toEqual([
      0, 1, 2, 3, 16, 17, 18, 19,
    ]);
    const blocks = explainBlocks(
      {
        ruleKey: 'repeated-correction',
        definition: { key: 'repeated-correction', tests: [{ big: true }] },
        message: 'Có 3 prompt',
        advice: 'Mô tả kết quả mong đợi',
        evidence: { count: 3 },
        turnSeq: 10,
      },
      turns,
    );
    expect(blocks[0].content).toContain('advice: Mô tả kết quả mong đợi');
    expect(blocks[0].content).not.toContain('tests');
    expect(blocks[2].content).toContain('[seq 13]');
    expect(blocks[2].content).not.toContain('[seq 14]');
  });

  it('hậu kiểm bỏ seq không có trong session', () => {
    const result = dropUnknownSeqs(
      {
        title: 't',
        keyTurns: [
          { seq: 1, note: 'a' },
          { seq: 99, note: 'bịa' },
        ],
      },
      new Set([0, 1]),
    );
    expect(result).toEqual({ title: 't', keyTurns: [{ seq: 1, note: 'a' }] });
  });
});
