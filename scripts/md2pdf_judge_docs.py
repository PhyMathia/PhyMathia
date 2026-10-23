#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""评委文档 Markdown → PDF 转换器（纯本地：python-markdown + LibreOffice）。

用法：
    python3 scripts/md2pdf_judge_docs.py [--outdir DIR] [md 文件 ...]

不带参数时转换 docs/参赛材料/评委文档/*.md。
图片一律内联为 data URI（含 repo 根的 baseline/shots/*.jpg），
远端徽章（img.shields.io）降级为文字，保证离线可渲染。
"""
from __future__ import annotations

import argparse
import base64
import html
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import markdown

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DIR = REPO / "docs" / "参赛材料" / "评委文档"

# ---------------------------------------------------------------- 打印样式
CSS = r"""
@page { size: A4; margin: 18mm 16mm 18mm 16mm; }
html { font-size: 10.5pt; }
body {
  font-family: "Noto Sans CJK SC", "Droid Sans Fallback", sans-serif;
  font-size: 10.5pt; line-height: 1.7; color: #1a1a1a;
  margin: 0; padding: 0; text-align: left;
}
h1, h2, h3, h4 { font-family: "Noto Sans CJK SC", sans-serif; color: #0f2b46; line-height: 1.35; }
h1 { font-size: 20pt; margin: 0 0 14pt; padding-bottom: 7pt; border-bottom: 2.2pt solid #0f2b46; }
h2 { font-size: 15pt; margin: 20pt 0 9pt; padding: 4pt 0 4pt 8pt; border-left: 4.5pt solid #2f7fd0;
     background: #eef4fb; page-break-after: avoid; }
h3 { font-size: 12.5pt; margin: 15pt 0 7pt; color: #1c4f80; page-break-after: avoid; }
h4 { font-size: 11pt; margin: 12pt 0 6pt; color: #333; page-break-after: avoid; }
p { margin: 6pt 0; }
a { color: #1a5fa8; text-decoration: none; }
strong { color: #0d2f4f; }
ul, ol { margin: 6pt 0 6pt 0; padding-left: 20pt; }
li { margin: 3pt 0; }
blockquote {
  margin: 9pt 0; padding: 7pt 11pt; background: #f5f8fb;
  border-left: 3.5pt solid #9dbfe0; color: #2b3a4a;
}
blockquote p { margin: 3pt 0; }
hr { border: 0; border-top: 1pt solid #d2dbe4; margin: 14pt 0; }
code { font-family: "Noto Sans Mono CJK SC", monospace; font-size: 9.5pt;
       background: #f2f4f7; padding: 1pt 3pt; color: #b03060; }
pre { background: #f7f8fa; border: 1pt solid #dfe4ea; border-radius: 3pt;
      padding: 8pt 10pt; margin: 8pt 0; page-break-inside: avoid; }
pre code { background: none; color: #24303c; font-size: 9pt; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 9pt 0; font-size: 9.5pt;
        page-break-inside: auto; }
th, td { border: 0.8pt solid #b9c6d3; padding: 5pt 7pt; vertical-align: top; text-align: left; }
th { background: #e8eff7; color: #0f2b46; font-weight: bold; }
tr { page-break-inside: avoid; }
img { max-width: 100%; margin: 6pt 0; }
table.figbox, table.figbox td { border: none !important; background: none !important; }
table.figbox td { text-align: center; }
.badges { font-size: 9pt; color: #55636f; margin: 6pt 0 10pt; }
.badges span { border: 0.8pt solid #c3ced9; border-radius: 8pt; padding: 1pt 6pt;
               margin-right: 5pt; background: #f6f8fa; }
#TOC { background: #fafbfc; border: 0.8pt solid #dde4ea; border-radius: 3pt;
       padding: 9pt 14pt; margin: 12pt 0 18pt; }
#TOC::before { content: "目录"; display: block; font-size: 13pt; font-weight: bold;
               color: #0f2b46; margin-bottom: 6pt; }
#TOC ul { list-style: none; padding-left: 12pt; margin: 3pt 0; }
#TOC > ul { padding-left: 0; }
#TOC li { margin: 2pt 0; font-size: 10pt; }
.doc-footer { margin-top: 18pt; padding-top: 7pt; border-top: 0.8pt solid #d2dbe4;
              font-size: 8.5pt; color: #77848f; }
"""

MD_EXT = ["extra", "tables", "fenced_code", "sane_lists", "attr_list",
          "md_in_html", "toc", "nl2br"]

BADGE_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<url>https?://[^)\s]*shields\.io[^)\s]*)\)")
IMG_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<url>[^)\s]+)(?:\s+\"[^\"]*\")?\)")


def data_uri(path: Path) -> str | None:
    if not path.is_file():
        return None
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def preprocess(text: str, md_path: Path) -> tuple[str, list[str]]:
    """徽章降级为文字；本地图片内联为 data URI。返回 (文本, 警告列表)。"""
    warns: list[str] = []

    def badge(m: re.Match) -> str:
        alt = m.group("alt").strip()
        return f"`{alt}`" if alt else ""

    text = BADGE_RE.sub(badge, text)

    def img(m: re.Match) -> str:
        url, alt = m.group("url"), m.group("alt")
        if url.startswith("data:"):
            return m.group(0)
        if re.match(r"^[a-z]+://", url):
            warns.append(f"远端图片未内联（离线可能空白）：{url}")
            return m.group(0)
        cand = (md_path.parent / url).resolve()
        if not cand.is_file():
            cand = (REPO / url).resolve()
        uri = data_uri(cand)
        if uri is None:
            warns.append(f"图片缺失，已跳过：{url}")
            return f"*（图片缺失：{url}）*"
        return f"![{alt}]({uri})"

    text = IMG_RE.sub(img, text)
    return text, warns


def build_html(md_path: Path, want_toc: bool | None = None) -> tuple[str, list[str]]:
    raw = md_path.read_text(encoding="utf-8")
    body_md, warns = preprocess(raw, md_path)
    # PDF 内嵌标题取文档首个 H1（LibreOffice 用 <title> 当 PDF 标题），
    # 否则改过名的文件在阅读器里还显示成 README
    m = re.search(r"^#\s+(.+?)\s*$", raw, re.M)
    doc_title = m.group(1).strip() if m else md_path.stem
    if want_toc is None:
        # 文档自带「目录」小节时不再自动生成，避免重复
        want_toc = not re.search(r"^#{1,3}\s*目录\s*$", raw, re.M)
    md = markdown.Markdown(extensions=MD_EXT, extension_configs={
        "toc": {"title": "目录", "toc_depth": "1-3", "anchorlink": False},
    })
    body = md.convert(body_md)
    toc = getattr(md, "toc", "") if want_toc else ""
    if toc:
        # LibreOffice 的 HTML 导入器不认 CSS 的 page-break-*，用 HTML 分页元素
        toc += '<br clear="all" style="page-break-before:always">'
    # 图片包进单格表格（LibreOffice 的 HTML 导入器对 <figure>/page-break-* 支持很差，
    # 会把图注排到与正文重叠；表格是它稳的路径），并写死 width 属性——它同样不认
    # img 的 CSS max-width，会把 1600px 截图按原尺寸铺开溢出好几页。
    # 正文宽 178mm ≈ 672px@96dpi，留边取 620。
    body = re.sub(
        r'<img (?![^>]*\bwidth=)([^>]*?)src="(data:[^"]+)"([^>]*?)>',
        lambda m: f'<img {m.group(1)}src="{m.group(2)}"{m.group(3)} width="620">',
        body,
    )

    def wrap_fig(m: re.Match) -> str:
        img, alt = m.group(1), html.escape(m.group(2))
        cap = f'<p style="font-size:9pt;color:#5a6b7c;margin:4pt 0 0;">{alt}</p>' if alt.strip() else ""
        return ('<table class="figbox" style="border:none;width:100%;margin:10pt 0;">'
                f'<tr><td style="border:none;text-align:center;padding:0;">{img}{cap}</td></tr></table>')

    body = re.sub(r'<p>(<img [^>]*alt="([^"]*)"[^>]*>)</p>', wrap_fig, body)
    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{html.escape(doc_title)}</title>
<style>{CSS}</style></head>
<body>
{toc}
{body}
</body></html>
"""
    return doc, warns


def html_to_pdf(html_path: Path, outdir: Path) -> Path:
    """LibreOffice headless 转 PDF（HOME 指向可写临时目录，避免 dconf 报错）。"""
    with tempfile.TemporaryDirectory(prefix="lo-home-") as home:
        env = {**os.environ, "HOME": home, "TMPDIR": home}
        proc = subprocess.run(
            ["soffice", "--headless", "--norestore", "--nolockcheck",
             "--convert-to", "pdf:writer_pdf_Export",
             "--outdir", str(outdir), str(html_path)],
            env=env, capture_output=True, text=True, timeout=600,
        )
    pdf = outdir / (html_path.stem + ".pdf")
    if proc.returncode != 0 or not pdf.is_file():
        raise RuntimeError(
            f"LibreOffice 转换失败（rc={proc.returncode}）\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return pdf


def convert(md_path: Path, outdir: Path, want_toc: bool | None = None) -> Path:
    doc, warns = build_html(md_path, want_toc)
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="md2pdf-") as tmp:
        html_path = Path(tmp) / (md_path.stem + ".html")
        html_path.write_text(doc, encoding="utf-8")
        pdf = html_to_pdf(html_path, outdir)
    for w in warns:
        print(f"    ! {w}")
    return pdf


def main() -> int:
    ap = argparse.ArgumentParser(description="评委文档 Markdown → PDF")
    ap.add_argument("files", nargs="*", help="Markdown 文件（默认：评委文档目录全部）")
    ap.add_argument("--outdir", help="PDF 输出目录（默认与源文件同目录）")
    ap.add_argument("--no-toc", action="store_true", help="不生成目录页")
    ap.add_argument("--toc", action="store_true", help="强制生成目录页")
    args = ap.parse_args()

    targets = [Path(f).resolve() for f in args.files] or sorted(DEFAULT_DIR.glob("*.md"))
    if not targets:
        print("没有找到 Markdown 文件", file=sys.stderr)
        return 1
    if not shutil.which("soffice"):
        print("未找到 soffice（LibreOffice），无法生成 PDF", file=sys.stderr)
        return 1

    outdir = Path(args.outdir).resolve() if args.outdir else None
    rc = 0
    for md_path in targets:
        dest = outdir or md_path.parent
        print(f"[{md_path.name}] → {dest}")
        try:
            pdf = convert(md_path, dest, False if args.no_toc else (True if args.toc else None))
        except Exception as exc:  # noqa: BLE001
            print(f"    ✗ 失败：{exc}", file=sys.stderr)
            rc = 1
            continue
        size = pdf.stat().st_size / 1024
        print(f"    ✓ {pdf.name}（{size:.0f} KB）")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
