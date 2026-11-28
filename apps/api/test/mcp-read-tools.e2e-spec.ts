import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
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
// Đọc (M6.15) và ghi cho leader (M6.16), theo thứ tự tên như `tools/list`.
const TOOL_NAMES = [
  'add_session_note',
  'draft_rule',
  'get_findings',
  'get_member_profile',
  'get_my_ai_results',
  'get_overview',
  'get_prompt_library',
  'get_rule',
  'get_session',
  'get_skill_clusters',
  'list_members',
  'list_projects',
  'list_rules',
  'save_rule',
  'search_sessions',
  'set_rule_enabled',
  'test_rule',
  'whoami',
];

interface ToolResult {
  isError: boolean;
  structured: Record<string, any>;
  text: string;
}

/** Số liệu thật của từng tool phải khớp `outputSchema` trong contract (packages/schema/mcp). */
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
function loadDefinition(name: string) {
  return require(`@teamlens/schema/mcp/${name}.json`) as {
    inputSchema: object;
    outputSchema: object;
  };
}
function expectMatchesSchema(name: string, value: unknown): void {
  const validate = ajv.compile(loadDefinition(name).outputSchema);
  const ok = validate(value);
  expect(
    ok,
    `${name} lệch schema: ${JSON.stringify(validate.errors?.slice(0, 5))}`,
  ).toBe(true);
}

