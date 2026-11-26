import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  createTestApp,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const PASSWORD = 'teamlens123';
const require = createRequire(import.meta.url);

/** Đọc file mẫu trong packages/schema/examples (bản sao, sửa thoải mái). */
function example(name: string): Record<string, any> {
  const path = require.resolve(`@teamlens/schema/session.v1.schema.json`);
  const file = path.replace(/session\.v1\.schema\.json$/, `examples/${name}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

const rawBody = (body: unknown) => body as string;

const EXAMPLES = [
  'claude-code-simple.json',
  'claude-code-subagent.json',
  'codex-session.json',
];

describe('POST /agent/v1/ingest (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let token: string;
  let otherToken: string;
  let acmeProjectId: string;
  let shopWebProjectId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();

    await request(server)
      .post('/api/v1/setup')
      .send({
        email: 'admin@teamlens.local',
        name: 'Admin',
        password: PASSWORD,
      })
      .expect(201);
    const admin = await loginAs('admin@teamlens.local');
    const memberId = await insertUser({
      email: 'member@teamlens.local',
      name: 'member',
      password: PASSWORD,
    });
    await insertUser({
      email: 'other@teamlens.local',
      name: 'other',
      password: PASSWORD,
    });
    // Project "Acme" có wildcard github.com/acme/* và gitlab.com/acme/*;
    // project "Shop web" có pattern cụ thể github.com/acme/shop-web → phải thắng wildcard.
    const acme = await admin
      .post('/api/v1/projects')
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    acmeProjectId = acme.body.id;
    const shopWeb = await admin
      .post('/api/v1/projects')
      .send({ name: 'Shop web', slug: 'shop-web' })
      .expect(201);
    shopWebProjectId = shopWeb.body.id;
    for (const [projectId, pattern] of [
      [acmeProjectId, 'github.com/acme/*'],
      [acmeProjectId, 'gitlab.com/acme/*'],
      [shopWebProjectId, 'github.com/acme/shop-web'],
    ]) {
      await admin
        .post(`/api/v1/projects/${projectId}/repos`)
        .send({ remotePattern: pattern })
        .expect(201);
    }
    for (const projectId of [acmeProjectId, shopWebProjectId]) {
      await admin
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: memberId })
        .expect(201);
    }
    token = await deviceToken('member@teamlens.local');
    otherToken = await deviceToken('other@teamlens.local');
  });

  afterAll(async () => {
    await app?.close();
  });

  async function loginAs(email: string) {
    const agent = request.agent(server);
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return agent;
  }

  async function deviceToken(email: string): Promise<string> {
    const code = await request(server)
      .post('/agent/v1/device/code')
      .send({ deviceName: 'PC', os: 'windows', cliVersion: '0.1.0' })
      .expect(200);
    const user = await loginAs(email);
    await user
      .post('/api/v1/device/approve')
      .send({ userCode: code.body.userCode })
      .expect(200);
    const res = await request(server)
      .post('/agent/v1/device/token')
      .send({ deviceCode: code.body.deviceCode })
      .expect(200);
    return res.body.accessToken as string;
  }

  const ingest = (body: unknown, auth = token) =>
    request(server)
      .post('/agent/v1/ingest')
      .set('Authorization', `Bearer ${auth}`)
      .send(body as object);

  const count = async (table: 'sessions' | 'turns') =>
    (
      await querySql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
    )[0].n;

  it('không có token → 401', async () => {
    await request(server)
      .post('/agent/v1/ingest')
      .send(example('claude-code-simple.json'))
      .expect(401);
  });

  it('header Authorization sai dạng → 401 invalid_token ngay, không đọc body (kể cả zip bomb)', async () => {
    const bomb = gzipSync(Buffer.alloc(11 * 1024 * 1024, 0x20));
    for (const auth of [undefined, 'Basic abc', 'Bearer khong-phai-tld']) {
      const req = request(server)
        .post('/agent/v1/ingest')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .serialize(rawBody);
      if (auth) req.set('Authorization', auth);
      const res = await req.send(bomb).expect(401);
      expect(res.body).toEqual({
        error: 'invalid_token',
        message: expect.any(String),
      });
    }
    // Đúng dạng nhưng token giả: middleware cho qua, guard thật vẫn trả 401.
    const res = await ingest(
      example('claude-code-simple.json'),
      'tld_gia',
    ).expect(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('gửi các file mẫu → 202, gửi lại cùng batch_id → duplicate, không trùng dữ liệu', async () => {
    const first: Record<string, any>[] = [];
    for (const name of EXAMPLES) {
      const res = await ingest(example(name)).expect(202);
      expect(res.body.duplicate).toBe(false);
      expect(res.body.rejected).toEqual([]);
      first.push(res.body);
    }
    const sessionsAfter = await count('sessions');
    const turnsAfter = await count('turns');
    expect(sessionsAfter).toBe(4);

    for (const [i, name] of EXAMPLES.entries()) {
      const res = await ingest(example(name)).expect(202);
      expect(res.body).toEqual({ ...first[i], duplicate: true });
    }
    expect(await count('sessions')).toBe(sessionsAfter);
    expect(await count('turns')).toBe(turnsAfter);

    // Mỗi session sinh đúng một job session.ingested (lần gửi trùng không sinh thêm).
    const jobs = await querySql<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'session.ingested' AND data->>'sessionId' IN (SELECT id::text FROM sessions)`,
    );
    expect(jobs[0].n).toBe(4);
  });

  it('pattern cụ thể thắng wildcard; nối session con với cha', async () => {
    const rows = await querySql<{
      source_id: string;
      project_id: string;
      parent_session_id: string | null;
      id: string;
      turn_count: number;
      input_tokens: number;
    }>(
      `SELECT id, source_id, project_id, parent_session_id, turn_count, input_tokens FROM sessions`,
    );
    const by = (src: string) => rows.find((r) => r.source_id === src)!;
    const parent = by('claude_code:9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d');
    const child = by('claude_code:agent-3f9e1d2c');
    expect(parent.project_id).toBe(shopWebProjectId);
    expect(child.parent_session_id).toBe(parent.id);
    expect(
      by('claude_code:5e1c2d3a-7b8f-4c6d-9e0a-1b2c3d4e5f60').project_id,
    ).toBe(acmeProjectId);
    expect(parent.turn_count).toBe(4);
    expect(Number(parent.input_tokens)).toBe(2100 + 2600);
  });

  it('batch_id mới cùng session (gửi tăng dần) → không trùng session/turn', async () => {
    const batch = example('claude-code-simple.json');
    const sessionsBefore = await count('sessions');
    const turnsBefore = await count('turns');
    batch.batch_id = randomUUID();
    const lastSeq = Math.max(...batch.sessions[0].turns.map((t: any) => t.seq));
    const last = batch.sessions[0].turns.find((t: any) => t.seq === lastSeq);
    batch.sessions[0].turns = [
      last,
      {
        ...last,
        seq: lastSeq + 1,
        interrupted: true,
        reasoning_effort: 'high',
      },
    ];
    const res = await ingest(batch).expect(202);
    expect(res.body.accepted[0].turnsUpserted).toBe(2);
    expect(await count('sessions')).toBe(sessionsBefore);
    expect(await count('turns')).toBe(turnsBefore + 1);
    const [row] = await querySql<{
      interrupted: boolean;
      reasoning_effort: string;
    }>(
      `SELECT interrupted, reasoning_effort FROM turns WHERE session_id = $1 AND seq = $2`,
      [res.body.accepted[0].sessionId, lastSeq + 1],
    );
    expect(row).toEqual({ interrupted: true, reasoning_effort: 'high' });
  });

  it('session con tới trước cha → nối khi cha tới sau', async () => {
    const batch = example('claude-code-subagent.json');
    batch.batch_id = randomUUID();
    const [parentEnv, childEnv] = batch.sessions;
    const parentSrc = 'claude_code:late-parent';
    childEnv.session.source_id = 'claude_code:early-child';
    childEnv.session.parent_source_id = parentSrc;
    parentEnv.session.source_id = parentSrc;
    await ingest({ ...batch, sessions: [childEnv] }).expect(202);
    const res = await ingest({
      ...batch,
      batch_id: randomUUID(),
      sessions: [parentEnv],
    }).expect(202);
    const [child] = await querySql<{ parent_session_id: string }>(
      `SELECT parent_session_id FROM sessions WHERE source_id = 'claude_code:early-child'`,
    );
    expect(child.parent_session_id).toBe(res.body.accepted[0].sessionId);
  });

  it('repo ngoài project → rejected, session khác vẫn nhận', async () => {
    const batch = example('claude-code-subagent.json');
    batch.batch_id = randomUUID();
    batch.sessions[0].session.source_id = 'claude_code:outside';
    batch.sessions[0].session.repo_remote = 'github.com/evil/private-tool';
    batch.sessions[1].session.source_id = 'claude_code:inside';
    const res = await ingest(batch).expect(202);
    expect(res.body.rejected).toEqual([
      {
        sourceId: 'claude_code:outside',
        error: 'repo_not_in_project',
        message: expect.stringContaining('github.com/evil/private-tool'),
      },
    ]);
    expect(res.body.accepted.map((a: any) => a.sourceId)).toEqual([
      'claude_code:inside',
    ]);
    const rows = await querySql(
      `SELECT 1 FROM sessions WHERE source_id = 'claude_code:outside'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('user không là thành viên → mọi session bị rejected', async () => {
    const batch = example('claude-code-simple.json');
    const res = await ingest(batch, otherToken).expect(202);
    expect(res.body.accepted).toEqual([]);
    expect(res.body.rejected[0].error).toBe('repo_not_in_project');
  });

  it('seq trùng trong batch → invalid_session', async () => {
    const batch = example('claude-code-simple.json');
    batch.batch_id = randomUUID();
    batch.sessions[0].session.source_id = 'claude_code:dup-seq';
    batch.sessions[0].turns[1].seq = batch.sessions[0].turns[0].seq;
    const res = await ingest(batch).expect(202);
    expect(res.body.rejected[0].error).toBe('invalid_session');
  });

  it('sai schema → 400 validation_error', async () => {
    const batch = example('claude-code-simple.json');
    batch.batch_id = randomUUID();
    batch.sessions[0].turns[0].seq = -1;
    const res = await ingest(batch).expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.message).toContain('/sessions/0/turns/0/seq');
  });

  it('JSON hỏng → 400 validation_error', async () => {
    const res = await request(server)
      .post('/agent/v1/ingest')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send('{"schema_version": 1,')
      .expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('schema_version 2 → 426 kèm phiên bản CLI tối thiểu', async () => {
    const batch = example('claude-code-simple.json');
    batch.schema_version = 2;
    const res = await ingest(batch).expect(426);
    expect(res.body).toEqual({
      error: 'unsupported_schema_version',
      message: expect.any(String),
      supportedSchemaVersions: [1],
      minCliVersion: expect.any(String),
    });
  });

  it('body gzip → 202; gửi lại → duplicate', async () => {
    const batch = example('codex-session.json');
    batch.batch_id = randomUUID();
    const body = gzipSync(JSON.stringify(batch));
    const send = () =>
      request(server)
        .post('/agent/v1/ingest')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        // superagent mặc định JSON-hoá Buffer khi Content-Type là JSON: gửi nguyên byte.
        .serialize(rawBody)
        .send(body);
    const first = await send().expect(202);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.accepted).toHaveLength(1);
    const again = await send().expect(202);
    expect(again.body.duplicate).toBe(true);
  });

  it('gzip hỏng → 400', async () => {
    const res = await request(server)
      .post('/agent/v1/ingest')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      // superagent mặc định JSON-hoá Buffer khi Content-Type là JSON: gửi nguyên byte.
      .serialize(rawBody)
      .send(Buffer.from('không phải gzip'))
      .expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('zip bomb (> 10 MB sau giải nén) → 413', async () => {
    const bomb = gzipSync(Buffer.alloc(11 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(100 * 1024);
    const res = await request(server)
      .post('/agent/v1/ingest')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      // superagent mặc định JSON-hoá Buffer khi Content-Type là JSON: gửi nguyên byte.
      .serialize(rawBody)
      .send(bomb)
      .expect(413);
    expect(res.body.error).toBe('payload_too_large');
  });

  it('body > 100 KB (vượt parser mặc định) vẫn nhận', async () => {
    const batch = example('claude-code-simple.json');
    batch.batch_id = randomUUID();
    batch.sessions[0].session.source_id = 'claude_code:big';
    batch.sessions[0].turns[0].text = 'a'.repeat(300 * 1024);
    const res = await ingest(batch).expect(202);
    expect(res.body.accepted).toHaveLength(1);
  });

  it('route khác vẫn dùng parser JSON mặc định (login gửi body JSON)', async () => {
    const admin = await loginAs('admin@teamlens.local');
    await admin.get('/api/v1/projects').expect(200);
  });
});
