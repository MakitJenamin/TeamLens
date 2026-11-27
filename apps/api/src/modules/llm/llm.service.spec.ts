import { z } from 'zod';
import type { ApiError } from '../../common/api-error.js';
import type { Database } from '../../db/client.js';
import {
  FAKE_HANG,
  FakeLlmAdapter,
  fakeAdapters,
} from './adapters/fake.adapter.js';
import type { LlmKeyService } from './llm-key.service.js';
import { llmError } from './llm-errors.js';
import { LlmService } from './llm.service.js';
import type { LlmKeyConfig, LlmTask } from './llm.types.js';

const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION = '33333333-3333-4333-8333-333333333333';

const KEY: LlmKeyConfig = {
  provider: 'openai_compatible',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5:3b',
  apiKey: 'sk-secret-key',
};

const schema = z.object({ title: z.string(), count: z.number().int() });

function task(): LlmTask<z.infer<typeof schema>> {
  return {
    kind: 'session_summary',
    subjectType: 'session',
    subjectId: SESSION,
    subjectUserId: USER,
    locale: 'vi',
    promptVersion: 'session_summary@1',
    system: 'Tóm tắt session.',
    untrusted: [{ label: 'turn 1', content: 'sửa bug login' }],
    schema,
  };
}

/** DB giả: ghi lại lệnh insert/upsert, `returning()` trả bản ghi dựng từ values. */
function fakeDb() {
  const inserts: {
    values: Record<string, unknown>;
    conflict: { target: unknown[]; set: Record<string, unknown> };
  }[] = [];
  const db = {
    insert: () => {
      const entry = {
        values: {},
        conflict: { target: [], set: {} },
      } as (typeof inserts)[number];
      inserts.push(entry);
      const chain = {
        values: (values: Record<string, unknown>) => {
          entry.values = values;
          return chain;
        },
        onConflictDoUpdate: (
          conflict: (typeof inserts)[number]['conflict'],
        ) => {
          entry.conflict = conflict;
          return chain;
        },
        returning: () => Promise.resolve([{ id: 'r1', ...entry.values }]),
      };
      return chain;
    },
  } as unknown as Database;
  return { db, inserts };
}

function setup(key: LlmKeyConfig | null = KEY, timeoutMs?: number) {
  const fake = new FakeLlmAdapter();
  const { db, inserts } = fakeDb();
  const keys = {
    getDecryptedKey: vi.fn().mockResolvedValue(key),
    hasKey: vi.fn().mockResolvedValue(key !== null),
  } as unknown as LlmKeyService;
  const service = new LlmService(db, keys, fakeAdapters(fake), timeoutMs);
  return { service, fake, inserts };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as ApiError).getResponse() as { error: string }).error;
  }
  throw new Error('không ném lỗi');
}

describe('LlmService.run', () => {
  it('thành công: gọi adapter với prompt đã bọc, lưu và trả kết quả đã validate', async () => {
    const { service, fake, inserts } = setup();
    fake.enqueue('```json\n{"title":"Sửa bug","count":2}\n```');
    const row = await service.run(USER, task());

    expect(row.result).toEqual({ title: 'Sửa bug', count: 2 });
    expect(row.provider).toBe('openai_compatible');
    expect(row.model).toBe('qwen2.5:3b');
    expect(row.inputTokens).toBe(10);
    expect(row.outputTokens).toBe(5);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.apiKey).toBe('sk-secret-key');
    expect(call.system).toContain('SECURITY NOTICE');
    expect(call.system).toContain('Tóm tắt session.');
    expect(call.user).toContain('<untrusted_data label="turn 1">');
    expect(call.jsonSchema).toMatchObject({
      type: 'object',
      required: ['title', 'count'],
    });
    expect(call.jsonSchema).not.toHaveProperty('$schema');
    expect(call.maxOutputTokens).toBe(2048);

    expect(inserts[0].values).toMatchObject({
      userId: USER,
      kind: 'session_summary',
      subjectType: 'session',
      subjectId: SESSION,
      subjectUserId: USER,
      locale: 'vi',
      promptVersion: 'session_summary@1',
    });
  });

  it('ghi đè: upsert theo unique (người bấm, kind, đối tượng, locale) và đổi created_at', async () => {
    const { service, fake, inserts } = setup();
    fake.enqueue({ title: 'a', count: 1 });
    await service.run(USER, task());
    const { conflict } = inserts[0];
    expect(conflict.target).toHaveLength(5);
    expect(conflict.set).toMatchObject({ result: { title: 'a', count: 1 } });
    expect(conflict.set.createdAt).toBeInstanceOf(Date);
  });

  it('sai schema thì thử lại 1 lần, lần sau đúng thì thành công và cộng token', async () => {
    const { service, fake } = setup();
    fake.enqueue({ title: 'a' }, { title: 'b', count: 3 });
    const row = await service.run(USER, task());
    expect(fake.calls).toHaveLength(2);
    expect(row.result).toEqual({ title: 'b', count: 3 });
    expect(row.inputTokens).toBe(20);
  });

  it('sai schema hai lần (hoặc không phải JSON) thì llm_bad_output và không lưu', async () => {
    const { service, fake, inserts } = setup();
    fake.enqueue('xin chào', { title: 'a', count: 'x' });
    expect(await errorCode(service.run(USER, task()))).toBe('llm_bad_output');
    expect(fake.calls).toHaveLength(2);
    expect(inserts).toHaveLength(0);
  });

  it('chưa có key thì llm_key_missing, không gọi adapter', async () => {
    const { service, fake } = setup(null);
    expect(await errorCode(service.run(USER, task()))).toBe('llm_key_missing');
    expect(fake.calls).toHaveLength(0);
  });

  it('quá thời gian chờ thì llm_timeout và hủy signal', async () => {
    const { service, fake } = setup(KEY, 20);
    fake.enqueue(FAKE_HANG);
    expect(await errorCode(service.run(USER, task()))).toBe('llm_timeout');
    expect(fake.calls[0].signal.aborted).toBe(true);
  });

  it('lỗi LLM của adapter giữ nguyên mã, lỗi lạ thành llm_provider_error', async () => {
    const { service, fake } = setup();
    fake.enqueue(llmError('llm_key_invalid'), new TypeError('fetch failed'));
    expect(await errorCode(service.run(USER, task()))).toBe('llm_key_invalid');
    expect(await errorCode(service.run(USER, task()))).toBe(
      'llm_provider_error',
    );
  });
});

describe('LlmService.testKey', () => {
  it('trả latency khi model trả {ok}', async () => {
    const { service, fake } = setup();
    fake.enqueue({ ok: true });
    const result = await service.testKey(KEY);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fake.calls[0].jsonSchema).toMatchObject({ required: ['ok'] });
  });

  it('báo lỗi của provider', async () => {
    const { service, fake } = setup();
    fake.enqueue(llmError('llm_model_not_found'));
    expect(await errorCode(service.testKey(KEY))).toBe('llm_model_not_found');
  });
});
