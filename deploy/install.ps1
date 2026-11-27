# TeamLens: cai lenh `tl` (CLI + daemon) len Windows bang mot lenh.
#
# PowerShell (Windows PowerShell 5.1 hoac PowerShell 7):
#   irm https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.ps1 | iex
# CMD:
#   curl -fsSL https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.cmd -o install.cmd && install.cmd && del install.cmd
#
# Script chi CAI tl: tai SHA256SUMS + tl-x86_64-pc-windows-msvc.zip tu releases/latest/download, kiem
# SHA-256 cua zip TRUOC khi giai nen (sai thi dung, khong cai), cai vao %LOCALAPPDATA%\teamlens\bin\tl.exe,
# them thu muc do vao PATH cua user. Tham gia nhom la buoc rieng: tl join https://<server>/i/<ma>.
# May da co tl.exe thi khong tai de (file co the dang bi daemon giu): in phien ban dang co, goi y
# `tl update`, van dam bao PATH.
#
# Luu y khi sua file nay:
# - File PHAI la ASCII thuan. GitHub tra asset voi Content-Type application/octet-stream, va
#   `irm | iex` tren Windows PowerShell 5.1 giai ma no bang Latin-1: chu co dau thanh rac, BOM
#   UTF-8 thanh loi cu phap. Vi vay comment viet khong dau, con thong bao cho nguoi dung viet
#   tieng Viet co dau bang ma \uXXXX, in qua ham Write-Vi ([regex]::Unescape roi -f). Duong dan
#   va URL luon truyen lam tham so {0}, {1}, khong ghep vao chuoi mau (dau \ trong duong dan se bi
#   Unescape hieu sai). Workflow release kiem file chi co ASCII.
# - Script chay trong chinh phien PowerShell cua nguoi dung (qua iex) nen KHONG dung `exit` (dong
#   luon cua so): boc trong `& { ... }` va dung `return`. Thiet lap toan phien doi tam (encoding,
#   TLS, progress bar) khoi phuc trong `finally`. Ket qua bao qua $global:LASTEXITCODE (0 thanh
#   cong, 1 loi) de install.cmd tra ma thoat dung.
# - PATH cua user doc/ghi thang registry HKCU\Environment de giu nguyen muc %VAR% chua mo rong va
#   kieu REG_EXPAND_SZ, sau do ghi/xoa mot bien tam qua SetEnvironmentVariable de Windows phat
#   WM_SETTINGCHANGE (terminal moi thay PATH moi).
# - Bien chi danh cho test: TEAMLENS_INSTALL_BASE_URL (thu muc chua zip + SHA256SUMS thay cho GitHub;
#   chi nhan https://, hoac http:// toi localhost/127.0.0.1), TEAMLENS_INSTALL_TEST_ENV_KEY (ghi PATH
#   vao khoa khac duoi HKCU thay cho Environment, khong phat WM_SETTINGCHANGE).
& {
    $ErrorActionPreference = 'Stop'
    $global:LASTEXITCODE = 1
    $previousEncoding = [Console]::OutputEncoding
    $previousProgress = $ProgressPreference
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    $tempDir = $null

    function Write-Vi {
        param([string]$Format, [object[]]$Arguments = @())
        Write-Host ([regex]::Unescape($Format) -f $Arguments)
    }

    function Get-TlVersion([string]$Exe) {
        try {
            $text = (& $Exe --version 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $text) { return $text }
        }
        catch {
        }
        return $null
    }

    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $releaseUrl = 'https://github.com/MakitJenamin/TeamLens/releases/latest/download'
        if ($env:TEAMLENS_INSTALL_BASE_URL) {
            $override = $env:TEAMLENS_INSTALL_BASE_URL.Trim().TrimEnd('/')
            if ($override -notmatch '^(https://[^\s?#]+|http://(localhost|127\.0\.0\.1)(:\d+)?(/[^\s?#]*)?)$') {
                Write-Vi 'TEAMLENS_INSTALL_BASE_URL kh\u00f4ng h\u1ee3p l\u1ec7: {0} (ch\u1ec9 nh\u1eadn https://, ho\u1eb7c http:// t\u1edbi localhost/127.0.0.1). \u0110\u00e3 d\u1eebng, kh\u00f4ng c\u00e0i g\u00ec.' $override
                return
            }
            $releaseUrl = $override
            Write-Vi 'D\u00f9ng ngu\u1ed3n c\u00e0i th\u1eed t\u1eeb TEAMLENS_INSTALL_BASE_URL: {0}' $releaseUrl
        }
        $zipName = 'tl-x86_64-pc-windows-msvc.zip'
        $sumsName = 'SHA256SUMS'
        $binDir = Join-Path $env:LOCALAPPDATA 'teamlens\bin'
        $candidate = Join-Path $binDir 'tl.exe'

        # Tim tl.exe: thu muc cai mac dinh cua TeamLens truoc, roi toi PATH.
        $tl = $null
        if (Test-Path -LiteralPath $candidate) {
            $tl = $candidate
        }
        else {
            $found = Get-Command 'tl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found) { $tl = $found.Source }
        }

        if ($tl) {
            $current = Get-TlVersion $tl
            if (-not $current) { $current = '?' }
            Write-Vi 'M\u00e1y n\u00e0y \u0111\u00e3 c\u00f3 tl ({0}) \u1edf {1}, kh\u00f4ng t\u1ea3i \u0111\u00e8.' $current, $tl
            Write-Vi 'Mu\u1ed1n l\u00ean b\u1ea3n m\u1edbi nh\u1ea5t th\u00ec ch\u1ea1y: tl update'
        }
        else {
            # Windows PowerShell 5.1 mac dinh co the chua bat TLS 1.2 (GitHub bat buoc).
            [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
            # Thanh tien trinh cua Invoke-WebRequest lam tai cham han tren 5.1.
            $ProgressPreference = 'SilentlyContinue'

            $tempDir = Join-Path $env:TEMP ('teamlens-install-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
            $zipPath = Join-Path $tempDir $zipName
            $sumsPath = Join-Path $tempDir $sumsName

            Write-Vi '\u0110ang t\u1ea3i {0} t\u1eeb {1} ...' $zipName, $releaseUrl
            try {
                Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$sumsName" -OutFile $sumsPath
                Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$zipName" -OutFile $zipPath
            }
            catch {
                Write-Vi 'Kh\u00f4ng t\u1ea3i \u0111\u01b0\u1ee3c tl: {0}' $_.Exception.Message
                Write-Vi 'Ki\u1ec3m tra k\u1ebft n\u1ed1i m\u1ea1ng r\u1ed3i ch\u1ea1y l\u1ea1i l\u1ec7nh c\u00e0i, ho\u1eb7c h\u1ecfi leader.'
                return
            }

            # Kiem SHA-256 TRUOC khi giai nen: sai thi dung, khong cai gi.
            $expected = $null
            foreach ($line in Get-Content -LiteralPath $sumsPath) {
                $parts = $line.Trim() -split '\s+', 2
                if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $zipName) {
                    $expected = $parts[0]
                    break
                }
            }
            if (-not $expected) {
                Write-Vi '{0} kh\u00f4ng c\u00f3 d\u00f2ng cho {1}. \u0110\u00e3 d\u1eebng, kh\u00f4ng c\u00e0i g\u00ec.' $sumsName, $zipName
                return
            }
            $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
            if ($actual -ine $expected) {
                Write-Vi 'SHA-256 c\u1ee7a {0} kh\u00f4ng kh\u1edbp v\u1edbi {1} (file t\u1ea3i v\u1ec1 c\u00f3 th\u1ec3 b\u1ecb h\u1ecfng ho\u1eb7c b\u1ecb s\u1eeda).' $zipName, $sumsName
                Write-Vi '  Mong \u0111\u1ee3i: {0}' $expected.ToLowerInvariant()
                Write-Vi '  Th\u1ef1c t\u1ebf:  {0}' $actual.ToLowerInvariant()
                Write-Vi '\u0110\u00e3 d\u1eebng, kh\u00f4ng c\u00e0i g\u00ec. H\u00e3y ch\u1ea1y l\u1ea1i l\u1ec7nh c\u00e0i; v\u1eabn l\u1ed7i th\u00ec b\u00e1o leader.'
                return
            }
            Write-Vi '\u0110\u00e3 ki\u1ec3m SHA-256: kh\u1edbp.'

            $extractDir = Join-Path $tempDir 'zip'
            Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
            $extracted = Join-Path $extractDir 'tl.exe'
            if (-not (Test-Path -LiteralPath $extracted)) {
                Write-Vi '{0} kh\u00f4ng ch\u1ee9a tl.exe \u1edf g\u1ed1c. \u0110\u00e3 d\u1eebng, kh\u00f4ng c\u00e0i g\u00ec.' $zipName
                return
            }
            New-Item -ItemType Directory -Path $binDir -Force | Out-Null
            Copy-Item -LiteralPath $extracted -Destination $candidate -Force
            $tl = $candidate
        }

        # Thu muc cai cua TeamLens phai nam trong PATH cua user (khong dung PATH cua may).
        if ($tl -eq $candidate) {
            $envKeyPath = 'Environment'
            if ($env:TEAMLENS_INSTALL_TEST_ENV_KEY) { $envKeyPath = $env:TEAMLENS_INSTALL_TEST_ENV_KEY }
            $target = $binDir.TrimEnd('\')
            $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($envKeyPath)
            try {
                $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $entries = @($userPath -split ';' | Where-Object { $_.Trim() -ne '' })
                $already = $false
                foreach ($entry in $entries) {
                    $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim()).TrimEnd('\')
                    if ($expanded -ieq $target) { $already = $true; break }
                }
                if (-not $already) {
                    $newPath = (@($entries) + $binDir) -join ';'
                    $envKey.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
                    if (-not $env:TEAMLENS_INSTALL_TEST_ENV_KEY) {
                        # Ghi roi xoa mot bien tam de Windows phat WM_SETTINGCHANGE cho terminal moi.
                        [Environment]::SetEnvironmentVariable('TEAMLENS_INSTALL_REFRESH', '1', 'User')
                        [Environment]::SetEnvironmentVariable('TEAMLENS_INSTALL_REFRESH', $null, 'User')
                    }
                    Write-Vi '\u0110\u00e3 th\u00eam {0} v\u00e0o PATH c\u1ee7a user.' $binDir
                }
            }
            finally {
                $envKey.Close()
            }
            $sessionEntries = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') })
            if ($sessionEntries -notcontains $target) {
                $env:Path = "$binDir;$env:Path"
            }
        }

        if ($tempDir) {
            $installed = Get-TlVersion $tl
            if (-not $installed) {
                Write-Vi '\u0110\u00e3 ch\u00e9p tl.exe v\u00e0o {0} nh\u01b0ng ch\u1ea1y "tl --version" kh\u00f4ng \u0111\u01b0\u1ee3c. H\u00e3y ch\u1ea1y l\u1ea1i l\u1ec7nh c\u00e0i; v\u1eabn l\u1ed7i th\u00ec b\u00e1o leader.' $tl
                return
            }
            Write-Host ''
            Write-Vi '\u0110\u00e3 c\u00e0i {0} v\u00e0o {1}' $installed, $tl
        }
        Write-Host ''
        Write-Vi 'B\u01b0\u1edbc ti\u1ebfp theo: tham gia nh\u00f3m b\u1eb1ng link m\u1eddi leader g\u1eedi cho b\u1ea1n:'
        Write-Vi '    tl join https://<server>/i/<m\u00e3 m\u1eddi>'
        Write-Vi 'L\u1ec7nh tl d\u00f9ng \u0111\u01b0\u1ee3c ngay trong c\u1eeda s\u1ed5 n\u00e0y; c\u1eeda s\u1ed5 terminal m\u1edf m\u1edbi c\u0169ng c\u00f3 s\u1eb5n tl.'
        $global:LASTEXITCODE = 0
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