describe('Tool MCP đọc (M6.15, e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let leaderId: string;
  let m1: string;
  let m2: string;
  let m1Token: string;
  let m2Token: string;
  let leaderToken: string;
  let projectP: string;
  let projectQ: string;
  let s1: string; // session của m1
  let s2: string; // session của m2
  let finding1: string;

  const rpc = (token: string, body: object) =>
    request(server)
      .post('/api/v1/mcp')
      .set('Accept', ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  async function call(
    token: string,
    name: string,
    args: object = {},
  ): Promise<ToolResult> {
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
  /** Gọi tool, bắt buộc thành công và khớp schema. */
  async function ok(token: string, name: string, args: object = {}) {
    const result = await call(token, name, args);
    expect(result.isError, result.text).toBe(false);
    expectMatchesSchema(name, result.structured);
    return result.structured;
  }

  const sql = (text: string) => text.replace(/'/g, "''");
  const insertSession = async (userId: string, projectId: string, sourceId: string, startedAt: string, turnCount: number) => {
    const [row] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,$3,'claude_code','example.org/demo',$4,$5,1000,500,0,0) RETURNING id`,
      [userId, projectId, sourceId, startedAt, turnCount],
    );
    return row.id;
  };
  const insertTurn = (
    sessionId: string,
    seq: number,
    role: string,
    kind: string,
    ts: string,
    fields: { text?: string; tool?: object; output?: object; diff?: object; usage?: object } = {},
  ) =>
    // JSON ghi thẳng vào câu SQL (dữ liệu test tự dựng): truyền chuỗi qua tham số ::jsonb bị mã hóa hai lần.
    querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text,tool,output,diff,usage)
       VALUES ($1,$2,$3,$4,$5,$6,
         ${fields.tool ? `'${sql(JSON.stringify(fields.tool))}'::jsonb` : 'NULL'},
         ${fields.output ? `'${sql(JSON.stringify(fields.output))}'::jsonb` : 'NULL'},
         ${fields.diff ? `'${sql(JSON.stringify(fields.diff))}'::jsonb` : 'NULL'},
         ${fields.usage ? `'${sql(JSON.stringify(fields.usage))}'::jsonb` : 'NULL'})`,
      [sessionId, seq, role, kind, ts, fields.text ?? null],
    );

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();

    leaderId = await insertUser({
      email: 'leader@read.local',
      name: 'Leader Đọc',
      role: 'leader',
      password: PASSWORD,
    });
    m1 = await insertUser({ email: null, name: 'Member Một' });
    m2 = await insertUser({ email: null, name: 'Member Hai' });
    m1Token = (await insertDevice(m1, 'PC-1')).token;
    m2Token = (await insertDevice(m2, 'PC-2')).token;

    const leader = request.agent(server);
    await leader
      .post('/api/v1/auth/login')
      .send({ email: 'leader@read.local', password: PASSWORD })
      .expect(200);
    projectP = (
      await leader.post('/api/v1/projects').send({ name: 'Dự án P', slug: 'p' }).expect(201)
    ).body.id as string;
    projectQ = (
      await leader.post('/api/v1/projects').send({ name: 'Dự án Q', slug: 'q' }).expect(201)
    ).body.id as string;
    for (const userId of [m1, m2])
      await leader.post(`/api/v1/projects/${projectP}/members`).send({ userId }).expect(201);
    leaderToken = (
      await leader.post('/api/v1/me/agent-tokens').send({ name: 'Đọc' }).expect(201)
    ).body.secret as string;

    // Rule: hai rule mặc định; project P ghi đè `rule-a` (tắt, mức medium).
    await querySql(
      `INSERT INTO rules (project_id,key,category,severity,definition,enabled,version) VALUES
         (NULL,'rule-a','verification','high','{"type":"demo","threshold":3}'::jsonb,true,1),
         (NULL,'rule-b','prompting','low','{"type":"demo"}'::jsonb,true,1)`,
    );
    await querySql(
      `INSERT INTO rules (project_id,key,category,severity,definition,enabled,version)
       VALUES ($1,'rule-a','verification','medium','{"type":"demo","threshold":5}'::jsonb,false,2)`,
      [projectP],
    );

    await querySql("SELECT ensure_turns_partitions('2026-11-02T00:00Z', 0)");
    s1 = await insertSession(m1, projectP, 's1', '2026-11-04T10:00Z', 5);
    s2 = await insertSession(m2, projectP, 's2', '2026-11-05T10:00Z', 1);
    await insertTurn(s1, 1, 'user', 'prompt', '2026-11-04T10:00Z', {
      text: `Sửa lỗi giỏ hàng unikeyword ${'x'.repeat(2500)}`,
    });
    await insertTurn(s1, 2, 'assistant', 'tool_call', '2026-11-04T10:01Z', {
      tool: { name: 'Bash', input: { command: 'pnpm test' }, status: 'ok' },
      output: { text: 'y'.repeat(2600), truncated: false, original_bytes: 2600 },
    });
    await insertTurn(s1, 3, 'assistant', 'tool_call', '2026-11-04T10:02Z', {
      tool: { name: 'Edit', input: { path: 'src/cart.ts' }, status: 'ok' },
      diff: { path: 'src/cart.ts', patch: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1 },
      usage: { input: 100, output: 50, cache_read: 0, cache_write: 0 },
    });
    await insertTurn(s1, 4, 'user', 'prompt', '2026-11-04T10:03Z', {
      text: 'khóa AKIAIOSFODNN7EXAMPLE nằm trong prompt',
    });
    await insertTurn(s1, 5, 'assistant', 'reply', '2026-11-04T10:04Z', { text: 'Đã xong.' });
    await insertTurn(s2, 1, 'user', 'prompt', '2026-11-05T10:00Z', { text: 'Việc của member hai' });

    const [rule] = await querySql<{ id: string }>("SELECT id FROM rules WHERE key='rule-a' AND project_id IS NULL");
    const [f] = await querySql<{ id: string }>(
      `INSERT INTO findings (session_id,rule_id,rule_version,turn_seq,evidence)
       VALUES ($1,$2,1,1,'{"count":1,"message":"Prompt thiếu mong muốn.","severity":"high"}'::jsonb) RETURNING id`,
      [s1, rule.id],
    );
    finding1 = f.id;

    // Kết quả AI: m1 và m2 cùng tóm tắt session s1 (chỉ m1 được xem s1).
    for (const [userId, note] of [[m1, 'của m1'], [m2, 'của m2']] as const)
      await querySql(
        `INSERT INTO ai_results (user_id,kind,subject_type,subject_id,locale,provider,model,prompt_version,input_tokens,output_tokens,result)
         VALUES ($1,'session_summary','session',$2,'vi','anthropic','claude-test','session_summary@1',10,20,
           '{"title":"Tóm tắt ${note}"}'::jsonb)`,
        [userId, s1],
      );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('tools/list có đủ tool với schema đúng file contract', async () => {
    const res = await rpc(m1Token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200);
    const tools = res.body.result.tools as { name: string; inputSchema: object; outputSchema: object }[];
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      const def = loadDefinition(tool.name);
      expect(tool.inputSchema).toEqual(def.inputSchema);
      expect(tool.outputSchema).toEqual(def.outputSchema);
    }
  });

  it('whoami khớp schema', async () => {
    await ok(m1Token, 'whoami');
  });

  it('list_projects: member thấy project mình, leader thấy tất cả', async () => {
    const member = await ok(m1Token, 'list_projects');
    expect(member.projects.map((p: { id: string }) => p.id)).toEqual([projectP]);
    const leader = await ok(leaderToken, 'list_projects');
    expect(leader.projects.map((p: { id: string }) => p.id).sort()).toEqual([projectP, projectQ].sort());
  });

  describe('list_members', () => {
    it('member chỉ thấy chính mình, leader thấy cả project, không có email', async () => {
      const member = await ok(m1Token, 'list_members', { projectId: projectP });
      expect(member.members).toEqual([{ userId: m1, name: 'Member Một', role: 'member' }]);
      const leader = await ok(leaderToken, 'list_members', { projectId: projectP });
      // Leader tạo project nên cũng là thành viên của nó.
      expect(leader.members.map((m: { userId: string }) => m.userId).sort()).toEqual([leaderId, m1, m2].sort());
      expect(JSON.stringify(leader)).not.toContain('email');
    });
    it('project mình không thuộc → lỗi quyền; leader hỏi project không tồn tại → không tìm thấy', async () => {
      const denied = await call(m1Token, 'list_members', { projectId: projectQ });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('không có quyền');
      const missing = await call(leaderToken, 'list_members', {
        projectId: '00000000-0000-4000-8000-000000000000',
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('Không tìm thấy');
    });
  });

  it('get_overview: leader đọc được và khớp schema; member bị từ chối', async () => {
    await ok(leaderToken, 'get_overview', { projectId: projectP, from: '2026-11-02T00:00:00Z', to: '2026-11-16T00:00:00Z' });
    const denied = await call(m1Token, 'get_overview', { projectId: projectP });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('không có quyền');
  });

  describe('get_member_profile', () => {
    it('member xem của mình; leader xem của người khác và có audit profile.view', async () => {
      await ok(m1Token, 'get_member_profile', { userId: m1, projectId: projectP });
      await ok(leaderToken, 'get_member_profile', { userId: m1, projectId: projectP });
      const audit = await querySql(
        "SELECT 1 FROM audit_log WHERE action='profile.view' AND actor_id=$1",
        [leaderId],
      );
      expect(audit.length).toBeGreaterThan(0);
    });
    it('member xem của người khác → lỗi quyền; uuid sai → lỗi tham số', async () => {
      const denied = await call(m1Token, 'get_member_profile', { userId: m2, projectId: projectP });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('không có quyền');
      const bad = await call(m1Token, 'get_member_profile', { userId: 'abc', projectId: projectP });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('Tham số không hợp lệ');
    });
  });

  describe('search_sessions', () => {
    it('member chỉ thấy session của mình, leader thấy cả hai, lọc theo người', async () => {
      const member = await ok(m1Token, 'search_sessions', { projectId: projectP });
      expect(member.items.map((s: { id: string }) => s.id)).toEqual([s1]);
      const leader = await ok(leaderToken, 'search_sessions', { projectId: projectP });
      expect(leader.items.map((s: { id: string }) => s.id).sort()).toEqual([s1, s2].sort());
      const filtered = await ok(leaderToken, 'search_sessions', { projectId: projectP, userId: m2 });
      expect(filtered.items.map((s: { id: string }) => s.id)).toEqual([s2]);
      const denied = await call(m1Token, 'search_sessions', { projectId: projectP, userId: m2 });
      expect(denied.isError).toBe(true);
    });
    it('tìm theo từ khóa và phân trang bằng cursor', async () => {
      const hit = await ok(leaderToken, 'search_sessions', { projectId: projectP, q: 'unikeyword' });
      expect(hit.items.map((s: { id: string }) => s.id)).toEqual([s1]);
      expect(hit.items[0].match.turnSeq).toBe(1);
      const first = await ok(leaderToken, 'search_sessions', { projectId: projectP, limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await ok(leaderToken, 'search_sessions', { projectId: projectP, limit: 1, cursor: first.nextCursor });
      expect(second.items).toHaveLength(1);
      expect(second.items[0].id).not.toBe(first.items[0].id);
    });
    it('tham số lạ, limit vượt 50 và project không thuộc → lỗi', async () => {
      for (const args of [
        { projectId: projectP, linhTinh: 1 },
        { projectId: projectP, limit: 51 },
        { projectId: projectP, includeSubagents: 'true' },
      ]) {
        const res = await call(m1Token, 'search_sessions', args);
        expect(res.isError).toBe(true);
        expect(res.text).toContain('Tham số không hợp lệ');
      }
      const denied = await call(m1Token, 'search_sessions', { projectId: projectQ });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('không có quyền');
    });
  });

  describe('get_session', () => {
    it('phân trang turn, cắt văn bản dài, che diff, che secret, khớp schema', async () => {
      const first = await ok(m1Token, 'get_session', { sessionId: s1, limit: 2 });
      expect(first.turns.map((t: { seq: number }) => t.seq)).toEqual([1, 2]);
      expect(first.page).toEqual({ fromSeq: 0, returned: 2, totalTurns: 5, nextFromSeq: 3 });
      expect(first.turns[0].text).toHaveLength(2000);
      expect(first.turns[0].textTruncated).toBe(true);
      expect(first.turns[1].output.text).toHaveLength(2000);
      expect(first.turns[1].output.truncated).toBe(true);

      const second = await ok(m1Token, 'get_session', { sessionId: s1, fromSeq: 3, limit: 2 });
      expect(second.turns.map((t: { seq: number }) => t.seq)).toEqual([3, 4]);
      expect(second.turns[0].diff).toEqual({ path: 'src/cart.ts', added: 1, removed: 1 });
      expect(JSON.stringify(second)).not.toContain('@@ -1');
      expect(JSON.stringify(second)).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(second.turns[1].text).toContain('[REDACTED:aws_access_key]');
      expect(second.page.nextFromSeq).toBe(5);

      const last = await ok(m1Token, 'get_session', { sessionId: s1, fromSeq: 5 });
      expect(last.page).toEqual({ fromSeq: 5, returned: 1, totalTurns: 5, nextFromSeq: null });
      expect(last.session.turns).toBeUndefined();
    });
    it('member xem session của người khác → lỗi quyền; leader xem được và có audit session.view', async () => {
      const denied = await call(m2Token, 'get_session', { sessionId: s1 });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('không có quyền');
      await ok(leaderToken, 'get_session', { sessionId: s1 });
      const audit = await querySql(
        "SELECT 1 FROM audit_log WHERE action='session.view' AND actor_id=$1 AND target_id=$2",
        [leaderId, s1],
      );
      expect(audit.length).toBeGreaterThan(0);
    });
    it('session không tồn tại hoặc id sai → lỗi, limit 0 → lỗi tham số', async () => {
      const missing = await call(leaderToken, 'get_session', { sessionId: '00000000-0000-4000-8000-000000000000' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('Không tìm thấy');
      const bad = await call(leaderToken, 'get_session', { sessionId: s1, limit: 0 });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('Tham số không hợp lệ');
    });
  });

  describe('get_findings', () => {
    it('chủ session và leader đọc được, khớp schema; người khác bị từ chối', async () => {
      const own = await ok(m1Token, 'get_findings', { sessionId: s1 });
      expect(own.items).toHaveLength(1);
      expect(own.items[0]).toMatchObject({ id: finding1, ruleKey: 'rule-a', severity: 'high', turnSeq: 1 });
      await ok(leaderToken, 'get_findings', { sessionId: s1 });
      const denied = await call(m2Token, 'get_findings', { sessionId: s1 });
      expect(denied.isError).toBe(true);
      expect((await ok(m2Token, 'get_findings', { sessionId: s2 })).items).toEqual([]);
    });
  });

  describe('list_rules và get_rule', () => {
    const byKey = (rules: { key: string; scope: string }[], key: string) =>
      rules.find((r) => r.key === key);

    it('không có projectId chỉ trả rule mặc định (gồm rule có sẵn của hệ thống)', async () => {
      const res = await ok(m1Token, 'list_rules');
      expect(byKey(res.rules, 'rule-a')).toEqual({
        key: 'rule-a', category: 'verification', severity: 'high', enabled: true, version: 1, scope: 'default',
      });
      expect(byKey(res.rules, 'rule-b')).toMatchObject({ scope: 'default', severity: 'low' });
      expect(res.rules.every((r: { scope: string }) => r.scope === 'default')).toBe(true);
      const keys = res.rules.map((r: { key: string }) => r.key);
      expect(keys).toEqual([...keys].sort((x: string, y: string) => x.localeCompare(y)));
    });
    it('có projectId thì rule riêng của project ghi đè rule mặc định cùng khóa', async () => {
      const res = await ok(m1Token, 'list_rules', { projectId: projectP });
      expect(byKey(res.rules, 'rule-a')).toEqual({
        key: 'rule-a', category: 'verification', severity: 'medium', enabled: false, version: 2, scope: 'project',
      });
      expect(byKey(res.rules, 'rule-b')?.scope).toBe('default');
      // Mỗi khóa chỉ xuất hiện một lần (rule riêng thay chứ không cộng thêm rule mặc định).
      const keys = res.rules.map((r: { key: string }) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
      const detail = await ok(m1Token, 'get_rule', { key: 'rule-a', projectId: projectP });
      expect(detail.rule.definition).toEqual({ type: 'demo', threshold: 5 });
      const base = await ok(m1Token, 'get_rule', { key: 'rule-a' });
      expect(base.rule.definition).toEqual({ type: 'demo', threshold: 3 });
    });
    it('rule không tồn tại hoặc project không thuộc → lỗi', async () => {
      const missing = await call(m1Token, 'get_rule', { key: 'khong-co' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('Không tìm thấy');
      const denied = await call(m1Token, 'list_rules', { projectId: projectQ });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('không có quyền');
    });
  });

  describe('get_my_ai_results', () => {
    it('chỉ trả kết quả của chính người gọi, không bao giờ của người khác', async () => {
      const mine = await ok(m1Token, 'get_my_ai_results', { subjectType: 'session', subjectId: s1 });
      expect(mine.results).toHaveLength(1);
      expect(mine.results[0].result.title).toBe('Tóm tắt của m1');
      const other = await ok(m2Token, 'get_my_ai_results', { subjectType: 'session', subjectId: s1 });
      expect(other.results[0].result.title).toBe('Tóm tắt của m2');
      const none = await ok(leaderToken, 'get_my_ai_results', { subjectType: 'session', subjectId: s1 });
      expect(none.results).toEqual([]);
    });
    it('lọc theo kind và locale; giá trị sai → lỗi tham số', async () => {
      const kind = await ok(m1Token, 'get_my_ai_results', { subjectType: 'session', subjectId: s1, kind: 'session_outcome' });
      expect(kind.results).toEqual([]);
      const locale = await ok(m1Token, 'get_my_ai_results', { subjectType: 'session', subjectId: s1, locale: 'en' });
      expect(locale.results).toEqual([]);
      const bad = await call(m1Token, 'get_my_ai_results', { subjectType: 'khong-co', subjectId: s1 });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('Tham số không hợp lệ');
    });
  });
});
