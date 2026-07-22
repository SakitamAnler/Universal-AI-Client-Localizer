@echo off
title Universal AI Desktop Client Localizer Service
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    echo =======================================================
    echo  正在获取 Windows 管理员权限 (用于微软商店/系统目录读写)...
    echo =======================================================
    goto UACPrompt
) else ( goto gotAdmin )

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
    echo UAC.ShellExecute "cmd.exe", "/c ""%~s0""", "", "runas", 1 >> "%temp%\getadmin.vbs"
    "%temp%\getadmin.vbs"
    del "%temp%\getadmin.vbs"
    exit /B

:gotAdmin
    pushd "%~dp0"

echo =======================================================
echo  Universal AI Desktop Client Localizer Service
echo  (Antigravity 2.0 / Codex / OpenCode / Claude)
echo =======================================================
echo.
echo Starting localization backend service...
echo Opening dashboard in your default browser...
echo.

:: Open the browser dashboard
start "" "http://localhost:3388"

:: Start the node service
node localize.js

if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Failed to start the localization service.
  echo Please make sure Node.js is installed on your system.
  echo You can download it from https://nodejs.org
  echo.
  pause
)
