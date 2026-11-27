import {
  buildMemberStatus,
  type DeviceRow,
  type MemberRow,
} from './member-status.js';

const now = new Date('2026-11-27T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

const member = (
  userId: string,
  joinedDaysAgo: number,
  name = userId,
): MemberRow => ({
  userId,
  name,
  email: null,
  role: 'member',
  joinedAt: daysAgo(joinedDaysAgo),
  lastSessionAt: null,
});

const device = (
  id: string,
  userId: string,
  patch: Partial<DeviceRow> = {},
): DeviceRow => ({
  id,
  userId,
  name: id,
  os: 'windows',
  cliVersion: '0.1.0',
  status: 'online',
  lastSeenAt: minutesAgo(5),
  createdAt: daysAgo(10),
  revokedAt: null,
  ...patch,
});

describe('buildMemberStatus', () => {
  it('áp trạng thái hiệu lực cho từng thiết bị', () => {
    const [row] = buildMemberStatus(
      [member('u1', 1)],
      [
        device('online', 'u1'),
        device('stale', 'u1', { lastSeenAt: minutesAgo(31) }),
        device('never', 'u1', { lastSeenAt: null }),
        device('paused', 'u1', { status: 'paused', lastSeenAt: minutesAgo(1) }),
        device('paused-old', 'u1', {
          status: 'paused',
          lastSeenAt: daysAgo(3),
        }),
        device('revoked-consent', 'u1', {
          status: 'consent_revoked',
          lastSeenAt: daysAgo(3),
        }),
      ],
      now,
    );
    const status = Object.fromEntries(row.devices.map((d) => [d.id, d.status]));
    expect(status).toEqual({
      online: 'online',
      stale: 'offline',
      never: 'offline',
      paused: 'paused',
      'paused-old': 'offline',
      'revoked-consent': 'consent_revoked',
    });
    expect(row.devices[0]).not.toHaveProperty('userId');
  });

  it('sắp thành viên mới tham gia trước, thiết bị chưa thu hồi trước rồi theo lastSeenAt', () => {
    const items = buildMemberStatus(
      [member('old', 30), member('new', 1), member('mid', 5)],
      [
        device('a-revoked', 'new', {
          revokedAt: daysAgo(1),
          lastSeenAt: minutesAgo(1),
        }),
        device('a-never', 'new', { lastSeenAt: null }),
        device('a-recent', 'new', { lastSeenAt: minutesAgo(2) }),
        device('a-older', 'new', { lastSeenAt: daysAgo(2) }),
        device('c1', 'old'),
      ],
      now,
    );
    expect(items.map((m) => m.userId)).toEqual(['new', 'mid', 'old']);
    expect(items[0].devices.map((d) => d.id)).toEqual([
      'a-recent',
      'a-older',
      'a-never',
      'a-revoked',
    ]);
    expect(items[1].devices).toEqual([]);
    expect(items[2].devices.map((d) => d.id)).toEqual(['c1']);
  });

  it('giữ nguyên joinedAt, lastSessionAt và không đụng tới thiết bị của người ngoài danh sách', () => {
    const last = daysAgo(2);
    const [row, ...rest] = buildMemberStatus(
      [{ ...member('u1', 3), lastSessionAt: last }],
      [device('x', 'someone-else')],
      now,
    );
    expect(rest).toEqual([]);
    expect(row.lastSessionAt).toBe(last);
    expect(row.joinedAt).toEqual(daysAgo(3));
    expect(row.devices).toEqual([]);
  });
});
