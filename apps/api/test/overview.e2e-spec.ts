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

describe('Tổng quan project (M2.9)', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    await app.get(QueueService).boss.deleteAllJobs(JOBS.sessionIngested);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('gộp số liệu theo tuần, chi phí, số liệu không tính điểm, top finding và phân quyền', async () => {
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
      email: 'member1@teamlens.local',
      password: 'teamlens123',
    };
    const member1 = await insertUser({
      ...memberCredentials,
      name: 'Member 1',
    });
    const member2 = await insertUser({
      email: 'member2@teamlens.local',
      password: 'teamlens123',
      name: 'Member 2',
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

    await querySql("SELECT ensure_turns_partitions('2026-11-02T00:00Z', 0)");
    const insertSession = async (v: {
      userId: string;
      sourceId: string;
      parent?: string;
      agent: string;
      startedAt: string;
      turnCount: number;
      input: number;
      output: number;
      cacheRead: number;
    }) => {
      const [row] = await querySql<{ id: string }>(
        `INSERT INTO sessions (user_id,project_id,source_id,parent_source_id,agent,repo_remote,started_at,turn_count,
           input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
         VALUES ($1,$2,$3,$4,$5,'example.org/demo',$6,$7,$8,$9,$10,0) RETURNING id`,
        [
          v.userId,
          projectId,
          v.sourceId,
          v.parent ?? null,
          v.agent,
          v.startedAt,
          v.turnCount,
          v.input,
          v.output,
          v.cacheRead,
        ],
      );
      return row.id;
    };
    const assistantTurn = (
      sessionId: string,
      seq: number,
      ts: string,
      model: string,
      usage: object,
      effort: string | null,
    ) =>
      // JSON ghi thẳng vào câu SQL (dữ liệu test do ta tự dựng): truyền chuỗi qua tham số `::jsonb` sẽ bị mã hóa hai lần.
      querySql(
        `INSERT INTO turns (session_id,seq,role,kind,ts,model,usage,reasoning_effort)
         VALUES ($1,$2,'assistant','message',$3,$4,'${JSON.stringify(usage)}'::jsonb,$5)`,
        [sessionId, seq, ts, model, effort],
      );

    // Tuần 2026-11-02: member1 có session gốc (3 prompt phản bác liên tiếp + 1 lượt Opus) và một session con (Sonnet).
    const s1 = await insertSession({
      userId: member1,
      sourceId: 's1',
      agent: 'claude_code',
      startedAt: '2026-11-04T10:00Z',
      turnCount: 4,
      input: 1_000_000,
      output: 200_000,
      cacheRead: 3_000_000,
    });
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) SELECT $1,n,'user','prompt','2026-11-04T10:00Z',
       CASE n WHEN 1 THEN 'Vẫn lỗi ở src/cart.ts' WHEN 2 THEN 'Chưa được' ELSE 'Vẫn lỗi' END FROM generate_series(1,3) n`,
      [s1],
    );
    await assistantTurn(
      s1,
      4,
      '2026-11-04T10:01Z',
      'claude-opus-4-6',
      { input: 1_000_000, output: 200_000, cache_read: 3_000_000 },
      null,
    );
    const child = await insertSession({
      userId: member1,
      sourceId: 'c1',
      parent: 's1',
      agent: 'claude_code',
      startedAt: '2026-11-04T10:05Z',
      turnCount: 1,
      input: 1_000_000,
      output: 100_000,
      cacheRead: 0,
    });
    await assistantTurn(
      child,
      1,
      '2026-11-04T10:05Z',
      'claude-sonnet-4-5',
      { input: 1_000_000, output: 100_000 },
      null,
    );
    // Tuần 2026-11-09: member2 dùng Codex với mức suy luận cao.
    const s2 = await insertSession({
      userId: member2,
      sourceId: 's2',
      agent: 'codex',
      startedAt: '2026-11-10T09:00Z',
      turnCount: 2,
      input: 100_000,
      output: 50_000,
      cacheRead: 400_000,
    });
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) VALUES ($1,1,'user','prompt','2026-11-10T09:00Z','ok')`,
      [s2],
    );
    await assistantTurn(
      s2,
      2,
      '2026-11-10T09:01Z',
      'gpt-5-codex',
      { input: 100_000, output: 50_000, cache_read: 400_000 },
      'high',
    );

    const db = app.get(DB);
    for (const id of [s1, child, s2]) await scoreSession(db, id);

    const url = `/api/v1/projects/${projectId}/overview`;
    const query = '?from=2026-11-02T00:00:00Z&to=2026-11-16T00:00:00Z';
    const { body } = await admin.get(url + query).expect(200);

    expect(body.range).toEqual({
      from: '2026-11-02T00:00:00.000Z',
      to: '2026-11-16T00:00:00.000Z',
    });
    // Session con không tính vào số session, nhưng token của nó cộng vào tuần.
    expect(body.totals).toMatchObject({
      sessions: 2,
      activeMembers: 2,
      tokens: 5_850_000,
    });
    expect(body.totals.estimatedCostUsd).toBeCloseTo(16.675, 4);
    expect(body.weeks).toHaveLength(2);
    expect(body.weeks[0]).toMatchObject({
      week: '2026-11-02',
      sessions: 1,
      tokens: 5_300_000,
    });
    expect(body.weeks[0].estimatedCostUsd).toBeCloseTo(16, 4);
    expect(body.weeks[0].scores.correction_loop).toBe(80);
    expect(Object.keys(body.weeks[0].scores)).toHaveLength(5);
    expect(body.weeks[1]).toMatchObject({
      week: '2026-11-09',
      sessions: 1,
      tokens: 550_000,
    });
    expect(body.weeks[1].estimatedCostUsd).toBeCloseTo(0.675, 4);

    expect(body.byAgent).toEqual([
      { agent: 'claude_code', sessions: 1, tokens: 5_300_000 },
      { agent: 'codex', sessions: 1, tokens: 550_000 },
    ]);
    expect(body.byModel.map((m: { model: string }) => m.model)).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-5',
      'gpt-5-codex',
    ]);
    expect(body.byModel[0]).toMatchObject({ turns: 1, tokens: 4_200_000 });

    expect(body.usageStats.cacheHitRate).toBeCloseTo(3_400_000 / 5_500_000, 4);
    expect(body.usageStats.premiumModelRate).toBeCloseTo(1 / 3, 4);
    expect(body.usageStats.highReasoningRate).toBe(1);
    expect(body.usageStats.avgOutputTokensPerTurn).toBeCloseTo(350_000 / 3, 2);

    const correction = body.topFindings.find(
      (f: { ruleKey: string }) => f.ruleKey === 'repeated-correction',
    );
    expect(correction).toEqual({
      ruleKey: 'repeated-correction',
      category: 'correction_loop',
      severity: 'high',
      count: 1,
      memberCount: 1,
    });
    const counts = body.topFindings.map((f: { count: number }) => f.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));

    // Không truyền from/to: 8 tuần gần nhất, vẫn trả 200.
    expect((await admin.get(url).expect(200)).body.weeks).toHaveLength(8);

    // Khoảng không có dữ liệu: số 0, chi phí null.
    const empty = (
      await admin
        .get(`${url}?from=2025-01-06T00:00:00Z&to=2025-01-20T00:00:00Z`)
        .expect(200)
    ).body;
    expect(empty.totals).toEqual({
      sessions: 0,
      activeMembers: 0,
      tokens: 0,
      estimatedCostUsd: null,
    });
    expect(empty.weeks).toHaveLength(2);

    // Lỗi tham số, phân quyền, không tìm thấy.
    await admin
      .get(`${url}?from=2026-11-10T00:00:00Z&to=2026-11-03T00:00:00Z`)
      .expect(400);
    await admin.get(`${url}?from=abc`).expect(400);
    await request(server).get(url).expect(401);
    const member = request.agent(server);
    await member
      .post('/api/v1/auth/login')
      .send(memberCredentials)
      .expect(200);
    await member.get(url + query).expect(403);
    await admin
      .get('/api/v1/projects/00000000-0000-4000-8000-000000000000/overview')
      .expect(404);
    await admin.get('/api/v1/projects/invalid/overview').expect(404);
  });
});
