import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  createTestApp,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const PASSWORD = 'teamlens123';

describe('TeamLens API (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Đăng nhập và trả về agent giữ cookie. */
  async function loginAs(email: string, password = PASSWORD) {
    const agent = request.agent(server);
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  }

  it('GET /health công khai', async () => {
    await request(server).get('/health').expect(200, { status: 'ok' });
  });

  describe('auth: setup → login → me → logout', () => {
    it('chưa đăng nhập thì 401 unauthenticated', async () => {
      const res = await request(server).get('/api/v1/auth/me').expect(401);
      expect(res.body).toEqual({
        error: 'unauthenticated',
        message: expect.any(String),
      });
    });

    it('setup tạo leader đầu tiên, đặt cookie', async () => {
      await request(server)
        .get('/api/v1/setup/status')
        .expect(200, { needsSetup: true });

      const bad = await request(server)
        .post('/api/v1/setup')
        .send({ email: 'khong-phai-email', name: 'A', password: '123' })
        .expect(400);
      expect(bad.body.error).toBe('validation_error');

      const res = await request(server)
        .post('/api/v1/setup')
        .send({
          email: 'Admin@TeamLens.local',
          name: 'Admin',
          password: PASSWORD,
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        email: 'admin@teamlens.local',
        name: 'Admin',
        role: 'leader',
      });
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/tl_session=[\w-]{43};/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Secure/);

      await request(server)
        .get('/api/v1/setup/status')
        .expect(200, { needsSetup: false });
      const again = await request(server)
        .post('/api/v1/setup')
        .send({ email: 'x@teamlens.local', name: 'X', password: PASSWORD })
        .expect(409);
      expect(again.body.error).toBe('already_setup');
    });

    it('login sai mật khẩu → 401 invalid_credentials', async () => {
      const res = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@teamlens.local', password: 'sai-mat-khau' })
        .expect(401);
      expect(res.body.error).toBe('invalid_credentials');
      const unknown = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@teamlens.local', password: PASSWORD })
        .expect(401);
      expect(unknown.body.error).toBe('invalid_credentials');
    });

    it('login → me → logout → me bị 401', async () => {
      const agent = await loginAs('admin@teamlens.local');
      const me = await agent.get('/api/v1/auth/me').expect(200);
      expect(me.body).toEqual({
        user: {
          id: expect.any(String),
          email: 'admin@teamlens.local',
          name: 'Admin',
          role: 'leader',
        },
        memberships: [],
      });

      const [{ n: before }] = await querySql<{ n: number }>(
        'SELECT count(*)::int AS n FROM auth_sessions',
      );
      await agent.post('/api/v1/auth/logout').expect(204);
      const [{ n: after }] = await querySql<{ n: number }>(
        'SELECT count(*)::int AS n FROM auth_sessions',
      );
      expect(after).toBe(before - 1);
      await agent.get('/api/v1/auth/me').expect(401);
    });
  });

  describe('project, thành viên, quyền', () => {
    let projectId: string;
    let memberId: string;
    let member2Id: string;
    let leaderId: string;

    it('leader thêm leader khác và tạo project', async () => {
      const admin = await loginAs('admin@teamlens.local');
      const created = await admin
        .post('/api/v1/users')
        .send({
          email: 'leader@teamlens.local',
          name: 'Leader',
          password: PASSWORD,
        })
        .expect(201);
      expect(created.body).toEqual({
        id: expect.any(String),
        email: 'leader@teamlens.local',
        name: 'Leader',
        role: 'leader',
      });
      leaderId = created.body.id;
      memberId = await insertUser({
        email: 'member1@teamlens.local',
        name: 'Member 1',
        password: PASSWORD,
      });
      member2Id = await insertUser({
        email: 'member2@teamlens.local',
        name: 'Member 2',
        password: PASSWORD,
      });
      const dup = await admin
        .post('/api/v1/users')
        .send({
          email: 'leader@teamlens.local',
          name: 'Trùng',
          password: PASSWORD,
        })
        .expect(409);
      expect(dup.body.error).toBe('email_taken');

      const project = await admin
        .post('/api/v1/projects')
        .send({ name: 'TeamLens', slug: 'teamlens' })
        .expect(201);
      expect(project.body).toEqual({
        id: expect.any(String),
        name: 'TeamLens',
        slug: 'teamlens',
        settings: {},
      });
      projectId = project.body.id;
      const slugTaken = await admin
        .post('/api/v1/projects')
        .send({ name: 'Khác', slug: 'teamlens' })
        .expect(409);
      expect(slugTaken.body.error).toBe('slug_taken');

      // Người tạo project tự là thành viên; leader khác thấy project dù chưa tham gia.
      const list = await admin.get('/api/v1/projects').expect(200);
      expect(list.body).toEqual([
        { id: projectId, name: 'TeamLens', slug: 'teamlens', isMember: true },
      ]);
      const leader = await loginAs('leader@teamlens.local');
      const leaderList = await leader.get('/api/v1/projects').expect(200);
      expect(leaderList.body).toEqual([
        { id: projectId, name: 'TeamLens', slug: 'teamlens', isMember: false },
      ]);
      await leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: leaderId })
        .expect(201);
    });

    it('member không tạo được project/user', async () => {
      const member = await loginAs('member1@teamlens.local');
      const res = await member
        .post('/api/v1/projects')
        .send({ name: 'X', slug: 'x' })
        .expect(403);
      expect(res.body.error).toBe('forbidden');
      await member.get('/api/v1/users').expect(403);
      await member
        .post('/api/v1/users')
        .send({ email: 'x@teamlens.local', name: 'X', password: PASSWORD })
        .expect(403);
    });

    it('leader thêm member, quản lý repo; ghi audit', async () => {
      const leader = await loginAs('leader@teamlens.local');
      const added = await leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: memberId })
        .expect(201);
      expect(added.body).toEqual({
        userId: memberId,
        email: 'member1@teamlens.local',
        name: 'Member 1',
        role: 'member',
      });
      const again = await leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: memberId })
        .expect(409);
      expect(again.body.error).toBe('already_member');
      const missing = await leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: '00000000-0000-4000-8000-000000000000' })
        .expect(404);
      expect(missing.body.error).toBe('user_not_found');

      const repo = await leader
        .post(`/api/v1/projects/${projectId}/repos`)
        .send({ remotePattern: 'git@github.com:MakitJenamin/TeamLens.git' })
        .expect(201);
      expect(repo.body).toEqual({
        id: expect.any(String),
        remotePattern: 'github.com/makitjenamin/teamlens',
      });
      const invalid = await leader
        .post(`/api/v1/projects/${projectId}/repos`)
        .send({ remotePattern: 'github.com' })
        .expect(400);
      expect(invalid.body.error).toBe('invalid_pattern');

      const detail = await leader
        .get(`/api/v1/projects/${projectId}`)
        .expect(200);
      expect(detail.body.repos).toEqual([repo.body]);

      const members = await leader
        .get(`/api/v1/projects/${projectId}/members`)
        .expect(200);
      expect(
        members.body.map((m: { name: string; role: string }) => [
          m.name,
          m.role,
        ]),
      ).toEqual([
        ['Admin', 'leader'],
        ['Leader', 'leader'],
        ['Member 1', 'member'],
      ]);

      const patched = await leader
        .patch(`/api/v1/projects/${projectId}`)
        .send({ settings: { leaderboard: true } })
        .expect(200);
      expect(patched.body).toEqual({
        id: projectId,
        name: 'TeamLens',
        slug: 'teamlens',
        settings: { leaderboard: true },
      });

      const actions = await querySql<{ action: string }>(
        'SELECT action FROM audit_log ORDER BY at',
      );
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining(['member.add', 'repo.add']),
      );
    });

    it('member bị 403 khi thêm member, xem được project và repo', async () => {
      const member = await loginAs('member1@teamlens.local');
      const res = await member
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: member2Id })
        .expect(403);
      expect(res.body).toEqual({
        error: 'forbidden',
        message: expect.any(String),
      });
      await member.get(`/api/v1/projects/${projectId}/members`).expect(403);
      await member.get(`/api/v1/projects/${projectId}`).expect(200);
      await member.get(`/api/v1/projects/${projectId}/repos`).expect(200);

      const me = await member.get('/api/v1/auth/me').expect(200);
      expect(me.body.memberships).toEqual([
        { projectId, projectName: 'TeamLens', projectSlug: 'teamlens' },
      ]);
      const list = await member.get('/api/v1/projects').expect(200);
      expect(list.body).toEqual([
        { id: projectId, name: 'TeamLens', slug: 'teamlens', isMember: true },
      ]);
    });

    it('người ngoài project bị 403; project không tồn tại → 404', async () => {
      const outsider = await loginAs('member2@teamlens.local');
      await outsider.get(`/api/v1/projects/${projectId}`).expect(403);
      const admin = await loginAs('admin@teamlens.local');
      const res = await admin
        .get('/api/v1/projects/00000000-0000-4000-8000-000000000000')
        .expect(404);
      expect(res.body.error).toBe('not_found');
      await admin.get('/api/v1/projects/khong-phai-uuid').expect(404);
    });

    it('leader đổi vai trò toàn server; không hạ được leader cuối cùng', async () => {
      const leader = await loginAs('leader@teamlens.local');
      // member2 có sẵn email + mật khẩu nên nâng được ngay.
      const raised = await leader
        .patch(`/api/v1/users/${member2Id}`)
        .send({ role: 'leader' })
        .expect(200);
      expect(raised.body.role).toBe('leader');
      await leader
        .patch(`/api/v1/users/${member2Id}`)
        .send({ role: 'owner' })
        .expect(400);
      await leader
        .patch(`/api/v1/users/${member2Id}`)
        .send({ role: 'member' })
        .expect(200);
      const noEmail = await insertUser({ email: null, name: 'Chưa có email' });
      const missing = await leader
        .patch(`/api/v1/users/${noEmail}`)
        .send({ role: 'leader' })
        .expect(400);
      expect(missing.body.error).toBe('credentials_required');
      const promoted = await leader
        .patch(`/api/v1/users/${noEmail}`)
        .send({
          role: 'leader',
          email: 'moi@teamlens.local',
          password: PASSWORD,
        })
        .expect(200);
      expect(promoted.body).toMatchObject({
        email: 'moi@teamlens.local',
        role: 'leader',
      });
      await loginAs('moi@teamlens.local');

      // Hạ hết leader khác thì leader cuối cùng bị giữ lại.
      const [{ id: adminId }] = await querySql<{ id: string }>(
        `SELECT id FROM users WHERE email = 'admin@teamlens.local'`,
      );
      for (const id of [adminId, noEmail]) {
        await leader
          .patch(`/api/v1/users/${id}`)
          .send({ role: 'member' })
          .expect(200);
      }
      const last = await leader
        .patch(`/api/v1/users/${leaderId}`)
        .send({ role: 'member' })
        .expect(409);
      expect(last.body.error).toBe('last_leader');
      await leader
        .patch(`/api/v1/users/${adminId}`)
        .send({ role: 'leader' })
        .expect(200);
    });

    it('leader xóa thành viên khỏi project', async () => {
      const leader = await loginAs('leader@teamlens.local');
      await leader
        .delete(`/api/v1/projects/${projectId}/members/${memberId}`)
        .expect(204);
      await leader
        .delete(`/api/v1/projects/${projectId}/members/${memberId}`)
        .expect(404);
      const actions = await querySql<{ action: string }>(
        'SELECT action FROM audit_log',
      );
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining(['user.role_change', 'member.remove']),
      );
    });
  });

  describe('device login', () => {
    it('code → token (pending) → approve → token → whoami → logout → whoami 401', async () => {
      const code = await request(server)
        .post('/agent/v1/device/code')
        .send({ deviceName: 'LAPTOP-01', os: 'windows', cliVersion: '0.1.0' })
        .expect(200);
      expect(code.body).toEqual({
        deviceCode: expect.any(String),
        userCode: expect.stringMatching(
          /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
        ),
        verificationUri: 'http://localhost:3000/device',
        verificationUriComplete: `http://localhost:3000/device?code=${code.body.userCode}`,
        expiresIn: 900,
        interval: 5,
      });
      const { deviceCode, userCode } = code.body as {
        deviceCode: string;
        userCode: string;
      };

      const pending = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode })
        .expect(400);
      expect(pending.body.error).toBe('authorization_pending');

      const tooFast = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode })
        .expect(400);
      expect(tooFast.body.error).toBe('slow_down');

      const unknown = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode: 'khong-ton-tai' })
        .expect(400);
      expect(unknown.body.error).toBe('expired_token');

      // Duyệt phải đăng nhập.
      await request(server)
        .post('/api/v1/device/approve')
        .send({ userCode })
        .expect(401);
      const member = await loginAs('member2@teamlens.local');
      const wrong = await member
        .post('/api/v1/device/approve')
        .send({ userCode: 'BBBB-BBBB' })
        .expect(404);
      expect(wrong.body.error).toBe('invalid_code');
      const approved = await member
        .post('/api/v1/device/approve')
        .send({ userCode: userCode.toLowerCase() })
        .expect(200);
      expect(approved.body).toEqual({
        device: { id: expect.any(String), name: 'LAPTOP-01' },
      });
      await member
        .post('/api/v1/device/approve')
        .send({ userCode })
        .expect(404);

      // Chờ hết `interval` rồi mới poll lại.
      await new Promise((resolve) => setTimeout(resolve, 5100));
      const token = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode })
        .expect(200);
      expect(token.body).toEqual({
        accessToken: expect.stringMatching(/^tld_[\w-]{43}$/),
        deviceId: approved.body.device.id,
      });
      const accessToken = token.body.accessToken as string;

      // Token chỉ trả một lần.
      await new Promise((resolve) => setTimeout(resolve, 5100));
      const twice = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode })
        .expect(400);
      expect(twice.body.error).toBe('expired_token');

      // DB chỉ lưu SHA-256 của token.
      const [stored] = await querySql<{ token_hash: string }>(
        'SELECT token_hash FROM devices WHERE id = $1',
        [approved.body.device.id],
      );
      expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.token_hash).not.toContain(accessToken);

      const whoami = await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(whoami.body).toEqual({
        user: {
          id: expect.any(String),
          email: 'member2@teamlens.local',
          name: 'Member 2',
        },
        role: 'member',
        device: { id: approved.body.device.id, name: 'LAPTOP-01' },
        projects: [],
      });

      const devices = await member.get('/api/v1/devices').expect(200);
      expect(devices.body).toEqual([
        {
          id: approved.body.device.id,
          name: 'LAPTOP-01',
          os: 'windows',
          cliVersion: '0.1.0',
          status: 'offline',
          lastSeenAt: expect.any(String),
          createdAt: expect.any(String),
          revokedAt: null,
        },
      ]);

      await request(server)
        .post('/agent/v1/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);
      const after = await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
      expect(after.body.error).toBe('invalid_token');
      const actions = await querySql<{ action: string }>(
        'SELECT action FROM audit_log',
      );
      expect(actions.map((a) => a.action)).toContain('device.revoke');
    });

    it('route /agent/v1/* thiếu hoặc sai token → 401 invalid_token', async () => {
      const missing = await request(server).get('/agent/v1/whoami').expect(401);
      expect(missing.body.error).toBe('invalid_token');
      await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', 'Bearer tld_khong-hop-le')
        .expect(401);
      // Cookie dashboard không dùng được cho /agent.
      const member = await loginAs('member2@teamlens.local');
      await member.get('/agent/v1/whoami').expect(401);
    });

    it('whoami trả vai trò, project và repo pattern; revoke chỉ chủ thiết bị hoặc leader', async () => {
      const code = await request(server)
        .post('/agent/v1/device/code')
        .send({ deviceName: 'PC-LEADER', os: 'windows', cliVersion: '0.1.0' })
        .expect(200);
      const leader = await loginAs('leader@teamlens.local');
      const approved = await leader
        .post('/api/v1/device/approve')
        .send({ userCode: code.body.userCode })
        .expect(200);
      const token = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode: code.body.deviceCode })
        .expect(200);

      const whoami = await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', `Bearer ${token.body.accessToken}`)
        .expect(200);
      expect(whoami.body.role).toBe('leader');
      expect(whoami.body.projects).toEqual([
        {
          id: expect.any(String),
          name: 'TeamLens',
          slug: 'teamlens',
          repoPatterns: ['github.com/makitjenamin/teamlens'],
        },
      ]);

      const deviceId = approved.body.device.id as string;
      const other = await loginAs('member2@teamlens.local');
      await other.post(`/api/v1/devices/${deviceId}/revoke`).expect(403);
      const admin = await loginAs('admin@teamlens.local');
      await admin.post(`/api/v1/devices/${deviceId}/revoke`).expect(204);
      await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', `Bearer ${token.body.accessToken}`)
        .expect(401);
    });

    it('mã hết hạn → approve 410 expired_code, token expired_token', async () => {
      const code = await request(server)
        .post('/agent/v1/device/code')
        .send({ deviceName: 'OLD', os: 'windows', cliVersion: '0.1.0' })
        .expect(200);
      await querySql(
        `UPDATE device_codes SET expires_at = now() - interval '1 minute' WHERE user_code = $1`,
        [code.body.userCode],
      );
      const member = await loginAs('member1@teamlens.local');
      const res = await member
        .post('/api/v1/device/approve')
        .send({ userCode: code.body.userCode })
        .expect(410);
      expect(res.body.error).toBe('expired_code');
      const token = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode: code.body.deviceCode })
        .expect(400);
      expect(token.body.error).toBe('expired_token');
    });
  });

  it('route không tồn tại → 404 dạng { error, message }', async () => {
    const admin = await loginAs('admin@teamlens.local');
    const res = await admin.get('/api/v1/khong-co').expect(404);
    expect(res.body).toEqual({
      error: 'not_found',
      message: expect.any(String),
    });
  });
});
