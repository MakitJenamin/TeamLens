import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { IngestBatch } from '@teamlens/schema';
import {
  IngestBodyError,
  parseIngestJson,
  readIngestBody,
} from './ingest-body.js';
import {
  unsupportedSchemaVersion,
  validateIngestBatch,
} from './ingest-validator.js';
import { semanticError } from './ingest.service.js';
import { IngestRateLimiter } from './rate-limiter.js';
import { matchProject, normalizeRepoRemote } from './repo-match.js';

const require = createRequire(import.meta.url);
const schemaPath = require.resolve('@teamlens/schema/session.v1.schema.json');
const example = (name: string) =>
  JSON.parse(
    readFileSync(
      schemaPath.replace(/session\.v1\.schema\.json$/, `examples/${name}`),
      'utf8',
    ),
  ) as IngestBatch;

function fakeRequest(
  body: Buffer,
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

describe('matchProject', () => {
  const patterns = [
    { projectId: 'wild', remotePattern: 'github.com/acme/*' },
    { projectId: 'exact', remotePattern: 'github.com/acme/shop-web' },
    { projectId: 'wild2', remotePattern: 'github.com/acme/*' },
  ];

  it('pattern cụ thể thắng wildcard dù đứng sau', () => {
    expect(matchProject('github.com/acme/shop-web', patterns)).toBe('exact');
  });

  it('wildcard: lấy pattern đứng trước', () => {
    expect(matchProject('github.com/acme/other', patterns)).toBe('wild');
  });

  it('không khớp org khác, tiền tố giống, hay subgroup', () => {
    expect(matchProject('github.com/acme2/x', patterns)).toBeNull();
    expect(matchProject('github.com/acme', patterns)).toBeNull();
    expect(matchProject('github.com/acme/sub/repo', patterns)).toBeNull();
  });
});

describe('normalizeRepoRemote', () => {
  it('chuẩn hóa dạng URL và scp', () => {
    expect(normalizeRepoRemote('https://GitHub.com/Acme/Shop.git')).toBe(
      'github.com/acme/shop',
    );
    expect(normalizeRepoRemote('git@github.com:acme/shop.git')).toBe(
      'github.com/acme/shop',
    );
  });

  it('subgroup chỉ hạ chữ thường', () => {
    expect(normalizeRepoRemote('gitlab.com/A/b/c.git/')).toBe(
      'gitlab.com/a/b/c',
    );
  });
});

describe('validateIngestBatch', () => {
  it.each([
    'claude-code-simple.json',
    'claude-code-subagent.json',
    'codex-session.json',
  ])('file mẫu %s hợp lệ', (name) => {
    expect(validateIngestBatch(example(name)).ok).toBe(true);
  });

  it('báo đường dẫn lỗi nhưng không in giá trị', () => {
    const batch = example('claude-code-simple.json');
    (batch.sessions[0].turns[0] as { text?: unknown }).text = 12345678;
    const result = validateIngestBatch(batch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('/sessions/0/turns/0/text');
      expect(result.message).not.toContain('12345678');
    }
  });
});

describe('unsupportedSchemaVersion', () => {
  it('chỉ trả về số nguyên khác 1', () => {
    expect(unsupportedSchemaVersion({ schema_version: 1 })).toBeNull();
    expect(unsupportedSchemaVersion({ schema_version: 2 })).toBe(2);
    expect(unsupportedSchemaVersion({ schema_version: '2' })).toBeNull();
    expect(unsupportedSchemaVersion({})).toBeNull();
    expect(unsupportedSchemaVersion(null)).toBeNull();
  });
});

describe('semanticError', () => {
  it('seq trùng, ended_at trước started_at, tự làm cha', () => {
    const env = example('claude-code-simple.json').sessions[0];
    expect(semanticError(env)).toBeNull();
    expect(
      semanticError({ ...env, turns: [env.turns[0], env.turns[0]] }),
    ).toMatch(/seq/);
    expect(
      semanticError({
        ...env,
        session: { ...env.session, ended_at: '2000-01-01T00:00:00Z' },
      }),
    ).toMatch(/ended_at/);
    expect(
      semanticError({
        ...env,
        session: { ...env.session, parent_source_id: env.session.source_id },
      }),
    ).toMatch(/parent_source_id/);
  });
});

describe('readIngestBody', () => {
  it('đọc body thường và gzip', async () => {
    const json = Buffer.from('{"a":1}');
    expect(await readIngestBody(fakeRequest(json))).toEqual(json);
    expect(
      await readIngestBody(
        fakeRequest(gzipSync(json), { 'content-encoding': 'gzip' }),
      ),
    ).toEqual(json);
  });

  it('vượt giới hạn sau giải nén → 413', async () => {
    const bomb = gzipSync(Buffer.alloc(5000, 0x20));
    await expect(
      readIngestBody(fakeRequest(bomb, { 'content-encoding': 'gzip' }), 1000),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('Content-Length khai báo vượt giới hạn → 413 không cần đọc', async () => {
    await expect(
      readIngestBody(
        fakeRequest(Buffer.from('{}'), { 'content-length': '2000' }),
        1000,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('gzip hỏng → 400, encoding lạ → 415', async () => {
    await expect(
      readIngestBody(
        fakeRequest(Buffer.from('xx'), { 'content-encoding': 'gzip' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readIngestBody(
        fakeRequest(Buffer.from('{}'), { 'content-encoding': 'br' }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('JSON hỏng → IngestBodyError 400', () => {
    expect(() => parseIngestJson(Buffer.from('{'))).toThrow(IngestBodyError);
  });
});

describe('IngestRateLimiter', () => {
  it('60 request/phút mỗi thiết bị, sang phút mới thì đếm lại', () => {
    let now = 0;
    const limiter = new IngestRateLimiter(() => now);
    for (let i = 0; i < 60; i++) expect(limiter.hit('d1')).toBeNull();
    expect(limiter.hit('d1')).toBe(60);
    expect(limiter.hit('d2')).toBeNull();
    now = 30_000;
    expect(limiter.hit('d1')).toBe(30);
    now = 60_000;
    expect(limiter.hit('d1')).toBeNull();
  });
});
