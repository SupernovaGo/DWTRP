@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem 统一 UTF-8 输出，避免中文在部分终端 / 重定向时乱码
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

set "ROOT=%CD%"
set "PY="

rem 准备环境用“全新”的 Python（.venv 由脚本自己创建）
if defined TRPE_BOOTSTRAP_PYTHON if exist "%TRPE_BOOTSTRAP_PYTHON%" set "PY=%TRPE_BOOTSTRAP_PYTHON%"
if not defined PY for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY for /f "delims=" %%i in ('python -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY if exist "%ROOT%\.venv\Scripts\python.exe" set "PY=%ROOT%\.venv\Scripts\python.exe"

if not defined PY (
  echo [ERROR] 未找到 Python，无法自动准备环境。
  echo         请先安装 Python 3.11+： https://www.python.org/downloads/
  echo         安装时请勾选 "Add python.exe to PATH"。
  pause
  exit /b 1
)

"%PY%" -c "import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)" 2>nul
if errorlevel 1 (
  echo [ERROR] Python 版本过低：%PY%
  echo        本项目需要 Python 3.11 及以上。
  pause
  exit /b 1
)

echo 使用的 Python：%PY%
echo.
"%PY%" "%ROOT%\scripts\setup_env.py" %*
pause
