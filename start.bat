@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PORT=5050
set PY=.venv-windows\Scripts\python.exe
set URL=http://127.0.0.1:%PORT%

if not exist "%PY%" (
    echo 首次运行：正在创建虚拟环境并安装依赖（需要联网，可能需要几分钟）...
    where py >nul 2>nul
    if errorlevel 1 (
        python -m venv .venv-windows
    ) else (
        py -3 -m venv .venv-windows
    )
    %PY% -m pip install --upgrade pip
    %PY% -m pip install -r requirements.txt
)

rem 轮询 /health，服务真正就绪后再打开浏览器（最多等 60 秒，避免先开页面后起服务）
start /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{$null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:%PORT%/health'; Start-Process '%URL%'; break}catch{Start-Sleep -Seconds 1}}"

echo PhyMathia 启动中: %URL%
echo 关闭本窗口即停止服务
%PY% src\main.py -p %PORT%
