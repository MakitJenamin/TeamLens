import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { randomToken, sha256 } from '../src/common/crypto.js';
import { UserEraseService } from '../src/modules/admin/user-erase.service.js';
import { JOBS } from '../src/queue/jobs.js';
import { QueueService } from '../src/queue/queue.service.js';
import {
  createTestApp,
  grantConsent,
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

async function insertDevice(userId: string, name: string) {
  const token = `tld_${randomToken()}`;
  const [row] = await querySql<{ id: string }>(
    `INSERT INTO devices (user_id, name, os, cli_version, token_hash, status)
     VALUES ($1, $2, 'windows', '0.1.0', $3, 'online') RETURNING id`,
    [userId, name, sha256(token)],
  );
  return { id: row.id, token };
}

async function insertAiResult(
  userId: string,
  subjectType: string,
  subjectId: string,
  subjectUserId: string | null,
) {
  const [row] = await querySql<{ id: string }>(
    `INSERT INTO ai_results (user_id, kind, subject_type, subject_id, subject_user_id,
       locale, provider, model, prompt_version, result)
     VALUES ($1, 'session_summary', $2, $3, $4, 'vi', 'anthropic', 'm', 'test@1', '{}'::jsonb)
     RETURNING id`,
    [userId, subjectType, subjectId, subjectUserId],
  );
  return row.id;
}

/** Mọi bảng có cột user_id trỏ tới users (cascade). */
const USER_TABLES = [
  'sessions',
  'devices',
  'consents',
  'agent_tokens',
  'user_llm_keys',
  'user_weekly_stats',
  'project_members',
  'auth_sessions',
  'ingest_batches',
];

describe('DELETE /api/v1/admin/users/:userId (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let leader: ReturnType<typeof request.agent>;
  let member: ReturnType<typeof request.agent>;
  let leaderId: string;
  let aId: string;
  let bId: string;
  let memberLoginId: string;
  let projectId: string;
  let aDevice: { id: string; token: string };
  let bDevice: { id: string; token: string };
  let aSessionIds: string[];
  let bSessionIds: string[];

  const ingest = (body: unknown, token: string) =>
    request(server)
      .post('/agent/v1/ingest')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object)
      .expect(202);

  const countWhere = async (table: string, column: string, ids: string[]) => {
    const [row] = await querySql<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1)`,
      [`{${ids.join(',')}}`],
    );
    return row.n;
  };

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

    aId = await insertUser({ email: null, name: 'Thành viên A' });
    bId = await insertUser({ email: null, name: 'Thành viên B' });
    memberLoginId = await insertUser({
      email: 'member@teamlens.local',
      name: 'Member',
      password: PASSWORD,
    });
    member = request.agent(server);
    await member
      .post('/api/v1/auth/login')
      .send({ email: 'member@teamlens.local', password: PASSWORD })
      .expect(200);

    const project = await leader
      .post('/api/v1/projects')
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    projectId = project.body.id;
    for (const remotePattern of ['github.com/acme/*', 'gitlab.com/acme/*'])
      await leader
        .post(`/api/v1/projects/${projectId}/repos`)
        .send({ remotePattern })
        .expect(201);
    for (const userId of [aId, bId])
      await leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId })
        .expect(201);

    aDevice = await insertDevice(aId, 'PC-A');
    await insertDevice(aId, 'PC-A2');
    bDevice = await insertDevice(bId, 'PC-B');
    await grantConsent(aDevice.token);
    await grantConsent(bDevice.token);

    // A: simple, codex, session cha + con; B: simple (cùng source_id với A).
    await ingest(example('claude-code-simple.json'), aDevice.token);
    await ingest(example('codex-session.json'), aDevice.token);
    await ingest(
      { ...example('claude-code-subagent.json'), batch_id: randomUUID() },
      aDevice.token,
    );
    await ingest(example('claude-code-simple.json'), bDevice.token);

    const ids = async (userId: string) =>
      (
        await querySql<{ id: string }>(
          'SELECT id FROM sessions WHERE user_id = $1 ORDER BY id',
          [userId],
        )
      ).map((r) => r.id);
    aSessionIds = await ids(aId);
    bSessionIds = await ids(bId);
    expect(aSessionIds).toHaveLength(4);
    expect(bSessionIds).toHaveLength(1);
    const [aSession] = aSessionIds;
    const [bSession] = bSessionIds;

    // Chờ job chấm điểm sau ingest chạy xong để dữ liệu ổn định.
    await vi.waitFor(
      async () => {
        const [row] = await querySql<{ n: number }>(
          `SELECT count(*)::int AS n FROM pgboss.job
           WHERE name = 'session.ingested' AND state NOT IN ('completed', 'failed')`,
        );
        expect(row.n).toBe(0);
      },
      { timeout: 20000, interval: 250 },
    );

    const [rule] = await querySql<{ id: string; version: number }>(
      'SELECT id, version FROM rules LIMIT 1',
    );
    for (const sessionId of [aSession, bSession])
      await querySql(
        `INSERT INTO findings (session_id, rule_id, rule_version, evidence)
         VALUES ($1, $2, $3, '{"scope":"turn"}'::jsonb)`,
        [sessionId, rule.id, rule.version],
      );
    const [aFinding] = await querySql<{ id: string }>(
      'SELECT id FROM findings WHERE session_id = $1 LIMIT 1',
      [aSession],
    );

    // Ghi chú: leader trên session A (mất theo session), A trên session B (dữ liệu của A),
    // leader trên session B (giữ).
    await querySql(
      `INSERT INTO notes (session_id, author_id, body) VALUES
       ($1, $3, 'leader về A'), ($2, $4, 'A viết trên B'), ($2, $3, 'leader về B')`,
      [aSession, bSession, leaderId, aId],
    );

    // Kết quả AI: A tự bấm; leader về session A; B về finding của A nhưng thiếu subject_user_id;
    // leader về session B (giữ).
    await insertAiResult(aId, 'session', aSession, aId);
    await insertAiResult(leaderId, 'session', aSession, aId);
    await insertAiResult(bId, 'finding', aFinding.id, null);
    await insertAiResult(leaderId, 'session', bSession, bId);

    for (const userId of [aId, bId]) {
      await querySql(
        `INSERT INTO user_llm_keys (user_id, provider, model, key_encrypted, key_hint)
         VALUES ($1, 'anthropic', 'm', 'x', '…abcd')`,
        [userId],
      );
      await querySql(
        `INSERT INTO agent_tokens (user_id, name, token_hash) VALUES ($1, 'Cursor', $2)`,
        [userId, sha256(`tlp_${randomToken()}`)],
      );
      await querySql(
        `INSERT INTO user_weekly_stats (user_id, project_id, week, sessions)
         VALUES ($1, $2, '2020-01-06', 5) ON CONFLICT DO NOTHING`,
        [userId, projectId],
      );
    }
    await querySql(
      `INSERT INTO prompt_library (project_id, session_id, approved_by) VALUES
       ($1, $2, $4), ($1, $3, $4)`,
      [projectId, aSession, bSession, leaderId],
    );
    await querySql(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES
       ($1, 'session.view', 'session', $2), ($3, 'session.view', 'session', $4)`,
      [leaderId, aSession, aId, bSession],
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('member gọi → 403; chưa đăng nhập → 401', async () => {
    await member.delete(`/api/v1/admin/users/${aId}`).expect(403);
    await request(server).delete(`/api/v1/admin/users/${aId}`).expect(401);
  });

  it('lỗi 404, 400, 409', async () => {
    for (const id of [randomUUID(), 'khong-phai-uuid']) {
      const res = await leader.delete(`/api/v1/admin/users/${id}`).expect(404);
      expect(res.body.error).toBe('not_found');
    }
    const self = await leader
      .delete(`/api/v1/admin/users/${leaderId}`)
      .expect(400);
    expect(self.body.error).toBe('cannot_erase_self');

    // Qua HTTP người gọi luôn là leader, nên đích là leader cuối cùng chỉ xảy ra khi hai leader
    // xóa nhau cùng lúc; gọi service với người gọi không phải leader để kiểm nhánh này.
    await expect(
      app
        .get(UserEraseService)
        .erase(
          { id: memberLoginId, email: null, name: 'Member', role: 'member' },
          leaderId,
        ),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: 'last_leader' },
    });

    expect(await countWhere('sessions', 'user_id', [aId])).toBe(4);
    expect(await countWhere('users', 'id', [leaderId, aId])).toBe(2);
  });

  it('xóa toàn bộ dữ liệu của A, không đụng B', async () => {
    const before = await querySql<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log',
    );
    const res = await leader.delete(`/api/v1/admin/users/${aId}`).expect(200);
    expect(res.body).toEqual({ userId: aId, sessions: 4, devices: 2 });

    expect(await countWhere('users', 'id', [aId])).toBe(0);
    for (const table of USER_TABLES)
      expect([table, await countWhere(table, 'user_id', [aId])]).toEqual([
        table,
        0,
      ]);
    for (const table of [
      'turns',
      'findings',
      'session_scores',
      'notes',
      'prompt_library',
    ])
      expect([
        table,
        await countWhere(table, 'session_id', aSessionIds),
      ]).toEqual([table, 0]);
    expect(await countWhere('notes', 'author_id', [aId])).toBe(0);
    expect(await countWhere('ai_results', 'user_id', [aId])).toBe(0);
    expect(await countWhere('ai_results', 'subject_user_id', [aId])).toBe(0);
    expect(await countWhere('ai_results', 'subject_id', aSessionIds)).toBe(0);
    expect(
      await querySql(
        `SELECT 1 FROM ai_results WHERE subject_type = 'finding'
         AND subject_id NOT IN (SELECT id FROM findings)`,
      ),
    ).toEqual([]);

    // Device token của A không còn dùng được.
    await request(server)
      .get('/agent/v1/whoami')
      .set('Authorization', `Bearer ${aDevice.token}`)
      .expect(401);
    await request(server)
      .post('/agent/v1/ingest')
      .set('Authorization', `Bearer ${aDevice.token}`)
      .send(example('claude-code-simple.json'))
      .expect(401);

    // Dữ liệu của B còn nguyên.
    expect(await countWhere('sessions', 'user_id', [bId])).toBe(1);
    expect(await countWhere('devices', 'user_id', [bId])).toBe(1);
    expect(await countWhere('consents', 'user_id', [bId])).toBe(1);
    expect(await countWhere('agent_tokens', 'user_id', [bId])).toBe(1);
    expect(await countWhere('user_llm_keys', 'user_id', [bId])).toBe(1);
    expect(
      await countWhere('user_weekly_stats', 'user_id', [bId]),
    ).toBeGreaterThan(0);
    expect(await countWhere('project_members', 'user_id', [bId])).toBe(1);
    expect(
      await countWhere('turns', 'session_id', bSessionIds),
    ).toBeGreaterThan(0);
    expect(
      await countWhere('findings', 'session_id', bSessionIds),
    ).toBeGreaterThan(0);
    expect(await countWhere('prompt_library', 'session_id', bSessionIds)).toBe(
      1,
    );
    expect(await querySql('SELECT body FROM notes ORDER BY body')).toEqual([
      { body: 'leader về B' },
    ]);
    expect(
      await querySql<{ user_id: string }>('SELECT user_id FROM ai_results'),
    ).toEqual([{ user_id: leaderId }]);
    await request(server)
      .get('/agent/v1/whoami')
      .set('Authorization', `Bearer ${bDevice.token}`)
      .expect(200);

    // Audit giữ lại: dòng session.view về session của A còn, dòng A thực hiện còn với actor null,
    // thêm đúng một dòng user.erase không chứa tên hay email.
    const after = await querySql<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log',
    );
    expect(after[0].n).toBe(before[0].n + 1);
    expect(
      await querySql(
        `SELECT actor_id FROM audit_log WHERE action = 'session.view' AND target_id = $1`,
        [aSessionIds[0]],
      ),
    ).toEqual([{ actor_id: leaderId }]);
    expect(
      await querySql(
        `SELECT actor_id FROM audit_log WHERE action = 'session.view' AND target_id = $1`,
        [bSessionIds[0]],
      ),
    ).toEqual([{ actor_id: null }]);
    const erase = await querySql<{
      actor_id: string;
      target_type: string;
      target_id: string;
      metadata: unknown;
      details: unknown;
    }>(
      `SELECT actor_id, target_type, target_id, metadata, details
       FROM audit_log WHERE action = 'user.erase'`,
    );
    expect(erase).toEqual([
      {
        actor_id: leaderId,
        target_type: 'user',
        target_id: aId,
        metadata: { sessions: 4, devices: 2 },
        details: null,
      },
    ]);

    // Xóa lần nữa: 404.
    await leader.delete(`/api/v1/admin/users/${aId}`).expect(404);
  });

  it('job chấm điểm còn trong hàng đợi cho session đã xóa không làm worker lỗi', async () => {
    const queue = app.get(QueueService);
    const ghost = aSessionIds[0];
    const jobId = await queue.send(JOBS.sessionIngested, { sessionId: ghost });
    await vi.waitFor(
      async () => {
        const rows = await querySql<{ state: string }>(
          `SELECT state FROM pgboss.job WHERE name = 'session.ingested' AND data->>'sessionId' = $1
           ORDER BY created_on DESC LIMIT 1`,
          [ghost],
        );
        expect(rows[0]?.state).toBe('completed');
      },
      { timeout: 20000, interval: 250 },
    );
    expect(jobId).toBeTruthy();
  });

  // Chạy cuối: leader gốc có thể bị xóa ở test này.
  it('hai leader xóa nhau cùng lúc: một lệnh thành công, lệnh kia 409', async () => {
    const otherId = await insertUser({
      email: 'leader2@teamlens.local',
      name: 'Leader 2',
      role: 'leader',
      password: PASSWORD,
    });
    const service = app.get(UserEraseService);
    const leaderUser = {
      id: leaderId,
      email: 'leader@teamlens.local',
      name: 'Leader',
      role: 'leader' as const,
    };
    const otherUser = {
      id: otherId,
      email: 'leader2@teamlens.local',
      name: 'Leader 2',
      role: 'leader' as const,
    };
    const results = await Promise.allSettled([
      service.erase(leaderUser, otherId),
      service.erase(otherUser, leaderId),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({
      status: 409,
      response: { error: 'last_leader' },
    });
    // Bên thua thấy mình là leader cuối cùng: còn đúng một leader.
    const [left] = await querySql<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE role = 'leader'",
    );
    expect(left.n).toBe(1);
  });
});
