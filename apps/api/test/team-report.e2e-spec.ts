import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LLM_ADAPTERS } from '../src/modules/llm/adapters/adapter.js';
import { FakeLlmAdapter, fakeAdapters } from '../src/modules/llm/adapters/fake.adapter.js';
import { LlmKeyService } from '../src/modules/llm/llm-key.service.js';
import { weekWindow } from '../src/modules/stats/refresh-weekly-stats.js';
import { teamWeekId } from '../src/modules/stats/team-report-prompts.js';
import { setupApp } from '../src/setup-app.js';
import { insertUser, querySql, resetDatabase } from './helpers.js';

const PASSWORD = 'teamlens123';
const DAY = 24 * 60 * 60 * 1000;
const MISSING = '99999999-9999-4999-8999-999999999999';
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const WEEK_START = new Date(weekWindow(new Date()).start.getTime() - 14 * DAY);
const WEEK = isoDay(WEEK_START);
const PREV_WEEK = isoDay(new Date(WEEK_START.getTime() - 7 * DAY));
const at = (offset: number) => new Date(WEEK_START.getTime() + offset * DAY + 3_600_000).toISOString();

describe('B2 báo cáo tuần của team do AI viết (M6.9, e2e, adapter giả)', () => {
  let app: INestApplication<App>;
  let server: App;
  const fake = new FakeLlmAdapter();
  let leaderId: string;
  let m1: string;
  let m2: string;
  let m3: string;
  let projectP: string;
  let projectQ: string;
  const sid: Record<string, string> = {};

  const url = (project: string) => `/api/v1/projects/${project}/ai/weekly-report`;
  async function loginAs(email: string) {
    const agent = request.agent(server);
    await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    return agent;
  }
  async function addSession(name: string, userId: string, startedAt: string, parentSource?: string) {
    const [row] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count,parent_source_id,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,$3,'claude_code','example.org/demo',$4,0,$5,10,10,0,0) RETURNING id`,
      [userId, projectP, name, startedAt, parentSource ?? null],
    );
    sid[name] = row.id;
    return row.id;
  }
  const stored = (userId: string) =>
    querySql<{ subject_user_id: string | null; subject_id: string; result: any }>(
      `SELECT subject_user_id, subject_id, result FROM ai_results WHERE user_id = $1 AND kind = 'weekly_team'`,
      [userId],
    );
  const auditCount = async () =>
    (await querySql<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action LIKE '%weekly%'`))[0].n;

  beforeAll(async () => {
    await resetDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_ADAPTERS)
      .useValue(fakeAdapters(fake))
      .compile();
    app = setupApp(moduleRef.createNestApplication({ logger: ['error', 'warn'] }));
    await app.init();
    server = app.getHttpServer();

    leaderId = await insertUser({ email: 'leader@tr.local', name: 'Leader', role: 'leader', password: PASSWORD });
    await insertUser({ email: 'leader2@tr.local', name: 'Leader Hai', role: 'leader', password: PASSWORD });
    m1 = await insertUser({ email: 'm1@tr.local', name: 'An Nguyễn', password: PASSWORD });
    m2 = await insertUser({ email: 'm2@tr.local', name: 'Bình Trần', password: PASSWORD });
    m3 = await insertUser({ email: 'm3@tr.local', name: 'Chi Lê', password: PASSWORD });
    const leader = await loginAs('leader@tr.local');
    projectP = (await leader.post('/api/v1/projects').send({ name: 'Dự án P', slug: 'p' }).expect(201)).body.id as string;
    projectQ = (await leader.post('/api/v1/projects').send({ name: 'Dự án Q', slug: 'q' }).expect(201)).body.id as string;
    for (const userId of [m1, m2, m3]) await leader.post(`/api/v1/projects/${projectP}/members`).send({ userId }).expect(201);

    // Tuần mục tiêu: m1 3 session, m2 2 session, m3 1 session (+1 session con của m1 không tính). Tuần trước: m1, m2.
    await addSession('a1', m1, at(1));
    await addSession('a2', m1, at(2));
    await addSession('a3', m1, at(3));
    await addSession('child', m1, at(2), 'cha');
    await addSession('b1', m2, at(1));
    await addSession('b2', m2, at(4));
    await addSession('c1', m3, at(2));
    await querySql(`UPDATE sessions SET work_type='bugfix' WHERE id = ANY($1::uuid[])`, [[sid.a1, sid.b1] as never]);
    for (const [name, key] of [['a1', 'no-test-after-edit'], ['a2', 'no-test-after-edit'], ['b1', 'lazy-prompting'], ['c1', 'no-test-after-edit']] as const)
      await querySql(`INSERT INTO findings (session_id,rule_id,rule_version) SELECT $1, id, 1 FROM rules WHERE key = $2`, [sid[name], key]);

    const stat = (userId: string, week: string, sessions: number, tokens: number, scores: object) =>
      querySql(
        `INSERT INTO user_weekly_stats (user_id,project_id,week,sessions,tokens,scores) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [userId, projectP, week, sessions, tokens, scores as never],
      );
    await stat(m1, WEEK, 3, 500000, { context: 80, verification: 64 }); // overall 72
    await stat(m2, WEEK, 2, 300000, { context: 60, verification: 50 }); // overall 55
    await stat(m3, WEEK, 1, 100000, { context: 60, verification: 60 }); // overall 60
    await stat(m1, PREV_WEEK, 2, 200000, { context: 60, verification: 60 }); // overall 60
    await stat(m3, PREV_WEEK, 1, 100000, { context: 70, verification: 62 }); // overall 66

    const keys = app.get(LlmKeyService);
    await keys.saveKey(leaderId, { provider: 'anthropic', model: 'claude-test', apiKey: 'sk-test-0000' });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => fake.reset());

  const goodOutput = {
    headline: 'Tuần có nhiều session hơn, verification vẫn thấp.',
    vsLastWeek: 'Từ 3 lên 6 session.',
    topIssues: [
      { issue: 'r1', comment: 'Thiếu chạy test sau khi sửa ở cả ba người.' },
      { issue: 'r9', comment: 'mã bịa' },
    ],
    improved: [
      { member: 'm1', comment: 'Điểm tổng tăng rõ.' },
      { member: 'm8', comment: 'mã bịa' },
    ],
    sharingSession: { topic: 'Chạy test sau khi sửa', detail: 'Demo quy trình chạy test.' },
  };

  it('leader: tuần mặc định là tuần gần nhất có session; AI chỉ nhận số liệu ẩn danh; kết quả do server điền; không audit', async () => {
    const agent = await loginAs('leader@tr.local');
    fake.enqueue(goodOutput);
    const res = await agent.post(url(projectP)).send({ locale: 'vi' }).expect(200);
    expect(res.body).toMatchObject({
      kind: 'weekly_team',
      subjectType: 'project_week',
      subjectId: teamWeekId(projectP, WEEK),
      locale: 'vi',
      promptVersion: 'weekly_team@1',
    });
    const r = res.body.result;
    expect(r.week).toBe(WEEK);
    expect(r.topIssues).toEqual([
      { ruleKey: 'no-test-after-edit', category: expect.any(String), severity: expect.any(String), count: 3, memberCount: 2, comment: 'Thiếu chạy test sau khi sửa ở cả ba người.' },
    ]);
    expect(r.improved).toEqual([{ userId: m1, name: 'An Nguyễn', change: 12, comment: 'Điểm tổng tăng rõ.' }]);
    expect(r.sharingSession.topic).toBe('Chạy test sau khi sửa');

    const call = fake.calls[0];
    expect(call.user).toContain('<untrusted_data label="team stats">');
    expect(call.user).toContain(`Week starting Monday ${WEEK} (UTC).`);
    expect(call.user).toContain('Sessions: 6. Tokens: 900000. Active members: 3.'); // 6 session gốc, bỏ session con
    expect(call.user).toContain('Previous week: 3 sessions, 300000 tokens.');
    expect(call.user).toContain('bugfix 2');
    expect(call.user).toContain('r1: no-test-after-edit');
    expect(call.user).toContain('x3 by 2 member(s)');
    expect(call.user).toContain('m1 | sessions 3 | overall 72 | previous 60 | change +12');
    expect(call.user).toContain('m2 | sessions 2 | overall 55 | previous n/a | change n/a');
    expect(call.user).toContain('m3 | sessions 1 | overall 60 | previous 66 | change -6');
    for (const secret of ['An Nguyễn', 'Bình Trần', 'Chi Lê', m1, m2, m3]) expect(call.user).not.toContain(secret);
    expect(await auditCount()).toBe('0');

    const [row] = await stored(leaderId);
    expect(row.subject_user_id).toBeNull();
    expect(row.result.improved[0].name).toBe('An Nguyễn'); // bản lưu có tên do server điền
  });

  it('GET trả kết quả đã lưu theo tuần và locale; bấm lại ghi đè; tuần trước (không có session) thì 409', async () => {
    const agent = await loginAs('leader@tr.local');
    expect((await agent.get(url(projectP)).expect(200)).body.result).toMatchObject({ kind: 'weekly_team' });
    expect((await agent.get(`${url(projectP)}?week=${WEEK}`).expect(200)).body.result).not.toBeNull();
    expect((await agent.get(`${url(projectP)}?locale=en`).expect(200)).body).toEqual({ result: null });
    expect((await agent.get(`${url(projectP)}?week=${PREV_WEEK}`).expect(200)).body).toEqual({ result: null });
    expect((await agent.get(url(projectQ)).expect(200)).body).toEqual({ result: null }); // project không có dữ liệu

    fake.enqueue(goodOutput);
    await agent.post(url(projectP)).send({ locale: 'vi' }).expect(200);
    expect(await stored(leaderId)).toHaveLength(1);

    const none = await agent.post(url(projectP)).send({ locale: 'vi', week: PREV_WEEK }).expect(409);
    expect(none.body.error).toBe('no_week_data');
    expect((await agent.post(url(projectQ)).send({ locale: 'vi' }).expect(409)).body.error).toBe('no_week_data');
    expect(fake.calls).toHaveLength(1);
  });

  it('chỉ leader: member 403, chưa đăng nhập 401, project không có 404', async () => {
    const member = await loginAs('m1@tr.local');
    await member.post(url(projectP)).send({ locale: 'vi' }).expect(403);
    await member.get(url(projectP)).expect(403);
    await request(server).post(url(projectP)).send({ locale: 'vi' }).expect(401);
    await request(server).get(url(projectP)).expect(401);
    const leader = await loginAs('leader@tr.local');
    await leader.post(url(MISSING)).send({ locale: 'vi' }).expect(404);
    await leader.get(url('abc')).expect(404);
    expect(fake.calls).toHaveLength(0);
  });

  it('chưa có key → 409 llm_key_missing, không gọi AI', async () => {
    const agent = await loginAs('leader2@tr.local');
    const res = await agent.post(url(projectP)).send({ locale: 'vi' }).expect(409);
    expect(res.body.error).toBe('llm_key_missing');
    expect(fake.calls).toHaveLength(0);
  });

  it('tuần không hợp lệ và body sai → 400', async () => {
    const agent = await loginAs('leader@tr.local');
    const tuesday = isoDay(new Date(WEEK_START.getTime() + DAY));
    const future = isoDay(new Date(weekWindow(new Date()).start.getTime() + 7 * DAY));
    for (const week of [tuesday, future, '2026-13-45', 'mai'])
      await agent.post(url(projectP)).send({ locale: 'vi', week }).expect(400);
    await agent.get(`${url(projectP)}?week=${tuesday}`).expect(400);
    await agent.post(url(projectP)).send({}).expect(400);
    await agent.post(url(projectP)).send({ locale: 'fr' }).expect(400);
    await agent.post(url(projectP)).send({ locale: 'vi', thua: 1 }).expect(400);
    await agent.get(`${url(projectP)}?locale=fr`).expect(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('model trả sai dạng hai lần → 502 llm_bad_output và không đổi bản đã lưu', async () => {
    const agent = await loginAs('leader@tr.local');
    const before = JSON.stringify(await stored(leaderId));
    fake.enqueue('không phải JSON', { headline: 5 });
    const res = await agent.post(url(projectP)).send({ locale: 'vi' }).expect(502);
    expect(res.body.error).toBe('llm_bad_output');
    expect(JSON.stringify(await stored(leaderId))).toBe(before);
  });

  it('xóa dữ liệu một thành viên (M5.6) xóa báo cáo team có nêu tên họ và kết quả tìm prompt mẫu có trích họ; giữ kết quả không nhắc tới họ', async () => {
    // Một kết quả tìm prompt mẫu (C2) có trích prompt của m1, và một kết quả không nhắc tới m1.
    await querySql(
      `INSERT INTO ai_results (user_id,kind,subject_type,subject_id,locale,provider,model,prompt_version,result)
       VALUES ($1,'prompt_candidates','project',$2,'vi','anthropic','claude-test','prompt_candidates@1',$3::jsonb),
              ($1,'prompt_candidates','project',$4,'vi','anthropic','claude-test','prompt_candidates@1',$5::jsonb)`,
      [
        leaderId,
        projectP,
        { candidates: [{ sessionId: sid.a1, userId: m1, userName: 'An Nguyễn', prompt: 'p' }], considered: 1 } as never,
        projectQ,
        { candidates: [{ sessionId: sid.b1, userId: m2, userName: 'Bình Trần', prompt: 'q' }], considered: 1 } as never,
      ],
    );
    expect((await stored(leaderId)).length).toBe(1);

    const leader = await loginAs('leader@tr.local');
    await leader.delete(`/api/v1/admin/users/${m1}`).expect(200);

    expect(await stored(leaderId)).toEqual([]); // báo cáo team nêu tên m1 đã bị xóa
    const candidates = await querySql<{ subject_id: string }>(
      `SELECT subject_id FROM ai_results WHERE kind = 'prompt_candidates' AND user_id = $1`,
      [leaderId],
    );
    expect(candidates.map((c) => c.subject_id)).toEqual([projectQ]); // chỉ còn kết quả nhắc tới m2
  });
});
