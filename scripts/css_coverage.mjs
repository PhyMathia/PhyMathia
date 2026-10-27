#!/usr/bin/env node
// T374 CSS 死字节 coverage 工具（2026-10-23）
//
// backlog 拍板口径：删块前必须全场景收 coverage 定名单——单页单状态的 21% 命中不能当
// 死代码名单（其他主题/弹窗/Φ/工坊/viewer 页的规则全算「未命中」但不是死代码）。
// 本工具三步走：
//   1. 解析三份源 CSS 成规则表（手写 tokenizer，@media/@supports/@layer 递归、
//      @keyframes/@font-face 原子记）；
//   2. 起隔离实例（T415，2026-10-27 起：临时数据目录的第二实例，不再读真实 data/——
//      以前直读真 data/ 还写过 kv，10-26 models.json 事故后开页面的测试一律不打真机；
//      空数据下「最富会话」态自动缺席、节点两态现造测试节点顶上），Playwright 驱动
//      场景矩阵（冷启/最富会话/各风格家族/深浅/大陆/右键菜单/拖拽态/高倍缩放/各弹窗/
//      窄视口/viewer 冷启＋inbox pmu），逐态对每个子选择器 querySelector 快照取并集
//      ——弹窗面板即使被后开的状态盖住，DOM 还在、命中不丢；
//   3. 未命中规则再做源码交叉验证（class/id/属性字面量在 js/html 源里连子串都搜不到
//      才算「证明死」——classList.add('a'+b) 这类拼名天然保守保活）。
//
// 用法：
//   node scripts/css_coverage.mjs            # 出报告（stdout 摘要 + logs/css-coverage.json）
//   node scripts/css_coverage.mjs --apply    # 在报告基础上删除「证明死」规则，写回源 CSS
//   PORT=5090 node scripts/css_coverage.mjs  # 换端口
//
// 删除永远只删规则文本不动注释（源 CSS 注释是设计文档）；删后须重跑 build:js＋本工具
// ＋frontend_smoke 复核。@font-face/@property/@import 与纯元素选择器一律保守保留。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.PORT || 5073);
const APPLY = process.argv.includes('--apply');
const CSS_FILES = ['styles.css', 'styles-panels.css', 'graph-override.css'].map(f => ({
  name: f, path: path.join(root, 'src/static/css', f),
}));

// ---------- CSS 解析 ----------
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

function parseBlock(text, file, base, mediaPath, out) {
  let i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && /\s/.test(text[i])) i++;
    if (i >= len) break;
    const selStart = i;
    let j = i;
    while (j < len) {
      if (text[j] === '/' && text[j + 1] === '*') { const e = text.indexOf('*/', j); j = e < 0 ? len : e + 2; continue; }
      if (text[j] === '{' || text[j] === ';') break;
      j++;
    }
    if (j >= len) break;
    if (text[j] === ';') { // @import/@charset 等语句：整条保留
      out.push({ file, kind: 'stmt', sel: stripComments(text.slice(selStart, j)).trim(), start: base + selStart, end: base + j + 1, media: mediaPath.join(' && ') });
      i = j + 1; continue;
    }
    const selText = stripComments(text.slice(selStart, j)).trim();
    let k = j + 1, d = 1;
    while (k < len && d > 0) {
      if (text[k] === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k); k = e < 0 ? len : e + 2; continue; }
      if (text[k] === '{') d++; else if (text[k] === '}') d--;
      k++;
    }
    const bodyEnd = k - 1;
    if (bodyEnd < 0) break;
    const body = text.slice(j + 1, bodyEnd);
    if (selText.startsWith('@')) {
      const at = (/^@([a-zA-Z-]+)/.exec(selText) || [])[1]?.toLowerCase() || '';
      if (at === 'media' || at === 'supports' || at === 'layer' || at === 'document' || at === 'container') {
        parseBlock(body, file, base + j + 1, mediaPath.concat(selText), out);
      } else {
        // keyframes / font-face / property / page / counter-style …原子单元
        out.push({ file, kind: at || 'at-other', sel: selText, start: base + selStart, end: base + bodyEnd + 1, media: mediaPath.join(' && '), body });
      }
    } else if (selText) {
      // 逗号分组按顶层逗号拆子选择器（括号内的逗号不算）
      const sels = [];
      let depth = 0, cur = '';
      for (const ch of selText) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { sels.push(cur.trim()); cur = ''; } else cur += ch;
      }
      if (cur.trim()) sels.push(cur.trim());
      out.push({ file, kind: 'rule', sel: selText, sels, start: base + selStart, end: base + bodyEnd + 1, media: mediaPath.join(' && '), body });
    }
    i = bodyEnd + 1;
  }
}

