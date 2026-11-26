import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { sha256 } from '../src/common/crypto.js';
import { CONSENT_TEXT_VERSION } from '../src/modules/consent/consent-text.js';
import {
  createTestApp,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const PASSWORD = 'teamlens123';

describe('Link mời, tl join, tl open, wizard setup (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let leader: ReturnType<typeof request.agent>;
  let projectId: string;
  let otherProjectId: string;
  /** Mã mời mặc định do wizard setup tạo. */
  let setupCode: string;
  let memberToken: string;
  let memberId: string;
  let ipSeq = 0;

  /** Mỗi request công khai một IP riêng (qua X-Forwarded-For) để không đụng rate limit. */
  const freshIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

  const preview = (code: string, ip = freshIp()) =>
    request(server).get(`/agent/v1/invites/${code}`).set('X-Forwarded-For', ip);

  const joinBody = (code: string, overrides: Record<string, unknown> = {}) => ({
    code,
    name: '  Thành viên mới  ',
    deviceName: 'LAPTOP-01',
    os: 'windows',
    cliVersion: '0.1.0',
    consent: { textVersion: CONSENT_TEXT_VERSION, backfill: true },
    ...overrides,
  });

  const join = (body: object, token?: string, ip = freshIp()) => {
    const req = request(server)
      .post('/agent/v1/join')
      .set('X-Forwarded-For', ip);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  const codeOf = (url: string) => url.split('/i/')[1];

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('wizard setup có project', () => {
    it('pattern sai → 400 invalid_pattern, rollback cả leader', async () => {
      const res = await request(server)
        .post('/api/v1/setup')
        .send({
          email: 'leader@teamlens.local',
          name: 'Leader',
          password: PASSWORD,
          project: {
            name: 'TeamLens',
            slug: 'teamlens',
            repoPatterns: ['github.com/acme/*', 'khong hop le'],
          },
        })
        .expect(400);
      expect(res.body.error).toBe('invalid_pattern');
      const [{ n }] = await querySql<{ n: number }>(
        'SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM projects) AS n',
      );
      expect(Number(n)).toBe(0);
      await request(server)
        .get('/api/v1/setup/status')
        .expect(200, { needsSetup: true });
    });

    it('thiếu repoPatterns → 400 validation_error', async () => {
      const res = await request(server)
        .post('/api/v1/setup')
        .send({
          email: 'leader@teamlens.local',
          name: 'Leader',
          password: PASSWORD,
          project: { name: 'TeamLens', slug: 'teamlens', repoPatterns: [] },
        })
        .expect(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('tạo leader + project + repo + link mời mặc định dùng được', async () => {
      leader = request.agent(server);
      const res = await leader
        .post('/api/v1/setup')
        .send({
          email: 'leader@teamlens.local',
          name: 'Leader',
          password: PASSWORD,
          project: {
            name: ' TeamLens ',
            slug: 'teamlens',
            repoPatterns: [
              'https://github.com/Acme/App.git',
              'github.com/acme/app',
              'git@gitlab.com:acme/*',
            ],
          },
        })
        .expect(201);
      expect(res.headers['set-cookie']?.[0]).toMatch(/^tl_session=/);
      expect(res.body.user).toMatchObject({ role: 'leader' });
      expect(res.body.project).toEqual({
        id: expect.any(String),
        name: 'TeamLens',
        slug: 'teamlens',
        settings: {},
        repos: [
          { id: expect.any(String), remotePattern: 'github.com/acme/app' },
          { id: expect.any(String), remotePattern: 'gitlab.com/acme/*' },
        ],
      });
      projectId = res.body.project.id;
      const invite = res.body.invite;
      expect(invite.url).toMatch(/^https?:\/\/[^/]+\/i\/[A-Za-z0-9_-]{43}$/);
      setupCode = codeOf(invite.url);
      expect(invite.code).toBe(setupCode);
      expect(invite.installCommand).toMatch(
        new RegExp(
          `^irm https?://[^ ]+/install\\.ps1\\?code=${setupCode} \\| iex$`,
        ),
      );
      expect(invite.invite).toMatchObject({
        projectId,
        status: 'active',
        maxUses: null,
        usedCount: 0,
        revokedAt: null,
        createdBy: { id: res.body.user.id, name: 'Leader' },
      });
      const days =
        (Date.parse(invite.invite.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
      // Leader là thành viên project; DB chỉ lưu SHA-256 của mã.
      await leader.get('/api/v1/auth/me').expect(200);
      const me = await leader.get('/api/v1/auth/me');
      expect(me.body.memberships).toHaveLength(1);
      const rows = await querySql<{ code_hash: string }>(
        'SELECT code_hash FROM invites',
      );
      expect(rows).toEqual([{ code_hash: sha256(setupCode) }]);
      await preview(setupCode).expect(200);
    });
  });

  describe('leader quản lý link mời', () => {
    it('member không được tạo/liệt kê/thu hồi', async () => {
      await insertUser({
        email: 'm@teamlens.local',
        name: 'm',
        password: PASSWORD,
      });
      const member = request.agent(server);
      await member
        .post('/api/v1/auth/login')
        .send({ email: 'm@teamlens.local', password: PASSWORD })
        .expect(200);
      await member.get(`/api/v1/projects/${projectId}/invites`).expect(403);
      await member.post(`/api/v1/projects/${projectId}/invites`).expect(403);
      await request(server)
        .get(`/api/v1/projects/${projectId}/invites`)
        .expect(401);
    });

    it('tạo (không body / có body), liệt kê, project không tồn tại → 404', async () => {
      const a = await leader
        .post(`/api/v1/projects/${projectId}/invites`)
        .expect(201);
      expect(a.body.invite.maxUses).toBeNull();
      const b = await leader
        .post(`/api/v1/projects/${projectId}/invites`)
        .send({ expiresInDays: 1, maxUses: 3 })
        .expect(201);
      expect(b.body.invite).toMatchObject({ maxUses: 3, status: 'active' });
      for (const bad of [
        { expiresInDays: 0 },
        { expiresInDays: 31 },
        { maxUses: 0 },
        { maxUses: 1.5 },
      ]) {
        const res = await leader
          .post(`/api/v1/projects/${projectId}/invites`)
          .send(bad)
          .expect(400);
        expect(res.body.error).toBe('validation_error');
      }
      const list = await leader
        .get(`/api/v1/projects/${projectId}/invites`)
        .expect(200);
      expect(list.body).toHaveLength(3);
      expect(list.body[0].id).toBe(b.body.invite.id);
      expect(list.body[0]).not.toHaveProperty('code');
      await leader
        .get('/api/v1/projects/00000000-0000-0000-0000-000000000000/invites')
        .expect(404);
      await leader.get('/api/v1/projects/khong-phai-uuid/invites').expect(404);
      const audit = await querySql<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'invite.create'",
      );
      expect(audit[0].n).toBe(3);
    });
  });

  describe('tl join', () => {
    it('preview trả project, repo, văn bản đồng ý; mã sai → 404', async () => {
      const res = await preview(setupCode).expect(200);
      expect(res.body).toEqual({
        serverUrl: expect.stringMatching(/^https?:\/\//),
        project: { id: projectId, name: 'TeamLens', slug: 'teamlens' },
        repoPatterns: ['github.com/acme/app', 'gitlab.com/acme/*'],
        consent: { version: CONSENT_TEXT_VERSION, text: expect.any(String) },
        expiresAt: expect.any(String),
      });
      expect(res.body.consent.text).toContain('Secret');
      for (const code of ['khong-ton-tai-123', 'ngan', 'co%20dau%20cach!!']) {
        const bad = await preview(code).expect(404);
        expect(bad.body.error).toBe('invite_not_found');
      }
    });

    it('máy mới → 201 kèm token; token dùng được với whoami', async () => {
      const res = await join(joinBody(setupCode)).expect(201);
      expect(res.body).toEqual({
        accessToken: expect.stringMatching(/^tld_[A-Za-z0-9_-]{43}$/),
        userId: expect.any(String),
        deviceId: expect.any(String),
        role: 'member',
        project: {
          id: projectId,
          name: 'TeamLens',
          slug: 'teamlens',
          repoPatterns: ['github.com/acme/app', 'gitlab.com/acme/*'],
        },
      });
      memberToken = res.body.accessToken;
      memberId = res.body.userId;

      const who = await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200);
      expect(who.body).toMatchObject({
        user: { id: memberId, email: null, name: 'Thành viên mới' },
        role: 'member',
        device: { id: res.body.deviceId, name: 'LAPTOP-01' },
        projects: [{ id: projectId }],
      });

      const [user] = await querySql<{
        email: string | null;
        password_hash: string | null;
        role: string;
      }>('SELECT email, password_hash, role FROM users WHERE id = $1', [
        memberId,
      ]);
      expect(user).toEqual({
        email: null,
        password_hash: null,
        role: 'member',
      });
      const [device] = await querySql<{
        token_hash: string;
        last_seen_at: Date | null;
      }>('SELECT token_hash, last_seen_at FROM devices WHERE id = $1', [
        res.body.deviceId,
      ]);
      expect(device.token_hash).toBe(sha256(memberToken));
      expect(device.last_seen_at).not.toBeNull();
      const consents = await querySql<{
        text_version: string;
        backfill: boolean;
        user_id: string;
      }>(
        'SELECT text_version, backfill, user_id FROM consents WHERE device_id = $1',
        [res.body.deviceId],
      );
      expect(consents).toEqual([
        {
          text_version: CONSENT_TEXT_VERSION,
          backfill: true,
          user_id: memberId,
        },
      ]);
      const [invite] = await querySql<{ used_count: number }>(
        'SELECT used_count FROM invites WHERE code_hash = $1',
        [sha256(setupCode)],
      );
      expect(invite.used_count).toBe(1);
      const audit = await querySql<{ actor_id: string; target_id: string }>(
        "SELECT actor_id, target_id FROM audit_log WHERE action = 'member.join'",
      );
      expect(audit).toEqual([
        { actor_id: memberId, target_id: `${projectId}:${memberId}` },
      ]);
    });

    it('join lại bằng token với project khác → 200 không token; cùng project → 200, không tăng lượt', async () => {
      const other = await leader
        .post('/api/v1/projects')
        .send({ name: 'Khác', slug: 'khac' })
        .expect(201);
      otherProjectId = other.body.id;
      const created = await leader
        .post(`/api/v1/projects/${otherProjectId}/invites`)
        .send({ maxUses: 5 })
        .expect(201);
      const code = created.body.code as string;

      const res = await join(
        joinBody(code, {
          consent: { textVersion: CONSENT_TEXT_VERSION, backfill: false },
        }),
        memberToken,
      ).expect(200);
      expect(res.body).not.toHaveProperty('accessToken');
      expect(res.body).toMatchObject({
        userId: memberId,
        role: 'member',
        project: { id: otherProjectId, slug: 'khac', repoPatterns: [] },
      });
      const again = await join(joinBody(code), memberToken).expect(200);
      expect(again.body.userId).toBe(memberId);

      const [invite] = await querySql<{ used_count: number }>(
        'SELECT used_count FROM invites WHERE code_hash = $1',
        [sha256(code)],
      );
      expect(invite.used_count).toBe(1);
      const [{ n: users }] = await querySql<{ n: number }>(
        'SELECT count(*)::int AS n FROM users',
      );
      expect(users).toBe(3); // leader, m, member mới
      const who = await request(server)
        .get('/agent/v1/whoami')
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200);
      expect(who.body.projects.map((p: { id: string }) => p.id).sort()).toEqual(
        [projectId, otherProjectId].sort(),
      );
    });

    it('Bearer sai → 401 invalid_token, không tạo gì', async () => {
      for (const auth of ['tld_gia', 'khong-phai-tld']) {
        const res = await join(joinBody(setupCode), auth).expect(401);
        expect(res.body.error).toBe('invalid_token');
      }
      const res = await request(server)
        .post('/agent/v1/join')
        .set('X-Forwarded-For', freshIp())
        .set('Authorization', 'Basic abc')
        .send(joinBody(setupCode))
        .expect(401);
      expect(res.body.error).toBe('invalid_token');
    });

    it('body sai → 400; tên chỉ có dấu cách → 400', async () => {
      for (const body of [
        joinBody(setupCode, { name: '   ' }),
        joinBody(setupCode, { consent: { textVersion: CONSENT_TEXT_VERSION } }),
        { code: setupCode },
      ]) {
        const res = await join(body).expect(400);
        expect(res.body.error).toBe('validation_error');
      }
    });

    it('consent khác phiên bản → 409 consent_outdated, không tạo user', async () => {
      const before = await querySql<{ n: number }>(
        'SELECT count(*)::int AS n FROM users',
      );
      const res = await join(
        joinBody(setupCode, {
          consent: { textVersion: '2000-01-01', backfill: false },
        }),
      ).expect(409);
      expect(res.body.error).toBe('consent_outdated');
      const after = await querySql<{ n: number }>(
        'SELECT count(*)::int AS n FROM users',
      );
      expect(after[0].n).toBe(before[0].n);
    });

    it('hết lượt → 410 invite_used_up', async () => {
      const created = await leader
        .post(`/api/v1/projects/${projectId}/invites`)
        .send({ maxUses: 1 })
        .expect(201);
      const code = created.body.code as string;
      await join(joinBody(code, { name: 'A' })).expect(201);
      const res = await join(joinBody(code, { name: 'B' })).expect(410);
      expect(res.body.error).toBe('invite_used_up');
      expect((await preview(code).expect(410)).body.error).toBe(
        'invite_used_up',
      );
      const list = await leader.get(`/api/v1/projects/${projectId}/invites`);
      const row = list.body.find(
        (i: { id: string }) => i.id === created.body.invite.id,
      );
      expect(row).toMatchObject({ status: 'used_up', usedCount: 1 });
    });

    it('hết hạn → 410 invite_expired', async () => {
      const created = await leader
        .post(`/api/v1/projects/${projectId}/invites`)
        .expect(201);
      await querySql(
        "UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1",
        [created.body.invite.id],
      );
      const code = created.body.code as string;
      expect((await preview(code).expect(410)).body.error).toBe(
        'invite_expired',
      );
      expect((await join(joinBody(code)).expect(410)).body.error).toBe(
        'invite_expired',
      );
    });

    it('thu hồi → 410 invite_revoked; thu hồi lại vẫn 204; id lạ → 404', async () => {
      const created = await leader
        .post(`/api/v1/projects/${projectId}/invites`)
        .expect(201);
      const id = created.body.invite.id as string;
      const code = created.body.code as string;
      await leader
        .delete(`/api/v1/projects/${projectId}/invites/${id}`)
        .expect(204);
      await leader
        .delete(`/api/v1/projects/${projectId}/invites/${id}`)
        .expect(204);
      // Link thuộc project khác thì không thu hồi qua project này được.
      await leader
        .delete(`/api/v1/projects/${otherProjectId}/invites/${id}`)
        .expect(404);
      await leader
        .delete(`/api/v1/projects/${projectId}/invites/khong-phai-uuid`)
        .expect(404);
      expect((await preview(code).expect(410)).body.error).toBe(
        'invite_revoked',
      );
      expect((await join(joinBody(code)).expect(410)).body.error).toBe(
        'invite_revoked',
      );
      const audit = await querySql<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'invite.revoke' AND target_id = $1",
        [id],
      );
      expect(audit[0].n).toBe(1);
    });

    it('quá 10 request/phút mỗi IP (preview + join tính chung) → 429 kèm Retry-After', async () => {
      const ip = '10.99.99.99';
      for (let i = 0; i < 5; i++) await preview(setupCode, ip).expect(200);
      for (let i = 0; i < 5; i++)
        await join(joinBody('khong-ton-tai-123'), undefined, ip).expect(404);
      const res = await preview(setupCode, ip).expect(429);
      expect(res.body.error).toBe('rate_limited');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      await join(joinBody(setupCode), undefined, ip).expect(429);
      // IP khác không bị ảnh hưởng.
      await preview(setupCode, '10.99.99.98').expect(200);
    });

    it('qua server web (loopback + X-Forwarded-For): hai người xem khác IP không chung hạn mức', async () => {
      // Server web chuyển IP thật của người xem; API tin header vì request tới từ loopback.
      for (let i = 0; i < 10; i++)
        await preview(setupCode, '203.0.113.7').expect(200);
      await preview(setupCode, '203.0.113.7').expect(429);
      await preview(setupCode, '198.51.100.2').expect(200);
    });

    it('phần đầu X-Forwarded-For do client tự ghi không giúp lách hạn mức', async () => {
      // Proxy tin cậy ghi IP thật ở cuối chuỗi; phần trước (IP công cộng, không tin cậy) bị bỏ qua.
      const real = '203.0.113.50';
      for (let i = 0; i < 10; i++)
        await preview(setupCode, `6.6.6.${i}, ${real}`).expect(200);
      await preview(setupCode, `7.7.7.7, ${real}`).expect(429);
    });
  });

  describe('tl open: web-login → auth/ticket', () => {
    const webLogin = (token = memberToken) =>
      request(server)
        .post('/agent/v1/web-login')
        .set('Authorization', `Bearer ${token}`);
    const ticketOf = (url: string) => new URL(url).searchParams.get('ticket')!;

    it('không có token → 401', async () => {
      await request(server).post('/agent/v1/web-login').expect(401);
    });

    it('đổi ticket lấy cookie; dùng lần 2 → 401 invalid_ticket', async () => {
      const res = await webLogin().expect(200);
      expect(res.body).toEqual({
        url: expect.stringMatching(/^https?:\/\/[^/]+\/auth\/cli\?ticket=/),
        expiresIn: 60,
      });
      const ticket = ticketOf(res.body.url);
      const [row] = await querySql<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM web_login_tickets',
      );
      expect(row).toEqual({ id: sha256(ticket), user_id: memberId });

      const browser = request.agent(server);
      const ok = await browser
        .post('/api/v1/auth/ticket')
        .send({ ticket })
        .expect(200);
      expect(ok.headers['set-cookie']?.[0]).toMatch(/^tl_session=.*HttpOnly/);
      expect(ok.body).toEqual({
        user: {
          id: memberId,
          email: null,
          name: 'Thành viên mới',
          role: 'member',
        },
      });
      const me = await browser.get('/api/v1/auth/me').expect(200);
      expect(me.body.user.id).toBe(memberId);

      const again = await request(server)
        .post('/api/v1/auth/ticket')
        .send({ ticket })
        .expect(401);
      expect(again.body.error).toBe('invalid_ticket');
    });

    it('ticket hết hạn hoặc sai → 401; user đã bị xóa → 401', async () => {
      const expired = ticketOf((await webLogin().expect(200)).body.url);
      await querySql(
        "UPDATE web_login_tickets SET expires_at = now() - interval '1 second' WHERE id = $1",
        [sha256(expired)],
      );
      for (const ticket of [expired, 'ticket-khong-ton-tai']) {
        const res = await request(server)
          .post('/api/v1/auth/ticket')
          .send({ ticket })
          .expect(401);
        expect(res.body.error).toBe('invalid_ticket');
      }
      await request(server)
        .post('/api/v1/auth/ticket')
        .send({ ticket: 'ngan' })
        .expect(400);

      const fresh = ticketOf((await webLogin().expect(200)).body.url);
      await querySql('UPDATE users SET deleted_at = now() WHERE id = $1', [
        memberId,
      ]);
      const res = await request(server)
        .post('/api/v1/auth/ticket')
        .send({ ticket: fresh })
        .expect(401);
      expect(res.body.error).toBe('invalid_ticket');
      await querySql('UPDATE users SET deleted_at = NULL WHERE id = $1', [
        memberId,
      ]);
    });
  });

  describe('ingest sau khi join', () => {
    it('thiết bị tạo bằng join đã có đồng ý → ingest không bị 403; rút đồng ý → 403', async () => {
      const require = createRequire(import.meta.url);
      const schemaPath =
        require.resolve('@teamlens/schema/session.v1.schema.json');
      const body = JSON.parse(
        readFileSync(
          schemaPath.replace(
            /session\.v1\.schema\.json$/,
            'examples/claude-code-simple.json',
          ),
          'utf8',
        ),
      ) as object;
      const send = () =>
        request(server)
          .post('/agent/v1/ingest')
          .set('Authorization', `Bearer ${memberToken}`)
          .send(body);
      await send().expect(202);
      await querySql(
        'UPDATE consents SET revoked_at = now() WHERE user_id = $1',
        [memberId],
      );
      const res = await send().expect(403);
      expect(res.body.error).toBe('consent_required');
    });
  });
});
