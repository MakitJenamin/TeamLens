import { describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets } from './mcp-redact.js';

describe('redactSecrets', () => {
  it.each([
    ['aws_access_key', 'key AKIAIOSFODNN7EXAMPLE end'],
    ['github_token', 'tok ghp_0123456789abcdefghijklmnopqrstuvwxyzAB ok'],
    ['anthropic_key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['openai_key', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD'],
    ['slack_token', 'xoxb-1234567890-abcdefghij'],
    ['google_api_key', 'AIzaSyA-1234567890abcdefghijklmnopqrstu'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl',
    ],
    ['teamlens_token', 'Bearer tlp_abcdefghijklmnopqrstuvwxyz012345'],
    ['teamlens_token', 'tld_abcdefghijklmnopqrstuvwxyz012345'],
  ])('che %s', (kind, text) => {
    const out = redactSecrets(text);
    expect(out).toContain(`[REDACTED:${kind}]`);
  });

  it('che cả khối khóa riêng, kể cả khi bị cắt giữa chừng', () => {
    const full = redactSecrets(
      'a\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nb',
    );
    expect(full).toBe('a\n[REDACTED:private_key]\nb');
    const cut = redactSecrets('x -----BEGIN PRIVATE KEY-----\nMIIabc');
    expect(cut).toBe('x [REDACTED:private_key]');
  });

  it('chỉ che mật khẩu trong URL, giữ phần còn lại', () => {
    expect(redactSecrets('postgres://admin:hunter22pw@db:5432/app')).toBe(
      'postgres://admin:[REDACTED:url_password]@db:5432/app',
    );
  });

  it('chỉ che giá trị của biến, giữ tên biến', () => {
    expect(redactSecrets('DB_PASSWORD=supersecret123')).toBe(
      'DB_PASSWORD=[REDACTED:secret_assignment]',
    );
    expect(redactSecrets('export MY_API_KEY=abcd1234efgh')).toBe(
      'export MY_API_KEY=[REDACTED:secret_assignment]',
    );
    expect(redactSecrets('"api_key": "abcd1234efgh"')).toContain(
      '"api_key": "[REDACTED:secret_assignment]"',
    );
  });

  it('không đụng vào chữ thường và uuid', () => {
    const text =
      'Session 0b9d8f9e-7c1a-4f4e-9b0e-2f6a1c3d4e5f sửa lỗi đăng nhập, password do người dùng nhập';
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets('password=ngan')).toBe('password=ngan');
  });
});

describe('redactDeep', () => {
  it('che mọi chuỗi lồng nhau, giữ nguyên khóa, số và null', () => {
    const input = {
      id: '1',
      n: 5,
      nothing: null,
      list: ['ok', 'tlp_abcdefghijklmnopqrstuvwxyz012345'],
      nested: { note: 'AKIAIOSFODNN7EXAMPLE' },
    };
    expect(redactDeep(input)).toEqual({
      id: '1',
      n: 5,
      nothing: null,
      list: ['ok', '[REDACTED:teamlens_token]'],
      nested: { note: '[REDACTED:aws_access_key]' },
    });
  });

  it('không sửa đối tượng gốc', () => {
    const input = { a: 'AKIAIOSFODNN7EXAMPLE' };
    redactDeep(input);
    expect(input.a).toBe('AKIAIOSFODNN7EXAMPLE');
  });
});
