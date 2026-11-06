@echo off
rem 云图记忆插件 · 一键安装（2026-11-06）
rem 只做三件事：拷贝插件、登记 profile、写好 patch；每步都先备份。
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1"
echo.
pause
endlocal
