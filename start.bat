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

rem 4 秒后（等服务就绪）自动打开浏览器
start /min cmd /c "timeout /t 4 /nobreak >nul && start %URL%"

echo PhyMathia 启动中: %URL%
echo 关闭本窗口即停止服务
%PY% src\main.py -p %PORT%
