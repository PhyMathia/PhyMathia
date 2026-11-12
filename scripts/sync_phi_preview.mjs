#!/usr/bin/env node
// 把 src/static/phi/phi-pet.{css,js} 内联回 phi-preview.html。
//
// 为什么需要：预览页刻意做成自包含（双击 file:// 也能看），代价是 CSS/JS 有两份副本。
// 改完桌宠样式或脚本跑一次本脚本，两边逐字一致，避免“预览是新的、真机是旧的”。
// 用法：node scripts/sync_phi_preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cssPath = path.join(root, 'src/static/phi/phi-pet.css');
const jsPath = path.join(root, 'src/static/phi/phi-pet.js');
const previewPath = path.join(root, 'src/static/phi/phi-preview.html');

const css = fs.readFileSync(cssPath, 'utf8').trimEnd();
const js = fs.readFileSync(jsPath, 'utf8').trimEnd();
// 预览页里这两段都缩进两个空格（<style>/<script> 内的既有排版）；保持缩进，
// 这样源文件改动在预览页的 diff 里还是一行对一行，而不是整块重写。
const indent = text => text.split('\n').map(line => (line ? '  ' + line : line)).join('\n');
const cssInline = indent(css);
const jsInline = indent(js);
let html = fs.readFileSync(previewPath, 'utf8');

const CSS_MARK = '/* 以下为桌宠本体样式（与 src/static/phi/phi-pet.css 完全一致） */';
const cssStart = html.indexOf(CSS_MARK);
if (cssStart < 0) throw new Error('预览页找不到 CSS 锚点');
const cssBodyStart = cssStart + CSS_MARK.length;
const cssEnd = html.indexOf('\n</style>', cssBodyStart);
if (cssEnd < 0) throw new Error('预览页找不到 </style>');
html = html.slice(0, cssBodyStart) + '\n' + cssInline + html.slice(cssEnd);

const JS_MARK = '// ===== Φ (Phi) 桌宠';
const jsMark = html.indexOf(JS_MARK);
if (jsMark < 0) throw new Error('预览页找不到 JS 锚点');
const jsBodyStart = html.lastIndexOf('<script>', jsMark) + '<script>'.length;
const jsEnd = html.indexOf('\n</script>', jsMark);
if (jsEnd < 0) throw new Error('预览页找不到内联 JS 结尾');
html = html.slice(0, jsBodyStart) + '\n' + jsInline + html.slice(jsEnd);

fs.writeFileSync(previewPath, html);
console.log('已同步 phi-preview.html：CSS ' + css.length + ' 字符，JS ' + js.length + ' 字符');
