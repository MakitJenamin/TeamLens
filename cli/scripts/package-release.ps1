<#
.SYNOPSIS
    Đóng gói tl.exe thành asset release: tl-x86_64-pc-windows-msvc.zip + SHA256SUMS.

.DESCRIPTION
    Dùng chung cho workflow `.github/workflows/release.yml` và khi tự thử trên máy.
    Các bước:
      1. Smoke test: `tl.exe --version` phải in đúng `tl <ExpectedVersion>`.
      2. Tạo zip chứa đúng một file `tl.exe` ở gốc zip.
      3. Mở lại zip kiểm: chỉ có `tl.exe`, SHA-256 trùng file gốc.
      4. Ghi `SHA256SUMS` kiểu `sha256sum`: `<hex thường>  <tên file>`, xuống dòng LF, UTF-8 không BOM.
    Chạy được trên Windows PowerShell 5.1 và PowerShell 7.

.EXAMPLE
    ./cli/scripts/package-release.ps1 -BinaryPath cli/target/x86_64-pc-windows-msvc/release/tl.exe -OutDir dist -ExpectedVersion 0.1.0
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BinaryPath,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Tên asset cố định, không chứa phiên bản (để dùng được releases/latest/download/<asset>).
$ZipName = 'tl-x86_64-pc-windows-msvc.zip'
$SumsName = 'SHA256SUMS'
$ExeName = 'tl.exe'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256Hex([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
if ((Split-Path -Leaf $binary) -ne $ExeName) {
    throw "BinaryPath phải trỏ tới $ExeName, đang là: $binary"
}

# 1. Smoke test phiên bản.
$versionOutput = (& $binary --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "'$ExeName --version' thoát với mã $LASTEXITCODE"
}
$expectedOutput = "tl $ExpectedVersion"
if ($versionOutput -ne $expectedOutput) {
    throw "'$ExeName --version' in '$versionOutput', mong đợi '$expectedOutput'"
}
Write-Host "Smoke test OK: $versionOutput"

# 2. Tạo zip.
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outDirFull = (Resolve-Path -LiteralPath $OutDir).Path
$zipPath = Join-Path $outDirFull $ZipName
$sumsPath = Join-Path $outDirFull $SumsName
foreach ($p in @($zipPath, $sumsPath)) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $binary, $ExeName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
} finally {
    $zip.Dispose()
}

# 3. Kiểm lại nội dung zip.
$binaryHash = Get-Sha256Hex $binary
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    if ($names.Count -ne 1 -or $names[0] -ne $ExeName) {
        throw "Zip phải chứa đúng một file '$ExeName' ở gốc, đang có: $($names -join ', ')"
    }
    $stream = $zip.Entries[0].Open()
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $entryHash = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
    } finally {
        $stream.Dispose()
    }
} finally {
    $zip.Dispose()
}
if ($entryHash -ne $binaryHash) {
    throw "SHA-256 của $ExeName trong zip ($entryHash) khác file gốc ($binaryHash)"
}

# 4. SHA256SUMS: hai dấu cách giữa hash và tên file, LF, không BOM.
$zipHash = Get-Sha256Hex $zipPath
$line = "$zipHash  $ZipName`n"
[System.IO.File]::WriteAllText($sumsPath, $line, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Đã tạo:"
Write-Host "  $zipPath"
Write-Host "  $sumsPath"
Write-Host "SHA256SUMS:"
Write-Host -NoNewline (Get-Content -Raw -LiteralPath $sumsPath)
