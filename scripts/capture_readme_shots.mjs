// README 配图采集：打开「你显式指认的服务」，载入指定会话，导出 1440×900 @2x 高清截图。
//
//   PHYMATHIA_BASE=http://127.0.0.1:5050/ node scripts/capture_readme_shots.mjs [--session <sess_id>] [--out docs/images]
//
// 本工具是全部脚本里唯一允许打真机的（README 需要真实内容/真实会话，隔离实例给不了），
// 因此 T415（2026-10-27）起不再有默认端口——必须显式 PHYMATHIA_BASE= 指认，防手滑。
// 指认真机时两条安全线：
// - 绝不往 localStorage 种 phymathia_user_models / phymathia_active_models——应用加载
//   时会把本地模型整包推上服务端账号真源 data/users/<账号>/models.json（10-26 实踩
//   覆盖过日常 default 账号，修就是为这个）；
// - 测试类脚本（visual_baseline / verify_* / review_* / css_coverage）都已自带隔离
//   实例，不要为它们开真机。
//
// 与 visual_baseline.mjs 的区别（别混用）：
// - 基线用 deviceScaleFactor 0.5 出 720×450 的「小图」，只要够比对样式；README 需要 2x 高清。
// - 基线拍的是空画布（不载入会话），README 需要真实内容。
// - 必须开 prefers-reduced-motion（页面有 auroraDrift 28s 与粒子 rAF 两处持续动画），
//   否则同一界面两次截图都不一样。
// - 主题必须在「导航前」写 localStorage：导航后再设 data-theme 会被 ui.js 的 applyTheme 覆盖。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PHYMATHIA_BASE || '';
if (!BASE) {
  console.error('缺 PHYMATHIA_BASE：本工具拍真实内容、必须显式指认服务（也是防手滑打上真机）。\n'
    + '用法： PHYMATHIA_BASE=http://127.0.0.1:5050/ node scripts/capture_readme_shots.mjs [--session <sess_id>] [--out docs/images]\n'
    + '（只许读：别往页面种 phymathia_user_models / phymathia_active_models，会整包覆盖服务端账号模型配置——10-26 事故）');
  process.exit(2);
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const OUT_DIR = path.resolve(ROOT, arg('out', 'docs/images'));
const SESSION = arg('session', '');

function findShell() {
  const base = path.join(ROOT, '.tools', 'pw-browsers');
  if (!fs.existsSync(base)) throw new Error('缺少 .tools/pw-browsers（本机没有可用的无头浏览器）');
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('.tools/pw-browsers 下没找到 chrome-headless-shell');
}

// 关掉所有浮层（与 visual_baseline.mjs 同款；两条坑见该脚本注释：别用内联 display、别用顶层 const）
const CLOSE_ALL = `(function(){
  try{ closeSidebar(); }catch(e){}
  try{ closeKnowledgePanel(); }catch(e){}
  try{ closeMemoryPanel(); }catch(e){}
  try{ closeQuiz(); }catch(e){}
  try{ if (typeof closeSocraticModal === 'function') closeSocraticModal(); }catch(e){}
  try{ if (typeof closeBranchModal === 'function') closeBranchModal(); }catch(e){}
  try{ if (typeof closeGraphSearchPanel === 'function') closeGraphSearchPanel(); }catch(e){}
  try{ if (typeof closeContinentView === 'function') closeContinentView(); }catch(e){}
  try{ if (typeof closeAddModelDialog === 'function') closeAddModelDialog(); }catch(e){}
  ['modelPanel','levelPanel','dataPanel','graphSearchPanel','addModelDialog'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.classList.remove('show','active','open');
  });
  var ov = document.getElementById('onboardingOverlay');
  if (ov) { ov.classList.remove('active'); ov.style.display = 'none'; }
  var oc = document.getElementById('onboardingCard');
  if (oc) oc.classList.remove('visible');
  var eg = document.getElementById('exampleGuideOverlay');
  if (eg) { eg.classList.remove('active'); eg.style.display = 'none'; }
  return 'ok';
})()`;

// 每屏一个动作。session:true 表示先载入 --session 指定的会话。
const SHOTS = [
  // 主图：整张探索网。fitGraph 后手动拉到 1.0，节点文字在 README 缩放后仍可辨认
  { name: 'hero-canvas', theme: 'dark', session: true, wait: 2600,
    before: "try{ if(typeof fitGraph==='function') fitGraph(); if(typeof zoomGraph==='function') zoomGraph(1.0); }catch(e){}",
    settle: 1500 },
  { name: 'knowledge', theme: 'dark', session: true, wait: 2600,
    before: "try{ toggleKnowledgePanel(); }catch(e){}", settle: 2000 },
  { name: 'continent', theme: 'dark', session: true, wait: 2600,
    before: "try{ openContinentView(); }catch(e){}",
    hide: ['.continent-legend'], settle: 3200 },
  { name: 'canvas-light', theme: 'light', session: true, wait: 2600,
    before: "try{ if(typeof fitGraph==='function') fitGraph(); if(typeof zoomGraph==='function') zoomGraph(1.0); }catch(e){}",
    settle: 1500 },
];

const shell = findShell();
fs.mkdirSync(OUT_DIR, { recursive: true });

const PORT = Number(process.env.PHYMATHIA_CDP_PORT || 9333);
// --disable-dev-shm-usage：本机 /dev/shm 不可写（沙箱），不加则渲染进程起不来
const proc = spawn(shell, [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--disable-crash-reporter',
  `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 等调试端口就绪（最多 15s），别用固定 sleep 赌
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(500);
    try {
      const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      target = (await listRes.json()).find((t) => t.type === 'page');
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error(`调试端口 ${PORT} 未就绪（浏览器没起来？）`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  let first = true;
  for (const shot of SHOTS) {
    // 主题与「跳过新手引导」必须在导航前写进 localStorage
    await evalJs(`(function(){
      try{
        localStorage.setItem('phymathia_theme', ${JSON.stringify(shot.theme)});
        localStorage.setItem('phymathia_onboarding_done', '1');
        localStorage.setItem('phymathia_onboarding_seen', '1');
      }catch(e){}
      return 'seeded';
    })()`);
    await send('Page.navigate', { url: BASE });
    await sleep(shot.wait || 2500);
    if (first) {
      // 首次导航后 dump 一下会话列表，便于确认载入成功
      const info = await evalJs(`(function(){
        return JSON.stringify({
          items: Array.from(document.querySelectorAll('#sessionList .session-item')).slice(0,4).map(function(el){return (el.textContent||'').trim().slice(0,28);}),
          hasSwitch: typeof switchToSession === 'function',
        });
      })()`);
      console.log('会话列表探针:', info);
      first = false;
    }
    if (shot.session && SESSION) {
      const ok = await evalJs(`(function(){
        try{ switchToSession(${JSON.stringify(SESSION)}); return 'switched'; }catch(e){ return 'ERR:'+e.message; }
      })()`);
      console.log(`  ${shot.name}: switchToSession -> ${ok}`);
      await sleep(2600);
    }
    // 主题必须在「切会话之后」再钉一次：switchToSession 会恢复该会话自己的界面状态
    // （实测：同一个会话切进去是浅色、而首次加载是深色），导航前的 localStorage 种子会被它盖掉。
    await evalJs(`(function(){
      try{
        localStorage.setItem('phymathia_theme', ${JSON.stringify(shot.theme)});
        if (typeof applyTheme === 'function') applyTheme(${JSON.stringify(shot.theme)});
      }catch(e){}
      return 'theme=' + document.documentElement.getAttribute('data-theme');
    })()`);
    await sleep(500);
    await evalJs(CLOSE_ALL);
    await sleep(300);
    if (shot.before) await evalJs(shot.before);
    await sleep(shot.settle || 1200);
    if (shot.hide && shot.hide.length) {
      await evalJs(`(function(){
        ${JSON.stringify(shot.hide)}.forEach(function(sel){
          document.querySelectorAll(sel).forEach(function(el){ el.style.visibility='hidden'; });
        });
        return 'hidden';
      })()`);
      await sleep(250);
    }
    const themeNow = await evalJs("document.documentElement.getAttribute('data-theme')");
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, shot.name + '.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  ✓ ${path.relative(ROOT, file)}  (theme=${themeNow})`);
  }

  ws.close();
}

main()
  .then(() => { proc.kill(); process.exit(0); })
  .catch((err) => { console.error('采集失败:', err.message); proc.kill(); process.exit(1); });
