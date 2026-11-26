import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AuditService } from '../src/modules/access/audit.service.js';
import {
  createTestApp,
  insertDevice,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

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
    leaderId = await insertUser({
      email: 'leader@teamlens.local',
      name: 'leader',
      role: 'leader',
      password: PASSWORD,
    });
    memberId = await insertUser({
      email: 'member@teamlens.local',
      name: 'member',
      password: PASSWORD,
    });
    const project = await admin
      .post('/api/v1/projects')
      .send({ name: 'P', slug: 'p' })
      .expect(201);
    projectId = project.body.id;
    for (const userId of [leaderId, memberId]) {
      await admin
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId })
        .expect(201);
    }
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

  describe('lỗi 6: last_seen_at chỉ cập nhật khi cũ hơn 5 phút', () => {
    it('không ghi lại khi vừa cập nhật, ghi lại khi đã cũ', async () => {
      const { id: deviceId, token } = await insertDevice(memberId, 'PC');
      const auth = `Bearer ${token}`;
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
