#!/usr/bin/env python3
"""导出 git 提交记录为多张 A4 尺寸 PNG（可打印），并合成一份同名 PDF。

用法:
  python3 scripts/export_git_log_a4.py                     # 默认 200 DPI、时间正序
  python3 scripts/export_git_log_a4.py --dpi 300 --order latest
  python3 scripts/export_git_log_a4.py --out 导出图片/git-log-a4 --limit 50

输出: <out>/page-01.png ... page-NN.png + git-log-a4.pdf
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
A4_SIZES = {150: (1240, 1754), 200: (1654, 2339), 300: (2480, 3508)}

# A4 纸面配色（浅底深字，适合打印）
BG = (255, 255, 255)
INK = (23, 29, 46)
SUB = (104, 112, 130)
FAINT = (168, 176, 192)
ACCENT = (63, 94, 251)
ACCENT_DEEP = (38, 64, 196)
ACCENT_SOFT = (233, 238, 255)
LINE = (226, 231, 240)
ZEBRA = (247, 249, 253)
GREEN = (21, 146, 80)
RED = (214, 69, 56)

FONT_CANDIDATES = [
    ("/home/sample/.fonts/msyh.ttc", "/home/sample/.fonts/msyhbd.ttc"),
    ("/mnt/c/Windows/Fonts/msyh.ttc", "/mnt/c/Windows/Fonts/msyhbd.ttc"),
    ("/home/sample/.fonts/Deng.ttf", "/home/sample/.fonts/Deng.ttf"),
]
MONO_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
]
_font_cache = {}


def _first_existing(pairs):
    for reg, bold in pairs:
        if Path(reg).exists() and Path(bold).exists():
            return reg, bold
    sys.exit("未找到可用中文字体（msyh.ttc / Deng.ttf）")


CJK_REG, CJK_BOLD = _first_existing(FONT_CANDIDATES)
MONO_PATH = next((p for p in MONO_CANDIDATES if Path(p).exists()), CJK_REG)


def F(size, bold=False, mono=False):
    key = (size, bold, mono)
    if key not in _font_cache:
        if mono:
            path = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" \
                if bold and Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf").exists() else MONO_PATH
            _font_cache[key] = ImageFont.truetype(path, size)
        else:
            path = CJK_BOLD if bold else CJK_REG
            try:
                _font_cache[key] = ImageFont.truetype(path, size, index=0)
            except Exception:
                _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


def lh(font, factor=1.38):
    a, d = font.getmetrics()
    return int((a + d) * factor)


def git_text(*args):
    r = subprocess.run(["git", *args], cwd=REPO, capture_output=True, check=True)
    return r.stdout.decode("utf-8")


def load_commits(order):
    FS, RS = "\x1f", "\x1e"
    raw = git_text("log", "--date=format:%Y-%m-%d %H:%M",
                   f"--pretty=format:%H{FS}%h{FS}%an{FS}%ad{FS}%d{FS}%s{FS}%b{RS}")
    commits = []
    for chunk in raw.split(RS):
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        h, hs, an, ad, deco, subj, body = (chunk.split(FS) + [""])[:7]
        tags, others = [], []
        for d in [x.strip() for x in deco.strip().strip("()").split(",") if x.strip()]:
            (tags if d.startswith("tag:") else others).append(d)
        commits.append({
            "hash": h, "short": hs, "author": an.strip(), "date": ad.strip(),
            "tags": tags, "others": others,
            "subject": subj.strip(), "body": body.strip(),
        })
    if order == "oldest":
        commits.reverse()  # git log 默认新→旧，反转为旧→新
    return commits


def load_stats():
    """hash -> (files, insertions, deletions)，来自 --shortstat。"""
    out = git_text("log", "--shortstat", "--format=%H")
    stats, cur = {}, None
    for line in out.splitlines():
        line = line.strip()
        if re.fullmatch(r"[0-9a-f]{40}", line):
            cur = line
        elif cur and "changed" in line:
            mf = re.search(r"(\d+) files? changed", line)
            mi = re.search(r"(\d+) insertions?\(", line)
            md = re.search(r"(\d+) deletions?\(", line)
            stats[cur] = (int(mf.group(1)) if mf else 0,
                          int(mi.group(1)) if mi else 0,
                          int(md.group(1)) if md else 0)
    return stats


def wrap_text(draw, text, font, maxw):
    """中英混排贪心换行：ASCII 词不拆，CJK 逐字换行，超长词硬切。"""
    lines, cur = [], ""
    for para in str(text).split("\n"):
        cur = ""
        if not para.strip():
            lines.append("")
            continue
        for tok in re.findall(r"[!-~]+|\s+|.", para):
            if tok.isspace():
                if cur and draw.textlength(cur + " ", font=font) <= maxw:
                    cur += " "
                elif cur:
                    lines.append(cur)
                    cur = ""
                continue
            if draw.textlength(cur + tok, font=font) <= maxw:
                cur += tok
            elif draw.textlength(tok, font=font) > maxw:
                for ch in tok:
                    if draw.textlength(cur + ch, font=font) <= maxw:
                        cur += ch
                    else:
                        lines.append(cur)
                        cur = ch
            else:
                if cur:
                    lines.append(cur)
                cur = tok
        lines.append(cur)
    return lines


class Renderer:
    def __init__(self, dpi, total, first_date, last_date, branch):
        self.W, self.H = A4_SIZES[dpi]
        s = dpi / 200.0
        self.s = s
        self.M = int(self.W * 0.082)
        self.f_title = F(int(46 * s), bold=True)
        self.f_meta = F(int(26 * s))
        self.f_idx = F(int(25 * s), mono=True)
        self.f_hash = F(int(25 * s), bold=True, mono=True)
        self.f_subj = F(int(32 * s), bold=True)
        self.f_body = F(int(26 * s))
        self.f_stat = F(int(24 * s), mono=True)
        self.f_footer = F(int(24 * s))
        self.f_badge = F(int(20 * s))
        self.header_h = int(148 * s)
        self.footer_h = int(64 * s)
        self.total = total
        self.first_date, self.last_date, self.branch = first_date, last_date, branch
        self.pages = []
        self.page_no = 0

    # ---- 页面骨架 ----
    def _new_page(self):
        self.page_no += 1
        img = Image.new("RGB", (self.W, self.H), BG)
        d = ImageDraw.Draw(img)
        x0, x1 = self.M, self.W - self.M
        y = self.M - int(8 * self.s)
        d.text((x0, y), "PhyMathia · Git 提交记录", font=self.f_title, fill=INK)
        sub = (f"{self.branch} 分支 · 共 {self.total} 个提交 · "
               f"{self.first_date} → {self.last_date}")
        d.text((x0, y + lh(self.f_title) + int(10 * self.s)), sub,
               font=self.f_meta, fill=SUB)
        d.text((x1, y + int(6 * self.s)), f"第 {self.page_no} 页",
               font=self.f_meta, fill=SUB, anchor="ra")
        d.line([(x0, self.M + self.header_h - int(26 * self.s)),
                (x1, self.M + self.header_h - int(26 * self.s))],
               fill=ACCENT, width=max(2, int(3 * self.s)))
        self.pages.append((img, d))
        return self.M + self.header_h  # 内容起始 y

    def _finish_page(self, d):
        x0, x1 = self.M, self.W - self.M
        y = self.H - self.M + int(14 * self.s)
        d.line([(x0, y - int(10 * self.s)), (x1, y - int(10 * self.s))], fill=LINE,
               width=max(1, int(1 * self.s)))

    def draw_footers(self):
        """全部页面渲染完成后补页脚（此时才知道总页数）。"""
        total = len(self.pages)
        for no, (img, d) in enumerate(self.pages, 1):
            y = self.H - self.M + int(20 * self.s)
            d.text((self.W // 2, y),
                   f"第 {no} / {total} 页 · PhyMathia — 物理数学双域解释与可视化助手",
                   font=self.f_footer, fill=FAINT, anchor="ma")

    # ---- 徽标 ----
    def _badge(self, d, x, y, text, fill=None, outline=None, fg=BG):
        pad_x, pad_y = int(10 * self.s), int(5 * self.s)
        w = d.textlength(text, font=self.f_badge)
        hgt = lh(self.f_badge) - int(6 * self.s)
        box = [x, y, x + w + pad_x * 2, y + hgt + pad_y * 2]
        d.rounded_rectangle(box, radius=int(7 * self.s), fill=fill, outline=outline,
                            width=max(1, int(1.4 * self.s)))
        d.text(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2 - int(1 * self.s)), text,
               font=self.f_badge, fill=fg, anchor="mm")
        return box[2] - box[0]

    # ---- 单条提交 ----
    def block_height(self, draw, c, cw):
        fh, fs, fb = lh(self.f_hash), lh(self.f_subj), lh(self.f_body)
        subj_lines = wrap_text(draw, c["subject"], self.f_subj, cw)
        body_lines = wrap_text(draw, c["body"], self.f_body, cw - int(36 * self.s)) if c["body"] else []
        h = fh + int(8 * self.s) + len(subj_lines) * fs + int(6 * self.s)
        h += len(body_lines) * fb + (int(6 * self.s) if body_lines else 0)
        if c["stat"]:
            h += lh(self.f_stat) + int(6 * self.s)
        h += int(26 * self.s)  # 底部留白
        return h, subj_lines, body_lines

    def draw_block(self, d, y, c, idx, cw, zebra, top_of_page):
        x0, x1 = self.M, self.W - self.M
        s = self.s
        bh, subj_lines, body_lines = self.block_height(d, c, cw)
        if zebra:
            d.rectangle([x0 - int(14 * s), y - int(4 * s), x1 + int(14 * s), y + bh - int(18 * s)],
                        fill=ZEBRA)
        # 元信息行：#序号  短哈希  [徽标]  作者 …… 日期(右对齐)
        d.text((x0, y), f"#{idx:03d}", font=self.f_idx, fill=FAINT)
        hx = x0 + d.textlength(f"#{idx:03d} ", font=self.f_idx)
        d.text((hx, y), c["short"], font=self.f_hash, fill=ACCENT_DEEP)
        bx = hx + d.textlength(c["short"] + " ", font=self.f_hash)
        for t in c["tags"]:
            bw = self._badge(d, bx, y - int(2 * s), t, fill=ACCENT)
            bx += bw + int(8 * s)
        for o in c["others"]:
            bw = self._badge(d, bx, y - int(2 * s), o, outline=ACCENT, fg=ACCENT_DEEP)
            bx += bw + int(8 * s)
        d.text((x1, y), f'{c["author"]} · {c["date"]}', font=self.f_idx, fill=SUB, anchor="ra")
        y += lh(self.f_hash) + int(8 * s)
        # 标题（提交说明首行，长标题自动换行）
        for ln in subj_lines:
            d.text((x0, y), ln, font=self.f_subj, fill=INK)
            y += lh(self.f_subj)
        y += int(6 * s)
        # 正文
        if body_lines:
            for ln in body_lines:
                d.text((x0 + int(36 * s), y), ln, font=self.f_body, fill=SUB)
                y += lh(self.f_body)
            y += int(6 * s)
        # 变更统计
        if c["stat"]:
            files, ins, dele = c["stat"]
            x = x0 + int(36 * s)
            seg = f"{files} file" if files == 1 else f"{files} files"
            d.text((x, y), seg, font=self.f_stat, fill=SUB)
            x += d.textlength(seg, font=self.f_stat) + int(10 * s)
            if ins:
                seg = f"+{ins}"
                d.text((x, y), seg, font=self.f_stat, fill=GREEN)
                x += d.textlength(seg, font=self.f_stat) + int(8 * s)
            if dele:
                seg = f"-{dele}"
                d.text((x, y), seg, font=self.f_stat, fill=RED)
                x += d.textlength(seg, font=self.f_stat) + int(8 * s)
            y += lh(self.f_stat)
        y += int(18 * s)
        if not top_of_page:
            d.line([(x0, y), (x1, y)], fill=LINE, width=max(1, int(1 * s)))
        return y + int(8 * s)

    def render(self, commits):
        scratch = Image.new("RGB", (8, 8))
        d0 = ImageDraw.Draw(scratch)
        cw = self.W - self.M * 2
        content_top = self.M + self.header_h
        content_bottom = self.H - self.M - self.footer_h
        y = self._new_page()
        first_on_page = True
        for i, c in enumerate(commits, 1):
            bh, _, _ = self.block_height(d0, c, cw)
            if y + bh > content_bottom and not first_on_page:
                self._finish_page(self.pages[-1][1])
                y = self._new_page()
                first_on_page = True
            img, d = self.pages[-1]
            y = self.draw_block(d, y, c, i, cw, zebra=(i % 2 == 0), top_of_page=first_on_page)
            first_on_page = False
        self._finish_page(self.pages[-1][1])
        self.draw_footers()
        return [img for img, _ in self.pages]


def main():
    ap = argparse.ArgumentParser(description="git 提交记录导出 A4 图片")
    ap.add_argument("--out", default=str(REPO / "导出图片" / "git-log-a4"))
    ap.add_argument("--dpi", type=int, default=200, choices=sorted(A4_SIZES))
    ap.add_argument("--order", choices=["oldest", "latest"], default="oldest",
                    help="oldest=时间正序（开发历程），latest=最新在前")
    ap.add_argument("--limit", type=int, default=0, help="只导出最近 N 条（0=全部）")
    args = ap.parse_args()

    commits = load_commits(args.order)
    if args.limit > 0:
        commits = commits[:args.limit] if args.order == "latest" else commits[-args.limit:]
    stats = load_stats()
    for c in commits:
        c["stat"] = stats.get(c["hash"])

    branch = git_text("rev-parse", "--abbrev-ref", "HEAD").strip()
    first_date = min(c["date"] for c in commits)
    last_date = max(c["date"] for c in commits)
    r = Renderer(args.dpi, len(commits), first_date[:10], last_date[:10], branch)
    pages = r.render(commits)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, img in enumerate(pages, 1):
        p = out / f"page-{i:02d}.png"
        img.save(p)
        paths.append(p)
    pdf = out / "git-log-a4.pdf"
    pages[0].save(pdf, save_all=True, append_images=pages[1:], resolution=args.dpi)

    print(f"共 {len(commits)} 个提交 → {len(paths)} 页 A4（{args.dpi} DPI，{A4_SIZES[args.dpi][0]}×{A4_SIZES[args.dpi][1]}px）")
    for p in paths:
        print("  ", p)
    print("  ", pdf)


if __name__ == "__main__":
    main()
