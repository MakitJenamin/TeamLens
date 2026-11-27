import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from './key-crypto.js';

const SECRET = randomBytes(32).toString('base64');

describe('key-crypto', () => {
  it('mã hóa rồi giải mã ra đúng key, mỗi lần IV khác nhau', () => {
    const a = encryptSecret('sk-ant-123456789', SECRET);
    const b = encryptSecret('sk-ant-123456789', SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-ant');
    expect(decryptSecret(a, SECRET)).toBe('sk-ant-123456789');
    expect(decryptSecret(b, SECRET)).toBe('sk-ant-123456789');
  });

  it('giải mã được chuỗi rỗng (Ollama không cần key)', () => {
    expect(decryptSecret(encryptSecret('', SECRET), SECRET)).toBe('');
  });

  it('sai khóa thì bị từ chối', () => {
    const encoded = encryptSecret('sk-test', SECRET);
    const other = randomBytes(32).toString('base64');
    expect(() => decryptSecret(encoded, other)).toThrow();
  });

  it('sai IV hoặc dữ liệu bị sửa thì bị từ chối', () => {
    const [version, , ciphertext, tag] = encryptSecret('sk-test', SECRET).split(
      '.',
    );
    const wrongIv = randomBytes(12).toString('base64');
    expect(() =>
      decryptSecret([version, wrongIv, ciphertext, tag].join('.'), SECRET),
    ).toThrow();
    const encoded = encryptSecret('sk-test', SECRET).split('.');
    const bytes = Buffer.from(encoded[2], 'base64');
    bytes[0] ^= 1;
    encoded[2] = bytes.toString('base64');
    expect(() => decryptSecret(encoded.join('.'), SECRET)).toThrow();
  });

  it('định dạng lạ hoặc secret không đủ 32 byte thì ném lỗi', () => {
    expect(() => decryptSecret('abc', SECRET)).toThrow();
    expect(() =>
      encryptSecret('x', Buffer.from('short').toString('base64')),
    ).toThrow();
  });
});
