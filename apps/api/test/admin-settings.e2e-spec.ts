import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
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

describe('Cài đặt server M4.6', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('chỉ leader sửa; pattern, retention và văn bản đồng ý có hiệu lực với CLI', async () => {
    const server = app.getHttpServer();
    const leader = request.agent(server);
    await leader
      .post('/api/v1/setup')
      .send({
        email: 'leader@example.test',
        password: 'teamlens123',
        name: 'Leader',
      })
      .expect(201);
    await leader
      .post('/api/v1/auth/login')
      .send({ email: 'leader@example.test', password: 'teamlens123' })
      .expect(200);
    const memberId = await insertUser({
      email: 'member@example.test',
      password: 'teamlens123',
      name: 'Member',
    });
    const member = request.agent(server);
    await member
      .post('/api/v1/auth/login')
      .send({ email: 'member@example.test', password: 'teamlens123' })
      .expect(200);
    const device = await insertDevice(memberId, 'May A');
    await grantConsent(device.token);
    const bearer = { Authorization: `Bearer ${device.token}` };

    // Member không đọc hay sửa được.
    await member.get('/api/v1/admin/settings').expect(403);
    await member
      .patch('/api/v1/admin/settings')
      .send({ retentionDays: 30, expectedRetentionVersion: '0' })
      .expect(403);
    await member
      .post('/api/v1/admin/settings/redaction-test')
      .send({ id: 'acme', regex: 'a', sample: 'a' })
      .expect(403);

    // Mặc định.
    const initial = (await leader.get('/api/v1/admin/settings').expect(200))
      .body;
    expect(initial).toMatchObject({
      redactionPatterns: [],
      redactionPatternsVersion: '0',
      retentionDays: 90,
      retentionVersion: '0',
      affectedDevices: 1,
    });
    const version: string = initial.consentText.version;
    const rv = { expectedRedactionPatternsVersion: '0' };

    // Thiếu phiên bản đã đọc thì 400.
    await leader
      .patch('/api/v1/admin/settings')
      .send({ redactionPatterns: [] })
      .expect(400);
    // Id CLI bỏ qua (`_`) hoặc đổi nhãn (`_acme`) bị từ chối.
    for (const id of ['_', '_acme', 'acme_', 'Acme']) {
      await leader
        .patch('/api/v1/admin/settings')
        .send({
          ...rv,
          redactionPatterns: [{ id, name: 'X', regex: 'ACME-\\d+' }],
        })
        .expect(400);
    }
    // Pattern khớp mọi thứ bị từ chối, cả khi lưu lẫn khi thử.
    for (const regex of ['.+', '.*', '[\\s\\S]+', '\\w+']) {
      const broad = await leader
        .patch('/api/v1/admin/settings')
        .send({ ...rv, redactionPatterns: [{ id: 'all', name: 'X', regex }] })
        .expect(400);
      expect(broad.body.error).toBe('pattern_too_broad');
    }
    expect(
      (
        await leader
          .post('/api/v1/admin/settings/redaction-test')
          .send({ id: 'all', regex: '.+', sample: 'abc' })
          .expect(400)
      ).body.error,
    ).toBe('pattern_too_broad');

    // Pattern: cú pháp Rust, lookaround của Node bị từ chối.
    const bad = await leader
      .patch('/api/v1/admin/settings')
      .send({
        ...rv,
        redactionPatterns: [{ id: 'bad', name: 'Xấu', regex: '(?<=a)b' }],
      })
      .expect(400);
    expect(bad.body.error).toBe('pattern_invalid');
    await leader
      .patch('/api/v1/admin/settings')
      .send({
        ...rv,
        redactionPatterns: [
          { id: 'dup', name: 'A', regex: 'a' },
          { id: 'dup', name: 'B', regex: 'b' },
        ],
      })
      .expect(400);
    const tried = await leader
      .post('/api/v1/admin/settings/redaction-test')
      .send({ id: 'acme', regex: 'ACME-\\d+', sample: 'khoa ACME-42 het' })
      .expect(200);
    expect(tried.body).toEqual({
      matches: 1,
      redacted: 'khoa [REDACTED:acme] het',
    });
    // Như CLI: group `secret` không tham gia thì che cả chuỗi khớp; khớp rỗng bỏ qua.
    expect(
      (
        await leader
          .post('/api/v1/admin/settings/redaction-test')
          .send({
            id: 'k',
            regex: 'KEY-(?P<secret>\\d+)|TOK-[A-Z]+|\\d*',
            sample: 'KEY-12 TOK-AB x',
          })
          .expect(200)
      ).body,
    ).toEqual({ matches: 2, redacted: 'KEY-[REDACTED:k] [REDACTED:k] x' });
    const saved = await leader
      .patch('/api/v1/admin/settings')
      .send({
        ...rv,
        redactionPatterns: [
          {
            id: 'acme',
            name: 'Khóa ACME',
            description: 'nội bộ',
            regex: 'ACME-\\d+',
          },
        ],
      })
      .expect(200);
    expect(saved.body.consentText.version).toBe(version);
    expect(saved.body.redactionPatternsVersion).not.toBe('0');
    // Tab thứ hai còn giữ phiên bản cũ: 409, không ghi đè.
    const stale = await leader
      .patch('/api/v1/admin/settings')
      .send({ ...rv, redactionPatterns: [] })
      .expect(409);
    expect(stale.body.error).toBe('redaction_patterns_conflict');
    const config = (
      await request(server).get('/agent/v1/config').set(bearer).expect(200)
    ).body;
    expect(config.redaction_patterns).toEqual([
      { id: 'acme', regex: 'ACME-\\d+' },
    ]);
    expect(config.consent_text_version).toBe(version);

    // Retention: 7–730 hoặc vô hạn; không đổi phiên bản đồng ý.
    await leader
      .patch('/api/v1/admin/settings')
      .send({ retentionDays: 5, expectedRetentionVersion: '0' })
      .expect(400);
    await leader
      .patch('/api/v1/admin/settings')
      .send({ retentionDays: 30 })
      .expect(400);
    const forever = (
      await leader
        .patch('/api/v1/admin/settings')
        .send({ retentionDays: null, expectedRetentionVersion: '0' })
        .expect(200)
    ).body;
    expect(forever.retentionDays).toBeNull();
    // Hai tab cùng lưu lần đầu (phiên bản '0'): tab sau nhận 409.
    expect(
      (
        await leader
          .patch('/api/v1/admin/settings')
          .send({ retentionDays: 30, expectedRetentionVersion: '0' })
          .expect(409)
      ).body.error,
    ).toBe('retention_conflict');
    const year = (
      await leader
        .patch('/api/v1/admin/settings')
        .send({
          retentionDays: 365,
          expectedRetentionVersion: forever.retentionVersion,
        })
        .expect(200)
    ).body;
    expect(year.retentionDays).toBe(365);
    await leader
      .patch('/api/v1/admin/settings')
      .send({
        retentionDays: 30,
        expectedRetentionVersion: forever.retentionVersion,
      })
      .expect(409);
    // 409 rollback cả request: pattern gửi kèm cũng không được lưu.
    await leader
      .patch('/api/v1/admin/settings')
      .send({
        redactionPatterns: [],
        expectedRedactionPatternsVersion: year.redactionPatternsVersion,
        retentionDays: 30,
        expectedRetentionVersion: forever.retentionVersion,
      })
      .expect(409);
    expect(
      (await leader.get('/api/v1/admin/settings').expect(200)).body
        .redactionPatterns,
    ).toHaveLength(1);

    // Văn bản đồng ý: cần phiên bản form đã tải; nội dung không đổi thì không tăng phiên bản.
    await leader
      .patch('/api/v1/admin/settings')
      .send({ consentText: 'x' })
      .expect(400);
    await leader
      .patch('/api/v1/admin/settings')
      .send({ consentText: 'x', expectedConsentVersion: 'cu' })
      .expect(409);
    const same = await leader
      .patch('/api/v1/admin/settings')
      .send({
        consentText: initial.consentText.text,
        expectedConsentVersion: version,
      })
      .expect(200);
    expect(same.body.consentText.version).toBe(version);

    const edited = (
      await leader
        .patch('/api/v1/admin/settings')
        .send({ consentText: 'Văn bản mới', expectedConsentVersion: version })
        .expect(200)
    ).body;
    expect(edited.consentText.version).not.toBe(version);
    expect(edited.consentText.text).toBe('Văn bản mới');
    expect(edited.affectedDevices).toBe(0);

    // CLI cũ: config trả phiên bản mới, ingest bị chặn tới khi đồng ý lại.
    expect(
      (await request(server).get('/agent/v1/config').set(bearer).expect(200))
        .body.consent_text_version,
    ).toBe(edited.consentText.version);
    const blocked = await request(server)
      .post('/agent/v1/ingest')
      .set(bearer)
      .send(example('claude-code-simple.json'))
      .expect(403);
    expect(blocked.body.error).toBe('consent_required');
    await request(server)
      .post('/agent/v1/consent')
      .set(bearer)
      .send({
        action: 'grant',
        textVersion: edited.consentText.version,
        backfill: false,
      })
      .expect(200);
    await request(server)
      .post('/agent/v1/ingest')
      .set(bearer)
      .send(example('claude-code-simple.json'))
      .expect(202);

    // Audit: chỉ số lượng/ID/phiên bản, không có regex hay nội dung văn bản.
    const audit = await querySql<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM audit_log WHERE action LIKE 'settings.%' ORDER BY at`,
    );
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'settings.redaction_patterns.update',
        'settings.retention.update',
        'settings.consent_text.update',
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain('ACME-');
    expect(JSON.stringify(audit)).not.toContain('Văn bản mới');
  });
});
