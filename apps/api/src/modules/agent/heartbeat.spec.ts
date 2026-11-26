import {
  DEVICE_OFFLINE_AFTER_MS,
  effectiveDeviceStatus,
  HEARTBEAT_LIMIT_PER_MINUTE,
  HeartbeatRateLimiter,
  heartbeatSchema,
} from './heartbeat.js';

const validBody = {
  status: 'online',
  cli_version: '0.1.0',
  agents: [
    { agent: 'claude_code', version: '2.1.3', files: 12 },
    { agent: 'codex', version: null, files: 0 },
  ],
  parse_errors: 1,
  queue: { batches: 2, bytes: 48213, dropped: 0, failed: 0 },
  sent_at: '2026-11-27T08:15:00Z',
};

describe('heartbeatSchema', () => {
  it('nhận body đúng contract, kể cả sent_at có offset', () => {
    expect(heartbeatSchema.safeParse(validBody).success).toBe(true);
    expect(
      heartbeatSchema.safeParse({
        ...validBody,
        status: 'paused',
        sent_at: '2026-11-27T15:15:00.123+07:00',
      }).success,
    ).toBe(true);
  });

  it('từ chối status lạ, số âm, agent lạ, trường thừa', () => {
    for (const bad of [
      { ...validBody, status: 'offline' },
      { ...validBody, status: 'consent_revoked' },
      { ...validBody, parse_errors: -1 },
      { ...validBody, agents: [{ agent: 'cursor', version: null, files: 1 }] },
      { ...validBody, queue: { ...validBody.queue, extra: 1 } },
      { ...validBody, extra: true },
      { ...validBody, sent_at: 'hôm qua' },
      { ...validBody, cli_version: '' },
    ]) {
      expect(heartbeatSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('effectiveDeviceStatus', () => {
  const now = new Date('2026-11-27T10:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('chưa từng heartbeat → offline', () => {
    expect(effectiveDeviceStatus('online', null, now)).toBe('offline');
  });

  it('heartbeat trong 30 phút → giữ status', () => {
    expect(effectiveDeviceStatus('online', ago(60_000), now)).toBe('online');
    expect(
      effectiveDeviceStatus('paused', ago(DEVICE_OFFLINE_AFTER_MS), now),
    ).toBe('paused');
  });

  it('quá 30 phút → offline, trừ consent_revoked', () => {
    const old = ago(DEVICE_OFFLINE_AFTER_MS + 1);
    expect(effectiveDeviceStatus('online', old, now)).toBe('offline');
    expect(effectiveDeviceStatus('paused', old, now)).toBe('offline');
    expect(effectiveDeviceStatus('consent_revoked', old, now)).toBe(
      'consent_revoked',
    );
    expect(effectiveDeviceStatus('consent_revoked', null, now)).toBe(
      'consent_revoked',
    );
  });
});

describe('HeartbeatRateLimiter', () => {
  it('cho 20 request/phút rồi trả số giây chờ', () => {
    let now = 0;
    const limiter = new HeartbeatRateLimiter(() => now);
    for (let i = 0; i < HEARTBEAT_LIMIT_PER_MINUTE; i++) {
      expect(limiter.hit('d1')).toBeNull();
    }
    expect(limiter.hit('d1')).toBe(60);
    expect(limiter.hit('d2')).toBeNull();
    now = 60_000;
    expect(limiter.hit('d1')).toBeNull();
  });
});
