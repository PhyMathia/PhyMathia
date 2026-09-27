// 前端视觉基线：深浅两套主题 × 若干界面，导出计算样式 + 截图，用于逐轮比对外观是否被动到。
//
//   node scripts/visual_baseline.mjs --record   写基线到 baseline/
//   node scripts/visual_baseline.mjs --check    与基线比对（差异退出码 1）
//
// 口径说明：
// - 主判据是「计算样式」——确定性，不受渲染时机影响；截图为辅，供人眼复核。
// - 必须开 prefers-reduced-motion：页面有 auroraDrift(28s) 与粒子 rAF 两处持续动画，
//   不开的话同一个界面两次截图都不一样。项目已内置该降级（styles.css `.aurora-glass { animation:none }`）。
// - 主题必须在「导航前」写 localStorage：导航后再设 data-theme 会被 ui.js 启动时的 applyTheme 覆盖。
// - 用 deviceScaleFactor 0.5 出图：布局仍是 1440×900，图片只有 720×450，够看又不至于让基线过大。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PHYMATHIA_BASE || 'http://localhost:5050/';
const OUT_DIR = path.join(ROOT, 'baseline');
const MODE = process.argv.includes('--record') ? 'record'
  : process.argv.includes('--check') ? 'check'
    : process.argv.includes('--explain') ? 'explain' : null;
// check/explain 时把新图写到别处，别把基线截图覆盖掉（否则下次没得比）
const SHOT_DIR = path.join(ROOT, MODE === 'record' ? 'baseline/shots' : '.cache/visual-baseline-current');

if (!MODE) {
  console.error('用法: node scripts/visual_baseline.mjs --record | --check | --explain <类名关键字>');
  process.exit(2);
}

// ---------- 找无头浏览器 ----------
function findShell() {
  const base = path.join(ROOT, '.tools', 'pw-browsers');
  if (!fs.existsSync(base)) throw new Error('缺少 .tools/pw-browsers（本机没有可用的无头浏览器）');
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('.tools/pw-browsers 下没找到 chrome-headless-shell');
}

// ---------- 探针 ----------
// 固定选择器：覆盖本轮会动的每一个载体/控件，逐项比对。
const SELECTORS = [
  // 载体
  '.chat-header', '.header-secondary-bar', '.sidebar', '#knowledgePanel', '#memoryPanel',
  '.model-panel', '.model-dialog', '.socratic-modal', '.quiz-modal', '.level-panel',
  '.graph-canvas-toolbar', '.progress-status', '.graph-search-panel', '.onboarding-card',
  '.example-guide-dialog', '.bookmark-modal', '.memory-dialog',
  // 按钮
  '.header-btn', '.new-chat-btn', '.clear-all-btn', '.md-btn', '.md-btn-save', '.md-btn-cancel',
  '.bm-btn', '.bm-btn-save', '.bm-btn-cancel', '.ob-btn', '.ob-btn-next', '.ob-btn-skip',
  '.kp-filter-btn', '.kp-tool-btn', '.am-mini-btn', '.am-tab', '.model-add-btn',
  '.graph-tool-btn', '.status-control-btn', '.memory-clear-btn', '.session-delete',
  '.level-option', '.socratic-confidence button', '.sidebar-help-btn',
  // 输入
  '.md-field input', '.md-field select', '.kp-search', '#graphSearchInput', '.model-select',
  '.am-model-list', '.memory-form-field input',
  // 其它
  '.kp-close', '.kp-stat-card', '.kp-card', '.memory-empty', '.memory-dialog-actions button',
  '.learn-dir-btn', '.socratic-btn',
];

const PROPS = ['border-radius', 'background-color', 'background-image', 'color', 'font-size',
  'padding', 'border', 'box-shadow', 'backdrop-filter', 'transition', 'opacity'];

// 普查压缩用：只保留短属性，值截断，最终只存哈希——普查是「安全网」，
// 差异定位交给上面的逐项探针；真要看细节用 --explain <关键字>。
const CENSUS_PROPS = ['border-radius', 'background-color', 'color', 'font-size', 'padding',
  'border-color', 'border-width', 'box-shadow', 'backdrop-filter'];
const CENSUS_TRUNC = { 'background-color': 30, 'color': 30, 'border-color': 30, 'box-shadow': 40 };

// 随机/持续动画的元素：每次采样都不一样，不进普查（否则每轮都是假差异）。
// span.phi-confetti 是 Φ 宠物的撒花粒子，位置随机。
const IGNORE_CLASSES = ['phi-confetti'];

