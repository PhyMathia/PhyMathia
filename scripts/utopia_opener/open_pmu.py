#!/usr/bin/env python3
# ===== PhyMathia Utopia 快照「双击打开」启动器 =====
# 双击 .pmu 时由系统文件关联调起（路径作为 argv[1]）：
#   1) 健康检查本机服务（默认 127.0.0.1:5050）；没跑就拉起 src/main.py 并等就绪
#   2) 把 .pmu 复制进服务端收件箱 data/utopia_inbox/（唯一写路径，服务端只读）
#   3) 用默认浏览器打开 viewer.html?from=inbox&id=<文件名>
# 安装方式见同目录 install_linux.sh / install_windows.bat。
# 也可手动命令行使用：python3 open_pmu.py <文件.pmu> [--port 5050] [--print-url]

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

# 仓库根 = 启动器所在位置上两级；多副本/测试环境可用 PHYMATHIA_ROOT 覆盖
ROOT = Path(os.environ.get('PHYMATHIA_ROOT') or Path(__file__).resolve().parent.parent.parent)
INBOX_LIMIT = 50  # 收件箱只保留最近 N 个（按修改时间），防无限增长


def _health_ok(port: int) -> bool:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def _ensure_server(port: int) -> bool:
    if _health_ok(port):
        return True
    main_py = ROOT / 'src' / 'main.py'
    if not main_py.is_file():
        print(f'[PhyMathia] 找不到服务入口：{main_py}', file=sys.stderr)
        return False
    print('[PhyMathia] 服务未启动，正在启动（首次需几秒）…')
    (ROOT / 'data').mkdir(parents=True, exist_ok=True)  # 全新副本可能还没有 data/
    log = open(ROOT / 'data' / 'utopia_opener.log', 'ab')
    subprocess.Popen(
        [sys.executable, str(main_py), '-p', str(port)],
        cwd=str(ROOT), stdout=log, stderr=log,
        start_new_session=(sys.platform != 'win32'),
        creationflags=0x00000008 if sys.platform == 'win32' else 0,  # DETACHED_PROCESS
    )
    for _ in range(60):  # 最多等 30 秒
        time.sleep(0.5)
        if _health_ok(port):
            return True
    print('[PhyMathia] 服务启动超时，请手动运行 python3 src/main.py -p 5050 后重试', file=sys.stderr)
    return False


def _deliver(pmu: Path, port: int) -> str:
    """复制进收件箱，返回服务端文件名。"""
    inbox = ROOT / 'data' / 'utopia_inbox'
    inbox.mkdir(parents=True, exist_ok=True)
    # 文件名白名单与服务端一致：安全字符 + .pmu 后缀；重名加时间戳不覆盖
    stem = ''.join(c if (c.isalnum() or c in '-_.') else '_' for c in pmu.stem)[:40] or 'snapshot'
    name = stem + '.pmu'
    stamp = int(time.time())
    if (inbox / name).exists():
        name = f'{stem}_{stamp}.pmu'
    shutil.copy2(pmu, inbox / name)
    # 收件箱保活：只留最近 N 份
    files = sorted(inbox.glob('*.pmu'), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[INBOX_LIMIT:]:
        try:
            old.unlink()
        except OSError:
            pass
    return name


def main() -> int:
    parser = argparse.ArgumentParser(description='双击打开 PhyMathia Utopia 快照（.pmu）')
    parser.add_argument('pmu', nargs='?', help='.pmu 文件路径')
    parser.add_argument('--port', type=int, default=5050)
    parser.add_argument('--print-url', action='store_true', help='只打印 URL，不调浏览器（自测用）')
    args = parser.parse_args()

    if not args.pmu:
        parser.error('缺少 .pmu 文件路径')
    pmu = Path(args.pmu).expanduser().resolve()
    if not pmu.is_file():
        print(f'[PhyMathia] 文件不存在：{pmu}', file=sys.stderr)
        return 1

    if not _ensure_server(args.port):
        return 2
    try:
        name = _deliver(pmu, args.port)
    except OSError as e:
        print(f'[PhyMathia] 快照投递失败：{e}', file=sys.stderr)
        return 3
    url = f'http://127.0.0.1:{args.port}/viewer.html?from=inbox&id={urllib.parse.quote(name)}'
    if args.print_url:
        print(url)
    else:
        webbrowser.open(url)
        print(f'[PhyMathia] 已在浏览器打开：{url}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
