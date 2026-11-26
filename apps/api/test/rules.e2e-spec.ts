import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DB } from '../src/db/db.module.js';
import { JOBS } from '../src/queue/jobs.js';
import { QueueService } from '../src/queue/queue.service.js';
import { scoreSession } from '../src/modules/rules/score-session.js';
import { createTestApp, querySql, resetDatabase } from './helpers.js';

describe('Chấm session và đọc findings', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    // Các suite trước xóa dữ liệu session nhưng có thể còn job của session cũ.
    await app.get(QueueService).boss.deleteAllJobs(JOBS.sessionIngested);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('job thật, chấm lại đồng thời, phân quyền và bằng chứng hết hạn', async () => {
    const server = app.getHttpServer();
    const admin = request.agent(server);
    const credentials = {
      email: 'admin@teamlens.local',
      password: 'teamlens123',
    };
    await admin
      .post('/api/v1/setup')
      .send({ ...credentials, name: 'Admin' })
      .expect(201);
    await admin.post('/api/v1/auth/login').send(credentials).expect(200);
    const memberCredentials = {
      email: 'member@teamlens.local',
      password: 'teamlens123',
    };
    const member = await admin
      .post('/api/v1/users')
      .send({ ...memberCredentials, name: 'Member' })
      .expect(201);
    const project = await admin
      .post('/api/v1/projects')
      .send({ name: 'Demo', slug: 'demo' })
      .expect(201);
    await admin
      .post(`/api/v1/projects/${project.body.id}/members`)
      .send({ email: memberCredentials.email, role: 'member' })
      .expect(201);
    const [{ id }] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id, project_id, source_id, agent, repo_remote, started_at)
      VALUES ($1,$2,'example','codex','example.org/demo',now()) RETURNING id`,
      [member.body.id, project.body.id],
    );
    await querySql('SELECT ensure_turns_partitions(now(), 0)');
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) SELECT $1,n,'user','prompt',now(),'Vẫn lỗi' FROM generate_series(1,3) n`,
      [id],
    );
    const url = `/api/v1/sessions/${id}/findings`;
    await request(server).get(url).expect(401);
    const owner = request.agent(server);
    await owner.post('/api/v1/auth/login').send(memberCredentials).expect(200);
    expect((await owner.get(url).expect(200)).body.items).toEqual([]);
    await app.get(QueueService).send(JOBS.sessionIngested, { sessionId: id });
    await vi.waitFor(
      async () => {
        expect((await owner.get(url).expect(200)).body.items).toMatchObject([
          {
            ruleKey: 'repeated-correction',
            severity: 'high',
            turnSeq: 3,
            evidenceExcerpt: 'Vẫn lỗi',
          },
        ]);
      },
      { timeout: 15000, interval: 250 },
    );
    await Promise.all([
      scoreSession(app.get(DB), id),
      scoreSession(app.get(DB), id),
    ]);
    expect((await admin.get(url).expect(200)).body.items).toHaveLength(1);
    const scores = await querySql(
      'SELECT category,score FROM session_scores WHERE session_id=$1',
      [id],
    );
    expect(scores).toHaveLength(5);
    expect(scores).toContainEqual({ category: 'correction_loop', score: 80 });
    expect(
      await querySql(
        "SELECT action FROM audit_log WHERE target_id=$1 AND action='session.view'",
        [id],
      ),
    ).toHaveLength(1);
    const other = { email: 'other@teamlens.local', password: 'teamlens123' };
    await admin
      .post('/api/v1/users')
      .send({ ...other, name: 'Other' })
      .expect(201);
    const outsider = request.agent(server);
    await outsider.post('/api/v1/auth/login').send(other).expect(200);
    await outsider.get(url).expect(403);
    await owner.get('/api/v1/sessions/invalid/findings').expect(404);
    await querySql('UPDATE sessions SET turn_count=3 WHERE id=$1', [id]);
    await querySql('DELETE FROM turns WHERE session_id=$1 AND seq=3', [id]);
    await scoreSession(app.get(DB), id);
    expect(
      (await owner.get(url).expect(200)).body.items[0].evidenceExcerpt,
    ).toBeNull();
    await querySql(
      "INSERT INTO turns (session_id,seq,role,kind,ts,text) VALUES ($1,3,'user','prompt',now(),'OK')",
      [id],
    );
    await scoreSession(app.get(DB), id);
    expect((await owner.get(url).expect(200)).body.items).toEqual([]);
  });
});