// ---------- 可测选择器清洗 ----------
const DYNAMIC_PSEUDO = /:(?:hover|focus|focus-within|focus-visible|active|visited|link|target|fullscreen|picture-in-picture|playing|paused|autofill|user-invalid|user-valid|placeholder-shown|default|indeterminate|blank|defined)\b/g;
function matchable(sel) {
  let s = sel.replace(/::[a-zA-Z-]+(?:\([^)]*\))?/g, '');
  s = s.replace(DYNAMIC_PSEUDO, '');
  s = s.replace(/:not\(\s*\)/g, '').replace(/:is\(\s*\)/g, '').replace(/:where\(\s*\)/g, '');
  s = s.trim();
  if (!s || s === '*' || /^[>~+\s*]+$/.test(s)) return null;
  return s;
}

// ---------- 源码语料（交叉验证用） ----------
function buildCorpus() {
  const parts = [];
  const jsDir = path.join(root, 'src/static/js');
  for (const f of fs.readdirSync(jsDir)) {
    if (!f.endsWith('.js')) continue;
    if (f === 'app.js' || f === 'viewer.js' || f.endsWith('.map')) continue; // 构建产物
    parts.push(fs.readFileSync(path.join(jsDir, f), 'utf8'));
  }
  const staticDir = path.join(root, 'src/static');
  for (const f of fs.readdirSync(staticDir)) {
    if (f.endsWith('.html')) parts.push(fs.readFileSync(path.join(staticDir, f), 'utf8'));
  }
  const phiDir = path.join(staticDir, 'phi');
  if (fs.existsSync(phiDir)) {
    for (const f of fs.readdirSync(phiDir)) if (f.endsWith('.js') || f.endsWith('.html')) parts.push(fs.readFileSync(path.join(phiDir, f), 'utf8'));
  }
  return parts.join('\n');
}

