import { decodeCursor, encodeCursor, mapTurn } from './session-mappers.js';

const ID = '0f8f2b1c-1d2e-4f3a-9b4c-5d6e7f8a9b0c';

describe('cursor', () => {
  it('mã hóa rồi giải mã giữ nguyên micro giây và id', () => {
    const cursor = { startedAt: '2026-11-20T08:00:00.123456Z', id: ID };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'khong-phai-base64-json',
    Buffer.from('"chuoi"').toString('base64url'),
    Buffer.from(JSON.stringify({ s: 'hôm qua', i: ID })).toString('base64url'),
    Buffer.from(
      JSON.stringify({ s: '2026-11-20T08:00:00Z', i: 'x; DROP' }),
    ).toString('base64url'),
  ])('cursor sai dạng trả 400 validation_error: %s', (raw) => {
    expect(() => decodeCursor(raw)).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({ error: 'validation_error' }),
      }),
    );
  });
});

describe('mapTurn', () => {
  const base = {
    seq: 3,
    role: 'assistant' as const,
    kind: 'tool_call' as const,
    ts: new Date('2026-11-20T08:01:00.000Z'),
    model: 'claude-opus-5-5',
    text: null,
    tool: null,
    output: null,
    diff: null,
    usage: null,
    attachments: null,
    redactions: null,
    interrupted: false,
    reasoningEffort: null,
  };

  it('đổi jsonb snake_case sang camelCase của contract', () => {
    const turn = mapTurn({
      ...base,
      tool: { name: 'Bash', input: { command: 'pnpm test' }, status: 'ok' },
      output: { text: 'ok', truncated: true, original_bytes: 9000 },
      diff: {
        path: 'a.ts',
        patch: '@@ -1 +1 @@\n-a\n+b',
        added: 1,
        removed: 1,
      },
      usage: { input: 10, output: 5, cache_read: 7 },
      attachments: [{ type: 'image', count: 2 }],
      redactions: [{ type: 'aws_access_key', count: 1 }],
      interrupted: true,
      reasoningEffort: 'high',
    });
    expect(turn).toEqual({
      seq: 3,
      role: 'assistant',
      kind: 'tool_call',
      ts: '2026-11-20T08:01:00.000Z',
      model: 'claude-opus-5-5',
      text: null,
      tool: { name: 'Bash', input: { command: 'pnpm test' }, status: 'ok' },
      output: { text: 'ok', truncated: true, originalBytes: 9000 },
      diff: {
        path: 'a.ts',
        patch: '@@ -1 +1 @@\n-a\n+b',
        added: 1,
        removed: 1,
      },
      usage: {
        input: 10,
        output: 5,
        cacheRead: 7,
        cacheWrite: 0,
        estimated: false,
      },
      attachments: [{ type: 'image', count: 2 }],
      redactions: [{ type: 'aws_access_key', count: 1 }],
      interrupted: true,
      reasoningEffort: 'high',
    });
  });

  it('trường thiếu thành null hoặc mảng rỗng', () => {
    const turn = mapTurn({
      ...base,
      tool: { name: 'Write' },
      output: { text: 'x', truncated: false },
    });
    expect(turn.tool).toEqual({ name: 'Write', input: null, status: null });
    expect(turn.output).toEqual({
      text: 'x',
      truncated: false,
      originalBytes: null,
    });
    expect(turn.diff).toBeNull();
    expect(turn.usage).toBeNull();
    expect(turn.attachments).toEqual([]);
    expect(turn.redactions).toEqual([]);
  });
});
