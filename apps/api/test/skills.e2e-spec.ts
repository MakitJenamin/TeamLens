import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { clusterIdOf } from '../src/modules/skills/skills.service.js';
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
const DAY = 24 * 60 * 60 * 1000;

// Ba cách gõ cùng một việc: cùng bộ từ khóa nên cùng dấu vân tay "chạy file lint lỗi".
const LINT = [
  'Chạy pnpm test rồi sửa lỗi lint trong file src/cart.ts giúp mình nhé',
  'chạy pnpm test và sửa lỗi lint trong file src/checkout/index.tsx nhé',
  'Hãy chạy PNPM test, sửa lỗi lint trong file "orders.ts" 2',
];
// Cụm thứ hai: dấu vân tay "bằng module test thanh".
const VITEST = [
  'Viết unit test cho module thanh toán bằng vitest',
  'viết unit test cho module thanh toán bằng Vitest nhé',
  'Hãy viết unit test cho module thanh toán bằng vitest giúp mình',
];
const LINT_FINGERPRINT = 'chạy file lint lỗi';

const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
function expectMatchesSchema(value: unknown): void {
  const def = require('@teamlens/schema/mcp/get_skill_clusters.json') as { outputSchema: object };
  const validate = ajv.compile(def.outputSchema);
  expect(validate(value), `lệch schema: ${JSON.stringify(validate.errors?.slice(0, 5))}`).toBe(true);
}

