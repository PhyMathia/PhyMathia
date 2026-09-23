@echo off
rem ===== 把 .pmu 注册成「双击即开」的文件类型（Windows）=====
rem 原理：assoc 定义 .pmu 扩展名类型 + ftype 指定打开命令（python 启动器）。
rem 以管理员或普通用户运行均可（写入 HKCU/HKLM 由系统决定）。卸载：install_windows.bat --uninstall
setlocal

set SCRIPT_DIR=%~dp0
set OPENER=%SCRIPT_DIR%open_pmu.py
set ASSOC_NAME=PhyMathUtopiaFile

if "%~1"=="--uninstall" (
  assoc .pmu= 2>nul
  ftype %ASSOC_NAME%= 2>nul
  echo 已卸载 .pmu 文件关联。
  pause
  exit /b 0
)

if not exist "%OPENER%" (
  echo 找不到启动器：%OPENER%
  pause
  exit /b 1
)

rem 找一个可用的 Python（py launcher 优先，其次 PATH 里的 python）
set "PYCMD="
where py >nul 2>nul && set "PYCMD=py"
if "%PYCMD%"=="" (
  where python >nul 2>nul && set "PYCMD=python"
)
if "%PYCMD%"=="" (
  echo 未找到 Python，请先安装 Python 3 并勾选 "Add to PATH"。
  pause
  exit /b 1
)

rem assoc/ftype 修改的是文件类型注册表；普通用户运行若被拒，请右键"以管理员身份运行"
assoc .pmu=%ASSOC_NAME%
ftype %ASSOC_NAME%="%PYCMD%" "%OPENER%" "%%1" %%*

echo.
echo 安装完成。现在双击任意 .pmu 文件就会用 PhyMathia 查看器打开。
echo （若双击无反应：右键 .pmu 文件 → 打开方式 → 选择其他应用 → 选 PhyMathia/Python）
pause
