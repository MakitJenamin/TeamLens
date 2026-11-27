import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApiError } from '../src/common/api-error.js';
import { AppModule } from '../src/app.module.js';
import { LLM_ADAPTERS } from '../src/modules/llm/adapters/adapter.js';
import {
  FakeLlmAdapter,
  fakeAdapters,
} from '../src/modules/llm/adapters/fake.adapter.js';
import { LlmKeyService } from '../src/modules/llm/llm-key.service.js';
import { LlmService } from '../src/modules/llm/llm.service.js';
import { setupApp } from '../src/setup-app.js';
import { insertUser, querySql, resetDatabase } from './helpers.js';

const schema = z.object({ title: z.string() });

async function errorOf(promise: Promise<unknown>): Promise<{
  status: number;
  error: string;
}> {
  try {
    await promise;
  } catch (error) {
    const apiError = error as ApiError;
    return {
      status: apiError.getStatus(),
      error: (apiError.getResponse() as { error: string }).error,
    };
  }
  throw new Error('không ném lỗi');
}

describe('Module llm (e2e, DB thật, adapter giả)', () => {
  let app: INestApplication;
  let llm: LlmService;
  let keys: LlmKeyService;
  const fake = new FakeLlmAdapter();
  let userId: string;

  beforeAll(async () => {
    await resetDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_ADAPTERS)
      .useValue(fakeAdapters(fake))
      .compile();
    app = setupApp(
      moduleRef.createNestApplication({ logger: ['error', 'warn'] }),
    );
    await app.init();
    llm = app.get(LlmService);
    keys = app.get(LlmKeyService);
    userId = await insertUser({ email: null, name: 'Thành viên AI' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => fake.reset());

  it('lưu key: bắt buộc apiKey lần đầu, baseUrl với openai_compatible', async () => {
    expect(
      await errorOf(
        keys.saveKey(userId, { provider: 'anthropic', model: 'claude-x' }),
      ),
    ).toEqual({ status: 400, error: 'validation_error' });
    expect(
      await errorOf(
        keys.saveKey(userId, {
          provider: 'openai_compatible',
          model: 'qwen',
          apiKey: 'sk-abc',
        }),
      ),
    ).toEqual({ status: 400, error: 'validation_error' });
    expect(await keys.getKeyInfo(userId)).toBeNull();
    expect(await llm.hasKey(userId)).toBe(false);
  });

  it('lưu key mã hóa, trả gợi ý 4 ký tự cuối; bỏ trống apiKey thì giữ key cũ', async () => {
    const saved = await keys.saveKey(userId, {
      provider: 'anthropic',
      model: 'claude-x',
      apiKey: 'sk-ant-secret-WXYZ',
    });
    expect(saved).toMatchObject({
      provider: 'anthropic',
      baseUrl: null,
      model: 'claude-x',
      keyHint: '…WXYZ',
    });
    const [row] = await querySql<{ key_encrypted: string }>(
      'SELECT key_encrypted FROM user_llm_keys WHERE user_id = $1',
      [userId],
    );
    expect(row.key_encrypted).not.toContain('secret');

    const updated = await keys.saveKey(userId, {
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:3b',
    });
    expect(updated.keyHint).toBe('…WXYZ');
    expect(await keys.getDecryptedKey(userId)).toEqual({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:3b',
      apiKey: 'sk-ant-secret-WXYZ',
    });
  });

  it('openai_compatible cho phép key rỗng (Ollama)', async () => {
    const saved = await keys.saveKey(userId, {
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:3b',
      apiKey: '',
    });
    expect(saved.keyHint).toBe('');
    expect((await keys.getDecryptedKey(userId))?.apiKey).toBe('');
  });

  it('run lưu ai_results, chạy lại thì ghi đè cùng bản ghi; findResults chỉ trả của người gọi', async () => {
    const subjectId = randomUUID();
    const task = {
      kind: 'session_summary' as const,
      subjectType: 'session' as const,
      subjectId,
      subjectUserId: userId,
      locale: 'vi' as const,
      promptVersion: 'session_summary@1',
      system: 'Tóm tắt',
      untrusted: [{ label: 'turn 1', content: 'nội dung' }],
      schema,
    };
    fake.enqueue({ title: 'lần 1' });
    const first = await llm.run(userId, task);
    expect(first.result).toEqual({ title: 'lần 1' });

    fake.enqueue({ title: 'lần 2' });
    const second = await llm.run(userId, task);
    expect(second.id).toBe(first.id);
    expect(second.result).toEqual({ title: 'lần 2' });
    expect(second.createdAt.getTime()).toBeGreaterThanOrEqual(
      first.createdAt.getTime(),
    );

    const [{ count }] = await querySql<{ count: string }>(
      'SELECT count(*) FROM ai_results WHERE subject_id = $1',
      [subjectId],
    );
    expect(Number(count)).toBe(1);

    const mine = await llm.findResults(userId, {
      subjectType: 'session',
      subjectIds: [subjectId],
      locale: 'vi',
    });
    expect(mine.map((r) => r.result)).toEqual([{ title: 'lần 2' }]);
    const otherUser = await insertUser({ email: null, name: 'Người khác' });
    expect(
      await llm.findResults(otherUser, {
        subjectType: 'session',
        subjectIds: [subjectId],
      }),
    ).toEqual([]);
    expect(
      await llm.findResults(userId, {
        subjectType: 'session',
        subjectIds: [subjectId],
        locale: 'en',
      }),
    ).toEqual([]);
  });

  it('xóa key thì run báo llm_key_missing (409)', async () => {
    await keys.deleteKey(userId);
    expect(await keys.getKeyInfo(userId)).toBeNull();
    expect(
      await errorOf(
        llm.run(userId, {
          kind: 'session_summary',
          subjectType: 'session',
          subjectId: randomUUID(),
          locale: 'vi',
          promptVersion: 'x@1',
          system: 'x',
          untrusted: [],
          schema,
        }),
      ),
    ).toEqual({ status: 409, error: 'llm_key_missing' });
  });
});