function selectorTokens(sel) {
  const tokens = new Set();
  for (const m of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) tokens.add(m[1]);
  for (const m of sel.matchAll(/#([A-Za-z_][\w-]*)/g)) tokens.add(m[1]);
  for (const m of sel.matchAll(/\[([a-zA-Z-]+)(?:[*^|$~]?=\s*["']?([^"'\]]*)["']?)?\]/g)) {
    tokens.add(m[1]);
    if (m[2]) tokens.add(m[2]);
  }
  return tokens;
}

// ---------- 服务 ----------
// 起隔离实例这件事归 scripts/lib/test_server.mjs（T415）；不再在真仓库根起服务——
// 那样 cwd 决定的 DATA_DIR 就是真实 data/，kv 写入会落进日常数据。

// ---------- 场景矩阵（逐态快照） ----------
async function driveStates(page, base, sels, union, stateHits) {
  const covered = [];
  const failed = [];
  let currentState = null;
  const snapshot = async () => {
    const hits = await page.evaluate(list => {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        try { if (document.querySelector(list[i]) !== null) out.push(i); } catch { /* 不可测 */ }
      }
      return out;
    }, sels);
    for (const h of hits) union.add(h);
    if (currentState) {
      stateHits ??= [];
      const prev = stateHits.find(s => s.name === currentState);
      if (prev) for (const h of hits) prev.hits.add(h);
      else stateHits.push({ name: currentState, hits: new Set(hits) });
    }
  };
  const step = async (name, fn) => {
    try {
      currentState = name;
      await fn();
      await page.waitForTimeout(450);
      await snapshot();
      covered.push(name);
    } catch (e) {
      failed.push(name + ': ' + String(e && e.message ? e.message : e).split('\n')[0]);
    } finally { currentState = null; }
  };
  const click = (sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) throw new Error(s + ' 不存在');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, sel);

  await step('index 冷启', async () => {
    await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
  });
  // 最富会话（按消息数挑）——switchToSession 是异步全局
  let richSid = null;
  try {
    const list = await (await fetch(base + '/api/sessions')).json();
    const arr = Array.isArray(list) ? list : (list.sessions || []);
    let best = -1;
    for (const s of arr) {
      const n = Number(s.message_count ?? s.messages ?? s.msg_count ?? 0);
      if (n > best) { best = n; richSid = s.id ?? s.sid; }
    }
  } catch { /* 拿不到就停在本页 */ }
  if (richSid) {
    await step('最富会话', async () => {
      await page.evaluate(sid => window.switchToSession(sid), richSid);
      await page.waitForTimeout(1200);
    });
  }
  // 风格家族全轮（全局函数直调，不必开面板）＋深浅
  let families = [];
  try {
    families = await page.evaluate(() => Array.from(document.querySelectorAll('.level-option[data-family]')).map(el => el.dataset.family));
  } catch { /* 取不到就默认家族 */ }
  if (!families.length) families = [];
  for (const fam of families) {
    await step('家族 ' + fam, async () => {
      await page.evaluate(f => window.pickStyleFamily(f), fam);
    });
  }
  await step('浅色模式', async () => {
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });
  });
  await step('慢机降级类', async () => {
    await page.evaluate(() => document.documentElement.classList.add('node-blur-lite'));
  });
  // 画布动态态：右键菜单 / 拖拽指示 / 高倍缩放
  // 节点态需要画布上有节点——隔离实例是空画布（T415 起不依赖真实 data/），现造一组
  // 覆盖节点家族的测试节点（问题分析＋六族模块视角）。只造一颗不够：answer/module
  // 族的规则在真实数据里靠会话内容命中，空画布没机会命中就会混进 DEAD 名单——拼名网
  // 救不了动态拼出来的类名（T415 实测 19 条假阳性）。
  const ensureNodes = () => page.evaluate(() => {
    for (const key of ['answer', 'physics', 'math', 'graph', 'viz', 'learn', 'socratic', 'human_note']) {
      window.addBlankNodePoint = { x: 60 + Math.random() * 640, y: 60 + Math.random() * 420 };
      window.createManualNode(key);
    }
    if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
    if (!document.querySelector('.graph-node')) throw new Error('造了测试节点仍无 .graph-node');
  });
  await step('节点右键菜单', async () => {
    await ensureNodes();
    await page.evaluate(() => {
      const el = document.querySelector('.graph-node');
      if (!el) throw new Error('无节点');
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    });
  });
  await step('节点拖拽中', async () => {
    await ensureNodes();
    await page.evaluate(() => {
      const el = document.querySelector('.graph-node');
      if (!el) throw new Error('无节点');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.x + 60, clientY: r.y + 60 }));
    });
    await page.waitForTimeout(150);
  });
  await step('高倍缩放', async () => {
    await page.evaluate(() => {
      const c = document.querySelector('#graphCanvas') || document.body;
      for (let i = 0; i < 14; i++) c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 700, clientY: 450 }));
    });
  });
  // 弹窗与面板（点击失败容忍：面板 DOM 常驻，很多选择器冷启已命中）
  const clickSelectors = [
    ['#knowledgeBtn', '知识面板'], ['#modelBtn', '模型面板'], ['#levelBtn', '难度面板'],
    ['#themeBtn', '主题面板'], ['#moreBtn', '更多菜单'], ['#taskPanelBtn', '任务面板'],
    ['#progressTaskBtn', '进度任务面板'], ['#graphSearchPanel', '图搜索面板'], ['#dataPanel', '数据面板'],
    ['#sessionMultiSelectBtn', '会话多选'], ['#tokenRangeBtn', '用量面板'],
  ];
  for (const [sel, name] of clickSelectors) {
    await step(name, async () => { await click(sel); });
  }
  await step('知识大陆', async () => {
    await click('#kpContinentBtn');
    await page.waitForTimeout(900);
  });
  await step('大陆回画布', async () => {
    await page.evaluate(() => { if (typeof window.closeContinentView === 'function') window.closeContinentView(); });
  });
  // 窄视口（响应式断点）
  await step('窄视口', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  // viewer：冷启 + inbox pmu
  const inbox = path.join(root, 'data/utopia_inbox');
  const pmu = fs.existsSync(inbox) ? fs.readdirSync(inbox).filter(f => f.endsWith('.pmu'))
    .map(f => ({ f, size: fs.statSync(path.join(inbox, f)).size }))
    .sort((a, b) => b.size - a.size)[0] : null;
  await step('viewer 冷启', async () => {
    await page.goto(base + '/viewer.html', { waitUntil: 'networkidle', timeout: 30000 });
  });
  if (pmu) {
    await step('viewer pmu', async () => {
      await page.goto(base + '/viewer.html?from=inbox&id=' + encodeURIComponent(pmu.f), { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
    });
  }
  return { covered, failed };
}

// ---------- 主流程 ----------
const server = await startIsolatedServer({ port: PORT, label: 'phymathia-csscov', copyDataDirs: ['utopia_inbox'] });
let browser;
try {
  const rules = [];
  for (const f of CSS_FILES) {
    const text = fs.readFileSync(f.path, 'utf8');
    parseBlock(text, f.name, 0, [], rules);
  }
  const flat = []; // { ruleIdx, sel }
  rules.forEach((r, idx) => {
    if (r.kind !== 'rule') return;
    for (const s of r.sels) flat.push({ ruleIdx: idx, sel: s });
  });
  const matchables = flat.map(f => ({ ...f, m: matchable(f.sel) }));
  const testable = matchables.filter(x => x.m);
  const selList = testable.map(x => x.m);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const union = new Set(); // selList 下标
  const stateHits = [];
  const { covered, failed } = await driveStates(page, server.base, selList, union, stateHits);

  const hitByRule = new Set();
  for (const i of union) hitByRule.add(testable[i].ruleIdx);
  const untestableRules = new Set(matchables.filter(x => !x.m).map(x => x.ruleIdx));

  const corpus = buildCorpus();
  // 拼名网：JS 里 'prefix-' + x、x + '-suffix' 拼出来的类名，全词搜索搜不到但活着
  // （实测翻车：harness.js:447 的 'graph-harness-status-'+kind、harness-preview.js:238
  // 的 'graph-harness-op-'+op）。凡死候选 token 与源码某「无空格、含 -/_、≥8 字符」的
  // 字符串字面量构成前缀或后缀关系 → 一律保守保活。
  const literals = [];
  {
    const seen = new Set();
    for (const m of corpus.matchAll(/['"`]([^'"`\n]{8,120})['"`]/g)) {
      const s = m[1];
      if (seen.has(s) || /\s/.test(s) || !/[-_]/.test(s)) continue;
      seen.add(s); literals.push(s);
    }
  }
  const verdict = rules.map((r, idx) => {
    if (r.kind !== 'rule') return { idx, verdict: 'keep', reason: '非 rule（' + r.kind + '）' };
    if (untestableRules.has(idx)) return { idx, verdict: 'keep', reason: '含不可测选择器' };
    if (hitByRule.has(idx)) return { idx, verdict: 'keep', reason: '场景命中' };
    const tokens = new Set();
    for (const s of r.sels) for (const t of selectorTokens(s)) tokens.add(t);
    if (!tokens.size) return { idx, verdict: 'keep', reason: '纯元素/通配选择器' };
    for (const t of tokens) {
      if (corpus.includes(t)) return { idx, verdict: 'keep', reason: '源码可寻(' + t + ')' };
      for (const L of literals) {
        if (t.startsWith(L) || t.endsWith(L)) return { idx, verdict: 'keep', reason: '拼名疑似(' + L + ')' };
      }
    }
    return { idx, verdict: 'dead', reason: '全态未命中且源码无字面量/拼名' };
  });

  // CSS 变量守卫（保守到「全 CSS 出现超过一次或源码可寻即保」——宁可多保不误删）：
  const allCss = CSS_FILES.map(f => fs.readFileSync(f.path, 'utf8')).join('\n');
  const deadIdxSet = new Set(verdict.filter(v => v.verdict === 'dead').map(v => v.idx));
  for (const idx of [...deadIdxSet]) {
    for (const m of (rules[idx].body || '').matchAll(/(--[\w-]+)\s*:/g)) {
      const v = m[1];
      const occurrences = allCss.split(v).length - 1;
      if (occurrences > 1 || corpus.includes(v)) {
        verdict[idx] = { idx, verdict: 'keep', reason: '定义变量 ' + v + ' 被引用' };
        deadIdxSet.delete(idx);
        break;
      }
    }
  }
  // keyframes：动画名在幸存 CSS 引用 ∪ 源码语料出现 → 保，否则死
  const survivingBodies = rules.filter((_, i) => verdict[i].verdict !== 'dead').map(r => r.body || '').join('\n');
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.kind !== 'keyframes') continue;
    const name = (/^@keyframes\s+([\w-]+)/.exec(r.sel) || [])[1];
    if (!name) { verdict[i] = { idx: i, verdict: 'keep', reason: 'keyframes 名解析不出' }; continue; }
    const used = new RegExp('animation[^;{}]*\\b' + name + '\\b').test(survivingBodies) || corpus.includes(name);
    verdict[i] = { idx: i, verdict: used ? 'keep' : 'dead', reason: used ? '动画被引用' : '动画无引用' };
  }

  const byFile = {};
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i], v = verdict[i];
    byFile[r.file] ??= { total: 0, dead: 0, deadBytes: 0 };
    byFile[r.file].total++;
    if (v.verdict === 'dead') { byFile[r.file].dead++; byFile[r.file].deadBytes += r.end - r.start; }
  }
  const deadList = rules.map((r, i) => ({ r, v: verdict[i] })).filter(x => x.v.verdict === 'dead');
  console.log('=== CSS coverage（场景 ' + covered.length + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 个' : '') + '）===');
  for (const [f, s] of Object.entries(byFile)) {
    console.log(`${f}: 规则 ${s.total}，证明死 ${s.dead} 条 ≈ ${(s.deadBytes / 1024).toFixed(1)} KB`);
  }
  if (failed.length) console.log('失败场景（不阻断，只收窄名单）：\n  ' + failed.join('\n  '));
  // viewer 拆表供数：viewer 两态命中的规则按文件分布（styles-panels 若近零＝可拆）
  const viewerStates = stateHits.filter(s => s.name.startsWith('viewer'));
  if (viewerStates.length) {
    const vUnion = new Set();
    for (const s of viewerStates) for (const h of s.hits) vUnion.add(h);
    const perFile = {};
    const panelsSels = [];
    for (const i of vUnion) {
      const r = rules[testable[i].ruleIdx];
      perFile[r.file] = (perFile[r.file] || 0) + 1;
      if (r.file === 'styles-panels.css') panelsSels.push(r.sel.slice(0, 80));
    }
    console.log('=== viewer 两态命中分布（拆表供数）===');
    for (const [f, n] of Object.entries(perFile)) console.log(`${f}: ${n} 条规则命中`);
    if (panelsSels.length) console.log('styles-panels 在 viewer 命中的全部规则：\n  ' + panelsSels.join('\n  '));
    else console.log('styles-panels 在 viewer 命中：0 条');
  }
  const report = {
    at: new Date().toISOString(), covered, failed,
    testable: testable.map(x => ({ ruleIdx: x.ruleIdx, sel: x.sel })),
    stateHits: stateHits.map(s => ({ name: s.name, hits: [...s.hits] })),
    rules: rules.map((r, i) => ({ file: r.file, kind: r.kind, sel: r.sel, start: r.start, end: r.end, media: r.media, verdict: verdict[i].verdict, reason: verdict[i].reason })),
  };
  const reportPath = path.join(root, 'logs/css-coverage.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
  console.log('明细：' + reportPath);
  for (const { r } of deadList) console.log(`  DEAD ${r.file} @${r.start} ${r.sel.slice(0, 110)}${r.media ? '  [' + r.media + ']' : ''}`);

  if (APPLY) {
    if (!deadList.length) console.log('无可删规则，--apply 空转');
    else {
      for (const f of CSS_FILES) {
        let text = fs.readFileSync(f.path, 'utf8');
        const deadInFile = deadList.filter(x => x.r.file === f.name).map(x => x.r).sort((a, b) => b.start - a.start);
        if (!deadInFile.length) continue;
        for (const r of deadInFile) {
          let start = r.start;
          let end = r.end;
          // 解析器会把规则前的注释并进范围起点。单行短注释描述的就是这条规则，随删；
          // 多行 / 带 ===== 横幅 / ≥240 字符的是节级设计文档，留下、起点跳过它。
          if (text.startsWith('/*', start)) {
            const close = text.indexOf('*/', start);
            if (close >= 0 && close < end) {
              const comment = text.slice(start, close + 2);
              if (comment.includes('\n') || comment.includes('=====') || comment.length >= 240) {
                start = close + 2;
                while (start < end && /[\t\n ]/.test(text[start])) start++;
              }
            }
          }
          while (end < text.length && /[\t ]/.test(text[end])) end++;
          if (text[end] === '\n') { end++; while (end < text.length && /[\t ]/.test(text[end])) end++; }
          text = text.slice(0, start) + text.slice(end);
        }
        text = text.replace(/\n{3,}/g, '\n\n');
        fs.writeFileSync(f.path, text, 'utf8');
        console.log(`[apply] ${f.name}: 删 ${deadInFile.length} 条，余 ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`);
      }
      console.log('已写回源 CSS——下一步必须：npm run build:js && node scripts/css_coverage.mjs（复核归零）&& node scripts/frontend_smoke.mjs');
    }
  }
} finally {
  if (browser) await browser.close().catch(() => { });
  server.stop();
}
