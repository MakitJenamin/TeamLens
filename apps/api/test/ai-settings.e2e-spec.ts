import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { sha256 } from '../src/common/crypto.js';
import { LLM_ADAPTERS } from '../src/modules/llm/adapters/adapter.js';
import {
  FakeLlmAdapter,
  fakeAdapters,
} from '../src/modules/llm/adapters/fake.adapter.js';
import { llmError } from '../src/modules/llm/llm-errors.js';
import { setupApp } from '../src/setup-app.js';
import {
  insertDevice,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const PASSWORD = 'matkhau-dai-123';

describe('Cài đặt AI: /api/v1/me/llm-key, /api/v1/me/agent-tokens (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  const fake = new FakeLlmAdapter();
  let leader: ReturnType<typeof request.agent>;
  let member: ReturnType<typeof request.agent>;
  let memberId: string;

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
    server = app.getHttpServer();

    await insertUser({
      email: 'leader@ai.local',
      name: 'Leader',
      role: 'leader',
      password: PASSWORD,
    });
    leader = request.agent(server);
    await leader
      .post('/api/v1/auth/login')
      .send({ email: 'leader@ai.local', password: PASSWORD })
      .expect(200);

    // Member không có mật khẩu: vào dashboard bằng `tl open` (web-login → auth/ticket).
    memberId = await insertUser({ email: null, name: 'Thành viên' });
    const { token } = await insertDevice(memberId, 'MEMBER-PC');
    const ticketRes = await request(server)
      .post('/agent/v1/web-login')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    member = request.agent(server);
    await member
      .post('/api/v1/auth/ticket')
      .send({
        ticket: new URL(ticketRes.body.url as string).searchParams.get(
          'ticket',
        ),
      })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => fake.reset());

  it('chưa đăng nhập → 401', async () => {
    await request(server).get('/api/v1/me/llm-key').expect(401);
    await request(server).get('/api/v1/me/agent-tokens').expect(401);
  });

  describe('llm-key', () => {
    it('leader và member mỗi người một key, không thấy của nhau, GET không trả key', async () => {
      expect((await leader.get('/api/v1/me/llm-key').expect(200)).body).toEqual(
        { key: null },
      );

      const put = await leader
        .put('/api/v1/me/llm-key')
        .send({
          provider: 'anthropic',
          model: 'claude-sonnet',
          apiKey: 'sk-ant-leader-SECRET-a1B2',
        })
        .expect(200);
      expect(put.body).toEqual({
        key: {
          provider: 'anthropic',
          baseUrl: null,
          model: 'claude-sonnet',
          keyHint: '…a1B2',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      });

      await member
        .put('/api/v1/me/llm-key')
        .send({
          provider: 'openai_compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen2.5:3b',
          apiKey: '',
        })
        .expect(200);

      const leaderKey = await leader.get('/api/v1/me/llm-key').expect(200);
      const memberKey = await member.get('/api/v1/me/llm-key').expect(200);
      expect(leaderKey.body.key.model).toBe('claude-sonnet');
      expect(memberKey.body.key).toMatchObject({
        provider: 'openai_compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen2.5:3b',
        keyHint: '',
      });
      expect(JSON.stringify(leaderKey.body)).not.toContain('SECRET');
      expect(put.text).not.toContain('SECRET');

      // DB chỉ có bản mã hóa.
      const rows = await querySql<{ key_encrypted: string }>(
        'SELECT key_encrypted FROM user_llm_keys',
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.key_encrypted).not.toContain('SECRET');

      // Member xóa key của mình: key leader còn nguyên.
      await member.delete('/api/v1/me/llm-key').expect(204);
      await member.delete('/api/v1/me/llm-key').expect(204);
      expect((await member.get('/api/v1/me/llm-key').expect(200)).body).toEqual(
        { key: null },
      );
      expect(
        (await leader.get('/api/v1/me/llm-key').expect(200)).body.key,
      ).not.toBeNull();
    });

    it('PUT bỏ trống apiKey giữ key cũ; validate body', async () => {
      await leader
        .put('/api/v1/me/llm-key')
        .send({ provider: 'anthropic', model: 'claude-haiku' })
        .expect(200);
      const key = await leader.get('/api/v1/me/llm-key').expect(200);
      expect(key.body.key).toMatchObject({
        model: 'claude-haiku',
        keyHint: '…a1B2',
      });

      // Chưa có key mà không gửi apiKey.
      const missing = await member
        .put('/api/v1/me/llm-key')
        .send({ provider: 'anthropic', model: 'm' })
        .expect(400);
      expect(missing.body.error).toBe('validation_error');
      // openai_compatible thiếu baseUrl, baseUrl sai, trường lạ, provider lạ.
      for (const body of [
        { provider: 'openai_compatible', model: 'm', apiKey: 'k' },
        { provider: 'openai_compatible', baseUrl: 'ftp://x', model: 'm' },
        { provider: 'anthropic', model: 'm', apiKey: 'k', userId: memberId },
        { provider: 'gemini', model: 'm', apiKey: 'k' },
        { provider: 'anthropic', model: '  ', apiKey: 'k' },
      ]) {
        const res = await member.put('/api/v1/me/llm-key').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('validation_error');
      }
    });

    it('POST /test dùng adapter, trường thiếu lấy từ key đã lưu, lỗi theo mã llm_*', async () => {
      fake.enqueue({ ok: true });
      const ok = await leader
        .post('/api/v1/me/llm-key/test')
        .send({})
        .expect(200);
      expect(ok.body).toEqual({
        ok: true,
        provider: 'anthropic',
        model: 'claude-haiku',
        latencyMs: expect.any(Number),
      });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({
        apiKey: 'sk-ant-leader-SECRET-a1B2',
        model: 'claude-haiku',
      });

      // Cấu hình gửi lên ghi đè, không lưu gì.
      fake.enqueue({ ok: true });
      await leader
        .post('/api/v1/me/llm-key/test')
        .send({ model: 'claude-other', apiKey: 'sk-new-key-0000' })
        .expect(200);
      expect(fake.calls[1]).toMatchObject({
        apiKey: 'sk-new-key-0000',
        model: 'claude-other',
      });
      expect(
        (await leader.get('/api/v1/me/llm-key').expect(200)).body.key.model,
      ).toBe('claude-haiku');

      fake.enqueue(llmError('llm_key_invalid'));
      const invalid = await leader
        .post('/api/v1/me/llm-key/test')
        .send({})
        .expect(422);
      expect(invalid.body.error).toBe('llm_key_invalid');

      // Member chưa có key → 409, không gọi provider.
      const missing = await member
        .post('/api/v1/me/llm-key/test')
        .send({})
        .expect(409);
      expect(missing.body.error).toBe('llm_key_missing');
      expect(fake.calls).toHaveLength(3);

      // Member thử cấu hình Ollama chưa lưu, key rỗng.
      fake.enqueue({ ok: true });
      const ollama = await member
        .post('/api/v1/me/llm-key/test')
        .send({
          provider: 'openai_compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen2.5:3b',
          apiKey: '',
        })
        .expect(200);
      expect(ollama.body.provider).toBe('openai_compatible');
      expect(fake.calls[3]).toMatchObject({
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
      });
    });
  });

  describe('agent-tokens', () => {
    it('tạo, liệt kê, thu hồi; token người khác → 404', async () => {
      expect(
        (await member.get('/api/v1/me/agent-tokens').expect(200)).body,
      ).toEqual({ tokens: [] });

      const first = await member
        .post('/api/v1/me/agent-tokens')
        .send({ name: '  Claude Code trên laptop ' })
        .expect(201);
      expect(first.body).toEqual({
        token: {
          id: expect.any(String),
          name: 'Claude Code trên laptop',
          lastUsedAt: null,
          createdAt: expect.any(String),
          revokedAt: null,
        },
        secret: expect.stringMatching(/^tlp_[\w-]{43}$/),
      });
      const second = await member
        .post('/api/v1/me/agent-tokens')
        .send({ name: 'Codex' })
        .expect(201);
      const leaderToken = await leader
        .post('/api/v1/me/agent-tokens')
        .send({ name: 'Leader agent' })
        .expect(201);

      // DB chỉ lưu SHA-256.
      const [row] = await querySql<{ token_hash: string }>(
        'SELECT token_hash FROM agent_tokens WHERE id = $1',
        [first.body.token.id as string],
      );
      expect(row.token_hash).toBe(sha256(first.body.secret as string));

      const list = await member.get('/api/v1/me/agent-tokens').expect(200);
      expect(list.text).not.toContain('tlp_');
      expect(
        (list.body.tokens as { name: string }[]).map((t) => t.name),
      ).toEqual(['Codex', 'Claude Code trên laptop']);
      expect(
        (
          (await leader.get('/api/v1/me/agent-tokens').expect(200)).body
            .tokens as { name: string }[]
        ).map((t) => t.name),
      ).toEqual(['Leader agent']);

      // Token của người khác (kể cả leader thu hồi token của member) → 404.
      await leader
        .delete(`/api/v1/me/agent-tokens/${first.body.token.id}`)
        .expect(404);
      await member
        .delete(`/api/v1/me/agent-tokens/${leaderToken.body.token.id}`)
        .expect(404);
      await member
        .delete(`/api/v1/me/agent-tokens/${randomUUID()}`)
        .expect(404);
      await member
        .delete('/api/v1/me/agent-tokens/khong-phai-uuid')
        .expect(404);

      await member
        .delete(`/api/v1/me/agent-tokens/${second.body.token.id}`)
        .expect(204);
      // Thu hồi lần nữa → 404.
      await member
        .delete(`/api/v1/me/agent-tokens/${second.body.token.id}`)
        .expect(404);
      const after = await member.get('/api/v1/me/agent-tokens').expect(200);
      expect(after.body.tokens).toHaveLength(1);
      expect(after.body.tokens[0].id).toBe(first.body.token.id);
      const [revoked] = await querySql<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM agent_tokens WHERE id = $1',
        [second.body.token.id as string],
      );
      expect(revoked.revoked_at).not.toBeNull();
    });

    it('validate tên token', async () => {
      for (const body of [{}, { name: '   ' }, { name: 'x'.repeat(101) }]) {
        const res = await member.post('/api/v1/me/agent-tokens').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('validation_error');
      }
    });
  });
});
