import {
  generateUserCode,
  normalizeUserCode,
  USER_CODE_ALPHABET,
} from './user-code.js';

describe('generateUserCode', () => {
  it('sinh mã dạng XXXX-XXXX chỉ dùng bảng chữ cho phép', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateUserCode();
      expect(code).toMatch(
        /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
      );
    }
  });

  it('dùng được hết bảng chữ (không lệch về đầu bảng)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of generateUserCode().replace('-', '')) seen.add(ch);
    }
    expect(seen.size).toBe(USER_CODE_ALPHABET.length);
  });

  it('dùng nguồn ngẫu nhiên được truyền vào', () => {
    let i = 0;
    expect(generateUserCode(() => i++)).toBe('BCDF-GHJK');
    expect(generateUserCode(() => USER_CODE_ALPHABET.length - 1)).toBe(
      'ZZZZ-ZZZZ',
    );
  });

  it('bảng chữ không có nguyên âm và ký tự dễ nhầm', () => {
    expect(USER_CODE_ALPHABET).toBe('BCDFGHJKLMNPQRSTVWXZ');
    expect(USER_CODE_ALPHABET).not.toMatch(/[AEIOUY01]/);
  });
});

describe('normalizeUserCode', () => {
  it.each([
    ['WDJB-MJHT', 'WDJB-MJHT'],
    ['wdjb-mjht', 'WDJB-MJHT'],
    ['WDJBMJHT', 'WDJB-MJHT'],
    [' wdjb mjht ', 'WDJB-MJHT'],
  ])('%j → %s', (input, expected) => {
    expect(normalizeUserCode(input)).toBe(expected);
  });

  it.each(['', 'WDJB-MJH', 'WDJB-MJHTX', 'AEIO-UBCD', 'WDJB-MJH1'])(
    'từ chối %j',
    (input) => {
      expect(normalizeUserCode(input)).toBeNull();
    },
  );
});
