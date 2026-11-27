import { INVITE_CODE_RE } from './invite-status.js';

/** Base URL release mặc định của CLI (quy ước release M5.1–M5.3). */
export const DEFAULT_CLI_RELEASE_URL =
  'https://github.com/MakitJenamin/TeamLens/releases/latest/download';

/** Tên asset trong release (không chứa phiên bản để dùng được `releases/latest/download`). */
export const CLI_ZIP_ASSET = 'tl-x86_64-pc-windows-msvc.zip';
export const CLI_SUMS_ASSET = 'SHA256SUMS';

/**
 * Kiểm tra base URL release: phải là `https:`; `http:` chỉ cho `localhost`/`127.0.0.1` (dev, test).
 * Trả bản đã bỏ dấu `/` cuối, hoặc `null` khi không hợp lệ. Dùng ở `config/env.ts` và trong
 * `renderInstallScript` (phòng khi được gọi trực tiếp).
 */
export function normalizeReleaseUrl(value: string): string | null {
  if (/[\s\r\n]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) return null;
  return value.replace(/\/+$/, '');
}

/** Đặt chuỗi trong nháy đơn của PowerShell (ký tự đặc biệt duy nhất là `'`, viết đôi để thoát). */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Script PowerShell cho `irm <server>/install.ps1?code=<mã> | iex` (M3.6 + M5.2, SPEC 7.1, 13).
 *
 * Luồng: tìm `tl.exe` (PATH hoặc `%LOCALAPPDATA%\teamlens\bin\tl.exe`). Chưa có thì tải
 * `SHA256SUMS` và `tl-x86_64-pc-windows-msvc.zip` từ `releaseUrl` vào một thư mục tạm riêng trong
 * `$env:TEMP`, kiểm SHA-256 của zip **trước khi giải nén** (sai thì dừng, không cài), giải nén vào
 * `%LOCALAPPDATA%\teamlens\bin`, thêm thư mục đó vào PATH của user (không trùng, không đụng PATH
 * máy) và `$env:Path` của phiên hiện tại; cuối cùng chạy `tl join <server>/i/<mã>`. Đã có `tl.exe`
 * thì không tải lại (cập nhật do `tl` tự lo, M5.3).
 *
 * Lưu ý khi sửa:
 * - Script chạy trong chính phiên PowerShell của người dùng (qua `iex`) nên **không dùng `exit`**
 *   (sẽ đóng luôn cửa sổ): bọc trong `& { ... }` và dùng `return`. Mọi thiết lập toàn phiên đổi tạm
 *   (encoding, TLS, progress bar) khôi phục trong `finally`.
 * - Chỉ nhúng `code` đã qua `INVITE_CODE_RE` (chỉ gồm `A-Za-z0-9_-`); địa chỉ server và base URL
 *   release được thoát nháy đơn, nên không có đường nhúng lệnh lạ vào script.
 * - PATH của user đọc/ghi thẳng registry `HKCU\Environment` để giữ nguyên các mục `%VAR%` chưa
 *   mở rộng và kiểu `REG_EXPAND_SZ` (`[Environment]::SetEnvironmentVariable('Path', ..., 'User')`
 *   ghi lại dạng đã mở rộng, kiểu `REG_SZ`, làm hỏng các mục như `%JAVA_HOME%\bin`). Sau đó gọi
 *   `SetEnvironmentVariable` với một biến tạm để Windows phát `WM_SETTINGCHANGE` (terminal mới
 *   thấy PATH mới). Biến `TEAMLENS_INSTALL_TEST_ENV_KEY` **chỉ dành cho test**: trỏ việc ghi PATH
 *   sang một khóa khác dưới HKCU để chạy thử script thật mà không đụng PATH thật.
 */
