import { describe, expect, it } from 'vitest';
import { CONSENT_TEXT, CONSENT_TEXT_VERSION } from './consent-text.js';

describe('CONSENT_TEXT', () => {
  it('hướng dẫn đúng các lệnh có thật và không còn hứa lệnh ở "bản sau"', () => {
    // Các lệnh này đều có trong CLI (M3.3, M3.7); văn bản phải nhắc đủ để người dùng biết quyền của mình.
    for (const command of [
      '`tl pause`',
      '`tl resume`',
      '`tl consent`',
      '`tl consent revoke`',
      '`tl uninstall`',
      '`tl logout`',
    ]) {
      expect(CONSENT_TEXT).toContain(command);
    }
    expect(CONSENT_TEXT).not.toContain('bản sau');
  });

  it('có phiên bản dạng ngày.thứ-tự', () => {
    expect(CONSENT_TEXT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
