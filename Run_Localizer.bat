@echo off
title Universal AI Desktop Client Localizer Service
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
