import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp, insertUser, querySql, resetDatabase } from './helpers.js';

describe('Leaderboard (M4.3)', () => {
  let app: INestApplication<App>;
  beforeAll(async () => { await resetDatabase(); app = await createTestApp(); });
  afterAll(async () => { await app?.close(); });

  it('ẩn danh tính ở API, chặn bảng riêng tư và đếm đúng session gốc trong tháng UTC', async () => {
    const server = app.getHttpServer();
    const leader = request.agent(server);
    await leader.post('/api/v1/setup').send({ email: 'leader@example.test', password: 'teamlens123', name: 'Leader' }).expect(201);
    await leader.post('/api/v1/auth/login').send({ email: 'leader@example.test', password: 'teamlens123' }).expect(200);
    const aliceId = await insertUser({ email: 'alice@example.test', password: 'teamlens123', name: 'Alice' });
    const bobId = await insertUser({ email: 'bob@example.test', password: 'teamlens123', name: 'Bob' });
    const projectId: string = (await leader.post('/api/v1/projects').send({ name: 'One', slug: 'one' }).expect(201)).body.id;
    const otherId: string = (await leader.post('/api/v1/projects').send({ name: 'Two', slug: 'two' }).expect(201)).body.id;
    for (const userId of [aliceId, bobId]) {
      await leader.post(`/api/v1/projects/${projectId}/members`).send({ userId }).expect(201);
    }
    const alice = request.agent(server);
    await alice.post('/api/v1/auth/login').send({ email: 'alice@example.test', password: 'teamlens123' }).expect(200);
    await alice.get(`/api/v1/projects/${projectId}/leaderboard?at=2026-03-02`).expect(403);

    await querySql(`INSERT INTO user_weekly_stats (user_id, project_id, week, sessions, scores)
      VALUES ($1,$3,'2026-03-02',5,'{"context":80}'::jsonb),
             ($2,$3,'2026-03-02',6,'{"context":90}'::jsonb)`, [aliceId, bobId, projectId]);
    await leader.patch(`/api/v1/projects/${projectId}`).send({ settings: { leaderboardPublic: true } }).expect(200);
    const publicBoard = await alice.get(`/api/v1/projects/${projectId}/leaderboard?at=2026-03-02`).expect(200);
    expect(publicBoard.body.entries).toEqual([
      { rank: 1, userId: null, name: null, isSelf: false, sessions: 6, overall: 90, scores: { context: 90 } },
      { rank: 2, userId: aliceId, name: 'Alice', isSelf: true, sessions: 5, overall: 80, scores: { context: 80 } },
    ]);
    expect(JSON.stringify(publicBoard.body)).not.toContain(bobId);
    expect(JSON.stringify(publicBoard.body)).not.toContain('Bob');

    for (let n = 1; n <= 5; n++) {
      const [row] = await querySql<{ id: string }>(`INSERT INTO sessions
        (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count)
        VALUES ($1,$2,$3,'codex','example.org/repo',$4,1) RETURNING id`,
        [aliceId, projectId, `root-${n}`, n === 1 ? '2026-03-01T00:00:00Z' : `2026-03-0${n}T10:00:00Z`]);
      await querySql(`INSERT INTO session_scores (session_id,category,score) VALUES ($1,'context',80)`, [row.id]);
    }
    await querySql(`INSERT INTO sessions (user_id,project_id,source_id,parent_source_id,agent,repo_remote,started_at)
      VALUES ($1,$2,'child','root-1','codex','example.org/repo','2026-03-01T12:00:00Z')`, [aliceId, projectId]);
    await querySql(`INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at)
      VALUES ($1,$2,'february','codex','example.org/repo','2026-02-28T23:59:59Z')`, [aliceId, projectId]);
    const month = await alice.get(`/api/v1/projects/${projectId}/leaderboard?period=month&at=2026-03-15`).expect(200);
    expect(month.body.mySessions).toBe(5);
    expect(month.body.entries).toHaveLength(1);
    expect(month.body.entries[0]).toMatchObject({ userId: aliceId, sessions: 5, overall: 80 });

    await leader.patch(`/api/v1/projects/${projectId}`).send({ settings: { leaderboardEnabled: false } }).expect(200);
    await alice.get(`/api/v1/projects/${projectId}/leaderboard?at=2026-03-02`).expect(403);
    const off = await leader.get(`/api/v1/projects/${projectId}/leaderboard?at=2026-03-02`).expect(200);
    expect(off.body.entries).toEqual([]);
    const other = await leader.get(`/api/v1/projects/${otherId}/leaderboard?at=2026-03-02`).expect(200);
    expect(other.body.leaderboardEnabled).toBe(true);
    expect(other.body.leaderboardPublic).toBe(false);
  });
});
