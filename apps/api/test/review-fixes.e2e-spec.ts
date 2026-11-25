import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AuditService } from '../src/modules/access/audit.service.js';
import { createTestApp, querySql, resetDatabase } from './helpers.js';

const PASSWORD = 'teamlens123';

// Các lỗi được chỉ ra khi review PR #1.
describe('Sửa lỗi review PR #1 (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let projectId: string;
  let leaderId: string;
  let memberId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();

    await request(server)
      .post('/api/v1/setup')
      .send({
        email: 'admin@teamlens.local',
        name: 'Admin',
        password: PASSWORD,
      })
      .expect(201);
    const admin = await loginAs('admin@teamlens.local');
    for (const email of ['leader@teamlens.local', 'member@teamlens.local']) {
      const res = await admin
        .post('/api/v1/users')
        .send({ email, name: email, password: PASSWORD })
        .expect(201);
      if (email.startsWith('leader')) leaderId = res.body.id;
      else memberId = res.body.id;
    }
    const project = await admin
      .post('/api/v1/projects')
      .send({ name: 'P', slug: 'p' })
      .expect(201);
    projectId = project.body.id;
    await admin
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ email: 'leader@teamlens.local', role: 'leader' })
      .expect(201);
    await admin
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ email: 'member@teamlens.local', role: 'member' })
      .expect(201);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  async function loginAs(email: string) {
    const agent = request.agent(server);
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return agent;
  }

  /** Xin device code và duyệt bằng tài khoản member. */
  async function approvedCode() {
    const code = await request(server)
      .post('/agent/v1/device/code')
      .send({ deviceName: 'PC', os: 'windows', cliVersion: '0.1.0' })
      .expect(200);
    const member = await loginAs('member@teamlens.local');
    const approved = await member
      .post('/api/v1/device/approve')
      .send({ userCode: code.body.userCode })
      .expect(200);
    return {
      deviceCode: code.body.deviceCode as string,
      userCode: code.body.userCode as string,
      deviceId: approved.body.device.id as string,
    };
  }

  describe('lỗi 2: đổi token sau khi code đã duyệt nhưng vừa hết hạn', () => {
    it('trong 5 phút grace sau expiresAt vẫn nhận được token', async () => {
      const { deviceCode, userCode, deviceId } = await approvedCode();
      await querySql(
        `UPDATE device_codes SET expires_at = now() - interval '2 minutes' WHERE user_code = $1`,
        [userCode],
      );
      const res = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode })
        .expect(200);
      expect(res.body.deviceId).toBe(deviceId);
    });

    it('quá grace thì expired_token và thiết bị bị thu hồi (không mồ côi)', async () => {
      const { deviceCode, userCode, deviceId } = await approvedCode();
      await querySql(
        `UPDATE device_codes SET expires_at = now() - interval '6 minutes' WHERE user_code = $1`,
        [userCode],
      );
      const res = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode })
        .expect(400);
      expect(res.body.error).toBe('expired_token');
      const [device] = await querySql<{
        revoked_at: Date | null;
        token_hash: string | null;
      }>('SELECT revoked_at, token_hash FROM devices WHERE id = $1', [
        deviceId,
      ]);
      expect(device.revoked_at).not.toBeNull();
      expect(device.token_hash).toBeNull();
    });
  });

  describe('lỗi 3: insert + audit trong cùng transaction', () => {
    it('audit lỗi thì không tạo project', async () => {
      const audit = app.get(AuditService);
      const spy = vi
        .spyOn(audit, 'record')
        .mockRejectedValueOnce(new Error('audit hỏng'));
      const admin = await loginAs('admin@teamlens.local');
      await admin
        .post('/api/v1/projects')
        .send({ name: 'Rollback', slug: 'rollback' })
        .expect(500);
      spy.mockRestore();
      const rows = await querySql(
        `SELECT id FROM projects WHERE slug = 'rollback'`,
      );
      expect(rows).toHaveLength(0);
    });

    it('audit lỗi thì không tạo user', async () => {
      const audit = app.get(AuditService);
      const spy = vi
        .spyOn(audit, 'record')
        .mockRejectedValueOnce(new Error('audit hỏng'));
      const admin = await loginAs('admin@teamlens.local');
      await admin
        .post('/api/v1/users')
        .send({
          email: 'rollback@teamlens.local',
          name: 'Rollback',
          password: PASSWORD,
        })
        .expect(500);
      spy.mockRestore();
      const rows = await querySql(
        `SELECT id FROM users WHERE email = 'rollback@teamlens.local'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('lỗi 4: không để project mất leader cuối cùng', () => {
    it('hạ vai trò leader cuối → 409 last_leader', async () => {
      const admin = await loginAs('admin@teamlens.local');
      const res = await admin
        .patch(`/api/v1/projects/${projectId}/members/${leaderId}`)
        .send({ role: 'member' })
        .expect(409);
      expect(res.body.error).toBe('last_leader');
    });

    it('xóa leader cuối → 409 last_leader (kể cả leader tự rời)', async () => {
      const leader = await loginAs('leader@teamlens.local');
      const res = await leader
        .delete(`/api/v1/projects/${projectId}/members/${leaderId}`)
        .expect(409);
      expect(res.body.error).toBe('last_leader');
      const [row] = await querySql<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, leaderId],
      );
      expect(row.role).toBe('leader');
    });

    it('khi còn leader khác thì hạ/xóa được', async () => {
      const leader = await loginAs('leader@teamlens.local');
      await leader
        .patch(`/api/v1/projects/${projectId}/members/${memberId}`)
        .send({ role: 'leader' })
        .expect(200);
      await leader
        .patch(`/api/v1/projects/${projectId}/members/${leaderId}`)
        .send({ role: 'member' })
        .expect(200);
      // Giờ member là leader duy nhất.
      const admin = await loginAs('admin@teamlens.local');
      const res = await admin
        .delete(`/api/v1/projects/${projectId}/members/${memberId}`)
        .expect(409);
      expect(res.body.error).toBe('last_leader');
      await admin
        .delete(`/api/v1/projects/${projectId}/members/${leaderId}`)
        .expect(204);
    });
  });

  describe('lỗi 6: last_seen_at chỉ cập nhật khi cũ hơn 5 phút', () => {
    it('không ghi lại khi vừa cập nhật, ghi lại khi đã cũ', async () => {
      const { deviceCode, deviceId } = await approvedCode();
      const token = await request(server)
        .post('/agent/v1/device/token')
        .send({ deviceCode })
        .expect(200);
      const auth = `Bearer ${token.body.accessToken}`;
      const lastSeen = async () => {
        const [row] = await querySql<{ last_seen_at: Date }>(
          'SELECT last_seen_at FROM devices WHERE id = $1',
          [deviceId],
        );
        return new Date(row.last_seen_at).getTime();
      };

      const stale = '2000-01-01T00:00:00Z';
      await querySql(
        `UPDATE devices SET last_seen_at = now() - interval '1 minute' WHERE id = $1`,
        [deviceId],
      );
      const before = await lastSeen();
      await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', auth)
        .expect(200);
      expect(await lastSeen()).toBe(before);

      await querySql(`UPDATE devices SET last_seen_at = $2 WHERE id = $1`, [
        deviceId,
        stale,
      ]);
      await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', auth)
        .expect(200);
      expect(await lastSeen()).toBeGreaterThan(Date.now() - 60_000);
    });
  });
});
