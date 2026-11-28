import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp, insertUser, querySql, resetDatabase } from './helpers.js';

describe('Quản lý rule M4.4', () => {
  let app: INestApplication<App>;
  beforeAll(async () => { await resetDatabase(); app = await createTestApp(); });
  afterAll(async () => { await app?.close(); });

  it('chỉ leader chỉnh rule theo project, thử không ghi điểm, chạy lại có trạng thái', async () => {
    const server = app.getHttpServer();
    const leader = request.agent(server);
    await leader.post('/api/v1/setup').send({ email: 'leader@example.test', password: 'teamlens123', name: 'Leader' }).expect(201);
    await leader.post('/api/v1/auth/login').send({ email: 'leader@example.test', password: 'teamlens123' }).expect(200);
    const memberId = await insertUser({ email: 'member@example.test', password: 'teamlens123', name: 'Member' });
    const member = request.agent(server);
    await member.post('/api/v1/auth/login').send({ email: 'member@example.test', password: 'teamlens123' }).expect(200);
    const a: string = (await leader.post('/api/v1/projects').send({ name: 'A', slug: 'a' }).expect(201)).body.id;
    const b: string = (await leader.post('/api/v1/projects').send({ name: 'B', slug: 'b' }).expect(201)).body.id;
    await leader.post(`/api/v1/projects/${a}/members`).send({ userId: memberId }).expect(201);
    await member.get(`/api/v1/projects/${a}/rules`).expect(403);
    await member.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ enabled: false }).expect(403);
    const initial = await leader.get(`/api/v1/projects/${a}/rules`).expect(200);
    expect(initial.body).toHaveLength(24);
    const original = initial.body.find((rule: { key: string }) => rule.key === 'vague-followup');
    expect(original).toMatchObject({ source: 'default', enabled: true, severity: 'low' });

    await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ thresholds: { min: -1 } }).expect(400);
    const updated = await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`)
      .send({ enabled: false, severity: 'medium', thresholds: { min: 4 } }).expect(200);
    expect(updated.body).toMatchObject({ source: 'project', enabled: false, severity: 'medium', version: original.version + 1, needsRerun: true });
    const other = await leader.get(`/api/v1/projects/${b}/rules`).expect(200);
    expect(other.body.find((rule: { key: string }) => rule.key === 'vague-followup')).toMatchObject({ source: 'default', enabled: true, severity: 'low' });

    const before = await querySql<{ n: string }>('SELECT count(*)::text AS n FROM findings');
    const trial = await leader.post(`/api/v1/projects/${a}/rules/vague-followup/test`).expect(200);
    expect(trial.body).toMatchObject({ sampledSessions: 0, matchedSessions: 0, examples: [] });
    const after = await querySql<{ n: string }>('SELECT count(*)::text AS n FROM findings');
    expect(after).toEqual(before);

    await querySql(`INSERT INTO project_rescore_runs (project_id,status,updated_at) VALUES ($1,'running',now())`, [a]);
    const conflict = await leader.post(`/api/v1/projects/${a}/rules/rerun`).expect(409);
    expect(conflict.body.error).toBe('rescore_in_progress');
    await querySql(`UPDATE project_rescore_runs SET status='failed', finished_at=now() WHERE project_id=$1`, [a]);
    const accepted = await leader.post(`/api/v1/projects/${a}/rules/rerun`).expect(202);
    expect(accepted.body).toMatchObject({ status: 'queued', runId: expect.any(String) });
    const status = await leader.get(`/api/v1/projects/${a}/rules/rerun/status`).expect(200);
    expect(status.body.id).toBe(accepted.body.runId);

    // Chờ job của project trống hoàn tất rồi mới khôi phục; endpoint restore tự xếp lượt chạy lại mới.
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await leader.get(`/api/v1/projects/${a}/rules/rerun/status`).expect(200);
      if (current.body.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const restored = await leader.delete(`/api/v1/projects/${a}/rules/vague-followup/override`).expect(202);
    expect(restored.body.runId).toEqual(expect.any(String));
    const list = await leader.get(`/api/v1/projects/${a}/rules`).expect(200);
    expect(list.body.find((rule: { key: string }) => rule.key === 'vague-followup')).toMatchObject({ source: 'default', enabled: true });
  });
});
