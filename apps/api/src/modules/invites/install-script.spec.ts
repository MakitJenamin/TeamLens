import { describe, expect, it } from 'vitest';
import { renderInstallScript } from './install-script.js';

const CODE = 'Zm9vYmFyYmF6cXV4';

describe('renderInstallScript', () => {
  it('nhúng link mời đúng định dạng <server>/i/<mã> và gọi tl join', () => {
    const script = renderInstallScript({
      publicUrl: 'https://teamlens.congty.com',
      code: CODE,
    });
    expect(script).toContain(`$link = 'https://teamlens.congty.com/i/${CODE}'`);
    expect(script).toContain('& $tl join $link');
  });

  it('bỏ dấu / cuối của địa chỉ server', () => {
    const script = renderInstallScript({
      publicUrl: 'https://tl.example.com//',
      code: CODE,
    });
    expect(script).toContain(`'https://tl.example.com/i/${CODE}'`);
    expect(script).not.toContain('com//i/');
  });

  it('thoát nháy đơn trong địa chỉ server để không nhúng được lệnh lạ', () => {
    const script = renderInstallScript({
      publicUrl: "https://x.example.com/a'b",
      code: CODE,
    });
    expect(script).toContain(`$link = 'https://x.example.com/a''b/i/${CODE}'`);
  });

  it('từ chối mã sai định dạng (chặn nhúng chuỗi lạ vào script)', () => {
    for (const code of [
      '',
      'ngan',
      "abc'; Remove-Item -Recurse C:\\ #",
      'co dau cach 123',
      'abc$(whoami)def',
      'a'.repeat(101),
    ]) {
      expect(() =>
        renderInstallScript({ publicUrl: 'https://a.example.com', code }),
      ).toThrow('Mã mời sai định dạng');
    }
  });

  it('không dùng exit (iex chạy trong phiên của người dùng, exit sẽ đóng cửa sổ)', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    expect(script).not.toMatch(/^\s*exit\b/m);
    expect(script).toContain('return');
  });

  it('báo rõ khi chưa có tl.exe và chừa chỗ cho M5.2', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    expect(script).toContain('Máy này chưa có tl.exe');
    expect(script).toContain('M5.2');
    expect(script).toContain('teamlens\\bin\\tl.exe');
  });

  it('dấu ngoặc nhọn cân bằng (script không bị vỡ cú pháp rõ ràng)', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    const open = (script.match(/\{/g) ?? []).length;
    const close = (script.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});
