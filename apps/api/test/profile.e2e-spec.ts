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

describe('Hồ sơ thành viên (M2.10)', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    await app.get(QueueService).boss.deleteAllJobs(JOBS.sessionIngested);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('điểm, trung bình team, anti-pattern kèm ví dụ và lời khuyên, audit và phân quyền', async () => {
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

    const member1Credentials = {
      email: 'member1@teamlens.local',
      password: 'teamlens123',
    };
    const member1 = await insertUser({
      ...member1Credentials,
      name: 'Thành viên 1',
    });
    const member2 = await insertUser({
      email: 'member2@teamlens.local',
      password: 'teamlens123',
      name: 'Thành viên 2',
    });
    const outsider = await insertUser({
      email: 'outsider@teamlens.local',
      password: 'teamlens123',
      name: 'Ngoài project',
    });
    const project = await admin
      .post('/api/v1/projects')
      .send({ name: 'Demo', slug: 'demo' })
      .expect(201);
    const projectId: string = project.body.id;
    for (const userId of [member1, member2])
      await admin
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId })
        .expect(201);

    await querySql("SELECT ensure_turns_partitions('2026-11-09T00:00Z', 0)");
    await querySql("SELECT ensure_turns_partitions('2026-11-16T00:00Z', 0)");
    const insertSession = async (
      userId: string,
      sourceId: string,
      startedAt: string,
      turnCount: number,
    ) => {
      const [row] = await querySql<{ id: string }>(
        `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count)
         VALUES ($1,$2,$3,'claude_code','example.org/demo',$4,$5) RETURNING id`,
        [userId, projectId, sourceId, startedAt, turnCount],
      );
      return row.id;
    };
    // member1 tuần 2026-11-09: ba prompt phản bác liên tiếp (repeated-correction, mức high).
    const s1 = await insertSession(member1, 's1', '2026-11-10T10:00Z', 3);
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) SELECT $1,n,'user','prompt','2026-11-10T10:00Z',
       CASE n WHEN 1 THEN 'Vẫn lỗi ở src/cart.ts' WHEN 2 THEN 'Chưa được' ELSE 'Vẫn lỗi' END FROM generate_series(1,3) n`,
      [s1],
    );
    // member1 tuần 2026-11-16: một session bình thường.
    const s3 = await insertSession(member1, 's3', '2026-11-17T10:00Z', 1);
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) VALUES ($1,1,'user','prompt','2026-11-17T10:00Z','ok')`,
      [s3],
    );
    // member2 tuần 2026-11-09: một session bình thường.
    const s2 = await insertSession(member2, 's2', '2026-11-11T10:00Z', 1);
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) VALUES ($1,1,'user','prompt','2026-11-11T10:00Z','ok')`,
      [s2],
    );
    const db = app.get(DB);
    for (const id of [s1, s2, s3]) await scoreSession(db, id);

    const range = 'from=2026-11-09T00:00:00Z&to=2026-11-23T00:00:00Z';
    const url = (userId: string, extra = range) =>
      `/api/v1/users/${userId}/profile?project=${projectId}&${extra}`;

    const { body } = await admin.get(url(member1)).expect(200);
    expect(body.user).toEqual({ id: member1, name: 'Thành viên 1' });
    expect(body.projectId).toBe(projectId);
    expect(body.range).toEqual({
      from: '2026-11-09T00:00:00.000Z',
      to: '2026-11-23T00:00:00.000Z',
    });
    expect(body.totals.sessions).toBe(2);
    expect(body.weeks.map((w: { week: string }) => w.week)).toEqual([
      '2026-11-09',
      '2026-11-16',
    ]);
    expect(body.weeks[0]).toMatchObject({ sessions: 1 });
    expect(body.weeks[0].scores.correction_loop).toBe(80);
    expect(Object.keys(body.scores)).toHaveLength(5);
    // Trung bình team tuần đầu: member1 80 (1 session) và member2 100 (1 session) -> 90.
    expect(body.weeks[0].teamScores.correction_loop).toBe(90);
    expect(body.teamScores.correction_loop).toBeGreaterThan(
      body.scores.correction_loop,
    );

    const pattern = body.patterns.find(
      (p: { ruleKey: string }) => p.ruleKey === 'repeated-correction',
    );
    expect(pattern).toMatchObject({
      category: 'correction_loop',
      severity: 'high',
      count: 1,
    });
    expect(typeof pattern.advice).toBe('string');
    expect(pattern.examples).toEqual([
      {
        sessionId: s1,
        turnSeq: 3,
        message: expect.any(String),
        excerpt: 'Vẫn lỗi',
      },
    ]);
    const counts = body.patterns.map((p: { count: number }) => p.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    // Anti-pattern của member2 không lẫn vào hồ sơ member1.
    expect(
      (await admin.get(url(member2)).expect(200)).body.patterns.every(
        (p: { ruleKey: string }) => p.ruleKey !== 'repeated-correction',
      ),
    ).toBe(true);

    // Leader xem hồ sơ người khác: ghi audit, mỗi lần xem một dòng.
    const audit = (target: string) =>
      querySql(
        "SELECT actor_id FROM audit_log WHERE action='profile.view' AND target_id=$1",
        [target],
      );
    expect(await audit(member1)).toHaveLength(1);

    // Member xem hồ sơ của chính mình: 200, thấy trung bình team, không ghi audit.
    const own = request.agent(server);
    await own.post('/api/v1/auth/login').send(member1Credentials).expect(200);
    const mine = (await own.get(url(member1)).expect(200)).body;
    expect(mine.user.id).toBe(member1);
    expect(mine.weeks[0].teamScores.correction_loop).toBe(90);
    expect(await audit(member1)).toHaveLength(1);
    // Member xem hồ sơ người khác: 403.
    await own.get(url(member2)).expect(403);

    // Không đăng nhập, tham số sai, không tìm thấy.
    await request(server).get(url(member1)).expect(401);
    await admin
      .get(`/api/v1/users/${member1}/profile?${range}`)
      .expect(400);
    await admin
      .get(`/api/v1/users/${member1}/profile?project=abc&${range}`)
      .expect(400);
    await admin
      .get(
        `/api/v1/users/${member1}/profile?project=00000000-0000-4000-8000-000000000000&${range}`,
      )
      .expect(404);
    await admin.get(url(outsider)).expect(404);
    await admin.get(`/api/v1/users/invalid/profile?project=${projectId}`).expect(404);
    await admin
      .get(url(member1, 'from=2026-11-20T00:00:00Z&to=2026-11-10T00:00:00Z'))
      .expect(400);

    // Mặc định 2 tuần gần nhất.
    expect(
      (await admin.get(`/api/v1/users/${member1}/profile?project=${projectId}`).expect(200))
        .body.weeks,
    ).toHaveLength(2);

    // Turn đã bị retention xóa: ví dụ chỉ còn nhận xét, không còn đoạn trích.
    await querySql('DELETE FROM turns WHERE session_id=$1 AND seq=3', [s1]);
    const expired = (await admin.get(url(member1)).expect(200)).body.patterns.find(
      (p: { ruleKey: string }) => p.ruleKey === 'repeated-correction',
    );
    expect(expired.examples[0].excerpt).toBeNull();
    expect(expired.examples[0].turnSeq).toBe(3);
  });
});
