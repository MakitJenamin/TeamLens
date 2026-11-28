import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  createTestApp,
  insertDevice,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const PASSWORD = 'teamlens123';
const ACCEPT = 'application/json, text/event-stream';

describe('MCP /api/v1/mcp (M6.3, e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let leaderId: string;
  let memberId: string;
  let memberDevice: { id: string; token: string };
  let agentToken: string;
  let alphaId: string;
  let betaId: string;

  const rpc = (token: string | null, body: object) => {
    const req = request(server)
      .post('/api/v1/mcp')
      .set('Accept', ACCEPT)
      .send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const call = (token: string, name: string, args: object = {}) =>
    rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();

    leaderId = await insertUser({
      email: 'leader@mcp.local',
      name: 'Leader MCP',
      role: 'leader',
      password: PASSWORD,
    });
    memberId = await insertUser({ email: null, name: 'Thành viên MCP' });
    memberDevice = await insertDevice(memberId, 'MEMBER-PC');

    const leader = request.agent(server);
    await leader
      .post('/api/v1/auth/login')
      .send({ email: 'leader@mcp.local', password: PASSWORD })
      .expect(200);
    // Tên project chứa một khóa AWS giả để kiểm tra cửa ra che secret.
    const alpha = await leader
      .post('/api/v1/projects')
      .send({ name: 'Alpha AKIAIOSFODNN7EXAMPLE', slug: 'alpha' })
      .expect(201);
    const beta = await leader
      .post('/api/v1/projects')
      .send({ name: 'Beta', slug: 'beta' })
      .expect(201);
    alphaId = alpha.body.id as string;
    betaId = beta.body.id as string;
    await leader
      .post(`/api/v1/projects/${alphaId}/members`)
      .send({ userId: memberId })
      .expect(201);

    const created = await leader
      .post('/api/v1/me/agent-tokens')
      .send({ name: 'Claude Code' })
      .expect(201);
    agentToken = created.body.secret as string;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('xác thực', () => {
    it('thiếu token, token lạ hoặc sai tiền tố → 401 invalid_token dạng JSON', async () => {
      for (const token of [null, 'abc', 'tld_khongtontai', 'tlp_khongtontai']) {
        const res = await rpc(token, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }).expect(401);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body.error).toBe('invalid_token');
      }
      await request(server).get('/api/v1/mcp').expect(401);
      await request(server).delete('/api/v1/mcp').expect(401);
    });

    it('cookie đăng nhập dashboard không thay được token', async () => {
      const agent = request.agent(server);
      await agent
        .post('/api/v1/auth/login')
        .send({ email: 'leader@mcp.local', password: PASSWORD })
        .expect(200);
      await agent
        .post('/api/v1/mcp')
        .set('Accept', ACCEPT)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    });

    it('device token đã thu hồi và token tlp_ đã thu hồi → 401', async () => {
      const revoked = await insertDevice(memberId, 'OLD-PC');
      await querySql('UPDATE devices SET revoked_at = now() WHERE id = $1', [
        revoked.id,
      ]);
      await rpc(revoked.token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }).expect(401);
    });
  });

  describe('giao thức', () => {
    it('initialize: trả thông tin server, không cấp Mcp-Session-Id (stateless)', async () => {
      const res = await rpc(memberDevice.token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }).expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['mcp-session-id']).toBeUndefined();
      expect(res.body.result.serverInfo.name).toBe('teamlens');
      expect(res.body.result.capabilities.tools).toBeDefined();
    });

    it('tools/list có whoami với schema đúng contract', async () => {
      const res = await rpc(memberDevice.token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }).expect(200);
      const tool = (
        res.body.result.tools as { name: string; inputSchema: object }[]
      ).find((t) => t.name === 'whoami');
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({ type: 'object' });
    });

    it('notification → 202; tool không tồn tại → lỗi JSON-RPC', async () => {
      await rpc(memberDevice.token, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }).expect(202);
      const res = await call(memberDevice.token, 'khong_co_tool').expect(200);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('khong_co_tool');
    });

    it('GET luôn 405 và DELETE luôn 204 khi có token hợp lệ', async () => {
      const get = await request(server)
        .get('/api/v1/mcp')
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(405);
      expect(get.body.error).toBe('method_not_allowed');
      await request(server)
        .delete('/api/v1/mcp')
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(204);
    });
  });

  describe('whoami', () => {
    it('member qua device token: chỉ thấy project mình tham gia', async () => {
      const res = await call(memberDevice.token, 'whoami').expect(200);
      const out = res.body.result.structuredContent;
      expect(out.user).toEqual({
        id: memberId,
        name: 'Thành viên MCP',
        role: 'member',
      });
      expect(out.tokenKind).toBe('device');
      expect(out.projects.map((p: { id: string }) => p.id)).toEqual([alphaId]);
      expect(JSON.parse(res.body.result.content[0].text)).toEqual(out);
    });

    it('leader qua token tlp_: thấy mọi project, tokenKind agent, ghi last_used_at', async () => {
      // Token mới (các test trước đã dùng agentToken nên last_used_at của nó không còn null).
      const leader = request.agent(server);
      await leader
        .post('/api/v1/auth/login')
        .send({ email: 'leader@mcp.local', password: PASSWORD })
        .expect(200);
      const fresh = await leader
        .post('/api/v1/me/agent-tokens')
        .send({ name: 'Thử last_used_at' })
        .expect(201);
      const freshId = fresh.body.token.id as string;
      const lastUsed = () =>
        querySql<{ last_used_at: string | null }>(
          'SELECT last_used_at FROM agent_tokens WHERE id = $1',
          [freshId],
        );
      expect((await lastUsed())[0].last_used_at).toBeNull();

      const res = await call(fresh.body.secret as string, 'whoami').expect(200);
      const out = res.body.result.structuredContent;
      expect(out.user).toMatchObject({ id: leaderId, role: 'leader' });
      expect(out.tokenKind).toBe('agent');
      expect(
        out.projects.map((p: { id: string }) => p.id).sort(),
      ).toEqual([alphaId, betaId].sort());

      expect((await lastUsed())[0].last_used_at).not.toBeNull();
    });

    it('cửa ra che secret: khóa AWS trong tên project bị che, ở cả content và structuredContent', async () => {
      const res = await call(agentToken, 'whoami').expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(text).toContain('[REDACTED:aws_access_key]');
    });

    it('thu hồi token tlp_ thì lần gọi sau bị 401', async () => {
      const leader = request.agent(server);
      await leader
        .post('/api/v1/auth/login')
        .send({ email: 'leader@mcp.local', password: PASSWORD })
        .expect(200);
      const second = await leader
        .post('/api/v1/me/agent-tokens')
        .send({ name: 'Tạm' })
        .expect(201);
      const secret = second.body.secret as string;
      await call(secret, 'whoami').expect(200);
      await leader
        .delete(`/api/v1/me/agent-tokens/${second.body.token.id as string}`)
        .expect(204);
      await call(secret, 'whoami').expect(401);
    });
  });
});
