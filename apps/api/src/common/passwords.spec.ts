import { hashPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('hash bằng argon2id và kiểm tra đúng/sai', async () => {
    const hashed = await hashPassword('teamlens123');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hashed, 'teamlens123')).toBe(true);
    expect(await verifyPassword(hashed, 'sai-mat-khau')).toBe(false);
  });

  it('hash hỏng thì trả false thay vì ném lỗi', async () => {
    expect(await verifyPassword('khong-phai-hash', 'x')).toBe(false);
  });
});
