import {
  INVITE_CODE_RE,
  inviteLinks,
  inviteStatus,
  unusableInviteError,
} from './invite-status.js';

const now = new Date('2026-11-27T10:00:00Z');
const future = new Date('2026-12-01T00:00:00Z');
const past = new Date('2026-11-20T00:00:00Z');
const base = {
  revokedAt: null,
  expiresAt: future,
  maxUses: null,
  usedCount: 0,
};

describe('inviteStatus', () => {
  it('còn hạn, không giới hạn lượt → active', () => {
    expect(inviteStatus({ ...base, usedCount: 500 }, now)).toBe('active');
  });

  it('còn lượt → active; dùng đủ lượt → used_up', () => {
    expect(inviteStatus({ ...base, maxUses: 2, usedCount: 1 }, now)).toBe(
      'active',
    );
    expect(inviteStatus({ ...base, maxUses: 2, usedCount: 2 }, now)).toBe(
      'used_up',
    );
  });

  it('hết hạn (kể cả đúng thời điểm hết hạn) → expired, ưu tiên hơn hết lượt', () => {
    expect(inviteStatus({ ...base, expiresAt: past }, now)).toBe('expired');
    expect(inviteStatus({ ...base, expiresAt: now }, now)).toBe('expired');
    expect(
      inviteStatus({ ...base, expiresAt: past, maxUses: 1, usedCount: 1 }, now),
    ).toBe('expired');
  });

  it('thu hồi ưu tiên nhất', () => {
    expect(
      inviteStatus(
        { revokedAt: past, expiresAt: past, maxUses: 1, usedCount: 1 },
        now,
      ),
    ).toBe('revoked');
  });
});

describe('unusableInviteError', () => {
  it('map trạng thái sang mã lỗi 410', () => {
    expect(unusableInviteError('active')).toBeNull();
    for (const [status, code] of [
      ['expired', 'invite_expired'],
      ['used_up', 'invite_used_up'],
      ['revoked', 'invite_revoked'],
    ] as const) {
      const error = unusableInviteError(status);
      expect(error?.getStatus()).toBe(410);
      expect(error?.getResponse()).toMatchObject({ error: code });
    }
  });
});

describe('INVITE_CODE_RE', () => {
  it('chỉ nhận base64url 10–100 ký tự', () => {
    expect(INVITE_CODE_RE.test('abcDEF_-0123')).toBe(true);
    expect(INVITE_CODE_RE.test('short')).toBe(false);
    expect(INVITE_CODE_RE.test('có dấu cách 123')).toBe(false);
    expect(INVITE_CODE_RE.test('a'.repeat(101))).toBe(false);
    expect(INVITE_CODE_RE.test('../../etc/passwd')).toBe(false);
  });
});

describe('inviteLinks', () => {
  it('ghép link mời và câu lệnh cài', () => {
    expect(inviteLinks('https://tl.example.com', 'abc')).toEqual({
      url: 'https://tl.example.com/i/abc',
      installCommand: 'irm https://tl.example.com/install.ps1?code=abc | iex',
    });
  });
});