// 界面序列：每步先关掉所有浮层，再执行动作，然后取图。
const SURFACES = [
  { name: '01-base', closeAll: true },
  { name: '02-sidebar', js: "toggleSidebar()" },
  { name: '03-model-panel', closeAll: true, expect: 'modelPanel', js: "document.getElementById('modelBtn').click()" },
  { name: '04-level-panel', closeAll: true, expect: 'levelPanel', js: "document.getElementById('levelBtn').click()" },
  { name: '05-knowledge', closeAll: true, expect: 'knowledgePanel', js: "toggleKnowledgePanel()", wait: 1200 },
  { name: '06-memory', closeAll: true, expect: 'memoryPanel', js: "openMemoryPanel()", wait: 1200 },
  { name: '07-quiz', closeAll: true, expect: 'quizModal', js: "openQuiz()", wait: 1800 },
  { name: '08-data-panel', closeAll: true, expect: 'dataPanel', js: "document.querySelector('.header-actions [title=\"数据管理\"]').click()" },
  { name: '09-continent', closeAll: true, js: "openContinentView()", wait: 2000 },
  { name: '10-addmodel', closeAll: true, expect: 'addModelDialog', js: "showAddModelDialog()" },
  { name: '11-search', closeAll: true, js: "openGraphSearchPanel()" },
  { name: '12-socratic', closeAll: true, js: "document.getElementById('socraticModal').hidden=false" },
];

// 关掉所有浮层。注意：不能用内联 style.display='none'——内联样式优先级高于类名，
// 会把后续 openXxx() 加的 .show/.active 一起压住，导致那一屏拍到的是空画布（踩过）。
// 关掉所有浮层。两条坑都在这里踩过：
// ① 不能用内联 style.display='none'——内联优先级高于类名，后续 openXxx() 加的 .show/.active 会被压住，
//    那一屏拍到的是空画布；② 顶层不能用 const/let——Runtime.evaluate 在同一上下文重复求值，
//    第二次会因「重复声明」抛 Uncaught。故整体包成 IIFE。
const CLOSE_ALL = `(function(){
  try{ closeSidebar(); }catch(e){}
  try{ closeKnowledgePanel(); }catch(e){}
  try{ closeMemoryPanel(); }catch(e){}
  try{ closeBookmarkModal(); }catch(e){}
  try{ closeQuiz(); }catch(e){}
  try{ closeAddModelDialog(); }catch(e){}
  try{ closeModelConfig(); }catch(e){}
  try{ closeMemoryClearDialog(); }catch(e){}
  try{ if (typeof closeSocraticModal === 'function') closeSocraticModal(); }catch(e){}
  try{ if (typeof closeBranchModal === 'function') closeBranchModal(); }catch(e){}
  try{ if (typeof closeExampleGuide === 'function') closeExampleGuide(); }catch(e){}
  try{ if (typeof closeVizFullscreen === 'function') closeVizFullscreen(); }catch(e){}
  try{ if (typeof closeGraphSearchPanel === 'function') closeGraphSearchPanel(); }catch(e){}
  try{ if (typeof closeContinentView === 'function') closeContinentView(); }catch(e){}
  document.querySelectorAll('.show, .active, .open').forEach(function(el){
    if (/Panel$|panel|dialog|overlay|modal/i.test(el.id || '')) el.classList.remove('show', 'active', 'open');
  });
  ['modelPanel','levelPanel','dataPanel','vizFullscreenOverlay','graphSearchPanel',
   'addModelDialog','modelConfigDialog','memoryClearDialog','bookmarkModal'].forEach(function(id){
    var el = document.getElementById(id);
    if (el && el.style.display === 'none') el.style.display = '';
  });
  ['socraticModal','branchModal','quizModal'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.hidden = true;
  });
  var ov = document.getElementById('onboardingOverlay');
  if (ov) { ov.classList.remove('active'); ov.style.display = 'none'; }
  var oc = document.getElementById('onboardingCard');
  if (oc) oc.classList.remove('visible');
  // 大陆面包屑的显隐取决于异步渲染时机，不钉住会让基线偶发多一条 census 键（踩过）
  var bc = document.getElementById('continentBreadcrumb');
  if (bc) bc.hidden = true;
  var eg = document.getElementById('exampleGuideOverlay');
  if (eg) { eg.classList.remove('active'); eg.style.display = 'none'; }
  return 'ok';
})()`;

