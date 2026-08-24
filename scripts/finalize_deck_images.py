#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""截图终装：PNG→JPG(1600×1000,≤500KB) → images/，删除旧占位图。"""

import os
import sys
from PIL import Image

STAGING = os.path.abspath(os.path.join(os.path.dirname(__file__), "..",
                       "html", "PhyMathia-参赛介绍", "images", "_staging"))
IMAGES = os.path.abspath(os.path.join(os.path.dirname(__file__), "..",
                         "html", "PhyMathia-参赛介绍", "images"))

SHOTS = ["03-dual-domain", "04-graph-net", "05-viz-iframe", "06-knowledge",
         "07-formulas", "08-quiz", "09-phi-harness", "10-sessions"]

OLD_PLACEHOLDERS = ["03-dark-landscape.jpg", "04-graph.jpg", "05-visual.jpg",
                    "06-light-landscape.jpg", "08-dark-portrait.jpg", "09-light-portrait.jpg"]


def main():
    only = sys.argv[1:] if len(sys.argv) > 1 else SHOTS
    for name in only:
        src = os.path.join(STAGING, name + ".png")
        if not os.path.exists(src):
            print("跳过（无 %s）" % name)
            continue
        im = Image.open(src).convert("RGB")
        if im.size != (1600, 1000):
            # 超采样原片 → LANCZOS 缩回目标尺寸（更锐）
            im = im.resize((1600, 1000), Image.LANCZOS)
        dst = os.path.join(IMAGES, name + ".jpg")
        q = 90
        while q >= 70:
            im.save(dst, "JPEG", quality=q, optimize=True, progressive=True)
            if os.path.getsize(dst) <= 500 * 1024:
                break
            q -= 6
        print("%-18s → %s (%dKB, q=%d)" % (name + ".jpg", dst, os.path.getsize(dst) // 1024, q))
    for old in OLD_PLACEHOLDERS:
        p = os.path.join(IMAGES, old)
        if os.path.exists(p):
            os.remove(p)
            print("已删旧占位图 %s" % old)


if __name__ == "__main__":
    main()
