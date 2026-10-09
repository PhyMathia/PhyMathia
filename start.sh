#!/usr/bin/env bash
# PhyMathia 一键启动脚本（Linux / macOS）
# 双击运行（需文件管理器允许执行），或在终端里 ./start.sh
# 首次运行会自动创建虚拟环境并安装依赖（需联网）
# 换端口：PHYMATHIA_PORT=5060 ./start.sh

cd "$(dirname "$(readlink -f "$0")")" || exit 1
PORT="${PHYMATHIA_PORT:-5050}"
PY=".venv-linux/bin/python"
URL="http://127.0.0.1:$PORT"

port_busy() {
    "$PY" -c "import socket;s=socket.socket();s.settimeout(0.5);exit(0 if s.connect_ex(('127.0.0.1',$PORT))==0 else 1)" 2>/dev/null
}

if [ ! -x "$PY" ]; then
    echo "首次运行：正在创建虚拟环境并安装依赖（需要联网，可能需要几分钟）..."
    python3 -m venv --copies .venv-linux || { echo "创建虚拟环境失败：请先安装 python3-venv"; exit 1; }
    "$PY" -m pip install --upgrade pip
    "$PY" -m pip install -r requirements.txt || { echo "依赖安装失败，请检查网络后重试"; exit 1; }
fi

if port_busy; then
    echo "端口 $PORT 已被占用：可能已经有一个 PhyMathia 正在运行，直接为你打开页面。"
    echo "如需重启服务，请先关闭原来的 PhyMathia 窗口。"
    xdg-open "$URL" >/dev/null 2>&1 || true
    exit 0
fi

"$PY" src/main.py -p "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

echo "正在启动 PhyMathia..."
for _ in $(seq 1 30); do
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "服务启动失败，请查看上方报错信息"; exit 1; }
    "$PY" -c "import urllib.request;urllib.request.urlopen('$URL/',timeout=1)" 2>/dev/null && break
    sleep 1
done
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || { echo "启动失败：端口 $PORT 已被其他程序占用"; exit 1; }

echo "PhyMathia 已启动: $URL"
echo "关闭本窗口或按 Ctrl+C 即停止服务"
xdg-open "$URL" >/dev/null 2>&1 || true
wait "$SERVER_PID"
