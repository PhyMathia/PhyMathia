// 画风体检：把「前端漂了多少」变成可打印、可设阈值的数字。
//
//   node scripts/style_debt.mjs            打印报告
//   node scripts/style_debt.mjs --check    与 style_debt.json 里的阈值比对，超标退出码 1
//   node scripts/style_debt.mjs --save     把当前数字写成阈值基线 style_debt.json
//
// 纯静态分析（不依赖浏览器、不需要服务在跑）。视觉是否被动到由 visual_baseline.mjs 负责。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILES = [
  'src/static/css/styles.css',
  'src/static/css/styles-panels.css',
  'src/static/css/graph-override.css',
];
const JS_DIR = 'src/static/js';
const BASELINE = path.join(ROOT, 'style_debt.json');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------- 极简 CSS 解析 ----------
function stripComments(s) {
  // 保留换行，行号才准
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

// 返回 { selector, body, line }[]，把 @media/@supports 内的规则摊平（at 字段记录外层条件）
function collectRules(src) {
  const s = stripComments(src);
  const out = [];
  function walk(from, to, at) {
    let i = from, depth = 0, preludeStart = from;
    while (i < to) {
      const c = s[i];
      if (c === '{') {
        if (depth === 0) preludeStart = i === 0 ? 0 : s.lastIndexOf('}', i - 1) + 1;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          const prelude = s.slice(preludeStart, i).replace(/[{}]/g, (m, off) => m);
          const open = s.indexOf('{', preludeStart);
          const sel = s.slice(preludeStart, open).replace(/\s+/g, ' ').trim();
          const body = s.slice(open + 1, i);
          if (sel.startsWith('@')) {
            if (/^@(media|supports|layer|container)\b/.test(sel)) walk(open + 1, i, at ? at + ' && ' + sel : sel);
          } else if (sel) {
            out.push({ selector: sel, body, line: lineOf(s, open), at });
          }
        }
      }
      i++;
    }
  }
  walk(0, s.length, '');
  return out;
}

// 从规则体里取声明（整段跳过嵌套块；末条声明可能不带分号，也要收）
function decls(body) {
  const s = stripComments(body);
  const out = [];
  let i = 0, buf = '';
  const push = () => {
    const m = buf.match(/^\s*(--[-a-zA-Z0-9]+|[-a-zA-Z]+)\s*:\s*([\s\S]*?)\s*$/);
    if (m && !m[2].includes('{')) out.push({ prop: m[1].toLowerCase(), value: m[2].replace(/\s+/g, ' ').trim() });
    buf = '';
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '{') {                       // 嵌套块（@keyframes 的 0%{}），整段跳过
      let d = 1; i++;
      while (i < s.length && d > 0) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; }
      buf = '';
      continue;
    }
    if (c === ';') { push(); i++; continue; }
    buf += c; i++;
  }
  push();
  return out;
}

// ---------- 采集 ----------
const files = CSS_FILES.map((f) => ({ path: f, src: read(f) }));
const rules = [];
for (const f of files) for (const r of collectRules(f.src)) rules.push({ ...r, file: f.path });

const allDecls = [];
for (const r of rules) for (const d of decls(r.body)) allDecls.push({ ...d, selector: r.selector, file: r.file, line: r.line });

