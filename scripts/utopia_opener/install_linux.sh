#!/usr/bin/env bash
# ===== 把 .pmu 注册成「双击即开」的文件类型（Linux / XDG 桌面）=====
# 原理：① 在用户级 shared-mime-info 注册 application/x-phymath-utopia 类型（*.pmu）；
#       ② 建一个桌面入口指向本仓库的 open_pmu.py；
#       ③ xdg-mime 把该类型默认打开方式设为这个入口。
# 卸载：./install_linux.sh --uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENER="$SCRIPT_DIR/open_pmu.py"
DESKTOP_ID="phymathia-viewer.desktop"
MIME_TYPE="application/x-phymath-utopia"
PY="${PYTHON:-python3}"

APPS_DIR="$HOME/.local/share/applications"
MIME_PKG_DIR="$HOME/.local/share/mime/packages"
DESKTOP_FILE="$APPS_DIR/$DESKTOP_ID"
MIME_FILE="$MIME_PKG_DIR/x-phymath.xml"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$DESKTOP_FILE" "$MIME_FILE" "$HOME/.config/mimeapps.list.bak-phymathia" 2>/dev/null || true
  # 从 mimeapps.list 里移除本类型关联（保留其它关联）
  if [[ -f "$HOME/.config/mimeapps.list" ]]; then
    sed -i "\\|$MIME_TYPE=$DESKTOP_ID|d" "$HOME/.config/mimeapps.list" || true
  fi
  command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$HOME/.local/share/mime" || true
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true
  echo "已卸载 .pmu 文件关联。"
  exit 0
fi

[[ -f "$OPENER" ]] || { echo "找不到启动器：$OPENER" >&2; exit 1; }
command -v "$PY" >/dev/null 2>&1 || { echo "未找到 $PY，请先安装 Python 3 或用 PYTHON=/路径 重新运行" >&2; exit 1; }

mkdir -p "$APPS_DIR" "$MIME_PKG_DIR"

# ① mime 类型：让系统认识 *.pmu
cat > "$MIME_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="$MIME_TYPE">
    <comment>PhyMathia Utopia 快照</comment>
    <glob pattern="*.pmu"/>
  </mime-type>
</mime-info>
EOF
command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$HOME/.local/share/mime" || \
  echo "（提示：系统没有 update-mime-database，若双击不生效请安装 shared-mime-info 包）"

# ② 桌面入口（NoDisplay：不出现在应用菜单，只作为文件的打开方式）
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=PhyMathia 查看器
Comment=打开 PhyMathia Utopia 探索网快照（.pmu）
Exec=$PY "$OPENER" %f
Terminal=false
MimeType=$MIME_TYPE;
NoDisplay=true
StartupNotify=false
Categories=Education;Science;
EOF
chmod +x "$OPENER"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true

# ③ 默认打开方式
xdg-mime default "$DESKTOP_ID" "$MIME_TYPE"

echo "安装完成。现在双击任意 .pmu 文件就会用 PhyMathia 查看器打开。"
echo "验证：xdg-mime query default $MIME_TYPE"
