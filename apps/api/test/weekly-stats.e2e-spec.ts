import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DB } from '../src/db/db.module.js';
import { JOBS } from '../src/queue/jobs.js';
import { QueueService } from '../src/queue/queue.service.js';
import { scoreSession } from '../src/modules/rules/score-session.js';
import {
  createTestApp,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

interface StatsRow extends Record<string, unknown> {
  week: string;
  sessions: number;
  tokens: string;
  scores: Record<string, number>;
}

describe('user_weekly_stats và chạy lại rule (M2.8)', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    await app.get(QueueService).boss.deleteAllJobs(JOBS.sessionIngested);
    await app.get(QueueService).boss.deleteAllJobs(JOBS.projectRescore);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('tổng hợp theo tuần, tính token cả session con, chạy lại ở nền và phân quyền', async () => {
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
    const memberId = await insertUser({ ...memberCredentials, name: 'Member' });
    const project = await admin
      .post('/api/v1/projects')
      .send({ name: 'Demo', slug: 'demo' })
      .expect(201);
    const projectId: string = project.body.id;
    await admin
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: memberId })
      .expect(201);

    await querySql("SELECT ensure_turns_partitions('2026-11-02T00:00Z', 0)");
    // Tuần 2026-11-02: một session gốc 3 prompt phản bác liên tiếp (correction_loop trừ 20) và một session con.
    const [root] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,'root','claude_code','example.org/demo','2026-11-04T10:00Z',3,100,50,10,5) RETURNING id`,
      [memberId, projectId],
    );
    const [child] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,parent_source_id,agent,repo_remote,started_at,turn_count,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,'child','root','claude_code','example.org/demo','2026-11-04T10:05Z',1,200,0,0,0) RETURNING id`,
      [memberId, projectId],
    );
    // Tuần kế tiếp (2026-11-09): một session gốc riêng.
    await querySql("SELECT ensure_turns_partitions('2026-11-09T00:00Z', 0)");
    const [nextWeek] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count,input_tokens)
       VALUES ($1,$2,'next','claude_code','example.org/demo','2026-11-10T09:00Z',1,7) RETURNING id`,
      [memberId, projectId],
    );
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) SELECT $1,n,'user','prompt','2026-11-04T10:00Z',
       CASE n WHEN 1 THEN 'Vẫn lỗi ở src/cart.ts' WHEN 2 THEN 'Chưa được' ELSE 'Vẫn lỗi' END FROM generate_series(1,3) n`,
      [root.id],
    );
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) VALUES ($1,1,'user','prompt','2026-11-10T09:00Z','ok')`,
      [nextWeek.id],
    );

    const db = app.get(DB);
    await scoreSession(db, root.id);
    await scoreSession(db, child.id);
    await scoreSession(db, nextWeek.id);

    const read = () =>
      querySql<StatsRow>(
        `SELECT week::text AS week, sessions, tokens::text AS tokens, scores
         FROM user_weekly_stats WHERE user_id=$1 AND project_id=$2 ORDER BY week`,
        [memberId, projectId],
      );
    const rows = await read();
    expect(rows).toHaveLength(2);
    // Session con không tính vào `sessions`, nhưng token của nó cộng vào tuần: 100+50+10+5+200.
    expect(rows[0]).toMatchObject({
      week: '2026-11-02',
      sessions: 1,
      tokens: '365',
    });
    expect(rows[1]).toMatchObject({
      week: '2026-11-09',
      sessions: 1,
      tokens: '7',
    });
    // Một session gốc, không có finding tuần (chưa đủ mẫu): điểm tuần bằng điểm session.
    const sessionScores = await querySql<{ category: string; score: number }>(
      'SELECT category, score FROM session_scores WHERE session_id=$1',
      [root.id],
    );
    expect(Object.keys(rows[0].scores)).toHaveLength(5);
    expect(rows[0].scores.correction_loop).toBe(80);
    expect(rows[0].scores).toEqual(
      Object.fromEntries(sessionScores.map((s) => [s.category, s.score])),
    );
    // Session con không có điểm riêng.
    expect(
      await querySql('SELECT 1 FROM session_scores WHERE session_id=$1', [
        child.id,
      ]),
    ).toHaveLength(0);

    // Chấm lại nhiều lần không tạo dòng trùng.
    await Promise.all([scoreSession(db, root.id), scoreSession(db, root.id)]);
    expect(await read()).toEqual(rows);

    // Chạy lại: phân quyền.
    const url = `/api/v1/projects/${projectId}/rules/rerun`;
    await request(server).post(url).expect(401);
    const member = request.agent(server);
    await member
      .post('/api/v1/auth/login')
      .send(memberCredentials)
      .expect(200);
    await member.post(url).expect(403);
    await admin
      .post('/api/v1/projects/00000000-0000-4000-8000-000000000000/rules/rerun')
      .expect(404);
    await admin.post('/api/v1/projects/invalid/rules/rerun').expect(404);

    // Xóa thống kê rồi chạy lại: job nền dựng lại đúng như cũ.
    await querySql('DELETE FROM user_weekly_stats');
    expect((await admin.post(url).expect(202)).body).toEqual({
      status: 'queued',
      runId: expect.any(String),
    });
    await vi.waitFor(
      async () => {
        expect(await read()).toEqual(rows);
      },
      { timeout: 15000, interval: 250 },
    );
    expect(
      await querySql(
        "SELECT 1 FROM audit_log WHERE target_id=$1 AND action='rules.rerun'",
        [projectId],
      ),
    ).toHaveLength(1);
  });
});
