import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { randomToken, sha256 } from '../src/common/crypto.js';
import { JOBS } from '../src/queue/jobs.js';
import { QueueService } from '../src/queue/queue.service.js';
import {
  createTestApp,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const PASSWORD = 'teamlens123';
const require = createRequire(import.meta.url);

function example(name: string): Record<string, any> {
  const path = require.resolve(`@teamlens/schema/session.v1.schema.json`);
  const file = path.replace(/session\.v1\.schema\.json$/, `examples/${name}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

const SIMPLE_SRC = 'claude_code:5e1c2d3a-7b8f-4c6d-9e0a-1b2c3d4e5f60';
const CODEX_SRC = 'codex:0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const PARENT_SRC = 'claude_code:9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const CHILD_SRC = 'claude_code:agent-3f9e1d2c';

/** Tạo thiết bị cho user thẳng trong DB, trả device token (`tld_...`). */
async function insertDevice(userId: string, name: string) {
  const token = `tld_${randomToken()}`;
  const [row] = await querySql<{ id: string }>(
    `INSERT INTO devices (user_id, name, os, cli_version, token_hash, status)
     VALUES ($1, $2, 'windows', '0.1.0', $3, 'online') RETURNING id`,
    [userId, name, sha256(token)],
  );
  return { id: row.id, token };
}

describe('POST /api/v1/users/:userId/merge (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let leader: ReturnType<typeof request.agent>;
  let leaderId: string;
  let fromId: string;
  let intoId: string;
  let fromDevice: { id: string; token: string };
  let acmeId: string;
  let soloId: string;
  let betaId: string;

  const ingest = (body: unknown, token: string) =>
    request(server)
      .post('/agent/v1/ingest')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object)
      .expect(202);

  const sessionsOf = (userId: string) =>
    querySql<{
      id: string;
      source_id: string;
      parent_session_id: string | null;
    }>(
      'SELECT id, source_id, parent_session_id FROM sessions WHERE user_id = $1 ORDER BY source_id',
      [userId],
    );

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();
    await app.get(QueueService).boss.deleteAllJobs(JOBS.sessionIngested);

    leader = request.agent(server);
    const setup = await leader
      .post('/api/v1/setup')
      .send({
        email: 'leader@teamlens.local',
        name: 'Leader',
        password: PASSWORD,
      })
      .expect(201);
    leaderId = setup.body.user.id;

    fromId = await insertUser({ email: null, name: 'An (máy 2)' });
    intoId = await insertUser({ email: null, name: 'An' });

    const project = async (name: string, slug: string, patterns: string[]) => {
      const res = await leader
        .post('/api/v1/projects')
        .send({ name, slug })
        .expect(201);
      for (const remotePattern of patterns)
        await leader
          .post(`/api/v1/projects/${res.body.id}/repos`)
          .send({ remotePattern })
          .expect(201);
      return res.body.id as string;
    };
    acmeId = await project('Acme', 'acme', [
      'github.com/acme/*',
      'gitlab.com/acme/*',
    ]);
    soloId = await project('Solo', 'solo', []);
    betaId = await project('Beta', 'beta', []);
    const addMember = (projectId: string, userId: string) =>
      leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId })
        .expect(201);
    await addMember(acmeId, fromId);
    await addMember(soloId, fromId);
    await addMember(acmeId, intoId);
    await addMember(betaId, intoId);

    fromDevice = await insertDevice(fromId, 'PC-2');
    const intoDevice = await insertDevice(intoId, 'PC-1');
    await querySql(
      `INSERT INTO consents (user_id, device_id, text_version) VALUES ($1, $2, 'v1')`,
      [fromId, fromDevice.id],
    );

    // User giữ lại: session simple (cùng batch_id với user cũ → ingest_batches trùng) + session cha.
    const subagent = example('claude-code-subagent.json');
    const [parentEnv, childEnv] = subagent.sessions;
    await ingest(example('claude-code-simple.json'), intoDevice.token);
    await ingest(
      { ...subagent, batch_id: randomUUID(), sessions: [parentEnv] },
      intoDevice.token,
    );
    // User cũ: simple (trùng source_id), codex, và session con của session cha nằm ở user kia.
    await ingest(example('claude-code-simple.json'), fromDevice.token);
    await ingest(example('codex-session.json'), fromDevice.token);
    await ingest(
      { ...subagent, batch_id: randomUUID(), sessions: [childEnv] },
      fromDevice.token,
    );
    // Bản simple của user cũ mới hơn → phải được giữ.
    await querySql(
      `UPDATE sessions SET updated_at = now() - interval '1 hour' WHERE user_id = $1 AND source_id = $2`,
      [intoId, SIMPLE_SRC],
    );
    await querySql(
      `INSERT INTO user_weekly_stats (user_id, project_id, week, sessions) VALUES
       ($1, $3, '2026-11-23', 3), ($2, $3, '2026-11-23', 2), ($2, $3, '2020-01-06', 9)`,
      [fromId, intoId, acmeId],
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('member gọi → 403; chưa đăng nhập → 401', async () => {
    await insertUser({
      email: 'member@teamlens.local',
      name: 'Member',
      password: PASSWORD,
    });
    const member = request.agent(server);
    await member
      .post('/api/v1/auth/login')
      .send({ email: 'member@teamlens.local', password: PASSWORD })
      .expect(200);
    await member
      .post(`/api/v1/users/${fromId}/merge`)
      .send({ intoUserId: intoId })
      .expect(403);
    await request(server)
      .post(`/api/v1/users/${fromId}/merge`)
      .send({ intoUserId: intoId })
      .expect(401);
  });

  it('lỗi 400/404/409', async () => {
    const same = await leader
      .post(`/api/v1/users/${fromId}/merge`)
      .send({ intoUserId: fromId })
      .expect(400);
    expect(same.body.error).toBe('same_user');
    const invalid = await leader
      .post(`/api/v1/users/${fromId}/merge`)
      .send({ intoUserId: 'khong-phai-uuid' })
      .expect(400);
    expect(invalid.body.error).toBe('validation_error');
    await leader.post(`/api/v1/users/${fromId}/merge`).send({}).expect(400);
    for (const [from, into] of [
      [randomUUID(), intoId],
      [fromId, randomUUID()],
      ['khong-phai-uuid', intoId],
    ]) {
      const res = await leader
        .post(`/api/v1/users/${from}/merge`)
        .send({ intoUserId: into })
        .expect(404);
      expect(res.body.error).toBe('not_found');
    }
    const mismatch = await leader
      .post(`/api/v1/users/${leaderId}/merge`)
      .send({ intoUserId: intoId })
      .expect(409);
    expect(mismatch.body.error).toBe('role_mismatch');
    // Không có gì bị đổi sau các lần lỗi.
    expect(await sessionsOf(fromId)).toHaveLength(3);
  });

  it('gộp user cũ vào user giữ lại', async () => {
    const before = await sessionsOf(fromId);
    const keptSimpleId = before.find((s) => s.source_id === SIMPLE_SRC)!.id;
    const childId = before.find((s) => s.source_id === CHILD_SRC)!.id;
    expect(before.find((s) => s.id === childId)!.parent_session_id).toBeNull();
    const mergeStartedAt = new Date(Date.now() - 1000);

    const res = await leader
      .post(`/api/v1/users/${fromId}/merge`)
      .send({ intoUserId: intoId })
      .expect(200);
    expect(res.body).toEqual({
      user: { id: intoId, email: null, name: 'An', role: 'member' },
      moved: { devices: 1, sessions: 3, projects: 1 },
    });

    // User cũ bị xóa hẳn; mọi dữ liệu thuộc user giữ lại.
    expect(
      await querySql('SELECT id FROM users WHERE id = $1', [fromId]),
    ).toEqual([]);
    const after = await sessionsOf(intoId);
    expect(after.map((s) => s.source_id)).toEqual(
      [CHILD_SRC, PARENT_SRC, SIMPLE_SRC, CODEX_SRC].sort(),
    );
    const bySrc = (src: string) => after.find((s) => s.source_id === src)!;
    expect(bySrc(SIMPLE_SRC).id).toBe(keptSimpleId);
    expect(bySrc(CHILD_SRC).parent_session_id).toBe(bySrc(PARENT_SRC).id);
    const turns = await querySql<{ n: number }>(
      'SELECT count(*)::int AS n FROM turns WHERE session_id NOT IN (SELECT id FROM sessions)',
    );
    expect(turns[0].n).toBe(0);

    const devices = await querySql<{ user_id: string }>(
      'SELECT user_id FROM devices ORDER BY name',
    );
    expect(devices.map((d) => d.user_id)).toEqual([intoId, intoId]);
    expect(await querySql('SELECT user_id FROM consents', [])).toEqual([
      { user_id: intoId },
    ]);
    const projects = await querySql<{ project_id: string }>(
      'SELECT project_id FROM project_members WHERE user_id = $1',
      [intoId],
    );
    expect(projects.map((p) => p.project_id).sort()).toEqual(
      [acmeId, soloId, betaId].sort(),
    );
    const batches = await querySql<{ user_id: string; n: number }>(
      'SELECT user_id, count(*)::int AS n FROM ingest_batches GROUP BY user_id',
    );
    expect(batches).toEqual([{ user_id: intoId, n: 4 }]);
    // Thống kê tuần bị ảnh hưởng đã xóa; tuần khác giữ nguyên.
    expect(await querySql('SELECT week::text FROM user_weekly_stats')).toEqual([
      { week: '2020-01-06' },
    ]);

    const audit = await querySql<{ actor_id: string; target_id: string }>(
      `SELECT actor_id, target_id FROM audit_log WHERE action = 'member.merge'`,
    );
    expect(audit).toEqual([
      { actor_id: leaderId, target_id: `${fromId}:${intoId}` },
    ]);

    // Token thiết bị của user cũ vẫn dùng được và giờ thuộc user giữ lại.
    const whoami = await request(server)
      .get('/agent/v1/whoami')
      .set('Authorization', `Bearer ${fromDevice.token}`)
      .expect(200);
    expect(whoami.body.user.id).toBe(intoId);
    expect(whoami.body.device.id).toBe(fromDevice.id);

    // Mọi session đã chuyển được chấm lại bằng job phát sau khi gộp.
    const movedIds = [keptSimpleId, childId, bySrc(CODEX_SRC).id];
    await vi.waitFor(
      async () => {
        const jobs = await querySql<{ n: number }>(
          `SELECT count(DISTINCT data->>'sessionId')::int AS n FROM pgboss.job
           WHERE name = 'session.ingested' AND state = 'completed'
             AND created_on >= $1 AND data->>'sessionId' = ANY($2)`,
          [mergeStartedAt.toISOString(), `{${movedIds.join(',')}}`],
        );
        expect(jobs[0].n).toBe(3);
      },
      { timeout: 20000, interval: 250 },
    );
    // Session con (subagent) không có điểm riêng; hai session gốc được chấm lại sau khi gộp.
    const scored = await querySql<{ n: number }>(
      'SELECT count(DISTINCT session_id)::int AS n FROM session_scores WHERE session_id = ANY($1) AND computed_at >= $2',
      [`{${movedIds.join(',')}}`, mergeStartedAt.toISOString()],
    );
    expect(scored[0].n).toBe(2);
    await leader.get(`/api/v1/sessions/${childId}/findings`).expect(200);

    // Gộp lại lần nữa: user cũ không còn → 404.
    await leader
      .post(`/api/v1/users/${fromId}/merge`)
      .send({ intoUserId: intoId })
      .expect(404);
  });

  it('gộp leader vào leader được', async () => {
    const otherLeader = await insertUser({
      email: 'leader2@teamlens.local',
      name: 'Leader 2',
      role: 'leader',
      password: PASSWORD,
    });
    const res = await leader
      .post(`/api/v1/users/${otherLeader}/merge`)
      .send({ intoUserId: leaderId })
      .expect(200);
    expect(res.body.user.id).toBe(leaderId);
    expect(res.body.moved).toEqual({ devices: 0, sessions: 0, projects: 0 });
  });
});
