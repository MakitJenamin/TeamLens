import { describe, expect, it } from 'vitest';
import { CONSENT_TEXT } from './consent-text.js';

describe('CONSENT_TEXT', () => {
  it('chỉ hướng dẫn lệnh đã có; lệnh chưa làm thì ghi rõ là bản sau', () => {
    expect(CONSENT_TEXT).toContain('`tl logout`');
    // `tl pause` (M3.3) và `tl uninstall` (M3.7) chưa có: không được hướng dẫn người dùng chạy.
    expect(CONSENT_TEXT).not.toContain('tl pause');
    expect(CONSENT_TEXT).not.toContain('tl uninstall');
    expect(CONSENT_TEXT).not.toMatch(/`tl consent`/);
    expect(CONSENT_TEXT).toMatch(/`tl consent revoke`[^\n]*bản sau/);
  });
});
