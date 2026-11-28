import { nextConsentVersion } from './server-settings.service.js';

describe('nextConsentVersion', () => {
  const now = new Date('2026-11-28T10:00:00Z');
  it('tăng N trong cùng ngày UTC', () => {
    expect(nextConsentVersion('2026-11-28.3', now)).toBe('2026-11-28.4');
  });
  it('sang ngày mới thì bắt đầu .1', () => {
    expect(nextConsentVersion('2026-11-27.3', now)).toBe('2026-11-28.1');
  });
  it('phiên bản lạ cũng cho ra phiên bản mới khác bản cũ', () => {
    expect(nextConsentVersion('v1', now)).toBe('2026-11-28.1');
  });
});
