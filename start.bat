@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem 统一 UTF-8 输出，避免中文在部分终端 / 重定向时乱码
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

set "ROOT=%CD%"
set "PY="

rem ---------- 1. 选择 Python 解释器 ----------
rem 优先：%DWTRP_PYTHON% > 项目内 .venv > py 启动器 > PATH 里的 python
if defined DWTRP_PYTHON if exist "%DWTRP_PYTHON%" set "PY=%DWTRP_PYTHON%"
if not defined PY if exist "%ROOT%\.venv\Scripts\python.exe" set "PY=%ROOT%\.venv\Scripts\python.exe"
if not defined PY for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY for /f "delims=" %%i in ('python -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"

if not defined PY goto :nopython

rem ---------- 2. 检查版本与依赖 ----------
"%PY%" -c "import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)" 2>nul
if errorlevel 1 goto :badversion

"%PY%" -c "import fastapi,uvicorn,numpy,jieba,rank_bm25,requests,tomli_w" 2>nul
if errorlevel 1 goto :nodeps

rem ---------- 3. 前端：必要时构建 ----------
where npm >nul 2>nul
if errorlevel 1 (
  if not exist "%ROOT%\web\dist\index.html" (
    echo [WARN] 未找到 npm，且 web\dist 不存在：界面将无法打开。
    echo        请安装 Node.js 后重新运行 start.bat，或直接使用已构建好的 dist。
  )
  goto :run
)

"%PY%" "%ROOT%\scripts\check_frontend.py" >nul 2>nul
if errorlevel 2 goto :build
if errorlevel 1 goto :build
goto :run

:build
if not exist "%ROOT%\web\node_modules" (
  echo 首次运行：安装前端依赖（npm install）...
  pushd "%ROOT%\web"
  call npm install
  popd
)
echo 构建前端（npm run build）...
pushd "%ROOT%\web"
call npm run build
popd
goto :run

rem ---------- 4. 启动后端 ----------
:run
echo.
echo 启动后端：http://127.0.0.1:8000
echo 手机 / 平板同 Wi-Fi 访问：http://本机局域网IP:8000 ^(IP 见「设置 → 个性化」^)
echo 按 Ctrl+C 停止服务。
echo.
start "" "http://127.0.0.1:8000"
"%PY%" "%ROOT%\server\main.py" --host 0.0.0.0 --port 8000 %*
pause
exit /b 0

:nopython
echo [ERROR] 未找到可用的 Python。
echo         请安装 Python 3.11 及以上版本： https://www.python.org/downloads/
echo         安装后运行 setup.bat 一键准备环境，或手动指定解释器：
echo             set DWTRP_PYTHON=C:\path\to\python.exe
pause
exit /b 1

:badversion
echo [ERROR] Python 版本过低：%PY%
echo        本项目需要 Python 3.11 及以上。
pause
exit /b 1

:nodeps
echo [WARN] 缺少必需依赖，是否现在自动安装？
choice /c YN /n /m "安装依赖 [Y/N]？"
if errorlevel 2 goto :nodepsexit
"%PY%" "%ROOT%\scripts\setup_env.py" --yes --no-venv
if errorlevel 1 goto :nodepsexit
goto :run

:nodepsexit
echo [ERROR] 依赖不完整。请运行 setup.bat，或手动执行：
echo         "%PY%" -m pip install -r requirements.txt
pause
exit /b 1
