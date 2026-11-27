import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { LLM_ADAPTERS } from '../src/modules/llm/adapters/adapter.js';
import {
  FakeLlmAdapter,
  fakeAdapters,
} from '../src/modules/llm/adapters/fake.adapter.js';
import { LlmKeyService } from '../src/modules/llm/llm-key.service.js';
import { setupApp } from '../src/setup-app.js';
import { insertUser, querySql, resetDatabase } from './helpers.js';

const PASSWORD = 'teamlens123';
const MISSING = '99999999-9999-4999-8999-999999999999';

const summary = (title: string) => ({
  title,
  summary: 'Sửa lỗi đăng nhập.',
  workType: 'bugfix',
  outcome: 'Xong.',
  filesTouched: ['src/login.ts'],
  keyTurns: [
    { seq: 0, note: 'yêu cầu' },
    { seq: 42, note: 'turn bịa' },
  ],
});

// Nút AI trên trang session (M6.5, M6.6): quyền, audit, ghi đè, kết quả riêng từng người.
describe('Session AI (e2e, adapter giả)', () => {
  let app: INestApplication<App>;
  let server: App;
  const fake = new FakeLlmAdapter();
  let leaderId: string;
  let member1: string;
  let member2: string;
  let session1: string;
  let session2: string;
  let findingId: string;

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

    await request(server)
      .post('/api/v1/setup')
      .send({
        email: 'leader@teamlens.local',
        name: 'Leader',
        password: PASSWORD,
      })
      .expect(201);
    const [leader] = await querySql<{ id: string }>(
      `SELECT id FROM users WHERE email = 'leader@teamlens.local'`,
    );
    leaderId = leader.id;
    member1 = await insertUser({
      email: 'm1@teamlens.local',
      name: 'm1',
      password: PASSWORD,
    });
    member2 = await insertUser({
      email: 'm2@teamlens.local',
      name: 'm2',
      password: PASSWORD,
    });
    const [project] = await querySql<{ id: string }>(
      `INSERT INTO projects (name, slug) VALUES ('P', 'p') RETURNING id`,
    );
    const started = '2026-11-20T08:00:00.000Z';
    await querySql(`SELECT ensure_turns_partitions($1::timestamptz, 0)`, [
      started,
    ]);
    const insertSession = async (userId: string, sourceId: string) => {
      const [row] = await querySql<{ id: string }>(
        `INSERT INTO sessions (user_id, project_id, source_id, agent, repo_remote, started_at, turn_count)
         VALUES ($1, $2, $3, 'claude_code', 'github.com/acme/app', $4::timestamptz, 6) RETURNING id`,
        [userId, project.id, sourceId, started],
      );
      for (let seq = 0; seq < 6; seq += 1)
        await querySql(
          `INSERT INTO turns (session_id, seq, role, kind, ts, text, tool)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::jsonb)`,
          [
            row.id,
            seq,
            seq % 2 === 0 ? 'user' : 'assistant',
            seq % 2 === 0 ? 'prompt' : 'tool_call',
            started,
            seq % 2 === 0 ? `vẫn lỗi lần ${seq}` : null,
            seq % 2 === 0
              ? null
              : JSON.stringify({
                  name: 'Edit',
                  input: { file_path: 'src/login.ts' },
                }),
          ],
        );
      return row.id;
    };
    session1 = await insertSession(member1, 'claude_code:s1');
    session2 = await insertSession(member2, 'claude_code:s2');

    // Rule mặc định có thể đã được seed lúc khởi động app: dùng lại nếu có.
    const [rule] = await querySql<{ id: string }>(
      `INSERT INTO rules (key, category, severity, definition)
       VALUES ('repeated-correction', 'correction_loop', 'high', $1::jsonb)
       ON CONFLICT ON CONSTRAINT rules_project_key_uq DO UPDATE SET key = EXCLUDED.key
       RETURNING id`,
      [
        JSON.stringify({
          key: 'repeated-correction',
          message: 'Có {{count}} prompt liên tiếp báo kết quả vẫn sai.',
          advice: 'Mô tả kết quả mong đợi và cung cấp ví dụ tái hiện lỗi.',
          tests: [],
        }),
      ],
    );
    const [finding] = await querySql<{ id: string }>(
      `INSERT INTO findings (session_id, rule_id, rule_version, turn_seq, evidence)
       VALUES ($1, $2, 1, 4, $3::jsonb) RETURNING id`,
      [
        session1,
        rule.id,
        JSON.stringify({
          count: 3,
          message: 'Có 3 prompt liên tiếp báo kết quả vẫn sai.',
          severity: 'high',
        }),
      ],
    );
    findingId = finding.id;

    const keys = app.get(LlmKeyService);
    for (const id of [leaderId, member1, member2])
      await keys.saveKey(id, {
        provider: 'anthropic',
        model: 'claude-test',
        apiKey: 'sk-test-0000',
      });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => fake.reset());

  async function loginAs(email: string) {
    const agent = request.agent(server);
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return agent;
  }

  const aiAudits = async (sessionId: string) =>
    querySql<{ actor_id: string }>(
      `SELECT actor_id FROM audit_log WHERE action = 'session.ai' AND target_id = $1`,
      [sessionId],
    );

  it('member tóm tắt session của mình: turn ở khối untrusted, seq bịa bị lọc', async () => {
    const m1 = await loginAs('m1@teamlens.local');
    fake.enqueue(summary('Lần 1'));
    const res = await m1
      .post(`/api/v1/sessions/${session1}/ai/summary`)
      .send({ locale: 'vi' })
      .expect(200);
    expect(res.body).toMatchObject({
      kind: 'session_summary',
      subjectType: 'session',
      subjectId: session1,
      locale: 'vi',
      model: 'claude-test',
      promptVersion: 'session_summary@1',
      result: { title: 'Lần 1', keyTurns: [{ seq: 0, note: 'yêu cầu' }] },
    });
    const call = fake.calls[0];
    expect(call.system).not.toContain('vẫn lỗi lần');
    expect(call.user).toContain('[seq 4] user/prompt: vẫn lỗi lần 4');
    expect(call.user).toContain('tool: Edit src/login.ts');
    expect(call.user).toContain('repeated-correction [seq 4]');
    expect(await aiAudits(session1)).toEqual([]);

    const [row] = await querySql<{ subject_user_id: string }>(
      `SELECT subject_user_id FROM ai_results WHERE subject_id = $1`,
      [session1],
    );
    expect(row.subject_user_id).toBe(member1);
  });

  it('bấm lại ghi đè: vẫn một dòng ai_results', async () => {
    const m1 = await loginAs('m1@teamlens.local');
    fake.enqueue(summary('Lần 2'));
    await m1
      .post(`/api/v1/sessions/${session1}/ai/summary`)
      .send({ locale: 'vi' })
      .expect(200);
    const rows = await querySql<{ title: string }>(
      `SELECT result->>'title' AS title FROM ai_results
       WHERE user_id = $1 AND kind = 'session_summary' AND subject_id = $2`,
      [member1, session1],
    );
    expect(rows).toEqual([{ title: 'Lần 2' }]);
  });

  it('member gọi trên session người khác: lỗi như route xem session; id lạ 404', async () => {
    const m1 = await loginAs('m1@teamlens.local');
    const view = await m1.get(`/api/v1/sessions/${session2}`);
    for (const path of ['ai/summary', 'ai/outcome']) {
      const res = await m1
        .post(`/api/v1/sessions/${session2}/${path}`)
        .send({ locale: 'vi' });
      expect(res.status).toBe(view.status);
      expect(res.body.error).toBe(view.body.error);
    }
    expect(view.status).toBe(403);
    await m1.get(`/api/v1/sessions/${session2}/ai`).expect(403);
    await m1
      .post(`/api/v1/sessions/${MISSING}/ai/summary`)
      .send({ locale: 'vi' })
      .expect(404);
    await m1
      .post(`/api/v1/findings/${MISSING}/ai/explain`)
      .send({ locale: 'vi' })
      .expect(404);
    const m2 = await loginAs('m2@teamlens.local');
    await m2
      .post(`/api/v1/findings/${findingId}/ai/explain`)
      .send({ locale: 'vi' })
      .expect(403);
    expect(fake.calls).toHaveLength(0);
  });

  it('locale sai: 400', async () => {
    const m1 = await loginAs('m1@teamlens.local');
    await m1
      .post(`/api/v1/sessions/${session1}/ai/summary`)
      .send({ locale: 'fr' })
      .expect(400);
    await m1.get(`/api/v1/sessions/${session1}/ai?locale=fr`).expect(400);
  });

  it('leader tóm tắt session của member: ghi audit session.ai', async () => {
    const leader = await loginAs('leader@teamlens.local');
    fake.enqueue(summary('Bản của leader'));
    await leader
      .post(`/api/v1/sessions/${session1}/ai/summary`)
      .send({ locale: 'vi' })
      .expect(200);
    expect(await aiAudits(session1)).toEqual([{ actor_id: leaderId }]);
  });

  it('leader và member mỗi người chỉ thấy bản của mình qua GET .../ai', async () => {
    const m1 = await loginAs('m1@teamlens.local');
    const leader = await loginAs('leader@teamlens.local');
    const mine = await m1.get(`/api/v1/sessions/${session1}/ai`).expect(200);
    expect(mine.body.summary.result.title).toBe('Lần 2');
    expect(mine.body.summary.result.keyTurns).toEqual([
      { seq: 0, note: 'yêu cầu' },
    ]);
    expect(mine.body.outcome).toBeNull();
    const theirs = await leader
      .get(`/api/v1/sessions/${session1}/ai?locale=vi`)
      .expect(200);
    expect(theirs.body.summary.result.title).toBe('Bản của leader');
    // GET .../ai chỉ kiểm quyền, không ghi audit (trang đã gọi GET /sessions/:id).
    const audits = await querySql<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id = $1 AND action IN ('session.view', 'session.ai')`,
      [session1],
    );
    expect(audits).toEqual([{ action: 'session.ai' }]);
    const en = await m1
      .get(`/api/v1/sessions/${session1}/ai?locale=en`)
      .expect(200);
    expect(en.body).toEqual({
      summary: null,
      outcome: null,
      findingExplains: [],
    });
  });

  it('A5 đánh giá kết quả', async () => {
    const m1 = await loginAs('m1@teamlens.local');
    fake.enqueue({
      status: 'stuck_loop',
      explanation: 'Người dùng báo lỗi lặp lại.',
      evidence: [
        { seq: 2, note: 'vẫn lỗi' },
        { seq: 7, note: 'bịa' },
      ],
    });
    const res = await m1
      .post(`/api/v1/sessions/${session1}/ai/outcome`)
      .send({ locale: 'en' })
      .expect(200);
    expect(res.body).toMatchObject({
      kind: 'session_outcome',
      locale: 'en',
      promptVersion: 'session_outcome@1',
      result: {
        status: 'stuck_loop',
        evidence: [{ seq: 2, note: 'vẫn lỗi' }],
      },
    });
  });

  it('A4 giải thích finding repeated-correction: rule và turn quanh chỗ dính', async () => {
    const m1 = await loginAs('m1@teamlens.local');
    fake.enqueue({
      why: 'Ba prompt liên tiếp báo vẫn lỗi.',
      advice: 'Đưa ví dụ tái hiện.',
      turns: [{ seq: 4, note: 'lần thứ ba' }],
    });
    const res = await m1
      .post(`/api/v1/findings/${findingId}/ai/explain`)
      .send({ locale: 'vi' })
      .expect(200);
    expect(res.body).toMatchObject({
      kind: 'finding_explain',
      subjectType: 'finding',
      subjectId: findingId,
      promptVersion: 'finding_explain@1',
      result: { why: 'Ba prompt liên tiếp báo vẫn lỗi.' },
    });
    const call = fake.calls[0];
    expect(call.user).toContain('key: repeated-correction');
    expect(call.user).toContain('advice: Mô tả kết quả mong đợi');
    expect(call.user).toContain('[seq 1]');
    expect(call.user).toContain('[seq 5]');

    const all = await m1.get(`/api/v1/sessions/${session1}/ai`).expect(200);
    expect(all.body.findingExplains).toHaveLength(1);
    expect(all.body.findingExplains[0].subjectId).toBe(findingId);
  });

  it('chưa có key: 409 llm_key_missing', async () => {
    await querySql(`DELETE FROM user_llm_keys WHERE user_id = $1`, [member2]);
    const m2 = await loginAs('m2@teamlens.local');
    const res = await m2
      .post(`/api/v1/sessions/${session2}/ai/summary`)
      .send({ locale: 'vi' })
      .expect(409);
    expect(res.body.error).toBe('llm_key_missing');
    expect(fake.calls).toHaveLength(0);
  });
});