describe('Skill Finder S0: GET /projects/:id/skill-clusters và tool MCP (M6.11, e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let leaderId: string;
  let m1: string;
  let m2: string;
  let projectP: string;
  let projectQ: string;
  let leader: ReturnType<typeof request.agent>;
  let member1: ReturnType<typeof request.agent>;
  let leaderToken: string;
  let m1Token: string;

  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const url = (projectId: string, qs = '') => `/api/v1/projects/${projectId}/skill-clusters${qs}`;

  async function insertSession(userId: string, sourceId: string, parentSourceId: string | null = null) {
    const [row] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,parent_source_id,agent,repo_remote,started_at,turn_count,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,$3,$4,'claude_code','example.org/demo',$5,1,10,10,0,0) RETURNING id`,
      [userId, projectP, sourceId, parentSourceId, ago(1)],
    );
    return row.id;
  }
  async function addPrompt(sessionId: string, seq: number, text: string, daysAgo: number, role = 'user', kind = 'prompt') {
    const ts = ago(daysAgo);
    await querySql('SELECT ensure_turns_partitions($1::timestamptz, 0)', [ts]);
    await querySql(
      `INSERT INTO turns (session_id,seq,role,kind,ts,text) VALUES ($1,$2,$3,$4,$5,$6)`,
      [sessionId, seq, role, kind, ts, text],
    );
  }

  const rpcCall = (token: string, args: object) =>
    request(server)
      .post('/api/v1/mcp')
      .set('Accept', ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_skill_clusters', arguments: args } })
      .expect(200);

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();

    leaderId = await insertUser({ email: 'leader@skills.local', name: 'Leader Skill', role: 'leader', password: PASSWORD });
    m1 = await insertUser({ email: 'm1@skills.local', name: 'Member Một', password: PASSWORD });
    m2 = await insertUser({ email: 'm2@skills.local', name: 'Member Hai', password: PASSWORD });
    m1Token = (await insertDevice(m1, 'PC-1')).token;

    leader = request.agent(server);
    await leader.post('/api/v1/auth/login').send({ email: 'leader@skills.local', password: PASSWORD }).expect(200);
    member1 = request.agent(server);
    await member1.post('/api/v1/auth/login').send({ email: 'm1@skills.local', password: PASSWORD }).expect(200);
    projectP = (await leader.post('/api/v1/projects').send({ name: 'Dự án P', slug: 'p' }).expect(201)).body.id as string;
    projectQ = (await leader.post('/api/v1/projects').send({ name: 'Dự án Q', slug: 'q' }).expect(201)).body.id as string;
    for (const userId of [m1, m2])
      await leader.post(`/api/v1/projects/${projectP}/members`).send({ userId }).expect(201);
    leaderToken = (await leader.post('/api/v1/me/agent-tokens').send({ name: 'Skill' }).expect(201)).body.secret as string;

    // m1: ba prompt LINT, hai prompt VITEST, và một prompt LINT cách đây 60 ngày (ngoài 30 ngày mặc định).
    const s1 = await insertSession(m1, 's1');
    await addPrompt(s1, 1, LINT[0], 2);
    await addPrompt(s1, 2, LINT[1], 3);
    await addPrompt(s1, 3, LINT[2], 4);
    await addPrompt(s1, 4, VITEST[0], 5);
    await addPrompt(s1, 5, VITEST[1], 6);
    await addPrompt(s1, 6, LINT[0], 60);
    // m2: một prompt LINT (cụm LINT thành 4, hai người) và ba prompt VITEST (cụm VITEST thành 5, hai người).
    const s2 = await insertSession(m2, 's2');
    await addPrompt(s2, 1, LINT[0], 1);
    await addPrompt(s2, 2, VITEST[0], 2);
    await addPrompt(s2, 3, VITEST[1], 3);
    await addPrompt(s2, 4, VITEST[2], 4);
    // Không được tính: prompt trong session con (agent viết), lượt trả lời của agent.
    const child = await insertSession(m2, 'child', 's2');
    for (let i = 1; i <= 5; i++) await addPrompt(child, i, VITEST[0], 1);
    await addPrompt(s2, 5, LINT[0], 1, 'assistant', 'reply');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('REST', () => {
    it('chưa đăng nhập → 401; id project sai → 404; project không tồn tại → 404', async () => {
      await request(server).get(url(projectP)).expect(401);
      await leader.get(url('invalid')).expect(404);
      await leader.get(url('00000000-0000-4000-8000-000000000000')).expect(404);
    });

    it('leader thấy cụm của cả team, nhiều lần lặp nhất trước, khoảng mặc định 30 ngày', async () => {
      const res = await leader.get(url(projectP)).expect(200);
      expect(res.body.stats).toEqual({ promptsAnalyzed: 9, promptsClustered: 9, clusterCount: 2, truncated: false });
      type Cluster = { id: string; count: number; users: unknown[]; label: string; lastSeenAt: string; firstSeenAt: string; examples: { ts: string }[] };
      const clusters = res.body.clusters as Cluster[];
      // Cụm VITEST có 5 lần (m2 ba lần, m1 hai lần), cụm LINT có 4 lần: nhiều lần lặp nhất đứng đầu.
      expect(clusters.map((c) => c.count)).toEqual([5, 4]);
      const a = clusters.find((c) => c.id === clusterIdOf(projectP, LINT_FINGERPRINT))!;
      const b = clusters.find((c) => c.id !== a.id)!;
      expect(a).toMatchObject({ count: 4, userCount: 2 });
      expect(a.users).toEqual([
        { userId: m1, name: 'Member Một', count: 3 },
        { userId: m2, name: 'Member Hai', count: 1 },
      ]);
      expect(a.examples).toHaveLength(3);
      const times = a.examples.map((e: { ts: string }) => Date.parse(e.ts));
      expect(times).toEqual([...times].sort((x, y) => y - x)); // gần nhất trước
      expect(a.examples[0]).toMatchObject({ userId: m2, turnSeq: 1 });
      expect(Date.parse(a.lastSeenAt)).toBeGreaterThan(Date.parse(a.firstSeenAt));
      expect(b).toMatchObject({ count: 5, userCount: 2 });
      expect(b.users).toEqual([
        { userId: m2, name: 'Member Hai', count: 3 },
        { userId: m1, name: 'Member Một', count: 2 },
      ]);
      expect(a.label.length).toBeLessThanOrEqual(200);
      expect(Date.parse(res.body.range.to) - Date.parse(res.body.range.from)).toBe(30 * DAY);
    });

    it('prompt trong session con và lượt trả lời của agent không được tính', async () => {
      const res = await leader.get(url(projectP, `?userId=${m2}`)).expect(200);
      // m2 chỉ có 1 prompt LINT và 3 VITEST thật; 5 prompt VITEST của session con bị bỏ qua.
      expect(res.body.clusters).toHaveLength(1);
      expect(res.body.clusters[0].count).toBe(3);
      expect(res.body.stats.promptsAnalyzed).toBe(4);
    });

    it('member chỉ thấy prompt của chính mình, id cụm giống với leader; xem người khác hoặc project khác → 403', async () => {
      const res = await member1.get(url(projectP)).expect(200);
      expect(res.body.clusters).toHaveLength(1);
      // m1 có 3 prompt LINT (đủ cụm) và 2 prompt VITEST (chưa đủ 3 nên không thành cụm).
      expect(res.body.clusters[0]).toMatchObject({ count: 3, userCount: 1 });
      expect(res.body.clusters[0].id).toBe(clusterIdOf(projectP, LINT_FINGERPRINT));
      expect(res.body.stats.promptsAnalyzed).toBe(5);
      expect(res.body.stats.promptsClustered).toBe(3);
      expect(JSON.stringify(res.body)).not.toContain(m2);
      await member1.get(url(projectP, `?userId=${m2}`)).expect(403);
      await member1.get(url(projectQ)).expect(403);
      await member1.get(url(projectP, `?userId=${m1}`)).expect(200);
    });

    it('mở rộng khoảng thời gian thì tính cả prompt cũ; giới hạn số cụm nhưng vẫn báo tổng số cụm', async () => {
      // Đúng 90 ngày trước đến bây giờ vẫn hợp lệ (dung sai vài mili giây giữa lúc client tính và lúc server nhận).
      const wide = await leader.get(url(projectP, `?from=${encodeURIComponent(ago(90))}`)).expect(200);
      expect(wide.body.clusters.map((c: { count: number }) => c.count).sort()).toEqual([5, 5]);
      const limited = await leader.get(url(projectP, '?limit=1')).expect(200);
      expect(limited.body.clusters).toHaveLength(1);
      expect(limited.body.stats.clusterCount).toBe(2);
    });

    it('tham số sai: from không trước to, quá 90 ngày, userId không phải UUID, limit ngoài 1–200 → 400', async () => {
      const from = encodeURIComponent(ago(1));
      const to = encodeURIComponent(ago(2));
      await leader.get(url(projectP, `?from=${from}&to=${to}`)).expect(400);
      await leader.get(url(projectP, `?from=${encodeURIComponent(ago(120))}`)).expect(400);
      await leader.get(url(projectP, '?userId=abc')).expect(400);
      await leader.get(url(projectP, '?limit=0')).expect(400);
      await leader.get(url(projectP, '?limit=201')).expect(400);
      await leader.get(url(projectP, '?from=hom-qua')).expect(400);
    });

    it('leader xem dữ liệu người khác ghi audit skill_clusters.view; xem của chính mình hoặc member xem thì không', async () => {
      const count = async () =>
        (await querySql("SELECT 1 FROM audit_log WHERE action='skill_clusters.view' AND target_id=$1", [projectP])).length;
      const before = await count();
      await leader.get(url(projectP)).expect(200);
      expect(await count()).toBe(before + 1);
      await leader.get(url(projectP, `?userId=${leaderId}`)).expect(200);
      await member1.get(url(projectP)).expect(200);
      expect(await count()).toBe(before + 1);
    });

    it('project chưa có prompt nào lặp đủ 3 lần cho danh sách rỗng', async () => {
      const res = await leader.get(url(projectQ)).expect(200);
      expect(res.body).toMatchObject({
        stats: { promptsAnalyzed: 0, promptsClustered: 0, clusterCount: 0, truncated: false },
        clusters: [],
      });
    });
  });

  describe('tool MCP get_skill_clusters', () => {
    it('leader qua token tlp_ và member qua device token đều khớp schema, cùng quyền như REST', async () => {
      const leaderRes = await rpcCall(leaderToken, { projectId: projectP });
      expect(leaderRes.body.result.isError).not.toBe(true);
      const out = leaderRes.body.result.structuredContent;
      expectMatchesSchema(out);
      expect(out.clusters.map((c: { count: number }) => c.count)).toEqual([5, 4]);

      const memberRes = await rpcCall(m1Token, { projectId: projectP });
      const own = memberRes.body.result.structuredContent;
      expectMatchesSchema(own);
      expect(own.clusters).toHaveLength(1);
      expect(own.clusters[0].count).toBe(3);
    });

    it('lỗi quyền và tham số được báo cho agent', async () => {
      const denied = await rpcCall(m1Token, { projectId: projectP, userId: m2 });
      expect(denied.body.result.isError).toBe(true);
      expect(denied.body.result.content[0].text).toContain('không có quyền');
      const bad = await rpcCall(m1Token, { projectId: projectP, limit: 51 });
      expect(bad.body.result.isError).toBe(true);
      expect(bad.body.result.content[0].text).toContain('Tham số không hợp lệ');
      const limited = await rpcCall(leaderToken, { projectId: projectP, limit: 1 });
      expect(limited.body.result.structuredContent.clusters).toHaveLength(1);
    });
  });
});
