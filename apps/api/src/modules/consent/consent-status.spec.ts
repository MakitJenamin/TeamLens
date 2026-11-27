import { describe, expect, it } from 'vitest';
import { type ConsentRow, deriveConsentStatus } from './consent-status.js';

const CURRENT = '2026-11-27.2';
const TEXT = 'Văn bản hiện hành';
const d = (iso: string) => new Date(iso);

const row = (over: Partial<ConsentRow>): ConsentRow => ({
  textVersion: CURRENT,
  backfill: false,
  grantedAt: d('2026-11-27T08:00:00Z'),
  revokedAt: null,
  ...over,
});

const derive = (rows: ConsentRow[], deviceRevoked = false) =>
  deriveConsentStatus({
    rows,
    currentVersion: CURRENT,
    currentText: TEXT,
    deviceRevoked,
  });

describe('deriveConsentStatus', () => {
  it('chưa có bản nào: none, mọi trường chi tiết là null', () => {
    expect(derive([])).toEqual({
      textVersion: CURRENT,
      text: TEXT,
      status: 'none',
      acceptedVersion: null,
      backfill: null,
      grantedAt: null,
      revokedAt: null,
    });
  });

  it('có bản chưa rút đúng phiên bản: granted', () => {
    const s = derive([row({ backfill: true })]);
    expect(s).toMatchObject({
      status: 'granted',
      acceptedVersion: CURRENT,
      backfill: true,
      grantedAt: '2026-11-27T08:00:00.000Z',
      revokedAt: null,
    });
  });

  it('chỉ có bản chưa rút phiên bản cũ: outdated, vẫn báo bản đã đồng ý', () => {
    const s = derive([row({ textVersion: '2026-11-26' })]);
    expect(s).toMatchObject({
      status: 'outdated',
      acceptedVersion: '2026-11-26',
    });
  });

  it('mọi bản đã rút: revoked kèm lần rút gần nhất, không còn chi tiết bản đồng ý', () => {
    const s = derive([
      row({ revokedAt: d('2026-11-27T09:00:00Z') }),
      row({ revokedAt: d('2026-11-27T10:00:00Z') }),
    ]);
    expect(s).toMatchObject({
      status: 'revoked',
      acceptedVersion: null,
      backfill: null,
      grantedAt: null,
      revokedAt: '2026-11-27T10:00:00.000Z',
    });
  });

  it('thiết bị consent_revoked mà không có dòng nào vẫn là revoked (không có revokedAt)', () => {
    expect(derive([], true)).toMatchObject({
      status: 'revoked',
      revokedAt: null,
    });
  });

  it('đồng ý lại sau khi rút: granted, không còn revokedAt', () => {
    const s = derive([
      row({ revokedAt: d('2026-11-27T09:00:00Z') }),
      row({ grantedAt: d('2026-11-27T11:00:00Z'), backfill: true }),
    ]);
    expect(s).toMatchObject({
      status: 'granted',
      backfill: true,
      grantedAt: '2026-11-27T11:00:00.000Z',
      revokedAt: null,
    });
  });

  it('nhiều bản chưa rút: ưu tiên bản đúng phiên bản hiện hành dù có bản cũ mới hơn', () => {
    const s = derive([
      row({ grantedAt: d('2026-11-27T08:00:00Z'), backfill: true }),
      row({ textVersion: '2026-11-26', grantedAt: d('2026-11-27T12:00:00Z') }),
    ]);
    expect(s).toMatchObject({
      status: 'granted',
      acceptedVersion: CURRENT,
      backfill: true,
    });
  });
});
