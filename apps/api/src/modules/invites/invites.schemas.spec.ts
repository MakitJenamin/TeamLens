import { CONSENT_TEXT_VERSION } from '../consent/consent-text.js';
import { createInviteSchema, joinSchema } from './invites.controller.js';

const valid = {
  code: 'abcdefghij',
  name: '  An  ',
  deviceName: 'LAPTOP-01',
  os: 'windows',
  cliVersion: '0.1.0',
  consent: { textVersion: CONSENT_TEXT_VERSION, backfill: false },
};

describe('joinSchema', () => {
  it('nhận body hợp lệ và trim tên', () => {
    const parsed = joinSchema.parse(valid);
    expect(parsed.name).toBe('An');
  });

  it.each([
    ['tên rỗng sau trim', { name: '   ' }],
    ['tên quá 100 ký tự', { name: 'a'.repeat(101) }],
    ['mã quá ngắn', { code: 'abc' }],
    ['mã quá dài', { code: 'a'.repeat(101) }],
    ['thiếu backfill', { consent: { textVersion: 'x' } }],
    [
      'backfill không phải boolean',
      { consent: { textVersion: 'x', backfill: 'yes' } },
    ],
    ['thiếu thiết bị', { deviceName: '' }],
    ['os quá dài', { os: 'w'.repeat(51) }],
  ])('từ chối: %s', (_label, patch) => {
    expect(joinSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('createInviteSchema', () => {
  it('body trống hoặc {} hợp lệ', () => {
    expect(createInviteSchema.parse(undefined)).toBeUndefined();
    expect(createInviteSchema.parse({})).toEqual({});
    expect(createInviteSchema.parse({ maxUses: null })).toEqual({
      maxUses: null,
    });
  });

  it.each([
    { expiresInDays: 0 },
    { expiresInDays: 31 },
    { expiresInDays: 2.5 },
    { maxUses: 0 },
    { maxUses: 1001 },
  ])('từ chối %o', (body) => {
    expect(createInviteSchema.safeParse(body).success).toBe(false);
  });
});