const CENSUS = `
(function(){
  const out = {};
  const props = ${JSON.stringify(CENSUS_PROPS)};
  const trunc = ${JSON.stringify(CENSUS_TRUNC)};
  const ignore = ${JSON.stringify(IGNORE_CLASSES)};
  for (const el of document.querySelectorAll('*')) {
    let key = null;
    if (typeof el.className === 'string' && el.className.trim()) {
      if (ignore.some((c) => el.classList.contains(c))) continue;
      key = el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).sort().join('.');
    } else if (['INPUT','SELECT','TEXTAREA','BUTTON'].includes(el.tagName)) {
      key = el.tagName.toLowerCase();
    }
    if (!key) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rec = {};
    for (const p of props) {
      let v = cs.getPropertyValue(p);
      const lim = trunc[p];
      if (lim && v.length > lim) v = v.slice(0, lim);
      rec[p] = v;
    }
    (out[key] || (out[key] = {}))[JSON.stringify(rec)] = 1;
  }
  const slim = {};
  for (const [k, sets] of Object.entries(out)) slim[k] = Object.keys(sets);
  return slim;
})()`;

const PROBE = `
(function(){
  const out = {};
  for (const sel of ${JSON.stringify(SELECTORS)}) {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = null; continue; }
    const cs = getComputedStyle(el);
    const rec = {};
    for (const p of ${JSON.stringify(PROPS)}) {
      let v = cs.getPropertyValue(p);
      if (p === 'background-image') v = v === 'none' ? 'none' : v.slice(0, 70);
      if (p === 'box-shadow') v = v.slice(0, 70);
      if (p === 'transition') v = v.slice(0, 90);
      rec[p] = v;
    }
    out[sel] = rec;
  }
  return out;
})()`;

