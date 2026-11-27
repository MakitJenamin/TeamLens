import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLI_RELEASE_URL,
  normalizeReleaseUrl,
  renderInstallScript,
} from './install-script.js';

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

  it('tìm tl.exe trong PATH và thư mục cài mặc định, đã có thì không tải lại', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    expect(script).toContain("Get-Command 'tl.exe'");
    expect(script).toContain("Join-Path $env:LOCALAPPDATA 'teamlens\\bin'");
    expect(script).toContain('không tải lại');
  });

  it('mặc định tải từ GitHub Releases latest, đúng tên asset', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    expect(script).toContain(`$releaseUrl = '${DEFAULT_CLI_RELEASE_URL}'`);
    expect(script).toContain("$zipName = 'tl-x86_64-pc-windows-msvc.zip'");
    expect(script).toContain("$sumsName = 'SHA256SUMS'");
    expect(script).toContain('"$releaseUrl/$sumsName"');
    expect(script).toContain('"$releaseUrl/$zipName"');
  });

  it('nhúng base URL release đã bỏ / cuối và thoát nháy đơn', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
      releaseUrl: "https://dl.example.com/tl'x/",
    });
    expect(script).toContain("$releaseUrl = 'https://dl.example.com/tl''x'");
    expect(script).not.toMatch(/[^']tl'x/);
  });

  it('từ chối base URL release không an toàn', () => {
    for (const releaseUrl of [
      'http://dl.example.com/x',
      'ftp://dl.example.com/x',
      'khong-phai-url',
      'https://dl.example.com/x?a=1',
      'https://dl.example.com/x\nWrite-Host hi',
    ]) {
      expect(() =>
        renderInstallScript({
          publicUrl: 'https://a.example.com',
          code: CODE,
          releaseUrl,
        }),
      ).toThrow('Base URL release CLI không hợp lệ');
    }
  });

  it('normalizeReleaseUrl: https, hoặc http chỉ cho localhost/127.0.0.1', () => {
    expect(normalizeReleaseUrl('https://x.example.com/a/')).toBe(
      'https://x.example.com/a',
    );
    expect(normalizeReleaseUrl('http://localhost:8765')).toBe(
      'http://localhost:8765',
    );
    expect(normalizeReleaseUrl('http://127.0.0.1:8765/r')).toBe(
      'http://127.0.0.1:8765/r',
    );
    expect(normalizeReleaseUrl('http://10.0.0.1/r')).toBeNull();
    expect(normalizeReleaseUrl('http://localhost.evil.com/r')).toBeNull();
    expect(normalizeReleaseUrl('https://user:pw@x.example.com/')).toBeNull();
  });

  it('kiểm SHA-256 (Get-FileHash, không phân biệt hoa thường) trước khi giải nén, sai thì dừng', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    const hash = script.indexOf(
      'Get-FileHash -LiteralPath $zipPath -Algorithm SHA256',
    );
    const compare = script.indexOf('$actual -ine $expected');
    const expand = script.indexOf('Expand-Archive');
    const install = script.indexOf('Copy-Item');
    expect(hash).toBeGreaterThan(0);
    expect(compare).toBeGreaterThan(hash);
    expect(expand).toBeGreaterThan(compare);
    expect(install).toBeGreaterThan(expand);
    // Nhánh sai hash phải return trước khi tới bước giải nén.
    const mismatch = script.slice(compare, expand);
    expect(mismatch).toContain('không khớp');
    expect(mismatch).toContain('return');
  });

  it('dùng TLS 1.2, -UseBasicParsing, tắt progress bar rồi khôi phục, dọn thư mục tạm trong finally', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    expect(script).toContain('[Net.SecurityProtocolType]::Tls12');
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
    const downloads = script
      .split('\n')
      .filter(
        (line) =>
          line.includes('Invoke-WebRequest') && !line.trim().startsWith('#'),
      );
    expect(downloads).toHaveLength(2);
    for (const line of downloads) expect(line).toContain('-UseBasicParsing');
    expect(script).toContain('Join-Path $env:TEMP');
    const tail = script.slice(script.lastIndexOf('finally {'));
    expect(tail).toContain('Remove-Item -LiteralPath $tempDir -Recurse');
    expect(tail).toContain('$ProgressPreference = $previousProgress');
    expect(tail).toContain(
      '[Net.ServicePointManager]::SecurityProtocol = $previousProtocol',
    );
  });

  it('thêm PATH của user (không trùng, không đụng PATH máy) và PATH của phiên hiện tại', () => {
    const script = renderInstallScript({
      publicUrl: 'https://a.example.com',
      code: CODE,
    });
    expect(script).toContain('[Microsoft.Win32.Registry]::CurrentUser');
    expect(script).toContain('DoNotExpandEnvironmentNames');
    expect(script).toContain('RegistryValueKind]::ExpandString');
    expect(script).toContain('$expanded -ieq $target');
    expect(script).not.toMatch(/LocalMachine|'Machine'/);
    expect(script).toContain('$env:Path = "$binDir;$env:Path"');
    expect(script).toContain('Mở terminal mới để dùng lệnh tl');
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
