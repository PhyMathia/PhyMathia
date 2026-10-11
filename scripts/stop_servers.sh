#!/usr/bin/env bash
# 一键查看/关闭本项目（PhyMathia）遗留的服务实例。
#
# 背景：多会话并行开发时，每个 AI 会话会各自起一个服务实例（不同端口），
# 会话结束后有时没关，残留实例每个占 60~120MB 内存。
#
# 用法（在本项目目录下执行）：
#   bash scripts/stop_servers.sh       # 只列出在跑的实例，不动任何东西
#   bash scripts/stop_servers.sh -y    # 关闭全部实例
#                                       （先确认没有正在使用的项目窗口！）
#
# 关闭后想再用项目，重新启动一个即可：
#   python3 src/main.py -p 5050

set -u

# 只匹配「本项目特征」的命令行，避免误杀其他项目的 python 进程
PATTERN='python.* src/main\.py -p'

mapfile -t PIDS < <(pgrep -f "$PATTERN")

if [ ${#PIDS[@]} -eq 0 ]; then
    echo "当前没有本项目（PhyMathia）的服务实例在运行。"
    exit 0
fi

echo "找到 ${#PIDS[@]} 个服务实例："
echo "--------------------------------------------------------------"
for pid in "${PIDS[@]}"; do
    port=$(ss -tlnp 2>/dev/null | grep "pid=$pid," | grep -oE '127\.0\.0\.1:[0-9]+' | head -1 | cut -d: -f2)
    rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
    rss_mb=$(( ${rss:-0} / 1024 ))
    elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    echo "  PID $pid  端口 ${port:-未知}  内存 ${rss_mb}MB  已运行 ${elapsed}"
done
echo "--------------------------------------------------------------"

if [ "${1:-}" != "-y" ]; then
    echo
    echo "以上只是列表，没有做任何改动。"
    echo "确认这些实例都不再需要后，执行：bash scripts/stop_servers.sh -y"
    exit 0
fi

echo
for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null && echo "已发送关闭信号：PID $pid"
done
sleep 2
# 2 秒后还没退的强制结束
for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null && echo "强制结束：PID $pid"
    fi
done
echo
echo "全部关闭。重新启动服务：python3 src/main.py -p 5050"