export function renderInstallScript(input: {
  publicUrl: string;
  code: string;
  releaseUrl?: string;
}): string {
  if (!INVITE_CODE_RE.test(input.code)) {
    throw new Error('Mã mời sai định dạng');
  }
  const releaseUrl = normalizeReleaseUrl(
    input.releaseUrl ?? DEFAULT_CLI_RELEASE_URL,
  );
  if (!releaseUrl) {
    throw new Error('Base URL release CLI không hợp lệ');
  }
  const server = input.publicUrl.replace(/\/+$/, '');
  const link = `${server}/i/${input.code}`;
  return `# TeamLens: tham gia nhóm bằng một lệnh.
# Script do server ${server.replace(/[\r\n]/g, '')} sinh ra. Nó tìm tl.exe trên máy (chưa có thì tải bản
# phát hành, kiểm SHA-256, cài vào %LOCALAPPDATA%\\teamlens\\bin và thêm vào PATH của user)
# rồi chạy \`tl join\` với link mời bên dưới.
& {
    $ErrorActionPreference = 'Stop'
    $previousEncoding = [Console]::OutputEncoding
    $previousProgress = $ProgressPreference
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    $tempDir = $null
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $link = ${psQuote(link)}
        $releaseUrl = ${psQuote(releaseUrl)}
        $zipName = '${CLI_ZIP_ASSET}'
        $sumsName = '${CLI_SUMS_ASSET}'
        $binDir = Join-Path $env:LOCALAPPDATA 'teamlens\\bin'
        $candidate = Join-Path $binDir 'tl.exe'

        # Tìm tl.exe: trong PATH, rồi trong thư mục cài mặc định của TeamLens.
        $tl = $null
        $found = Get-Command 'tl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $tl = $found.Source }
        if (-not $tl -and (Test-Path -LiteralPath $candidate)) { $tl = $candidate }

        if ($tl) {
            Write-Host "Đã có tl.exe ở $tl, không tải lại (tl tự cập nhật sau)."
        }
        else {
            # Windows PowerShell 5.1 mặc định có thể chưa bật TLS 1.2 (GitHub bắt buộc).
            [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
            # Thanh tiến trình của Invoke-WebRequest làm tải chậm hẳn trên 5.1.
            $ProgressPreference = 'SilentlyContinue'

            $tempDir = Join-Path $env:TEMP ('teamlens-install-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
            $zipPath = Join-Path $tempDir $zipName
            $sumsPath = Join-Path $tempDir $sumsName

            Write-Host "Máy này chưa có tl.exe. Đang tải $zipName từ $releaseUrl ..."
            try {
                Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$sumsName" -OutFile $sumsPath
                Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$zipName" -OutFile $zipPath
            }
            catch {
                Write-Host "Không tải được tl.exe: $($_.Exception.Message)"
                Write-Host 'Kiểm tra kết nối mạng rồi chạy lại lệnh này, hoặc hỏi leader.'
                return
            }

            # Kiểm SHA-256 TRƯỚC khi giải nén: sai thì dừng, không cài gì.
            $expected = $null
            foreach ($line in Get-Content -LiteralPath $sumsPath) {
                $parts = $line.Trim() -split '\\s+', 2
                if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $zipName) {
                    $expected = $parts[0]
                    break
                }
            }
            if (-not $expected) {
                Write-Host "$sumsName không có dòng cho $zipName. Đã dừng, không cài gì."
                return
            }
            $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
            if ($actual -ine $expected) {
                Write-Host "SHA-256 của $zipName không khớp với $sumsName (file tải về có thể bị hỏng hoặc bị sửa)."
                Write-Host "  Mong đợi: $($expected.ToLowerInvariant())"
                Write-Host "  Thực tế:  $($actual.ToLowerInvariant())"
                Write-Host 'Đã dừng, không cài gì. Hãy chạy lại lệnh này; vẫn lỗi thì báo leader.'
                return
            }
            Write-Host 'Đã kiểm SHA-256: khớp.'

            $extractDir = Join-Path $tempDir 'zip'
            Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
            $extracted = Join-Path $extractDir 'tl.exe'
            if (-not (Test-Path -LiteralPath $extracted)) {
                Write-Host "$zipName không chứa tl.exe ở gốc. Đã dừng, không cài gì."
                return
            }
            New-Item -ItemType Directory -Path $binDir -Force | Out-Null
            Copy-Item -LiteralPath $extracted -Destination $candidate -Force
            $tl = $candidate
            Write-Host "Đã cài tl.exe vào $candidate"
        }

        # Thư mục cài của TeamLens phải nằm trong PATH của user (không đụng PATH của máy).
        if ($tl -eq $candidate) {
            $envKeyPath = 'Environment'
            if ($env:TEAMLENS_INSTALL_TEST_ENV_KEY) { $envKeyPath = $env:TEAMLENS_INSTALL_TEST_ENV_KEY }
            $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($envKeyPath)
            try {
                $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $entries = @($userPath -split ';' | Where-Object { $_.Trim() -ne '' })
                $target = $binDir.TrimEnd('\\')
                $already = $false
                foreach ($entry in $entries) {
                    $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim()).TrimEnd('\\')
                    if ($expanded -ieq $target) { $already = $true; break }
                }
                if (-not $already) {
                    $newPath = (@($entries) + $binDir) -join ';'
                    $envKey.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
                    if (-not $env:TEAMLENS_INSTALL_TEST_ENV_KEY) {
                        # Ghi rồi xóa một biến tạm để Windows phát WM_SETTINGCHANGE cho terminal mới.
                        [Environment]::SetEnvironmentVariable('TEAMLENS_INSTALL_REFRESH', '1', 'User')
                        [Environment]::SetEnvironmentVariable('TEAMLENS_INSTALL_REFRESH', $null, 'User')
                    }
                    Write-Host "Đã thêm $binDir vào PATH của user. Mở terminal mới để dùng lệnh tl."
                }
            }
            finally {
                $envKey.Close()
            }
            $sessionEntries = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\\') })
            if ($sessionEntries -notcontains $target) {
                $env:Path = "$binDir;$env:Path"
            }
        }

        Write-Host "Đang chạy: tl join $link"
        & $tl join $link
        if ($LASTEXITCODE -ne 0) {
            Write-Host "tl join kết thúc với mã lỗi $LASTEXITCODE (xem thông báo ở trên)."
        }
    }
    finally {
        if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
            Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
        $ProgressPreference = $previousProgress
        [Console]::OutputEncoding = $previousEncoding
    }
}
`;
}
