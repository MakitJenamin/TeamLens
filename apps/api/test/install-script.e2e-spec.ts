import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp, resetDatabase } from './helpers.js';

const CODE = 'Zm9vYmFyYmF6cXV4';

describe('GET /install.ps1 (M3.6, M5.2)', () => {
  let app: INestApplication<App>;
  let publicUrl: string;
  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    publicUrl = String(app.get(ConfigService).get('TEAMLENS_PUBLIC_URL'))
      .trim()
      .replace(/\/+$/, '');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('công khai, trả script PowerShell có link mời, không cache, không cần đăng nhập', async () => {
    const res = await request(app.getHttpServer())
      .get(`/install.ps1?code=${CODE}`)
      .expect(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`$link = '${publicUrl}/i/${CODE}'`);
    expect(res.text).toContain('& $tl join $link');
    expect(res.text).not.toMatch(/^\s*exit\b/m);
    // M5.2: base URL release lấy từ TEAMLENS_CLI_RELEASE_URL (mặc định GitHub Releases).
    const releaseUrl = String(
      app.get(ConfigService).get('TEAMLENS_CLI_RELEASE_URL'),
    );
    expect(releaseUrl).toMatch(/^https:\/\//);
    expect(res.text).toContain(`$releaseUrl = '${releaseUrl}'`);
    expect(res.text).toContain('Get-FileHash');
  });

  it('không kiểm tra link còn dùng được: mã hợp lệ về hình thức nhưng không tồn tại vẫn nhận script', async () => {
    await request(app.getHttpServer())
      .get('/install.ps1?code=KhongTonTai_0123456789')
      .expect(200);
  });

  it('thiếu hoặc sai định dạng mã thì 404 invite_not_found dạng JSON, không lộ script', async () => {
    const server = app.getHttpServer();
    const cases = [
      '/install.ps1',
      '/install.ps1?code=',
      '/install.ps1?code=ngan',
      `/install.ps1?code=${encodeURIComponent("abc'; Remove-Item -Recurse C:\\ #")}`,
      '/install.ps1?code=abc$(whoami)def',
      `/install.ps1?code=${'a'.repeat(101)}`,
      `/install.ps1?code=${CODE}&code=${CODE}`,
    ];
    for (const url of cases) {
      const res = await request(server).get(url).expect(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error).toBe('invite_not_found');
      expect(res.text).not.toContain('tl join');
    }
  });

  it('quá 10 request/phút từ cùng một IP thì 429 kèm Retry-After', async () => {
    const server = app.getHttpServer();
    let limited = null;
    for (let i = 0; i < 25 && !limited; i++) {
      const res = await request(server).get(`/install.ps1?code=${CODE}`);
      if (res.status === 429) limited = res;
    }
    expect(limited).not.toBeNull();
    expect(limited!.body.error).toBe('rate_limited');
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
