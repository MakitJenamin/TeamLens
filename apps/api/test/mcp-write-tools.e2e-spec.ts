import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { DB } from '../src/db/db.module.js';
import { installDefaultRules } from '../src/modules/rules/score-session.js';
import {
  createTestApp,
  insertDevice,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as (ajv: Ajv2020) => Ajv2020;

const PASSWORD = 'teamlens123';
const ACCEPT = 'application/json, text/event-stream';
const RULE = 'repeated-correction'; // rule session có sẵn: ngưỡng min = 3
const WEEKLY_RULE = 'lazy-prompting'; // rule tuần có sẵn

interface ToolResult {
  isError: boolean;
  structured: Record<string, any>;
  text: string;
}

const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
function expectMatchesSchema(name: string, value: unknown): void {
  const def = require(`@teamlens/schema/mcp/${name}.json`) as { outputSchema: object };
  const validate = ajv.compile(def.outputSchema);
  expect(
    validate(value),
    `${name} lệch schema: ${JSON.stringify(validate.errors?.slice(0, 5))}`,
  ).toBe(true);
}

describe('Tool MCP ghi cho leader và prompt (M6.16, e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let leaderId: string;
  let memberId: string;
  let memberToken: string;
  let leaderToken: string;
  let projectId: string;
  let sA: string; // 3 prompt "vẫn lỗi" liên tiếp: bị rule bắt ở ngưỡng 3
  let sB: string; // 2 prompt: chỉ bị bắt nếu hạ ngưỡng xuống 2
  let sC: string; // không có phản bác

  const rpc = (token: string, body: object) =>
    request(server)
      .post('/api/v1/mcp')
      .set('Accept', ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  async function call(token: string, name: string, args: object = {}): Promise<ToolResult> {
    const res = await rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }).expect(200);
    const result = res.body.result;
    return {
      isError: result.isError === true,
      structured: result.structuredContent,
      text: result.content[0].text as string,
    };
  }
  async function ok(token: string, name: string, args: object = {}) {
    const result = await call(token, name, args);
    expect(result.isError, result.text).toBe(false);
    expectMatchesSchema(name, result.structured);
    return result.structured;
  }
  async function fails(token: string, name: string, args: object, contains: string) {
    const result = await call(token, name, args);
    expect(result.isError, `${name} lẽ ra phải lỗi`).toBe(true);
    expect(result.text).toContain(contains);
  }

  const insertSession = async (sourceId: string, startedAt: string, turnCount: number) => {
    const [row] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,$3,'claude_code','example.org/demo',$4,$5,10,10,0,0) RETURNING id`,
      [memberId, projectId, sourceId, startedAt, turnCount],
    );
    return row.id;
  };
  const prompts = (sessionId: string, texts: string[], ts: string) =>
    querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text)
       SELECT $1, n, 'user', 'prompt', $2, (ARRAY[${texts.map((t) => `'${t}'`).join(',')}])[n]
       FROM generate_series(1, ${texts.length}) n`,
      [sessionId, ts],
    );
  const projectRule = () =>
    querySql<{ severity: string; enabled: boolean; version: number; thresholds: string }>(
      `SELECT severity, enabled, version, definition->'thresholds'->>'min' AS thresholds
       FROM rules WHERE project_id=$1 AND key=$2`,
      [projectId, RULE],
    );
  const findingSeverity = (sessionId: string) =>
    querySql<{ severity: string }>(
      `SELECT f.evidence->>'severity' AS severity FROM findings f JOIN rules r ON r.id=f.rule_id
       WHERE f.session_id=$1 AND r.key=$2`,
      [sessionId, RULE],
    );

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();
    await installDefaultRules(app.get(DB));

    leaderId = await insertUser({
      email: 'leader@write.local',
      name: 'Leader Ghi',
      role: 'leader',
      password: PASSWORD,
    });
    memberId = await insertUser({ email: null, name: 'Member Ghi' });
    memberToken = (await insertDevice(memberId, 'PC')).token;

    const leader = request.agent(server);
    await leader.post('/api/v1/auth/login').send({ email: 'leader@write.local', password: PASSWORD }).expect(200);
    projectId = (await leader.post('/api/v1/projects').send({ name: 'Dự án G', slug: 'g' }).expect(201)).body.id as string;
    await leader.post(`/api/v1/projects/${projectId}/members`).send({ userId: memberId }).expect(201);
    leaderToken = (await leader.post('/api/v1/me/agent-tokens').send({ name: 'Ghi' }).expect(201)).body.secret as string;

    await querySql("SELECT ensure_turns_partitions('2026-11-02T00:00Z', 0)");
    sA = await insertSession('a', '2026-11-04T10:00Z', 3);
    sB = await insertSession('b', '2026-11-04T11:00Z', 2);
    sC = await insertSession('c', '2026-11-04T12:00Z', 2);
    await prompts(sA, ['Vẫn lỗi', 'vẫn lỗi', 'chưa được'], '2026-11-04T10:00Z');
    await prompts(sB, ['vẫn lỗi', 'chưa được'], '2026-11-04T11:00Z');
    await prompts(sC, ['xin chào', 'cảm ơn'], '2026-11-04T12:00Z');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('danh sách tool và prompt', () => {
    it('tools/list có đủ tool ghi', async () => {
      const res = await rpc(leaderToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200);
      const names = (res.body.result.tools as { name: string }[]).map((t) => t.name);
      for (const name of ['draft_rule', 'test_rule', 'save_rule', 'set_rule_enabled', 'add_session_note']) {
        expect(names).toContain(name);
      }
    });
    it('prompts/list: leader thấy cả ba, member không thấy weekly-review', async () => {
      const list = (token: string) =>
        rpc(token, { jsonrpc: '2.0', id: 1, method: 'prompts/list' }).expect(200);
      const leader = await list(leaderToken);
      expect((leader.body.result.prompts as { name: string }[]).map((p) => p.name)).toEqual(['coach-me', 'find-skills', 'weekly-review']);
      const member = await list(memberToken);
      expect((member.body.result.prompts as { name: string }[]).map((p) => p.name)).toEqual(['coach-me', 'find-skills']);
    });
    it('prompts/get trả lời nhắc; weekly-review cần projectId UUID; member không lấy được weekly-review', async () => {
      const get = (token: string, name: string, args?: object) =>
        rpc(token, { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name, arguments: args } }).expect(200);
      const coach = await get(memberToken, 'coach-me');
      expect(coach.body.result.messages[0].content.text).toContain('get_member_profile');
      const weekly = await get(leaderToken, 'weekly-review', { projectId });
      expect(weekly.body.result.messages[0].content.text).toContain(projectId);
      expect((await get(leaderToken, 'weekly-review', {})).body.error.message).toContain('Thiếu tham số');
      expect((await get(leaderToken, 'weekly-review', { projectId: 'abc' })).body.error.message).toContain('UUID');
      expect((await get(memberToken, 'weekly-review', { projectId })).body.error.code).toBe(-32602);
    });
  });

  it('member bị từ chối mọi tool ghi', async () => {
    const cases: [string, object][] = [
      ['draft_rule', { key: RULE, projectId, severity: 'low' }],
      ['test_rule', { key: RULE, projectId, severity: 'low' }],
      ['save_rule', { key: RULE, projectId, severity: 'low' }],
      ['set_rule_enabled', { key: RULE, projectId, enabled: false }],
      ['add_session_note', { sessionId: sA, body: 'ghi chú' }],
    ];
    for (const [name, args] of cases) await fails(memberToken, name, args, 'không có quyền');
    expect(await projectRule()).toEqual([]);
  });

  describe('draft_rule', () => {
    it('đổi mức độ và lời khuyên: tests nội tuyến vẫn qua, không lưu gì', async () => {
      const res = await ok(leaderToken, 'draft_rule', { key: RULE, projectId, severity: 'medium', advice: 'Hãy nêu kết quả mong đợi.' });
      expect(res.changes.map((c: { field: string }) => c.field)).toEqual(['severity', 'advice']);
      expect(res.rule).toMatchObject({ key: RULE, severity: 'medium', thresholds: { min: 3 } });
      expect(res.allPassed).toBe(true);
      expect(res.tests.length).toBeGreaterThan(0);
      expect(await projectRule()).toEqual([]);
    });
    it('hạ ngưỡng min xuống 2 làm hỏng một test nội tuyến và báo đúng test đó', async () => {
      const res = await ok(leaderToken, 'draft_rule', { key: RULE, projectId, thresholds: { min: 2 } });
      expect(res.allPassed).toBe(false);
      const failed = res.tests.filter((t: { passed: boolean }) => !t.passed);
      expect(failed).toEqual([
        { name: 'prompt bình thường ngắt chuỗi', expect: 'clean', actual: 'triggered', passed: false },
      ]);
    });
    it('đầu vào sai: ngưỡng lạ, min bằng 0, rule hoặc project không có, rule tuần, tham số lạ', async () => {
      await fails(leaderToken, 'draft_rule', { key: RULE, projectId, thresholds: { khong_co: 1 } }, 'không có ngưỡng');
      await fails(leaderToken, 'draft_rule', { key: RULE, projectId, thresholds: { min: 0 } }, 'số nguyên từ 1');
      await fails(leaderToken, 'draft_rule', { key: 'khong-co', projectId, severity: 'low' }, 'Không tìm thấy rule');
      await fails(leaderToken, 'draft_rule', { key: RULE, projectId: '00000000-0000-4000-8000-000000000000', severity: 'low' }, 'Không tìm thấy project');
      await fails(leaderToken, 'draft_rule', { key: WEEKLY_RULE, projectId, severity: 'low' }, 'rule tuần');
      await fails(leaderToken, 'draft_rule', { key: RULE, projectId, match: { op: 'count' } }, 'Tham số không hợp lệ');
      await fails(leaderToken, 'draft_rule', { key: RULE, projectId, thresholds: {} }, 'Tham số không hợp lệ');
    });
  });

  describe('test_rule', () => {
    it('so cấu hình mới với hiện hành trên session gần nhất, không trả nội dung turn', async () => {
      const res = await ok(leaderToken, 'test_rule', { key: RULE, projectId, thresholds: { min: 2 } });
      expect(res.sessionsEvaluated).toBe(3);
      expect(res.baselineTriggered).toBe(1);
      expect(res.candidateTriggered).toBe(2);
      expect(res.samples.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual([sA, sB].sort());
      expect(JSON.stringify(res)).not.toContain('vẫn lỗi');
      expect(JSON.stringify(res)).not.toContain('chưa được');
    });
    it('bỏ qua session con và session đã mất turn (retention)', async () => {
      const child = await insertSession('child', '2026-11-04T13:00Z', 1);
      await querySql('UPDATE sessions SET parent_source_id=$2 WHERE id=$1', [child, 'a']);
      const missing = await insertSession('missing', '2026-11-04T14:00Z', 5); // khai 5 turn nhưng không có turn nào
      const res = await ok(leaderToken, 'test_rule', { key: RULE, projectId, severity: 'low' });
      expect(res.sessionsEvaluated).toBe(3);
      await querySql('DELETE FROM sessions WHERE id IN ($1, $2)', [child, missing]);
    });
  });

  describe('save_rule', () => {
    it('từ chối khi tests nội tuyến không còn đúng, không ghi gì', async () => {
      await fails(leaderToken, 'save_rule', { key: RULE, projectId, thresholds: { min: 2 } }, 'tests nội tuyến');
      expect(await projectRule()).toEqual([]);
    });
    it('không có thay đổi thì từ chối', async () => {
      await fails(leaderToken, 'save_rule', { key: RULE, projectId, severity: 'high', thresholds: { min: 3 } }, 'Không có thay đổi');
    });
    it('lưu bản riêng của project, audit giá trị cũ và mới, chấm lại điểm bằng job nền', async () => {
      expect((await findingSeverity(sA)).length).toBe(0); // chưa chấm lần nào
      const res = await ok(leaderToken, 'save_rule', { key: RULE, projectId, severity: 'medium', advice: 'Nêu kết quả mong đợi.' });
      expect(res.rescore).toBe('queued');
      expect(res.rule).toMatchObject({ key: RULE, severity: 'medium', scope: 'project', version: 2, enabled: true });
      expect(res.changes.map((c: { field: string }) => c.field)).toEqual(['severity', 'advice']);

      expect(await projectRule()).toEqual([{ severity: 'medium', enabled: true, version: 2, thresholds: '3' }]);
      const [audit] = await querySql<{ details: any }>(
        "SELECT details FROM audit_log WHERE action='rule.save' AND actor_id=$1",
        [leaderId],
      );
      expect(audit.details).toMatchObject({
        via: 'mcp',
        projectId,
        key: RULE,
        previous: { scope: 'default', severity: 'high', version: 1 },
        next: { scope: 'project', severity: 'medium', version: 2 },
      });
      expect(audit.details.changes).toEqual(res.changes);
      // Lần chấm lại do MCP phát có dòng theo dõi như nút "Chạy lại" của dashboard.
      expect(await querySql('SELECT 1 FROM project_rescore_runs WHERE project_id=$1', [projectId])).toHaveLength(1);
      expect(await querySql("SELECT 1 FROM audit_log WHERE action='rules.rerun' AND details->>'via'='mcp'")).toHaveLength(1);

      // Điểm được tính lại: finding mới của session sA mang mức độ medium.
      await vi.waitFor(async () => expect(await findingSeverity(sA)).toEqual([{ severity: 'medium' }]), {
        timeout: 20000,
        interval: 300,
      });
    });
    it('lưu lần nữa sửa bản riêng đã có (tăng phiên bản), mặc định toàn server giữ nguyên', async () => {
      const res = await ok(leaderToken, 'save_rule', { key: RULE, projectId, severity: 'low' });
      expect(res.rule).toMatchObject({ severity: 'low', version: 3 });
      const [def] = await querySql<{ severity: string; version: number }>(
        'SELECT severity, version FROM rules WHERE project_id IS NULL AND key=$1',
        [RULE],
      );
      expect(def).toEqual({ severity: 'high', version: 1 });
    });
  });

  describe('set_rule_enabled', () => {
    it('tắt rule: audit giá trị cũ và mới, điểm tính lại (finding biến mất); bật lại thì finding trở lại', async () => {
      const off = await ok(leaderToken, 'set_rule_enabled', { key: RULE, projectId, enabled: false });
      expect(off).toMatchObject({ previousEnabled: true, rule: { enabled: false, scope: 'project' } });
      // Lần chạy trước có thể còn chạy: `in_progress`, và lần đó xong sẽ tự xếp thêm lần chạy (finding vẫn biến mất).
      expect(['queued', 'in_progress']).toContain(off.rescore);
      const [audit] = await querySql<{ details: any }>(
        "SELECT details FROM audit_log WHERE action='rule.set_enabled' AND actor_id=$1 ORDER BY at DESC LIMIT 1",
        [leaderId],
      );
      expect(audit.details).toMatchObject({ via: 'mcp', key: RULE, previous: { enabled: true }, next: { enabled: false } });
      await vi.waitFor(async () => expect(await findingSeverity(sA)).toEqual([]), { timeout: 20000, interval: 300 });

      await fails(leaderToken, 'set_rule_enabled', { key: RULE, projectId, enabled: false }, 'đã ở trạng thái');

      const on = await ok(leaderToken, 'set_rule_enabled', { key: RULE, projectId, enabled: true });
      expect(on.previousEnabled).toBe(false);
      await vi.waitFor(async () => expect((await findingSeverity(sA)).length).toBe(1), { timeout: 20000, interval: 300 });
    });
    it('bật/tắt được cả rule tuần; rule hoặc project không có thì lỗi', async () => {
      const res = await ok(leaderToken, 'set_rule_enabled', { key: WEEKLY_RULE, projectId, enabled: false });
      expect(res.rule).toMatchObject({ key: WEEKLY_RULE, enabled: false, scope: 'project' });
      await fails(leaderToken, 'set_rule_enabled', { key: 'khong-co', projectId, enabled: false }, 'Không tìm thấy rule');
      await fails(leaderToken, 'set_rule_enabled', { key: RULE, projectId: '00000000-0000-4000-8000-000000000000', enabled: false }, 'Không tìm thấy project');
      await fails(leaderToken, 'set_rule_enabled', { key: RULE, projectId, enabled: 'false' }, 'Tham số không hợp lệ');
    });
  });

  describe('add_session_note', () => {
    it('leader ghi chú vào turn hoặc cả session, có audit; turn không tồn tại thì lỗi', async () => {
      const note = await ok(leaderToken, 'add_session_note', { sessionId: sA, turnSeq: 1, body: '  Cần hỏi lại người viết.  ' });
      expect(note.note).toMatchObject({ sessionId: sA, turnSeq: 1, body: 'Cần hỏi lại người viết.' });
      expect(note.note.author.id).toBe(leaderId);
      const general = await ok(leaderToken, 'add_session_note', { sessionId: sA, body: 'Ghi chú chung' });
      expect(general.note.turnSeq).toBeNull();
      expect(
        await querySql("SELECT 1 FROM audit_log WHERE action='session.note.create' AND actor_id=$1 AND target_id=$2", [leaderId, sA]),
      ).toHaveLength(2);
      await fails(leaderToken, 'add_session_note', { sessionId: sA, turnSeq: 99, body: 'x' }, 'Không tìm thấy turn');
      await fails(leaderToken, 'add_session_note', { sessionId: sA, body: '   ' }, 'Tham số không hợp lệ');
      await fails(leaderToken, 'add_session_note', { sessionId: '00000000-0000-4000-8000-000000000000', body: 'x' }, 'Không tìm thấy session');
    });
  });
});