// ---------- CDP ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 服务必须在跑
  try {
    const r = await fetch(BASE + 'health', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    console.error('服务未运行：先 python3 src/main.py -p 5050 再跑本脚本（' + BASE + 'health 不可达）');
    process.exit(2);
  }

  const shell = findShell();
  const port = 9411;
  // 每次跑用独立 profile：复用同一个目录会撞上浏览器还在写缓存的竞态（ENOTEMPTY）。
  const cacheRoot = path.join(ROOT, '.cache');
  fs.mkdirSync(cacheRoot, { recursive: true });
  for (const d of fs.readdirSync(cacheRoot).filter((x) => x.startsWith('visual-baseline-profile'))) {
    try { fs.rmSync(path.join(cacheRoot, d), { recursive: true, force: true }); } catch {}
  }
  const profile = path.join(cacheRoot, 'visual-baseline-profile-' + process.pid + '-' + Date.now());
  const proc = spawn(shell, [
    '--remote-debugging-port=' + port, '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) ver = await r.json(); } catch {}
    if (!ver) await sleep(250);
  }
  if (!ver) { proc.kill('SIGKILL'); throw new Error('devtools 未就绪'); }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}, sessionId) => {
    const mid = ++id; const msg = { id: mid, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => pending.set(mid, { res, rej }));
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 0.5, mobile: false }, S);
  await send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, S);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 70));
    return r.result?.value;
  };
  const evaluateSoft = (expr) => evaluate('(function(){try{' + expr + '}catch(e){return "ERR:"+e.message}return "ok"})()');

  const result = {};
  let stateTag = '(未采集)';
  for (const theme of ['dark', 'light']) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      // 键名以 config/app 里的常量为准：引导卡是 phymathia_onboarding_done，
      // 写错键会让引导卡随机冒出来，基线就不确定了（踩过）
      source: `try{localStorage.setItem('phymathia_theme',${JSON.stringify(theme)});` +
        `localStorage.setItem('phymathia_onboarding_done','1');` +
        `localStorage.setItem('phymathia_guide_seen','1');}catch(e){}`,
    }, S);
    await send('Page.navigate', { url: BASE }, S);
    await sleep(3500);
    // ---- 应用状态必须钉死，否则基线不可比（2026-09-27 修）----
    // 原先脚本导航完就直接开探，从不选会话——采到的是「应用恰好停在哪个状态」。
    // 录基线那台机器上恰好停在一个有内容的会话，本机恰好停在空画布，于是
    // .graph-canvas-toolbar 等四个选择器报「元素有无变化」，一次 96 处。而空画布
    // 不出工具栏是**刻意设计**（docs/backlog.md D1），所以那 96 处既不是产品回归、
    // 也不是基线过期，是环境态依赖。基线里记下会话指纹，--check 时先比这一项，
    // 对不上就直说，别让人去逐条读「元素有无变化」。
    // 走 evaluateSoft：它自带页面侧 try/catch，getChatHistory 在会话尚未就绪时会抛，
    // 直接 evaluate 会把整个脚本带崩（这正是上面那次失败）。
    const sessionId = String(await evaluateSoft('return (typeof getCurrentSessionId==="function"?getCurrentSessionId():"")||"";') || '');
    const msgRaw = await evaluateSoft('return (typeof getChatHistory==="function"?getChatHistory():[]).length;');
    const msgCount = Number(msgRaw);
    const count = Number.isFinite(msgCount) ? msgCount : -1;
    stateTag = (sessionId && sessionId.indexOf('ERR:') !== 0 ? sessionId : '(无会话)')
      + ' · 消息 ' + count + ' 条'
      + (count === 0 ? '（空画布：工具栏按设计不出，.graph-canvas-toolbar 一族在探针里必然缺席）' : '');
    if (theme === 'dark') console.log('  · 本次探针会话：' + stateTag);
    for (const step of SURFACES) {
      if (step.closeAll) { await evaluate(CLOSE_ALL); await sleep(350); }
      if (step.js) {
        const r = await evaluateSoft(step.js);
        if (r && String(r).startsWith('ERR:')) console.error('  ! ' + theme + '-' + step.name + ' 动作报错：' + r);
        await sleep(step.wait || 800);
      }
      const name = theme + '-' + step.name;
      const raw = await evaluate(CENSUS);
      const census = {};
      for (const [k, sets] of Object.entries(raw)) {
        census[k] = sets.map((s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)).sort();
      }
      result[name] = { probe: await evaluate(PROBE), census };
      const shown = await evaluate(`(function(){
        const ids = ['modelPanel','levelPanel','dataPanel','addModelDialog','memoryPanel','knowledgePanel','quizModal'];
        return ids.filter((id) => { const e = document.getElementById(id); if (!e) return false;
          const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getBoundingClientRect().width > 0; }).join(',');
      })()`);
      result[name].visible = shown;
      if (step.expect && !shown.includes(step.expect)) console.error('  ! ' + name + ' 期望出现 ' + step.expect + '，实际可见：' + (shown || '(无)'));
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 78 }, S);
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, name + '.jpg'), Buffer.from(shot.data, 'base64'));
    }
  }

  ws.close(); proc.kill('SIGKILL');

  if (MODE === 'record') {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'computed.json'),
                     JSON.stringify({ __state: stateTag, __recordedAt: new Date().toISOString(), surfaces: result }));
    console.log('基线已写入 ' + path.relative(ROOT, OUT_DIR) + '/（computed.json + shots/）');
    console.log('录制时的应用状态：' + stateTag);
    console.log('界面数：' + Object.keys(result).length);
    const kb = (fs.statSync(path.join(OUT_DIR, 'computed.json')).size / 1024).toFixed(0);
    console.log('computed.json：' + kb + ' KB');
    process.exit(0);
  }

  // --explain <关键字>：打印本次采集中匹配该类名元素的完整渲染细节（普查是哈希，看不出内容）
  const explainAt = process.argv.indexOf('--explain');
  if (explainAt >= 0) {
    const kw = process.argv[explainAt + 1] || '';
    console.log('普查细节（匹配「' + kw + '」，共采样 ' + Object.keys(result).length + ' 个界面）\n');
    for (const [name, rec] of Object.entries(result)) {
      const hits = Object.keys(rec.census).filter((k) => k.includes(kw));
      if (!hits.length) continue;
      console.log('== ' + name);
      for (const k of hits) console.log('   ' + k + '  变体 ' + rec.census[k].length + ' 种: ' + rec.census[k].join(' '));
    }
    process.exit(0);
  }

  // ---- check ----
  const basePath = path.join(OUT_DIR, 'computed.json');
  if (!fs.existsSync(basePath)) {
    console.error('没有基线，先跑 --record');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  // 2026-09-27：基线文件升级成 {__state, __recordedAt, surfaces}，把「录的时候应用
  // 停在哪个会话」一起记下来。旧格式（直接是 surfaces 映射）仍兼容，只是没有指纹。
  const baseState = raw.__state || null;
  const base = raw.surfaces || raw;
  if (baseState && baseState !== stateTag) {
    console.log('\n✗ 基线与应用状态对不上，先别看下面的差异清单：');
    console.log('  · 基线录制时：' + baseState);
    console.log('  · 本次实际跑：' + stateTag);
    console.log('  → 差异多半是环境态造成的（画布空/有内容、停在哪个会话），不是外观回归。');
    console.log('  → 让两边停在同一状态再比，或用 --record 重录（会丢掉与上次基线的对比）。');
  }
  const diffs = { probe: [], census: [] };
  for (const name of Object.keys(base)) {
    const b = base[name], n = result[name];
    if (!n) { diffs.probe.push(name + ' : 本次未采到该界面'); continue; }
    for (const sel of Object.keys(b.probe)) {
      const bv = b.probe[sel], nv = n.probe[sel];
      if (!bv || !nv) { if (!!bv !== !!nv) diffs.probe.push(name + ' ' + sel + ' : 元素有无变化'); continue; }
      for (const p of PROPS) {
        if (bv[p] !== nv[p]) diffs.probe.push(name + ' ' + sel + ' ' + p + '\n      基线: ' + bv[p] + '\n      现在: ' + nv[p]);
      }
    }
    for (const key of Object.keys(b.census)) {
      const bv = b.census[key], nv = n.census[key];
      if (!nv) { diffs.census.push(name + ' ' + key + ' : 本次不存在'); continue; }
      const onlyB = bv.filter((x) => !nv.includes(x));
      const onlyN = nv.filter((x) => !bv.includes(x));
      if (onlyB.length || onlyN.length) {
        diffs.census.push(name + ' ' + key + ' : 渲染变体 ' + bv.length + '→' + nv.length +
          (onlyB.length ? '，少了 ' + onlyB.length + ' 种' : '') +
          (onlyN.length ? '，多了 ' + onlyN.length + ' 种' : '') +
          '（细节：--explain ' + key.split('.').slice(1).join('.') + '）');
      }
    }
    for (const key of Object.keys(n.census)) {
      if (!b.census[key]) diffs.census.push(name + ' ' + key + ' : 本次新增类');
    }
  }

  // 退出码只认**逐项探针**——那才是本脚本头注释里写明的「主判据：计算样式，确定性，
  // 不受渲染时机影响」。普查（同类元素在本轮渲染出几种变体）是调研项，它天生顺序相关：
  // 例如 button.continent-breadcrumb 只在第 09 步开过大陆之后才存在，于是下一个主题的
  // 第 02 步有没有它取决于**上一轮跑过什么**。把普查计进退出码，等于让「上一次是怎么跑
  // 的」决定这次红不红——那不是护栏，是随机数。
  if (!diffs.probe.length) {
    console.log('✓ 视觉基线一致（' + Object.keys(base).length + ' 个界面，计算样式逐项相同）');
    if (diffs.census.length) {
      console.log('  （另有 ' + diffs.census.length + ' 处普查差异——调研项，不参与判定：'
        + '普查天生顺序相关，见下方清单或 --explain <关键字>）');
    }
    process.exit(0);
  }
  const total = diffs.probe.length + diffs.census.length;
  // 默认只印前若干条，改动量大时会淹没终端；--full 全印，--grep <关键字> 只印匹配的
  const full = process.argv.includes('--full');
  const gi = process.argv.indexOf('--grep');
  const grepKw = gi >= 0 ? (process.argv[gi + 1] || '') : null;
  const keep = (arr) => {
    let a = grepKw ? arr.filter((x) => x.includes(grepKw)) : arr;
    return full ? a : a.slice(0, 60);
  };
  console.log('✗ 与基线有 ' + total + ' 处差异\n');
  if (diffs.probe.length) {
    const shown = keep(diffs.probe);
    console.log('--- 逐项探针（' + diffs.probe.length + (grepKw ? '，匹配 ' + grepKw + '：' + shown.length : '') + '）---');
    for (const d of shown) console.log('  ' + d);
    if (shown.length < diffs.probe.length && !full && !grepKw) console.log('  …省略 ' + (diffs.probe.length - shown.length) + ' 处（--full 或 --grep <关键字> 查看）');
  }
  if (diffs.census.length) {
    const shown = keep(diffs.census);
    console.log('\n--- 同类元素多样渲染（' + diffs.census.length + '）---');
    for (const d of shown) console.log('  ' + d);
    if (shown.length < diffs.census.length && !full && !grepKw) console.log('  …省略 ' + (diffs.census.length - shown.length) + ' 处');
  }
  console.log('\n本次截图见 ' + path.relative(ROOT, SHOT_DIR) + '/（基线图在 baseline/shots/，两者可直接对看）');
  process.exit(1);
}

main().catch((e) => { console.error('基线脚本失败：' + e.message); process.exit(2); });
