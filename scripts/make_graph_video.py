#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探索网超高清大图 → S 形巡览视频 (1920x1080)。

虚拟摄像机时间线：全景定位 → 放大到可读倍率 → 沿 S 形蛇形路线扫过画布 → 拉回全景。
每帧用 Pillow AFFINE 双三次插值从原图取景（亚像素平滑不抖动），帧直通 ffmpeg 编码 H.264。
用法: python3 scripts/make_graph_video.py --image 导出图片/xx.png [--duration 30 --rows 3 --preview]
"""
import argparse
import math
import os
import shutil
import subprocess
import sys

from PIL import Image

# 输入是用户自己导出的超大 PNG（常超 89MP 默认阈值），关闭解压炸弹防护
Image.MAX_IMAGE_PIXELS = None

OUT_W, OUT_H = 1920, 1080
ASPECT = OUT_W / OUT_H


def hex_to_rgb(s):
    s = s.strip().lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def loglerp(a, b, t):
    """视窗宽度按几何插值过渡，缩放观感更自然。"""
    return math.exp(math.log(a) * (1 - t) + math.log(b) * t)


def catmull_rom(points, t):
    """Catmull-Rom 样条：t∈[0,1] 均匀经过全部路径点，转角圆滑成 S 曲线。"""
    n = len(points)
    if n == 1:
        return points[0]
    seg = min(int(t * (n - 1)), n - 2)
    local = t * (n - 1) - seg
    p0 = points[max(seg - 1, 0)]
    p1 = points[seg]
    p2 = points[seg + 1]
    p3 = points[min(seg + 2, n - 1)]

    def cr(a, b, c, d, u):
        return 0.5 * ((2 * b) + (-a + c) * u +
                      (2 * a - 5 * b + 4 * c - d) * u * u +
                      (-a + 3 * b - 3 * c + d) * u * u * u)

    return tuple(cr(p0[k], p1[k], p2[k], p3[k], local) for k in range(len(p1)))


class Camera:
    """视窗由中心 (cx,cy) 与视窗宽度 vw 描述，渲染时映射到 1920x1080。"""

    def __init__(self, img_w, img_h):
        self.iw, self.ih = img_w, img_h

    def clamp(self, cx, cy, vw):
        vh = vw / ASPECT
        cx = min(max(cx, vw / 2), max(self.iw - vw / 2, vw / 2))
        cy = min(max(cy, vh / 2), max(self.ih - vh / 2, vh / 2))
        return cx, cy

    def render(self, base, cx, cy, vw):
        cx, cy = self.clamp(cx, cy, vw)
        vh = vw / ASPECT
        a = vw / OUT_W
        e = vh / OUT_H
        coeffs = (a, 0, cx - (OUT_W / 2) * a,
                  0, e, cy - (OUT_H / 2) * e)
        return base.transform((OUT_W, OUT_H), Image.AFFINE, coeffs,
                              resample=Image.BICUBIC)


BG_FILL = [0, 0, 0]


def cam_render(base, iw, ih, cx, cy, vw):
    """按视窗中心与宽度从大图取一帧 1920x1080（亚像素双三次插值）。"""
    vh = vw / ASPECT
    cx = min(max(cx, vw / 2), max(iw - vw / 2, vw / 2))
    cy = min(max(cy, vh / 2), max(ih - vh / 2, vh / 2))
    a = vw / OUT_W
    e = vh / OUT_H
    coeffs = (a, 0, cx - (OUT_W / 2) * a,
              0, e, cy - (OUT_H / 2) * e)
    return base.transform((OUT_W, OUT_H), Image.AFFINE, coeffs,
                          resample=Image.BICUBIC,
                          fillcolor=tuple(BG_FILL))


def build_timeline(img_w, img_h, args):
    vw_over = max(img_w * 1.03, img_h * ASPECT)
    cx0, cy0 = img_w / 2, img_h / 2
    vw_det = max(min(img_w * args.detail_frac, img_w), OUT_W / 4)
    det_h = min(vw_det / ASPECT, img_h * 0.96)
    vw_det = det_h * ASPECT

    rows = max(1, args.rows)
    ys = []
    if rows == 1:
        ys.append(img_h / 2)
    else:
        top = det_h / 2 * 0.92
        bot = img_h - det_h / 2 * 0.92
        for i in range(rows):
            ys.append(top + (bot - top) * i / (rows - 1))
    xin = vw_det * 0.44
    xl, xr = xin, img_w - xin
    path = []
    for i, y in enumerate(ys):
        path.append((xl if i % 2 == 0 else xr, y, vw_det))
        path.append((xr if i % 2 == 0 else xl, y, vw_det))

    T = {"hold0": 0.10, "dive": 0.12, "sweep": 0.62, "rise": 0.11, "hold1": 0.05}

    def state(p):
        b0 = T["hold0"]
        b1 = b0 + T["dive"]
        b2 = b1 + T["sweep"]
        b3 = b2 + T["rise"]
        if p < b0:
            drift = (p / b0) - 0.5
            return cx0 + drift * img_w * 0.01, cy0, vw_over
        if p < b1:
            t = smoothstep((p - b0) / T["dive"])
            sx, sy, sw = path[0]
            return (cx0 + (sx - cx0) * t,
                    cy0 + (sy - cy0) * t,
                    loglerp(vw_over, sw, t))
        if p < b2:
            t = smoothstep((p - b1) / T["sweep"])
            x, y, w = catmull_rom(path, t)
            return x, y, w
        if p < b3:
            t = smoothstep((p - b2) / T["rise"])
            lx, ly, lw = path[-1]
            return (lx + (cx0 - lx) * t,
                    ly + (cy0 - ly) * t,
                    loglerp(lw, vw_over, t))
        return cx0, cy0, vw_over

    return state


def find_ffmpeg(explicit):
    if explicit:
        return explicit
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    bindir = os.path.normpath(os.path.join(here, "..", ".video-build", "pylib",
                                           "imageio_ffmpeg", "binaries"))
    if os.path.isdir(bindir):
        for f in sorted(os.listdir(bindir)):
            if f.startswith("ffmpeg-"):
                return os.path.join(bindir, f)
    raise SystemExit("找不到 ffmpeg：请安装 ffmpeg 或用 --ff 指定路径")


def main():
    ap = argparse.ArgumentParser(description="探索网大图 → S 形巡览视频")
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--duration", type=float, default=30.0)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--rows", type=int, default=3)
    ap.add_argument("--detail-frac", type=float, default=0.34)
    ap.add_argument("--bg", default="#0f142d")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--ff", default="")
    ap.add_argument("--preview", action="store_true", help="只输出关键帧 PNG 检查构图")
    args = ap.parse_args()

    bg_rgb = hex_to_rgb(args.bg)
    BG_FILL[:] = list(bg_rgb)  # 视窗超出原图时的填充色与背景一致
    print("加载图片…", args.image)
    im = Image.open(args.image).convert("RGBA")
    iw, ih = im.size
    print(f"原图 {iw}x{ih}")
    bg_img = Image.new("RGBA", im.size, bg_rgb + (255,))
    base = Image.alpha_composite(bg_img, im).convert("RGB")
    im.close()

    state = build_timeline(iw, ih, args)
    stem = os.path.splitext(os.path.basename(args.image))[0]
    out_dir = os.path.dirname(os.path.abspath(args.image))
    out_path = args.out or os.path.join(out_dir, stem + "_S形巡览.mp4")

    if args.preview:
        prev_dir = os.path.join(out_dir, ".preview_frames")
        os.makedirs(prev_dir, exist_ok=True)
        marks = [("a_全景", 0.05), ("b_俯冲", 0.17), ("c_S行1", 0.33),
                 ("d_S中段", 0.52), ("e_S末段", 0.74), ("f_收尾全景", 0.97)]
        for tag, p in marks:
            cx, cy, vw = state(p)
            fr = cam_render(base, iw, ih, cx, cy, vw)
            fp = os.path.join(prev_dir, tag + ".png")
            fr.save(fp)
            print("预览帧:", fp, "(中心 %.0f,%.0f 视窗宽 %.0f)" % (cx, cy, vw))
        print("完成：仅生成预览帧")
        return

    ff = find_ffmpeg(args.ff)
    total = max(2, int(args.duration * args.fps))
    print(f"编码 {total} 帧 → {out_path}")
    cmd = [ff, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{OUT_W}x{OUT_H}", "-r", str(args.fps), "-i", "-",
           "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    fade_n = int(args.fps * 0.45)
    flat = Image.new("RGB", (OUT_W, OUT_H), bg_rgb)
    err_tail = b""
    try:
        for i in range(total):
            p = i / (total - 1)
            cx, cy, vw = state(p)
            fr = cam_render(base, iw, ih, cx, cy, vw)
            if i < fade_n:
                fr = Image.blend(flat, fr, (i + 1) / fade_n)
            k = total - 1 - i
            if k < fade_n:
                fr = Image.blend(flat, fr, (k + 1) / fade_n)
            proc.stdin.write(fr.tobytes())
            if i % max(1, total // 10) == 0:
                print(f"  渲染 {round(p * 100)}%  视窗中心 ({cx:.0f},{cy:.0f}) 宽 {vw:.0f}", flush=True)
        proc.stdin.close()
        rc = proc.wait()
    except BrokenPipeError:
        rc = proc.wait()
    if rc != 0:
        raise SystemExit(f"ffmpeg 退出码 {rc}")
    size_mb = os.path.getsize(out_path) / 1048576
    print(f"完成：{out_path}  ({args.duration}s / {args.fps}fps / {size_mb:.1f} MB)")


if __name__ == "__main__":
    main()