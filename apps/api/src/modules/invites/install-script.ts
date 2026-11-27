import { INVITE_CODE_RE } from './invite-status.js';

/** Đặt chuỗi trong nháy đơn của PowerShell (ký tự đặc biệt duy nhất là `'`, viết đôi để thoát). */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Script PowerShell cho `irm <server>/install.ps1?code=<mã> | iex` (M3.6, SPEC 7.1).
 *
 * Bản tối thiểu: tìm `tl.exe` (PATH hoặc `%LOCALAPPDATA%\teamlens\bin\tl.exe`) rồi chạy
 * `tl join <server>/i/<mã>`; chưa có `tl.exe` thì báo rõ và dừng. Phần tải `tl.exe` từ GitHub
 * Releases, kiểm SHA-256, đặt vào thư mục và thêm PATH là M5.2: chèn vào chỗ có ghi chú "M5.2".
 *
 * Lưu ý khi sửa:
 * - Script chạy trong chính phiên PowerShell của người dùng (qua `iex`) nên **không dùng `exit`**
 *   (sẽ đóng luôn cửa sổ): bọc trong `& { ... }` và dùng `return`.
 * - Chỉ nhúng `code` đã qua `INVITE_CODE_RE` (chỉ gồm `A-Za-z0-9_-`), và địa chỉ server được thoát
 *   nháy đơn, nên không có đường nhúng lệnh lạ vào script.
 */
export function renderInstallScript(input: {
  publicUrl: string;
  code: string;
}): string {
  if (!INVITE_CODE_RE.test(input.code)) {
    throw new Error('Mã mời sai định dạng');
  }
  const server = input.publicUrl.replace(/\/+$/, '');
  const link = `${server}/i/${input.code}`;
  return `# TeamLens: tham gia nhóm bằng một lệnh.
# Script do server ${server.replace(/[\r\n]/g, '')} sinh ra. Nó chỉ tìm tl.exe trên máy rồi chạy \`tl join\` với link mời bên dưới.
& {
    $ErrorActionPreference = 'Stop'
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $link = ${psQuote(link)}

        # Tìm tl.exe: trong PATH, rồi trong thư mục cài mặc định của TeamLens.
        $tl = $null
        $found = Get-Command 'tl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $tl = $found.Source }
        if (-not $tl) {
            $candidate = Join-Path $env:LOCALAPPDATA 'teamlens\\bin\\tl.exe'
            if (Test-Path -LiteralPath $candidate) { $tl = $candidate }
        }

        # M5.2 sẽ chèn vào đây: tải tl.exe từ GitHub Releases, kiểm SHA-256, đặt vào
        # %LOCALAPPDATA%\\teamlens\\bin và thêm vào PATH của user khi chưa tìm thấy tl.exe.

        if (-not $tl) {
            Write-Host 'Máy này chưa có tl.exe nên chưa tham gia được.'
            Write-Host 'Hãy cài tl.exe (hỏi leader hoặc xem hướng dẫn cài của nhóm) rồi chạy lại lệnh này.'
            return
        }

        Write-Host "Đang chạy: tl join $link"
        & $tl join $link
        if ($LASTEXITCODE -ne 0) {
            Write-Host "tl join kết thúc với mã lỗi $LASTEXITCODE (xem thông báo ở trên)."
        }
    }
    finally {
        [Console]::OutputEncoding = $previousEncoding
    }
}
`;
}