const isVar = (v) => /var\(--/.test(v);

// 变量定义行（用于把「令牌定义」排除出硬编码统计）
const tokenNames = new Set();
const tokenDefs = [];
for (const d of allDecls) {
  if (d.prop.startsWith('--')) { tokenNames.add(d.prop); tokenDefs.push(d); }
}

// 颜色字面量（属性值里）
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB = /rgba?\([^)]*\)/g;
function colorLiterals(pred) {
  const counts = new Map();
  for (const d of allDecls) {
    if (d.prop.startsWith('--')) continue;          // 令牌定义不算泄漏（尺子本来就在这里）
    if (pred && !pred(d)) continue;
    for (const re of [HEX, RGB]) {
      const m = d.value.match(re);
      if (!m) continue;
      for (const v of m) counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  return counts;
}
const colorLits = colorLiterals(null);
const colorLitTotal = [...colorLits.values()].reduce((a, b) => a + b, 0);

// 只统计「裸值」的不同取值：var() 引用是尺子本身，不算新取值（否则用了令牌反而"变多"）
function distinct(prop, { bareOnly = false } = {}) {
  const c = new Map();
  for (const d of allDecls) {
    if (d.prop !== prop) continue;
    const v = normVal(d.value);
    if (bareOnly && isVar(v)) continue;
    c.set(v, (c.get(v) || 0) + 1);
  }
  return c;
}
function tokenRefs(prop, prefix) {
  const c = new Map();
  for (const d of allDecls) {
    if (d.prop !== prop) continue;
    for (const m of d.value.match(/var\(--[a-z0-9-]+\)/g) || []) {
      if (!prefix || m.startsWith('var(' + prefix)) c.set(m, (c.get(m) || 0) + 1);
    }
  }
  return c;
}
function varShare(prop) {
  const all = allDecls.filter((d) => d.prop === prop);
  if (!all.length) return 0;
  return all.filter((d) => isVar(d.value)).length / all.length;
}
// `!important` 只是优先级标记，不该算成「又一种取值」
const normVal = (v) => v.replace(/\s*!important\s*$/, '').trim();

const radius = distinct('border-radius', { bareOnly: true });
const radiusAll = distinct('border-radius');
const fontSize = distinct('font-size', { bareOnly: true });
const fontSizeAll = distinct('font-size');
const zIndex = distinct('z-index', { bareOnly: true });  // 裸值口径（同 radius/font-size）：var() 引用是尺子本身，不算新取值（T63）
const shadow = distinct('box-shadow');

// 动效时长（剔除 :root 的主题变量过渡表——那是刻意设计的机制，不是散装数值）
const durCounts = new Map();
for (const d of allDecls) {
  if (!['transition', 'animation', 'transition-duration', 'animation-duration'].includes(d.prop)) continue;
  if (d.selector.includes(':root') || d.selector.includes('data-theme')) continue;
  for (const m of d.value.match(/\b\d*\.?\d+(?:ms|s)\b/g) || []) durCounts.set(m, (durCounts.get(m) || 0) + 1);
}

// 跨文件重复选择器
const selFiles = new Map();
for (const r of rules) {
  const key = r.selector;
  if (!selFiles.has(key)) selFiles.set(key, new Set());
  selFiles.get(key).add(r.file);
}
const crossFileDupes = [...selFiles.entries()]
  .filter(([, set]) => set.size > 1)
  .map(([sel, set]) => ({ sel, files: [...set].map((f) => path.basename(f)) }))
  .sort((a, b) => b.files.length - a.files.length);

// 同文件重复（≥3 次才算债）
const selCount = new Map();
for (const r of rules) selCount.set(r.selector, (selCount.get(r.selector) || 0) + 1);

// !important
const importantCount = allDecls.filter((d) => /!important/.test(d.value)).length;

// ---------- JS 侧 ----------
const jsFiles = fs.readdirSync(path.join(ROOT, JS_DIR)).filter((f) => f.endsWith('.js'));
let jsAll = '';
const jsInlineStyle = { total: 0, byFile: {} };
const jsColors = new Map();
for (const f of jsFiles) {
  const src = read(path.join(JS_DIR, f));
  jsAll += src;
  const n = (src.match(/\.style\.[a-zA-Z]+|cssText|setProperty\(|style="/g) || []).length;
  if (n) { jsInlineStyle.total += n; jsInlineStyle.byFile[f] = n; }
  for (const re of [HEX, RGB]) for (const m of src.match(re) || []) jsColors.set(m, (jsColors.get(m) || 0) + 1);
}

// 图标：stroke-width 与 svg 尺寸
const strokeWidths = new Map();
for (const f of ['src/static/index.html', ...jsFiles.map((x) => path.join(JS_DIR, x))]) {
  const src = read(f);
  for (const m of src.match(/stroke-width=["']?([\d.]+)/g) || []) {
    const v = m.split(/["']?/).pop().split('"')[0];
    const val = (m.match(/([\d.]+)$/) || [])[1];
    if (val) strokeWidths.set(val, (strokeWidths.get(val) || 0) + 1);
  }
}

// 关闭控件：字形与 aria-label
const closeGlyphs = { '&times;': 0, '×': 0, '✕': 0 };
for (const [k] of Object.entries(closeGlyphs)) {
  closeGlyphs[k] = (jsAll.match(new RegExp(k.replace(/[&;×✕]/g, (c) => '\\' + c), 'g')) || []).length;
}
const closeGlyphHtml = {};
for (const [k] of Object.entries(closeGlyphs)) {
  closeGlyphHtml[k] = (read('src/static/index.html').match(new RegExp(k.replace(/[&;×✕]/g, (c) => '\\' + c), 'g')) || []).length;
}
const ariaLabels = (jsAll.match(/aria-label=/g) || []).length +
  (read('src/static/index.html').match(/aria-label=/g) || []).length;

// 空态类
const emptyClasses = new Set();
for (const r of rules) for (const m of r.selector.match(/\.([a-z-]*empty[a-z-]*)/g) || []) emptyClasses.add(m.slice(1));

// 语义色家族计数（同一语义用了几个不同色值）
const RED = [], GREEN = [], AMBER = [];
for (const [v, n] of colorLits) {
  const hex = v.startsWith('#') ? v.toLowerCase() : null;
  const rgbm = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  const r = hex ? parseInt(hex.slice(1, 3), 16) : rgbm ? +rgbm[1] : null;
  const g = hex ? parseInt(hex.slice(3, 5), 16) : rgbm ? +rgbm[2] : null;
  const b = hex ? parseInt(hex.slice(5, 7), 16) : rgbm ? +rgbm[3] : null;
  if (r === null) continue;
  if (r > 200 && g < 120 && b < 140) RED.push([v, n]);
  else if (g > 130 && r < 90 && b < 160) GREEN.push([v, n]);
  else if (r > 200 && g > 130 && g < 210 && b < 90) AMBER.push([v, n]);
}
const famCount = (arr) => new Set(arr.map(([v]) => v.replace(/\s/g, ''))).size;

const report = {
  size: files.map((f) => ({ file: path.basename(f.path), lines: f.src.split('\n').length, chars: f.src.length })),
  tokens: {
    defined: tokenNames.size,
    radius: [...tokenNames].filter((t) => /^--r-/.test(t)).length,
    fontSize: [...tokenNames].filter((t) => /^--fs-/.test(t)).length,
    spacing: [...tokenNames].filter((t) => /^--sp-/.test(t)).length,
    duration: [...tokenNames].filter((t) => /^--dur|^--ease/.test(t)).length,
    zIndex: [...tokenNames].filter((t) => /^--z-/.test(t)).length,
    semantic: [...tokenNames].filter((t) => /^--(danger|success|warn)/.test(t)).length,
  },
  colors: {
    literalTotal: colorLitTotal,
    literalDistinct: colorLits.size,
    top: [...colorLits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  },
  radius: {
    decls: [...radiusAll.values()].reduce((a, b) => a + b, 0), distinct: radius.size,
    totalDistinct: radiusAll.size, varShare: varShare('border-radius'),
    tokens: [...tokenRefs('border-radius', '--r-').entries()].sort((a, b) => b[1] - a[1]),
    values: [...radius.entries()].sort((a, b) => b[1] - a[1]) },
  fontSize: {
    decls: [...fontSizeAll.values()].reduce((a, b) => a + b, 0), distinct: fontSize.size,
    totalDistinct: fontSizeAll.size, varShare: varShare('font-size'),
    tokens: [...tokenRefs('font-size', '--fs-').entries()].sort((a, b) => b[1] - a[1]) },
  zIndex: { decls: [...zIndex.values()].reduce((a, b) => a + b, 0), distinct: zIndex.size, values: [...zIndex.entries()].sort((a, b) => b[1] - a[1]) },
  shadow: { decls: [...shadow.values()].reduce((a, b) => a + b, 0), distinct: shadow.size, varShare: varShare('box-shadow') },
  duration: { decls: [...durCounts.values()].reduce((a, b) => a + b, 0), distinct: durCounts.size, values: [...durCounts.entries()].sort((a, b) => b[1] - a[1]) },
  dupes: { crossFile: crossFileDupes.length, crossFileList: crossFileDupes.slice(0, 12), sameFile3x: [...selCount.entries()].filter(([, n]) => n >= 3).length },
  important: importantCount,
  js: { inlineStyle: jsInlineStyle.total, colorLiterals: jsColors.size },
  icons: { strokeWidths: [...strokeWidths.entries()].sort((a, b) => b[1] - a[1]) },
  close: { glyphsCssJs: closeGlyphs, glyphsHtml: closeGlyphHtml, ariaLabels },
  empty: { classes: emptyClasses.size },
  semanticColors: { red: { distinct: famCount(RED), list: RED.sort((a, b) => b[1] - a[1]) }, green: { distinct: famCount(GREEN), list: GREEN.sort((a, b) => b[1] - a[1]) }, amber: { distinct: famCount(AMBER), list: AMBER.sort((a, b) => b[1] - a[1]) } },
};

// ---------- 输出 ----------
if (process.argv.includes('--save')) {
  const thresholds = {
    radiusDistinct: report.radius.distinct,
    fontSizeDistinct: report.fontSize.distinct,
    zIndexDistinct: report.zIndex.distinct,
    durationDistinct: report.duration.distinct,
    colorLiteralTotal: report.colors.literalTotal,
    important: report.important,
    crossFileDupes: report.dupes.crossFile,
    emptyClasses: report.empty.classes,
    jsColorLiterals: report.js.colorLiterals,
  };
  fs.writeFileSync(BASELINE, JSON.stringify(thresholds, null, 1));
  console.log('阈值基线已写入 style_debt.json');
  for (const [k, v] of Object.entries(thresholds)) console.log('  ' + k.padEnd(20) + v);
  process.exit(0);
}

const pct = (x) => (x * 100).toFixed(1) + '%';
console.log('===== 画风体检（style_debt）=====\n');
console.log('规模');
for (const s of report.size) console.log('  ' + s.file.padEnd(24) + s.lines + ' 行 / ' + s.chars + ' 字符');

console.log('\n令牌（尺子）');
console.log('  已定义令牌总数            ' + report.tokens.defined);
console.log('  圆角 --r-*               ' + report.tokens.radius);
console.log('  字号 --fs-*              ' + report.tokens.fontSize);
console.log('  间距 --sp-*              ' + report.tokens.spacing);
console.log('  动效 --dur-*/--ease-*    ' + report.tokens.duration);
console.log('  层级 --z-*               ' + report.tokens.zIndex);
console.log('  语义色 --danger/success/warn ' + report.tokens.semantic);

console.log('\n颜色');
console.log('  属性值里的颜色字面量      ' + report.colors.literalTotal + ' 处 / 去重 ' + report.colors.literalDistinct + ' 个');
console.log('  最高频：' + report.colors.top.map(([v, n]) => v + '×' + n).join('  '));
console.log('  语义色家族：红 ' + report.semanticColors.red.distinct + ' 种 / 绿 ' + report.semanticColors.green.distinct + ' 种 / 琥珀 ' + report.semanticColors.amber.distinct + ' 种');

console.log('\n散装数值');
console.log('  border-radius  ' + report.radius.decls + ' 条 / 裸值 ' + report.radius.distinct + ' 种 / 令牌引用 ' +
  report.radius.tokens.reduce((a, [, n]) => a + n, 0) + ' 处（' + report.radius.tokens.length + ' 种）/ var() 占比 ' + pct(report.radius.varShare));
console.log('     裸值：' + report.radius.values.slice(0, 10).map(([v, n]) => v + '×' + n).join('  '));
console.log('     令牌：' + report.radius.tokens.map(([v, n]) => v + '×' + n).join('  '));
console.log('  font-size      ' + report.fontSize.decls + ' 条 / 裸值 ' + report.fontSize.distinct + ' 种 / 令牌引用 ' +
  report.fontSize.tokens.reduce((a, [, n]) => a + n, 0) + ' 处（' + report.fontSize.tokens.map(([v, n]) => v + '×' + n).join(' ') + '）/ var() 占比 ' + pct(report.fontSize.varShare));
console.log('  box-shadow     ' + report.shadow.decls + ' 条 / ' + report.shadow.distinct + ' 种 / var() 占比 ' + pct(report.shadow.varShare));
console.log('  z-index        ' + report.zIndex.decls + ' 条 / 裸值 ' + report.zIndex.distinct + ' 种（var() 引用不计入——尺子本身，T63 起与 radius/font-size 同口径）');
console.log('      ' + report.zIndex.values.slice(0, 14).map(([v, n]) => v + '×' + n).join('  '));
console.log('  动效时长       ' + report.duration.decls + ' 条 / ' + report.duration.distinct + ' 种');
console.log('      ' + report.duration.values.slice(0, 10).map(([v, n]) => v + '×' + n).join('  '));

console.log('\n重复与冲突');
console.log('  跨文件重复选择器  ' + report.dupes.crossFile + ' 组');
for (const d of report.dupes.crossFileList) console.log('      ' + d.sel.slice(0, 62).padEnd(64) + d.files.join(' + '));
console.log('  同文件重复 ≥3 次  ' + report.dupes.sameFile3x + ' 个选择器');
console.log('  !important        ' + report.important + ' 处');

console.log('\n组件一致性');
console.log('  关闭字形  CSS/JS ' + JSON.stringify(report.close.glyphsCssJs) + '  HTML ' + JSON.stringify(report.close.glyphsHtml));
console.log('  aria-label 总数   ' + report.close.ariaLabels);
console.log('  空态类名          ' + report.empty.classes + ' 个');
console.log('  图标 stroke-width ' + report.icons.strokeWidths.map(([v, n]) => v + '×' + n).join('  '));
console.log('  JS 内联样式写入   ' + report.js.inlineStyle + ' 处 / JS 颜色字面量去重 ' + report.js.colorLiterals + ' 个');

if (process.argv.includes('--check')) {
  if (!fs.existsSync(BASELINE)) { console.error('\n没有 style_debt.json，先跑 --save'); process.exit(2); }
  const th = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const now = {
    radiusDistinct: report.radius.distinct,
    fontSizeDistinct: report.fontSize.distinct,
    zIndexDistinct: report.zIndex.distinct,
    durationDistinct: report.duration.distinct,
    colorLiteralTotal: report.colors.literalTotal,
    important: report.important,
    crossFileDupes: report.dupes.crossFile,
    emptyClasses: report.empty.classes,
    jsColorLiterals: report.js.colorLiterals,
  };
  const bad = Object.entries(th).filter(([k, v]) => now[k] > v);
  console.log('\n--- 阈值比对 ---');
  for (const [k, v] of Object.entries(th)) {
    const mark = now[k] > v ? '✗' : '·';
    console.log('  ' + mark + ' ' + k.padEnd(20) + now[k] + '  (上限 ' + v + ')');
  }
  if (bad.length) { console.error('\n✗ 有 ' + bad.length + ' 项超过阈值——画风在往回漂'); process.exit(1); }
  console.log('\n✓ 全部在阈值内');
}
