import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp, insertDevice, insertUser, querySql, resetDatabase } from './helpers.js';

describe('Của tôi và audit M4.5', () => {
  let app: INestApplication<App>;
  beforeAll(async () => { await resetDatabase(); app = await createTestApp(); });
  afterAll(async () => { await app?.close(); });

  it('member chỉ thấy consent/lượt xem của mình; cursor ổn định khi cùng thời điểm; audit chỉ leader', async () => {
    const server = app.getHttpServer();
    const leader = request.agent(server);
    const setup = await leader.post('/api/v1/setup').send({ email: 'leader@example.test', password: 'teamlens123', name: 'Leader' }).expect(201);
    const leaderId: string = setup.body.user.id;
    await leader.post('/api/v1/auth/login').send({ email: 'leader@example.test', password: 'teamlens123' }).expect(200);
    const ownerId = await insertUser({ email: 'owner@example.test', password: 'teamlens123', name: 'Owner' });
    const otherId = await insertUser({ email: 'other@example.test', password: 'teamlens123', name: 'Other' });
    const projectId: string = (await leader.post('/api/v1/projects').send({ name: 'Demo', slug: 'demo' }).expect(201)).body.id;
    const [own] = await querySql<{ id: string }>(`INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at)
      VALUES ($1,$2,'own','codex','example.org/demo','2026-11-20T10:00Z') RETURNING id`, [ownerId, projectId]);
    const [other] = await querySql<{ id: string }>(`INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at)
      VALUES ($1,$2,'other','codex','example.org/demo','2026-11-20T11:00Z') RETURNING id`, [otherId, projectId]);
    const device = await insertDevice(ownerId, 'Laptop của tôi');
    await querySql(`INSERT INTO consents (user_id,device_id,text_version,backfill,granted_at,revoked_at)
      VALUES ($1,$2,'2026-11-27.3',false,'2026-11-20T10:00Z',NULL),
             ($1,$2,'2026-11-26.1',true,'2026-11-19T10:00Z','2026-11-20T10:00Z')`, [ownerId, device.id]);
    await querySql(`INSERT INTO consents (user_id,text_version,backfill) VALUES ($1,'other-version',false)`, [otherId]);
    await querySql(`INSERT INTO audit_log (actor_id,action,target_type,target_id,at)
      SELECT $1,'session.view','session',$2,'2026-11-20T12:00Z' FROM generate_series(1,21)`, [leaderId, own.id]);
    await querySql(`INSERT INTO audit_log (actor_id,action,target_type,target_id,at)
      VALUES (NULL,'session.view','session',$1,'2026-11-20T12:01Z'),
             ($2,'session.view','session',$3,'2026-11-20T12:02Z')`, [own.id, leaderId, other.id]);
    const owner = request.agent(server);
    await owner.post('/api/v1/auth/login').send({ email: 'owner@example.test', password: 'teamlens123' }).expect(200);
    await owner.get('/api/v1/audit').expect(403);
    const consents = await owner.get('/api/v1/me/consents').expect(200);
    expect(consents.body).toHaveLength(2);
    expect(consents.body[0]).toMatchObject({ deviceId: device.id, deviceName: 'Laptop của tôi', textVersion: '2026-11-27.3' });
    expect(JSON.stringify(consents.body)).not.toContain('other-version');
    const devices = await owner.get('/api/v1/devices').expect(200);
    expect(devices.body).toHaveLength(1);
    const first = await owner.get('/api/v1/me/session-views?limit=20').expect(200);
    expect(first.body.items).toHaveLength(20);
    expect(first.body.items[0]).toMatchObject({ sessionId: own.id, actorId: null, actorName: null });
    const second = await owner.get(`/api/v1/me/session-views?limit=20&cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(22);
    expect(JSON.stringify(first.body) + JSON.stringify(second.body)).not.toContain(other.id);
    await owner.get('/api/v1/me/session-views?cursor=bad').expect(400);
    const audit = await leader.get(`/api/v1/audit?action=session.view&targetId=${own.id}&limit=20`).expect(200);
    expect(audit.body.items).toHaveLength(20);
    expect(audit.body.nextCursor).toEqual(expect.any(String));
    const byActor = await leader.get(`/api/v1/audit?action=session.view&actorId=${leaderId}&from=2026-11-20T12:00:00Z&to=2026-11-20T12:03:00Z`).expect(200);
    expect(byActor.body.items.every((item: { actorId: string }) => item.actorId === leaderId)).toBe(true);
  });
});
