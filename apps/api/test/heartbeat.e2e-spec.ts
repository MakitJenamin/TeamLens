import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { CONSENT_TEXT_VERSION } from '../src/modules/consent/consent-text.js';
import {
  createTestApp,
  insertDevice,
  insertUser,
  querySql,
  resetDatabase,
} from './helpers.js';

const body = (status: 'online' | 'paused') => ({
  status,
  cli_version: '0.2.0',
  agents: [{ agent: 'claude_code', version: '2.1.3', files: 12 }],
  parse_errors: 3,
  queue: { batches: 1, bytes: 1024, dropped: 0, failed: 0 },
  sent_at: '2026-11-27T08:15:00Z',
});

describe('POST /agent/v1/heartbeat (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let token: string;
  let deviceId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();
    const userId = await insertUser({ email: null, name: 'Thành viên' });
    ({ id: deviceId, token } = await insertDevice(userId, 'PC'));
  });

  afterAll(async () => {
    await app.close();
  });

  const device = async () =>
    (
      await querySql<{
        status: string;
        cli_version: string;
        last_seen_at: Date | null;
        last_heartbeat: Record<string, unknown> | null;
      }>(
        'SELECT status, cli_version, last_seen_at, last_heartbeat FROM devices WHERE id = $1',
        [deviceId],
      )
    )[0];

  it('online: ghi last_seen_at, cli_version, status và số liệu', async () => {
    expect((await device()).last_seen_at).toBeNull();
    const res = await request(server)
      .post('/agent/v1/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(body('online'))
      .expect(200);
    expect(res.body).toEqual({
      status: 'online',
      consent_text_version: CONSENT_TEXT_VERSION,
      min_cli_version: expect.any(String),
    });
    const row = await device();
    expect(row.status).toBe('online');
    expect(row.cli_version).toBe('0.2.0');
    expect(row.last_seen_at).not.toBeNull();
    expect(row.last_heartbeat).toEqual({
      agents: [{ agent: 'claude_code', version: '2.1.3', files: 12 }],
      parse_errors: 3,
      queue: { batches: 1, bytes: 1024, dropped: 0, failed: 0 },
      sent_at: '2026-11-27T08:15:00Z',
    });
  });

  it('paused rồi online đổi devices.status', async () => {
    await request(server)
      .post('/agent/v1/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(body('paused'))
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('paused'));
    expect((await device()).status).toBe('paused');
    await request(server)
      .post('/agent/v1/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(body('online'))
      .expect(200);
    expect((await device()).status).toBe('online');
  });

  it('không ghi đè consent_revoked nhưng vẫn cập nhật last_seen_at', async () => {
    await querySql(
      `UPDATE devices SET status = 'consent_revoked', last_seen_at = now() - interval '1 hour' WHERE id = $1`,
      [deviceId],
    );
    const before = (await device()).last_seen_at!;
    const res = await request(server)
      .post('/agent/v1/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send(body('online'))
      .expect(200);
    expect(res.body.status).toBe('consent_revoked');
    const row = await device();
    expect(row.status).toBe('consent_revoked');
    expect(row.last_seen_at!.getTime()).toBeGreaterThan(before.getTime());
    await querySql(`UPDATE devices SET status = 'online' WHERE id = $1`, [
      deviceId,
    ]);
  });

  it('body sai → 400 validation_error; thiếu token → 401', async () => {
    const res = await request(server)
      .post('/agent/v1/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...body('online'), status: 'offline' })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
    await request(server)
      .post('/agent/v1/heartbeat')
      .send(body('online'))
      .expect(401);
  });

  it('quá 20 request/phút → 429 rate_limited kèm Retry-After', async () => {
    let last: request.Response | undefined;
    for (let i = 0; i < 25; i++) {
      last = await request(server)
        .post('/agent/v1/heartbeat')
        .set('Authorization', `Bearer ${token}`)
        .send(body('online'));
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error).toBe('rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
