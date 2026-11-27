import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  createTestApp,
  insertDevice,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

describe('Trang Thành viên kèm trạng thái thiết bị (M4.2)', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('leader thấy thành viên, thiết bị và trạng thái hiệu lực; member bị 403', async () => {
    const server = app.getHttpServer();
    const leader = request.agent(server);
    const credentials = {
      email: 'leader@teamlens.local',
      password: 'teamlens123',
    };
    await leader
      .post('/api/v1/setup')
      .send({ ...credentials, name: 'Leader' })
      .expect(201);
    await leader.post('/api/v1/auth/login').send(credentials).expect(200);
    const memberCredentials = {
      email: 'member1@teamlens.local',
      password: 'teamlens123',
    };
    const member1 = await insertUser({ ...memberCredentials, name: 'An' });
    const member2 = await insertUser({ email: null, name: 'Bình' });
    const outsider = await insertUser({ email: null, name: 'Người ngoài' });

    const project = await leader
      .post('/api/v1/projects')
      .send({ name: 'Demo', slug: 'demo' })
      .expect(201);
    const projectId: string = project.body.id;
    const other = await leader
      .post('/api/v1/projects')
      .send({ name: 'Khác', slug: 'khac' })
      .expect(201);
    for (const userId of [member1, member2])
      await leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId })
        .expect(201);
    await leader
      .post(`/api/v1/projects/${other.body.id}/members`)
      .send({ userId: outsider })
      .expect(201);
    // An tham gia 10 ngày trước, Bình 2 ngày trước.
    await querySql(
      `UPDATE project_members SET created_at = now() - make_interval(days => $2::int)
       WHERE project_id = $1 AND user_id = $3`,
      [projectId, 10, member1],
    );
    await querySql(
      `UPDATE project_members SET created_at = now() - make_interval(days => $2::int)
       WHERE project_id = $1 AND user_id = $3`,
      [projectId, 2, member2],
    );

    // Thiết bị của An: một online, một heartbeat cũ (offline), một paused, một đã thu hồi.
    const online = await insertDevice(member1, 'AN-ONLINE');
    const stale = await insertDevice(member1, 'AN-STALE');
    const paused = await insertDevice(member1, 'AN-PAUSED');
    const revoked = await insertDevice(member1, 'AN-REVOKED');
    const consent = await insertDevice(member2, 'BINH-CONSENT');
    const never = await insertDevice(member2, 'BINH-NEVER');
    const setDevice = (
      id: string,
      status: string,
      minutesAgo: number,
      revokedAt = false,
    ) =>
      querySql(
        `UPDATE devices SET status = $2, last_seen_at = now() - make_interval(mins => $3::int),
           revoked_at = CASE WHEN $4 = 'yes' THEN now() ELSE NULL END WHERE id = $1`,
        [id, status, minutesAgo, revokedAt ? 'yes' : 'no'],
      );
    await setDevice(online.id, 'online', 5);
    await setDevice(stale.id, 'online', 3 * 24 * 60);
    await setDevice(paused.id, 'paused', 1);
    await setDevice(revoked.id, 'online', 10, true);
    await setDevice(consent.id, 'consent_revoked', 60 * 24);

    // Session: An có 2 session trong project và 1 session mới hơn ở project khác (không tính).
    const insertSession = (
      userId: string,
      project: string,
      sourceId: string,
      startedAt: string,
    ) =>
      querySql(
        `INSERT INTO sessions (user_id, project_id, source_id, agent, repo_remote, started_at, turn_count)
         VALUES ($1, $2, $3, 'claude_code', 'example.org/demo', $4, 1)`,
        [userId, project, sourceId, startedAt],
      );
    await insertSession(member1, projectId, 's1', '2026-11-20T08:00:00Z');
    await insertSession(member1, projectId, 's2', '2026-11-25T09:30:00Z');
    await insertSession(member1, other.body.id, 's3', '2026-11-26T10:00:00Z');

    const res = await leader
      .get(`/api/v1/projects/${projectId}/member-status`)
      .expect(200);
    const items = res.body.items as {
      userId: string;
      name: string;
      email: string | null;
      role: string;
      joinedAt: string;
      lastSessionAt: string | null;
      devices: { id: string; status: string; revokedAt: string | null }[];
    }[];
    // Người tạo project (leader) tự thành thành viên, tham gia mới nhất nên đứng đầu.
    expect(items.map((m) => m.name)).toEqual(['Leader', 'Bình', 'An']);
    const [creator, binh, an] = items;
    expect(creator).toMatchObject({ role: 'leader', devices: [] });
    expect(an).toMatchObject({
      userId: member1,
      email: 'member1@teamlens.local',
      role: 'member',
      lastSessionAt: '2026-11-25T09:30:00.000Z',
    });
    expect(binh).toMatchObject({ email: null, lastSessionAt: null });
    const day = 24 * 60 * 60_000;
    expect(Date.now() - new Date(an.joinedAt).getTime()).toBeGreaterThan(
      9.9 * day,
    );
    expect(Date.now() - new Date(binh.joinedAt).getTime()).toBeLessThan(
      2.1 * day,
    );

    const statusOf = (list: typeof an.devices) =>
      Object.fromEntries(list.map((d) => [d.id, d.status]));
    expect(statusOf(an.devices)).toEqual({
      [online.id]: 'online',
      [stale.id]: 'offline',
      [paused.id]: 'paused',
      [revoked.id]: 'online',
    });
    expect(an.devices.at(-1)?.id).toBe(revoked.id);
    expect(an.devices.at(-1)?.revokedAt).not.toBeNull();
    expect(statusOf(binh.devices)).toEqual({
      [consent.id]: 'consent_revoked',
      [never.id]: 'offline',
    });

    // Thu hồi qua endpoint có sẵn thì thiết bị vẫn trong danh sách, có revokedAt.
    await leader.post(`/api/v1/devices/${online.id}/revoke`).expect(204);
    const after = await leader
      .get(`/api/v1/projects/${projectId}/member-status`)
      .expect(200);
    const anAfter = after.body.items.find(
      (m: { userId: string }) => m.userId === member1,
    );
    expect(
      anAfter.devices.find((d: { id: string }) => d.id === online.id).revokedAt,
    ).not.toBeNull();

    const countAudit = async () =>
      (
        await querySql<{ count: number }>(
          'SELECT count(*)::int AS count FROM audit_log',
        )
      )[0].count;
    const auditBefore = await countAudit();
    await leader.get(`/api/v1/projects/${projectId}/member-status`).expect(200);

    // Member không xem được (kể cả là thành viên project).
    const member = request.agent(server);
    await member.post('/api/v1/auth/login').send(memberCredentials).expect(200);
    await member.get(`/api/v1/projects/${projectId}/member-status`).expect(403);
    await request(server)
      .get(`/api/v1/projects/${projectId}/member-status`)
      .expect(401);
    await leader
      .get(
        '/api/v1/projects/00000000-0000-4000-8000-000000000000/member-status',
      )
      .expect(404);
    await leader
      .get('/api/v1/projects/khong-phai-uuid/member-status')
      .expect(404);

    // Xem danh sách không ghi audit.
    expect(await countAudit()).toBe(auditBefore);
  });
});
