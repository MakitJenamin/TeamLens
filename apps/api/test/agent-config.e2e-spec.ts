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

const PASSWORD = 'teamlens123';

describe('GET /agent/v1/config (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let memberToken: string;
  let loneToken: string;
  let acmeId: string;
  let shopId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();

    await request(server)
      .post('/api/v1/setup')
      .send({
        email: 'leader@teamlens.local',
        name: 'Leader',
        password: PASSWORD,
      })
      .expect(201);
    const leader = request.agent(server);
    await leader
      .post('/api/v1/auth/login')
      .send({ email: 'leader@teamlens.local', password: PASSWORD })
      .expect(200);

    const memberId = await insertUser({ email: null, name: 'Thành viên' });
    const loneId = await insertUser({ email: null, name: 'Chưa vào project' });
    acmeId = (
      await leader
        .post('/api/v1/projects')
        .send({ name: 'Acme', slug: 'acme' })
        .expect(201)
    ).body.id;
    shopId = (
      await leader
        .post('/api/v1/projects')
        .send({ name: 'Shop', slug: 'shop' })
        .expect(201)
    ).body.id;
    const otherId = (
      await leader
        .post('/api/v1/projects')
        .send({ name: 'Khác', slug: 'khac' })
        .expect(201)
    ).body.id;
    for (const [projectId, pattern] of [
      [acmeId, 'github.com/acme/*'],
      [shopId, 'github.com/acme/shop-web'],
      [otherId, 'github.com/secret/*'],
    ]) {
      await leader
        .post(`/api/v1/projects/${projectId}/repos`)
        .send({ remotePattern: pattern })
        .expect(201);
    }
    for (const projectId of [acmeId, shopId]) {
      await leader
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: memberId })
        .expect(201);
    }
    memberToken = (await insertDevice(memberId, 'PC')).token;
    loneToken = (await insertDevice(loneId, 'PC')).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  const getConfig = (token: string) =>
    request(server)
      .get('/agent/v1/config')
      .set('Authorization', `Bearer ${token}`);

  it('thiếu hoặc sai token → 401 invalid_token', async () => {
    const missing = await request(server).get('/agent/v1/config').expect(401);
    expect(missing.body.error).toBe('invalid_token');
    const wrong = await getConfig('tld_sai').expect(401);
    expect(wrong.body.error).toBe('invalid_token');
  });

  it('chưa có setting → mặc định; chỉ repo của project mình là thành viên', async () => {
    const res = await getConfig(memberToken).expect(200);
    expect(res.body).toEqual({
      repo_patterns: [
        { project_id: acmeId, pattern: 'github.com/acme/*' },
        { project_id: shopId, pattern: 'github.com/acme/shop-web' },
      ],
      redaction_patterns: [],
      truncation: {
        tool_input_bytes: 4096,
        output_head_bytes: 2048,
        output_tail_bytes: 1024,
        diff_bytes: 262144,
        thinking_bytes: 8192,
      },
      consent_text_version: CONSENT_TEXT_VERSION,
      min_cli_version: process.env.MIN_CLI_VERSION ?? '0.1.0',
    });
  });

  it('user chưa vào project nào → repo_patterns rỗng', async () => {
    const res = await getConfig(loneToken).expect(200);
    expect(res.body.repo_patterns).toEqual([]);
  });

  it('đọc redaction_patterns và truncation từ bảng settings', async () => {
    await querySql(
      `INSERT INTO settings (key, value) VALUES
         ('redaction_patterns', $1::jsonb),
         ('truncation', $2::jsonb)`,
      [
        JSON.stringify([
          { id: 'acme_internal_token', regex: 'acme_[A-Za-z0-9]{32}' },
          { id: 'thiếu regex' },
        ]),
        JSON.stringify({ tool_input_bytes: 1000, diff_bytes: -5 }),
      ],
    );
    const res = await getConfig(memberToken).expect(200);
    expect(res.body.redaction_patterns).toEqual([
      { id: 'acme_internal_token', regex: 'acme_[A-Za-z0-9]{32}' },
    ]);
    expect(res.body.truncation).toEqual({
      tool_input_bytes: 1000,
      output_head_bytes: 2048,
      output_tail_bytes: 1024,
      diff_bytes: 262144,
      thinking_bytes: 8192,
    });
  });
});
