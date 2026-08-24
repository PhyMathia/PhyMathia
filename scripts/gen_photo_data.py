#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PhyMathia 参赛介绍 · 粒子颜色数据生成器

把图片离线预采样成「每颗粒子一个颜色」的数据文件（images-data.js），
浏览器运行时只画不读像素，所以 file:// 双击打开也能用（避开 canvas 取色被 taint 的问题）。

用法:
    python3 scripts/gen_photo_data.py --dir html/PhyMathia-参赛介绍/images \
        --out html/PhyMathia-参赛介绍/images-data.js --cols 128 --rows 80 [file ...]

说明:
    - 默认把 --dir 下所有 jpg/jpeg/webp/png 都生成；也可直接给文件参数指定。
    - 数据键 = 相对 html 目录的路径（与 SLIDES 里 photo 字段一致，如 images/03-xxx.jpg）。
    - cols/rows 必须与 index.html 引擎里的 PC.cols / PC.rows 一致（默认 128 × 80）。
    - 采样使用 cover 裁切 + LANCZOS 缩放，保证图和网格对齐。
"""

import argparse
import base64
import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow：pip install Pillow")


def sample_grid(img_path, cols, rows):
    """把图片按 cover 方式填进 cols×rows 网格，返回展平的 RGB 字节列表。"""
    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    s = max(cols / W, rows / H)  # cover：图片缩放后铺满网格
    # 网格能看到的原图像素区域
    x0 = (cols - W * s) / 2.0 / s
    y0 = (rows - H * s) / 2.0 / s
    w0 = cols / s
    h0 = rows / s
    x0 = max(0.0, x0)
    y0 = max(0.0, y0)
    w0 = min(W - x0, w0)
    h0 = min(H - y0, h0)
    crop = im.crop((int(x0), int(y0), int(x0 + w0), int(y0 + h0)))
    small = crop.resize((cols, rows), Image.LANCZOS)  # 缩小以做颜色平均
    out = []
    px = small.load()
    for r in range(rows):
        for c in range(cols):
            p = px[c, r]
            out.extend((p[0], p[1], p[2]))
    return bytes(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", default="images", help="图片目录（缺省 images）")
    ap.add_argument("--out", default="images-data.js", help="输出文件")
    ap.add_argument("--cols", type=int, default=128, help="网格列数")
    ap.add_argument("--rows", type=int, default=80, help="网格行数")
    ap.add_argument("files", nargs="*", help="可选：指定图片文件（缺省用 --dir 下全部）")
    args = ap.parse_args()

    files = list(args.files)
    if not files and os.path.isdir(args.dir):
        for name in sorted(os.listdir(args.dir)):
            if name.lower().endswith((".jpg", ".jpeg", ".webp", ".png")):
                files.append(os.path.join(args.dir, name))
    if not files:
        sys.exit("没有可处理的图片（请检查 --dir 或传入文件参数）")

    out_dir = os.path.dirname(os.path.abspath(args.out))  # 即 html 目录，数据键相对它
    # 键：相对 html 目录的路径（与 SLIDES 里 photo 字段一致，如 images/03-xxx.jpg）
    def key(path):
        k = os.path.relpath(path, out_dir).replace("\\", "/")
        if k.startswith("./"):
            k = k[2:]
        return k

    lines = [
        "// PhyMathia 参赛介绍 · 粒子颜色数据（离线预采样，file:// 双击可用）",
        "// 键 = SLIDES 里 photo 字段的路径；由 scripts/gen_photo_data.py 自动生成，改照片后重新运行",
        "window.PHY_PARTICLE_DATA = window.PHY_PARTICLE_DATA || {};",
    ]
    for f in files:
        if not os.path.isfile(f):
            print("跳过（不存在）:", f)
            continue
        cells = sample_grid(f, args.cols, args.rows)
        b64 = base64.b64encode(cells).decode("ascii")
        lines.append(
            'window.PHY_PARTICLE_DATA[%s] = '
            '{"cols":%d,"rows":%d,"b64":"%s"};'
            % (json.dumps(key(f)), args.cols, args.rows, b64)
        )
    text = "\n".join(lines) + "\n"
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("已生成 %s（%d 张图片，合计 %.1f KB）"
          % (args.out, len(files), os.path.getsize(args.out) / 1024.0))


if __name__ == "__main__":
    main()
