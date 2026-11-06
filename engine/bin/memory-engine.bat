@echo off
rem 记忆引擎服务启动器（2026-11-06）
rem 需要 Java 17+；系统 PATH 里是 Java 11 时会自动去找 jdk17。
rem 用法：memory-engine.bat    （MEMORY_DATA_DIR 可指定数据目录）
setlocal enabledelayedexpansion
set DIR=%~dp0
if "%MEMORY_DATA_DIR%"=="" set MEMORY_DATA_DIR=%USERPROFILE%\.dsh\storages\memory-engine

set JAVA_EXE=

rem 1) 明确指定
if not "%MEMORY_JAVA%"=="" (
  if exist "%MEMORY_JAVA%" set JAVA_EXE=%MEMORY_JAVA%
)

rem 2) JAVA_HOME
if "%JAVA_EXE%"=="" if not "%JAVA_HOME%"=="" (
  if exist "%JAVA_HOME%\bin\java.exe" set JAVA_EXE=%JAVA_HOME%\bin\java.exe
)

rem 3) 常见安装位置（优先 17+）
if "%JAVA_EXE%"=="" (
  for %%P in (
    "D:\jdk17\bin\java.exe"
    "C:\Program Files\Java\jdk-17\bin\java.exe"
    "C:\Program Files\Eclipse Adoptium\jdk-17*\bin\java.exe"
    "C:\Program Files\Java\jdk-21\bin\java.exe"
    "C:\Program Files\Java\jdk-22\bin\java.exe"
  ) do (
    if "%JAVA_EXE%"=="" if exist %%P set JAVA_EXE=%%P
  )
)

rem 4) 退回 PATH 里的 java，但要检查版本
if "%JAVA_EXE%"=="" (
  for /f "delims=" %%J in ('where java 2^>nul') do (
    if "%JAVA_EXE%"=="" set JAVA_EXE=%%J
  )
)

if "%JAVA_EXE%"=="" (
  echo [错误] 没找到 Java。
  echo        请安装 JDK 17 或更高：https://adoptium.net/
  echo        或用 MEMORY_JAVA=路径\java.exe 指定。
  pause
  exit /b 1
)

rem 版本检查：主版本号必须 >= 17
set VER_OK=0
for /f "tokens=2 delims= " %%V in ('""%JAVA_EXE%" -version 2>&1 | findstr /i "version""') do (
  set RAW=%%V
  set RAW=!RAW:"=!
  for /f "delims=." %%M in ("!RAW!") do (
    if %%M GEQ 17 set VER_OK=1
  )
)
if "%VER_OK%"=="0" (
  echo [错误] 当前 Java 版本低于 17：
  "%JAVA_EXE%" -version
  echo        记忆引擎需要 Java 17+。装好后重试，或用 MEMORY_JAVA 指定 17。
  pause
  exit /b 1
)

echo 引擎启动中…… 端口 8787
echo   java   : %JAVA_EXE%
echo   数据目录: %MEMORY_DATA_DIR%
"%JAVA_EXE%" -Dfile.encoding=UTF-8 -cp "%DIR%..\lib\*" com.aicompanion.memory.demo.ServerKt
endlocal
