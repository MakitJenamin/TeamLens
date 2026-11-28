import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/db/db.module.js';
import { rescoreProject, scoreSession } from '../src/modules/rules/score-session.js';
import { JOBS } from '../src/queue/jobs.js';
import { QueueService } from '../src/queue/queue.service.js';
import { createTestApp, insertDevice, insertUser, querySql, resetDatabase } from './helpers.js';

const PASSWORD = 'teamlens123';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe('Nhãn loại việc B4: gán khi chấm điểm, bộ lọc, Tổng quan, MCP (M6.7, e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let projectId: string;
  let m1: string;
  let m2: string;
  let m1Token: string;
  const ids: Record<string, string> = {};

  async function login(email: string) {
    const agent = request.agent(server);
    await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    return agent;
  }

  async function makeSession(
    name: string,
    userId: string,
    turns: { role: string; kind: string; text?: string; tool?: object; diff?: object }[],
    opts: { turnCount?: number; parentSource?: string; daysAgo?: number } = {},
  ) {
    const startedAt = ago(opts.daysAgo ?? 2);
    const [row] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count,parent_source_id,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,$3,'claude_code','example.org/demo',$4,$5,$6,10,10,0,0) RETURNING id`,
      [userId, projectId, name, startedAt, opts.turnCount ?? turns.length, opts.parentSource ?? null],
    );
    await querySql('SELECT ensure_turns_partitions($1::timestamptz, 0)', [startedAt]);
    for (const [i, t] of turns.entries())
      await querySql(
        `INSERT INTO turns (session_id,seq,role,kind,ts,text,tool,diff) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
        [
          row.id,
          i + 1,
          t.role,
          t.kind,
          startedAt,
          t.text ?? null,
          // postgres.js tự mã hóa JSON cho tham số `::jsonb`, nên truyền object chứ không truyền chuỗi.
          (t.tool ?? null) as never,
          (t.diff ?? null) as never,
        ],
      );
    ids[name] = row.id;
    return row.id;
  }
  const prompt = (text: string) => ({ role: 'user', kind: 'prompt', text });
  const edit = (path: string, added = 10) => ({
    role: 'assistant',
    kind: 'tool_call',
    tool: { name: 'Edit', status: 'ok' },
    diff: { path, added, removed: 0 },
  });
  const labelOf = async (name: string) =>
    (await querySql<{ work_type: string | null }>('SELECT work_type FROM sessions WHERE id=$1', [ids[name]]))[0].work_type;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();
    await app.get(QueueService).boss.deleteAllJobs(JOBS.sessionIngested);

    await insertUser({ email: 'leader@wt.local', name: 'Leader', role: 'leader', password: PASSWORD });
    m1 = await insertUser({ email: 'm1@wt.local', name: 'Member Một', password: PASSWORD });
    m2 = await insertUser({ email: 'm2@wt.local', name: 'Member Hai', password: PASSWORD });
    m1Token = (await insertDevice(m1, 'PC-1')).token;
    const leader = await login('leader@wt.local');
    projectId = (await leader.post('/api/v1/projects').send({ name: 'Dự án', slug: 'wt' }).expect(201)).body.id as string;
    for (const userId of [m1, m2]) await leader.post(`/api/v1/projects/${projectId}/members`).send({ userId }).expect(201);

    await makeSession('bug', m1, [prompt('Sửa lỗi đăng nhập khi mật khẩu có ký tự đặc biệt'), edit('src/login.ts')]);
    await makeSession('test', m1, [prompt('cập nhật code giúp mình'), edit('src/login.test.ts', 30), edit('src/login.ts', 3)]);
    await makeSession('question', m2, [prompt('Hàm tính thuế hoạt động thế nào?'), { role: 'assistant', kind: 'reply', text: 'Nó...' }]);
    await makeSession('feature', m2, [prompt('Thêm tính năng xuất báo cáo CSV'), edit('src/export.ts')]);
    await makeSession('child', m1, [prompt('Sửa lỗi trong subagent'), edit('src/x.ts')], { parentSource: 'cha' });
    await makeSession('noPrompt', m2, [{ role: 'assistant', kind: 'reply', text: 'xin chào' }]);
    // Đã mất turn do retention (turn_count 5 nhưng chỉ còn 2 turn): giữ nhãn cũ, không chấm lại.
    await makeSession('lost', m1, [prompt('Sửa lỗi gì đó'), edit('src/a.ts')], { turnCount: 5 });
    await querySql(`UPDATE sessions SET work_type='docs' WHERE id=$1`, [ids.lost]);
    // Ngoài khoảng thời gian mặc định của Tổng quan (8 tuần).
    await makeSession('old', m1, [prompt('Sửa lỗi cũ'), edit('src/old.ts')], { daysAgo: 200 });

    const db = app.get(DB);
    for (const id of Object.values(ids)) await scoreSession(db, id);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('chấm điểm gán nhãn cho session gốc; session con, không có prompt thì null; session mất turn giữ nhãn cũ', async () => {
    expect(await labelOf('bug')).toBe('bugfix');
    expect(await labelOf('test')).toBe('test'); // 30/33 dòng đổi ở file test, thắng từ khóa
    expect(await labelOf('question')).toBe('question');
    expect(await labelOf('feature')).toBe('feature');
    expect(await labelOf('old')).toBe('bugfix');
    expect(await labelOf('child')).toBeNull();
    expect(await labelOf('noPrompt')).toBeNull();
    expect(await labelOf('lost')).toBe('docs');
  });

  it('chấm lại project gán nhãn cho session cũ chưa có nhãn, và xóa nhãn khi không còn gì để xét', async () => {
    await querySql(`UPDATE sessions SET work_type=NULL WHERE id=$1`, [ids.bug]);
    await querySql(`UPDATE sessions SET work_type='feature' WHERE id=$1`, [ids.noPrompt]);
    await rescoreProject(app.get(DB), projectId);
    expect(await labelOf('bug')).toBe('bugfix');
    expect(await labelOf('noPrompt')).toBeNull();
  });

  it('danh sách và chi tiết session có workType; null khi chưa phân loại', async () => {
    const leader = await login('leader@wt.local');
    const list = await leader.get(`/api/v1/projects/${projectId}/sessions?includeSubagents=true&limit=100`).expect(200);
    const byId = new Map<string, { workType: string | null }>(list.body.items.map((s: { id: string; workType: string | null }) => [s.id, s]));
    expect(byId.get(ids.bug)?.workType).toBe('bugfix');
    expect(byId.get(ids.child)?.workType).toBeNull();
    expect(byId.get(ids.noPrompt)?.workType).toBeNull();
    const detail = await leader.get(`/api/v1/sessions/${ids.question}`).expect(200);
    expect(detail.body.workType).toBe('question');
  });

  it('lọc theo workType: chỉ session có đúng nhãn; member chỉ thấy của mình; nhãn sai thì 400', async () => {
    const leader = await login('leader@wt.local');
    const bugs = await leader.get(`/api/v1/projects/${projectId}/sessions?workType=bugfix&limit=100`).expect(200);
    expect(bugs.body.items.map((s: { id: string }) => s.id).sort()).toEqual([ids.bug, ids.old].sort());
    const none = await leader.get(`/api/v1/projects/${projectId}/sessions?workType=ops`).expect(200);
    expect(none.body.items).toEqual([]);
    // Kết hợp với lọc người.
    const mixed = await leader.get(`/api/v1/projects/${projectId}/sessions?workType=feature&userId=${m1}`).expect(200);
    expect(mixed.body.items).toEqual([]);

    const member = await login('m2@wt.local');
    const own = await member.get(`/api/v1/projects/${projectId}/sessions?workType=bugfix`).expect(200);
    expect(own.body.items).toEqual([]); // session bugfix là của m1
    const ownFeature = await member.get(`/api/v1/projects/${projectId}/sessions?workType=feature`).expect(200);
    expect(ownFeature.body.items.map((s: { id: string }) => s.id)).toEqual([ids.feature]);

    await leader.get(`/api/v1/projects/${projectId}/sessions?workType=khong-co`).expect(400);
  });

  it('Tổng quan có workTypes: chỉ session gốc trong khoảng, nhiều nhất trước, chưa phân loại là null cuối cùng', async () => {
    const leader = await login('leader@wt.local');
    const res = await leader.get(`/api/v1/projects/${projectId}/overview`).expect(200);
    // Trong 8 tuần: bug (bugfix), test, question, feature, noPrompt (null), lost (docs). Bỏ child (session con) và old (ngoài khoảng).
    expect(res.body.workTypes).toEqual([
      { workType: 'bugfix', sessions: 1 },
      { workType: 'docs', sessions: 1 },
      { workType: 'feature', sessions: 1 },
      { workType: 'question', sessions: 1 },
      { workType: 'test', sessions: 1 },
      { workType: null, sessions: 1 },
    ]);

    // Mở rộng khoảng thì session cũ vào, bugfix có 2.
    const wide = await leader
      .get(`/api/v1/projects/${projectId}/overview?from=${encodeURIComponent(ago(210))}&to=${encodeURIComponent(ago(0))}`)
      .expect(200);
    expect(wide.body.workTypes[0]).toEqual({ workType: 'bugfix', sessions: 2 });
  });

  it('tool MCP search_sessions lọc được theo workType (cùng quyền như dashboard)', async () => {
    const call = (args: object) =>
      request(server)
        .post('/api/v1/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${m1Token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_sessions', arguments: args } })
        .expect(200);
    const res = await call({ projectId, workType: 'bugfix' });
    const items = res.body.result.structuredContent.items as { id: string; workType: string }[];
    expect(items.map((s) => s.id).sort()).toEqual([ids.bug, ids.old].sort());
    expect(items.every((s) => s.workType === 'bugfix')).toBe(true);
    const bad = await call({ projectId, workType: 'khong-co' });
    expect(bad.body.result.isError).toBe(true);
  });
});
