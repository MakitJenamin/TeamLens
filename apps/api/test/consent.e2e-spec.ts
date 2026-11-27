import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  CONSENT_TEXT,
  CONSENT_TEXT_VERSION,
} from '../src/modules/consent/consent-text.js';
import {
  createTestApp,
  grantConsent,
  insertDevice,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const require = createRequire(import.meta.url);

function example(name: string): object {
  const path = require.resolve('@teamlens/schema/session.v1.schema.json');
  const file = path.replace(/session\.v1\.schema\.json$/, `examples/${name}`);
  return JSON.parse(readFileSync(file, 'utf8')) as object;
}

describe('Đồng ý lại và rút đồng ý (M3.7)', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('xem văn bản và trạng thái, rút đồng ý, đồng ý lại, phiên bản cũ, validate và không ảnh hưởng thiết bị khác', async () => {
    const server = app.getHttpServer();
    const userId = await insertUser({
      email: 'member@teamlens.local',
      password: 'teamlens123',
      name: 'Member',
    });
    const a = await insertDevice(userId, 'PC-A');
    const b = await insertDevice(userId, 'PC-B');
    await grantConsent(a.token);
    await grantConsent(b.token);

    const get = (token: string) =>
      request(server).get('/agent/v1/consent').set('Authorization', `Bearer ${token}`);
    const post = (token: string, body: object) =>
      request(server)
        .post('/agent/v1/consent')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const ingest = (token: string) =>
      request(server)
        .post('/agent/v1/ingest')
        .set('Authorization', `Bearer ${token}`)
        .send(example('claude-code-simple.json'));
    const deviceStatus = async (id: string) =>
      (
        await querySql<{ status: string }>(
          'SELECT status FROM devices WHERE id = $1',
          [id],
        )
      )[0].status;
    const audit = async (action: string, id: string) =>
      (
        await querySql(
          'SELECT 1 FROM audit_log WHERE action = $1 AND target_id = $2',
          [action, id],
        )
      ).length;

    // Chưa đăng nhập hoặc token giả.
    await request(server).get('/agent/v1/consent').expect(401);
    await get('tld_gia').expect(401);

    // Trạng thái ban đầu: đã đồng ý bản hiện hành, kèm văn bản.
    const initial = (await get(a.token).expect(200)).body;
    expect(initial).toMatchObject({
      textVersion: CONSENT_TEXT_VERSION,
      text: CONSENT_TEXT,
      status: 'granted',
      acceptedVersion: CONSENT_TEXT_VERSION,
      backfill: false,
      revokedAt: null,
    });
    expect((await ingest(a.token)).status).not.toBe(403);

    // Rút đồng ý: thiết bị consent_revoked, mọi bản đồng ý đã rút, ingest bị từ chối.
    const revoked = (await post(a.token, { action: 'revoke' }).expect(200)).body;
    expect(revoked).toMatchObject({
      status: 'revoked',
      acceptedVersion: null,
      backfill: null,
      grantedAt: null,
      revokedAt: expect.any(String),
    });
    expect(await deviceStatus(a.id)).toBe('consent_revoked');
    expect(
      await querySql(
        'SELECT 1 FROM consents WHERE device_id = $1 AND revoked_at IS NULL',
        [a.id],
      ),
    ).toHaveLength(0);
    const refused = await ingest(a.token).expect(403);
    expect(refused.body.error).toBe('consent_required');
    expect(await audit('consent.revoke', a.id)).toBe(1);
    // Token vẫn dùng được và rút lần nữa không lỗi.
    expect((await get(a.token).expect(200)).body.status).toBe('revoked');
    await post(a.token, { action: 'revoke' }).expect(200);

    // Thiết bị khác của cùng người không bị ảnh hưởng.
    expect((await get(b.token).expect(200)).body.status).toBe('granted');
    expect(await deviceStatus(b.id)).not.toBe('consent_revoked');
    expect((await ingest(b.token)).status).not.toBe(403);

    // Đồng ý lại: phiên bản sai bị từ chối, đúng thì ghi và hết trạng thái đã rút.
    const stale = await post(a.token, {
      action: 'grant',
      textVersion: '2020-01-01',
      backfill: false,
    }).expect(409);
    expect(stale.body.error).toBe('consent_outdated');
    expect(await deviceStatus(a.id)).toBe('consent_revoked');
    const regranted = (
      await post(a.token, {
        action: 'grant',
        textVersion: CONSENT_TEXT_VERSION,
        backfill: true,
      }).expect(200)
    ).body;
    expect(regranted).toMatchObject({
      status: 'granted',
      acceptedVersion: CONSENT_TEXT_VERSION,
      backfill: true,
      revokedAt: null,
    });
    expect(await deviceStatus(a.id)).toBe('online');
    expect((await ingest(a.token)).status).not.toBe(403);
    expect(await audit('consent.grant', a.id)).toBe(1);

    // Đồng ý lại khi đã granted chỉ đổi lựa chọn backfill, không thêm dòng.
    const rowsBefore = await querySql(
      'SELECT 1 FROM consents WHERE device_id = $1 AND revoked_at IS NULL',
      [a.id],
    );
    const again = (
      await post(a.token, {
        action: 'grant',
        textVersion: CONSENT_TEXT_VERSION,
        backfill: false,
      }).expect(200)
    ).body;
    expect(again).toMatchObject({ status: 'granted', backfill: false });
    expect(
      await querySql(
        'SELECT 1 FROM consents WHERE device_id = $1 AND revoked_at IS NULL',
        [a.id],
      ),
    ).toHaveLength(rowsBefore.length);

    // Văn bản đổi phiên bản: bản cũ chưa rút thành outdated, ingest từ chối, đồng ý lại thì granted.
    const c = await insertDevice(userId, 'PC-C');
    await querySql(
      `INSERT INTO consents (user_id, device_id, text_version, backfill) VALUES ($1, $2, '2020-01-01', true)`,
      [userId, c.id],
    );
    expect((await get(c.token).expect(200)).body).toMatchObject({
      status: 'outdated',
      acceptedVersion: '2020-01-01',
      backfill: true,
    });
    expect((await ingest(c.token).expect(403)).body.error).toBe(
      'consent_required',
    );
    expect(
      (
        await post(c.token, {
          action: 'grant',
          textVersion: CONSENT_TEXT_VERSION,
          backfill: true,
        }).expect(200)
      ).body.status,
    ).toBe('granted');

    // Thiết bị chưa từng có bản đồng ý: none; rút xong thì revoked.
    const d = await insertDevice(userId, 'PC-D');
    expect((await get(d.token).expect(200)).body.status).toBe('none');
    expect((await post(d.token, { action: 'revoke' }).expect(200)).body.status).toBe(
      'revoked',
    );

    // Body sai: 400 validation_error.
    for (const bad of [
      {},
      { action: 'delete' },
      { action: 'grant' },
      { action: 'grant', textVersion: CONSENT_TEXT_VERSION },
      { action: 'grant', textVersion: '', backfill: false },
      { action: 'grant', textVersion: CONSENT_TEXT_VERSION, backfill: 'yes' },
      { action: 'revoke', extra: 1 },
    ]) {
      const res = await post(a.token, bad).expect(400);
      expect(res.body.error).toBe('validation_error');
    }
  });
});
