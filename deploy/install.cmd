@echo off
rem TeamLens: cai lenh tl tu CMD. Lenh cai mot dong:
rem   curl -fsSL https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.cmd -o install.cmd && install.cmd && del install.cmd
rem File nay chi goi install.ps1 cua cung release qua PowerShell (irm ^| iex); moi viec cai nam o do.
rem TEAMLENS_INSTALL_BASE_URL (chi de test) thay base URL release; install.ps1 cung doc bien nay.
rem File giu ASCII va CRLF (.gitattributes): cmd.exe doc file .cmd theo code page OEM va xu ly dong LF kem.
rem Khong dung khoi ( ... ) quanh %PATH%: PATH thuong chua "(x86)" lam vo cu phap khoi.
setlocal
set "TL_BASE=https://github.com/MakitJenamin/TeamLens/releases/latest/download"
if defined TEAMLENS_INSTALL_BASE_URL set "TL_BASE=%TEAMLENS_INSTALL_BASE_URL%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; irm '%TL_BASE%/install.ps1' | iex; exit $LASTEXITCODE"
set "TL_EXIT=%ERRORLEVEL%"
if not "%TL_EXIT%"=="0" goto done
if not exist "%LOCALAPPDATA%\teamlens\bin\tl.exe" goto done
echo ;%PATH%; | find /i ";%LOCALAPPDATA%\teamlens\bin;" >nul
if not errorlevel 1 goto done
rem Them thu muc cai vao PATH cua chinh cua so cmd nay de dung tl ngay: file .cmd chay trong tien
rem trinh cmd dang mo, va lenh set dat sau endlocal tren cung dong thi con hieu luc sau khi script ket thuc.
endlocal & set "PATH=%LOCALAPPDATA%\teamlens\bin;%PATH%" & exit /b 0
:done
endlocal & exit /b %TL_EXIT%
