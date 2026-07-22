@echo off
chcp 65001 >nul
title Universal AI Client Localizer Service

:: Administrative Privileges Elevation Check
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    echo Requesting Administrator privileges for system/WindowsStore folder access...
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
echo Opening dashboard in default browser (http://localhost:3388)...
echo.

:: Open default browser
start "" "http://localhost:3388"

:: Start Node.js service
node localize.js

if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Failed to start localizer service.
  echo Please make sure Node.js is installed on your system.
  echo Download Node.js from: https://nodejs.org
  echo.
  pause
)
