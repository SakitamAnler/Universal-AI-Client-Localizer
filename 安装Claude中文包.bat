@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ============================================================
:: Claude Desktop 中文语言包安装脚本
:: 直接将 zh-CN.json 写入 Claude Desktop resources 目录
:: 请右键 → 以管理员身份运行 此批处理文件
:: ============================================================

echo.
echo ====================================================
echo   Claude Desktop 中文语言包安装工具
echo   版本：v1.0  by Universal-AI-Client-Localizer
echo ====================================================
echo.

:: 检查是否以管理员身份运行
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 请右键此文件，选择"以管理员身份运行"！
    echo.
    pause
    exit /b 1
)

echo [√] 已检测到管理员权限

:: 获取 Claude Desktop 安装路径
for /f "tokens=*" %%i in ('powershell -Command "try { (Get-AppxPackage -Name 'Claude').InstallLocation } catch { '' }"') do set "CLAUDE_ROOT=%%i"

if "!CLAUDE_ROOT!"=="" (
    echo [!] 未能自动检测到 Claude Desktop 安装路径
    echo     请手动输入 Claude Desktop 的 app 目录路径：
    echo     例如：C:\Program Files\WindowsApps\Claude_1.24012.1.0_x64__pzs8sxrjxfjjc\app
    echo.
    set /p CLAUDE_ROOT="路径: "
)

set "RESOURCES_DIR=!CLAUDE_ROOT!\resources"
set "DEST_FILE=!RESOURCES_DIR!\zh-CN.json"
set "SRC_FILE=%~dp0zh-CN-claude.json"

echo.
echo [*] Claude 安装路径：!CLAUDE_ROOT!
echo [*] resources 目录：!RESOURCES_DIR!
echo [*] 翻译文件来源：!SRC_FILE!
echo [*] 目标写入路径：!DEST_FILE!
echo.

:: 检查源文件存在
if not exist "!SRC_FILE!" (
    echo [错误] 找不到翻译文件：!SRC_FILE!
    echo        请确保 zh-CN-claude.json 在同一目录中
    pause
    exit /b 1
)

:: 检查 Claude resources 目录是否存在
if not exist "!RESOURCES_DIR!" (
    echo [错误] 找不到 Claude Desktop resources 目录：!RESOURCES_DIR!
    echo        请确认 Claude Desktop 已正确安装
    pause
    exit /b 1
)

echo [*] 正在获取目录所有权...
takeown /F "!RESOURCES_DIR!" /A /R /D Y >nul 2>&1

echo [*] 正在授予写入权限...
icacls "!RESOURCES_DIR!" /grant *S-1-5-32-544:F /T /C /Q >nul 2>&1
icacls "!RESOURCES_DIR!" /grant Administrators:F /T /C /Q >nul 2>&1

echo [*] 正在复制中文语言包...
copy /Y "!SRC_FILE!" "!DEST_FILE!" >nul 2>&1

if exist "!DEST_FILE!" (
    echo.
    echo ====================================================
    echo   ✅ 中文语言包安装成功！
    echo.
    echo   zh-CN.json 已写入：
    echo   !DEST_FILE!
    echo.
    echo   您的系统语言设置：
    powershell -Command "(Get-WinUserLanguageList).LanguageTag" 2>nul
    echo.
    echo   请重新启动 Claude Desktop，界面将自动显示中文。
    echo ====================================================
) else (
    echo.
    echo [错误] 复制失败！即使是管理员权限也无法写入。
    echo.
    echo 这可能是因为 Claude Desktop 正在运行，请：
    echo   1. 完全退出 Claude Desktop（右键托盘图标 → 退出）
    echo   2. 在任务管理器中结束所有 claude.exe 进程
    echo   3. 然后重新运行此脚本
    echo.
    echo 如仍失败，请手动操作：
    echo   将 !SRC_FILE!
    echo   复制到 !DEST_FILE!
)

echo.
pause
