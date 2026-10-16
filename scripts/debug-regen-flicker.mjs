#!/usr/bin/env node
// 一次性诊断脚本 v2（2026-10-16）：复现「重新生成节点时节点边框与连线快速闪动」。
// 与 v1 的差别：
//   ① mock 上游是「一整帧秒回」，复现不出真实模型几十秒的流式节奏 → 前面加一个慢速代理，
//      把一帧内容拆成 ~25 帧、每 400ms 一帧（≈10s 流），还原真机节奏；
//   ② 除了计数器，还用 CDP 逐帧抓屏（screencast），把画面落成 JPEG 供人眼核对；
//   ③ 修掉 v1 的两个量测 bug：mark 后的第一个采样桶被吞、汇总里 last 桶无计数字段。
// 用法：node scripts/debug-regen-flicker.mjs    （临时数据目录 + 5079/5082/5083 端口，不碰 data/）
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const APP_PORT = 5079;
const MOCK_PORT = 5082;
const PROXY_PORT = 5083;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const SLICES = Number(process.env.SLICES || 25);
const CHUNK_MS = Number(process.env.CHUNK_MS || 400);
const FRAME_DIR = process.env.FRAME_DIR || mkdtempSync(join(tmpdir(), 'regen-frames-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(FRAME_DIR, { recursive: true });
console.log('抓帧目录：' + FRAME_DIR + '（流式节奏：' + SLICES + ' 帧 × ' + CHUNK_MS + 'ms）');

// ===== 慢速代理：把 mock 的一整帧 SSE 拆成多帧慢慢吐 =====
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    let parsed = null;
    try { parsed = JSON.parse(raw.toString()); } catch (e) {}
    let upstream;
    try {
      upstream = await fetch(MOCK + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw.length ? raw : undefined });
    } catch (e) {
      res.writeHead(502); res.end('proxy upstream failed'); return;
    }
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream') || !parsed || !parsed.stream) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': ct });
      res.end(buf);
      return;
    }
    const text = await upstream.text();
    const out = [];
    for (const part of text.split('\n\n')) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj = null;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
      if (delta && typeof delta.content === 'string' && delta.content) {
        const s = delta.content;
        const n = Math.max(1, SLICES);
        const size = Math.ceil(s.length / n);
        for (let i = 0; i < s.length; i += size) {
          out.push(JSON.stringify({ ...obj, choices: [{ delta: { content: s.slice(i, i + size) } }] }));
        }
      } else {
        out.push(JSON.stringify(obj));
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let i = 0;
    const tick = () => {
      if (i >= out.length) {
        res.write('data: ' + JSON.stringify({ id: 'p', choices: [], usage: {} }) + '\n\ndata: [DONE]\n\n');
        res.end();
        return;
      }
      res.write('data: ' + out[i++] + '\n\n');
      setTimeout(tick, CHUNK_MS);
    };
    tick();
  });
});
await new Promise(r => proxy.listen(PROXY_PORT, '127.0.0.1', r));

const mock = spawn('node', ['scripts/mock_upstream.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let mockLog = '';
mock.stdout.on('data', d => { mockLog += d; });
mock.stderr.on('data', d => { mockLog += d; });
const workDir = mkdtempSync(join(tmpdir(), 'phymathia-flicker2-'));
cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
const server = spawn('python3', ['src/main.py', '-p', String(APP_PORT)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

const INSTRUMENT = () => {
  const fx = window.__fx = {
    calls: {}, missing: [], wrapped: [],
    mut: { canvasChild: 0, svgChild: 0, attrStyle: 0, attrClass: 0 },
    trans: { node: 0, edge: 0, other: 0 },
    transProps: {}, transTargets: {},
    transCancel: 0, anim: 0,
    ids: { nodeNew: 0, edgeNew: 0, layerNew: 0 },
    nodeSeq: 0, edgeSeq: 0, lastLayer: null,
    t0: performance.now(), buckets: [], timer: 0,
    geo: {}, geoChanged: 0, geoMaxDelta: 0,
  };
  const names = ['renderGraphCanvas', '_measureNodes', '_updateNodeTransforms', '_redrawEdges', '_patchGraphStreaming', '_refreshWorkflowNodeStatusUi', '_refreshWorkflowNodeUi', 'renderMath'];
  for (const n of names) {
    const orig = window[n];
    if (typeof orig !== 'function') { fx.missing.push(n); continue; }
    fx.calls[n] = 0;
    window[n] = function (...a) { fx.calls[n]++; return orig.apply(this, a); };
    fx.wrapped.push(n);
  }
  const canvas = document.getElementById('graphCanvas');
  new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'attributes') { if (m.attributeName === 'style') fx.mut.attrStyle++; else fx.mut.attrClass++; continue; }
      const n = (m.addedNodes ? m.addedNodes.length : 0) + (m.removedNodes ? m.removedNodes.length : 0);
      const t = m.target;
      if (t && t.closest && t.closest('svg.graph-edge-layer')) fx.mut.svgChild += n;
      else fx.mut.canvasChild += n;
    }
  }).observe(canvas, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  const clsOf = el => {
    if (!el) return '?';
    if (typeof el.className === 'string') return el.className;
    if (typeof el.getAttribute === 'function') return el.getAttribute('class') || '?';
    return '?';
  };
  document.addEventListener('transitionrun', e => {
    const cls = clsOf(e.target);
    if (cls.includes('graph-edge')) fx.trans.edge++;
    else if (cls.includes('graph-node')) fx.trans.node++;
    else fx.trans.other++;
    const key = (cls.split(' ')[0] || '?') + ':' + e.propertyName;
    fx.transProps[key] = (fx.transProps[key] || 0) + 1;
  }, true);
  document.addEventListener('transitioncancel', () => { fx.transCancel++; }, true);
  document.addEventListener('animationstart', () => { fx.anim++; }, true);

  const geo = () => {
    // 每个节点的几何：只在值变了才记（transform 串 + 高度）
    for (const el of document.querySelectorAll('#graphCanvas .graph-node')) {
      const id = el.dataset.nodeId;
      const tr = el.style.transform || '';
      const r = el.getBoundingClientRect();
      const rec = fx.geo[id];
      const key = tr + '|' + r.width.toFixed(2) + 'x' + r.height.toFixed(2);
      const h = Math.round(r.height);
      if (!rec) { fx.geo[id] = { key, h, changes: 0, dmax: 0, samples: [] }; continue; }
      if (rec.key !== key) {
        rec.changes++;
        fx.geoChanged++;
        const d = Math.abs(h - rec.h);
        if (d > rec.dmax) rec.dmax = d;
        if (d > fx.geoMaxDelta) fx.geoMaxDelta = d;
        rec.key = key; rec.h = h;
      }
    }
  };

  const snap = () => {
    geo();
    return {
      ms: Math.round(performance.now() - fx.t0),
      redraw: fx.calls._redrawEdges || 0,
      measure: fx.calls._measureNodes || 0,
      trans2: fx.calls._updateNodeTransforms || 0,
      full: fx.calls.renderGraphCanvas || 0,
      patch: fx.calls._patchGraphStreaming || 0,
      katex: fx.calls.renderMath || 0,
      svgChild: fx.mut.svgChild, canvasChild: fx.mut.canvasChild,
      attrStyle: fx.mut.attrStyle, attrClass: fx.mut.attrClass,
      tnode: fx.trans.node, tedge: fx.trans.edge, tcancel: fx.transCancel, anim: fx.anim,
      nodeNew: fx.ids.nodeNew, edgeNew: fx.ids.edgeNew, layerNew: fx.ids.layerNew,
      geoChanged: fx.geoChanged, geoMax: fx.geoMaxDelta,
    };
  };
  fx.snap = snap;
  fx.start = () => {
    if (fx.timer) clearInterval(fx.timer);
    fx.t0 = performance.now();
    fx.buckets = [];
    fx.buckets.push({ ...snap(), ms: 0 });
    fx.timer = setInterval(() => { fx.buckets.push(snap()); }, 100);
  };
  fx.stop = () => { if (fx.timer) clearInterval(fx.timer); fx.timer = 0; if (fx.buckets.length) fx.buckets.push({ ...snap(), ms: Math.round(performance.now() - fx.t0) }); return fx.buckets; };
  fx.mark = lbl => { fx.buckets.push({ ms: Math.round(performance.now() - fx.t0), mark: lbl }); };

  const tick = () => {
    const layer = document.querySelector('svg.graph-edge-layer');
    if (layer !== fx.lastLayer) { fx.ids.layerNew++; fx.lastLayer = layer; }
    document.querySelectorAll('#graphCanvas .graph-node').forEach(el => { if (!el.__fxId) { el.__fxId = ++fx.nodeSeq; fx.ids.nodeNew++; } });
    document.querySelectorAll('#graphCanvas .graph-edge').forEach(el => { if (!el.__fxId) { el.__fxId = ++fx.edgeSeq; fx.ids.edgeNew++; } });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const FIELDS = ['redraw', 'measure', 'trans2', 'full', 'patch', 'katex', 'svgChild', 'canvasChild', 'attrStyle', 'attrClass', 'tnode', 'tedge', 'tcancel', 'anim', 'nodeNew', 'edgeNew', 'layerNew', 'geoChanged', 'geoMax'];
const report = (label, buckets) => {
  console.log('\n===== ' + label + ' =====');
  let prev = null;
  for (const b of buckets) {
    if (b.mark) { console.log('  ' + String(b.ms).padStart(6) + 'ms  ── ' + b.mark); continue; }
    if (!prev) { prev = b; continue; }
    const parts = [];
    for (const f of ['redraw', 'measure', 'trans2', 'full', 'patch', 'katex', 'svgChild', 'canvasChild', 'attrStyle', 'attrClass', 'tnode', 'tedge', 'tcancel', 'anim', 'nodeNew', 'edgeNew', 'layerNew', 'geoChanged']) {
      const d = b[f] - prev[f];
      if (d > 0) parts.push(f + '=' + d);
    }
    const dm = b.geoMax - prev.geoMax;
    if (dm > 0) parts.push('最大高度变化=' + dm + 'px');
    if (parts.length) console.log('  ' + String(b.ms).padStart(6) + 'ms  ' + parts.join('  '));
    prev = b;
  }
  const real = buckets.filter(b => !b.mark);
  const a = real[0], z = real[real.length - 1];
  const dur = (z.ms - a.ms) / 1000;
  console.log('  ── 汇总（' + dur.toFixed(1) + 's，' + real.length + ' 个采样）');
  for (const f of FIELDS) {
    const d = z[f] - a[f];
    if (d > 0) console.log('     ' + f + ' = ' + d + (dur > 0 ? '  （' + (d / dur).toFixed(1) + '/秒）' : ''));
  }
};

let browser = null;
let frames = [];
try {
  let mockUp = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(MOCK + '/health')).ok) { mockUp = true; break; } } catch (e) {} await wait(250); }
  if (!mockUp) throw new Error('mock 上游没起来');
  let appUp = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) { appUp = true; break; } } catch (e) {} await wait(300); }
  if (!appUp) throw new Error('临时应用没起来');

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));
  await page.addInitScript((cfg) => {
    localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
    const act = {};
    for (const s of cfg.slots) act[s] = cfg.model.id;
    localStorage.setItem('phymathia_active_models', JSON.stringify(act));
    localStorage.setItem('phymathia_onboarding_done', '1');
    localStorage.setItem('phymathia_guide_seen', '1');
  }, {
    model: { id: 'mock-1', name: 'mock', provider: 'opencode', model: 'mock-1', apiKey: 'x', baseUrl: PROXY + '/v1' },
    slots: ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model'],
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => window.startQuestionWorkflow('用一句话说明简谐运动'));
  const waitPhys = async (timeoutMs) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      const c = await page.evaluate(() => {
        const n = (typeof graphView !== 'undefined' ? graphView.nodes : []).find(n => n.kind === 'module' && n.moduleKey === 'physics');
        return n ? (n.content || '') : '';
      });
      if (c.trim()) return c;
      await wait(600);
    }
    return '';
  };
  const content0 = await waitPhys(240000);
  if (!content0) throw new Error('物理视角节点没长出来 | serverLog尾: ' + serverLog.slice(-300));
  await wait(4000);
  console.log('画布就绪：节点 ' + await page.evaluate(() => document.querySelectorAll('#graphCanvas .graph-node').length)
    + ' 个、连线 ' + await page.evaluate(() => document.querySelectorAll('#graphCanvas .graph-edge').length) + ' 条');

  await page.evaluate(INSTRUMENT);
  const info = await page.evaluate(() => ({
    wrapped: window.__fx.wrapped, missing: window.__fx.missing,
    // 谁在给连线/节点写过渡？把计算值抓出来，别猜
    css: (() => {
      const pick = el => el ? {
        tp: getComputedStyle(el).transitionProperty,
        td: getComputedStyle(el).transitionDuration,
        filter: getComputedStyle(el).filter,
        bf: getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || '',
        tf: getComputedStyle(el).transform,
      } : null;
      const edge = document.querySelector('#graphCanvas .graph-edge');
      const layer = document.querySelector('svg.graph-edge-layer');
      const node = document.querySelector('#graphCanvas .graph-node');
      const root = document.documentElement;
      return {
        skin: root.getAttribute('data-node-skin') || '(默认族·不挂属性)',
        theme: root.getAttribute('data-theme'),
        edge: pick(edge), edgePath: pick(edge && edge.querySelector('path')), layer: pick(layer), node: pick(node),
        innerCss: (() => { const i = document.querySelector('.graph-canvas-inner'); return i ? { willChange: getComputedStyle(i).willChange, transform: getComputedStyle(i).transform } : null; })(),
      };
    })(),
  }));
  console.log('已包裹：' + info.wrapped.join(',') + (info.missing.length ? ' | 不存在：' + info.missing.join(',') : ''));
  console.log('皮肤=' + info.css.skin + ' 主题=' + info.css.theme);
  console.log('连线计算样式：' + JSON.stringify(info.css.edge));
  console.log('连线 path 计算样式：' + JSON.stringify(info.css.edgePath));
  console.log('边层 SVG：' + JSON.stringify(info.css.layer));
  console.log('节点计算样式：' + JSON.stringify(info.css.node));
  console.log('世界容器：' + JSON.stringify(info.css.innerCss));

  const physId = await page.evaluate(() => graphView.nodes.find(n => n.kind === 'module' && n.moduleKey === 'physics').id);
  const physContent = async (id) => page.evaluate((nid) => {
    const n = graphView.nodes.find(n => n.id === nid);
    return (n && n.content) || '';
  }, id);
  const openPanel = async (id) => {
    for (let i = 0; i < 4; i++) {
      await page.evaluate((nid) => {
        const b = document.querySelector('[data-node-id="' + nid + '"] .graph-node-actions .graph-regen-btn');
        if (b) b.click();
      }, id);
      try { await page.waitForSelector('[data-node-id="' + id + '"] .graph-regenerate-panel', { timeout: 2500 }); return true; } catch (e) { await wait(1200); }
    }
    return false;
  };

  // ===== CDP 逐帧抓屏 =====
  const cdp = await page.context().newCDPSession(page);
  let capOn = false;
  let capT0 = 0;
  cdp.on('Page.screencastFrame', async (f) => {
    if (capOn) frames.push({ t: Date.now() - capT0, data: f.data, meta: f.metadata });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) {}
  });

  const runRegen = async (label, withText, tag, opts) => {
    const o = opts || {};
    const watchMs = o.watchMs || 4000;
    if (!(await openPanel(physId))) { console.log('!! ' + label + '：面板没弹出来'); return null; }
    frames = [];
    capT0 = Date.now();
    capOn = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1500, maxHeight: 950, everyNthFrame: 1 });
    await page.evaluate(() => window.__fx.start());
    const before = await physContent(physId);
    await page.evaluate((arg) => {
      const node = document.querySelector('[data-node-id="' + arg.nid + '"]');
      if (arg.text) node.querySelector('.graph-regenerate-input').value = arg.text;
      node.querySelector('.graph-regenerate-actions .graph-draft-send').click();
      window.__fx.mark(arg.text ? '已点发送（带字修订）' : '已点发送（留空直发·走流式）');
    }, { nid: physId, text: withText });
    // 只等「首次内容变化」＝确认真发出去了；观察窗口按 watchMs 固定，不等流结束
    const dl = Date.now() + 180000;
    while (Date.now() < dl) {
      await wait(400);
      const c = await physContent(physId);
      if (c && c !== before) break;
    }
    await page.evaluate(() => { window.__fx.mark('首次内容变化（流还在继续）'); });
    let mid = null;
    if (o.midwayAtMs && o.midway) {
      await wait(o.midwayAtMs);
      mid = await o.midway();
      await wait(Math.max(0, watchMs - o.midwayAtMs));
    } else {
      await wait(watchMs);
    }
    await page.evaluate(() => { window.__fx.mark('观察窗口结束'); });
    capOn = false;
    await cdp.send('Page.stopScreencast').catch(() => {});
    const buckets = await page.evaluate(() => window.__fx.stop());
    report(label, buckets);
    console.log('  抓帧 ' + frames.length + ' 张');
    frames.forEach((f, i) => {
      writeFileSync(join(FRAME_DIR, tag + '-' + String(i).padStart(4, '0') + '-' + f.t + 'ms.jpg'), Buffer.from(f.data, 'base64'));
    });
    return mid;
  };

  await runRegen('通道A 带字修订（修订式，collectStreamText 收全文后一次落地）', '再加一个生活里的例子', 'A', { watchMs: 4000 });
  await wait(3000);

  // ===== 阶段C：增量画出来的边，必须与「整层重建」逐点一致 =====
  // 做法：流式进行中，先把当前所有边 path 的 d 抄下来，再强制跑一次全量 _redrawEdges()，
  // 两份 d 的坐标逐个比。有偏差＝增量路径漏更新，线会走偏（用户看到的就是线不贴节点）。
  const driftCheck = async (label) => page.evaluate((lbl) => {
    const read = () => {
      const out = {};
      document.querySelectorAll('#graphCanvas svg.graph-edge-layer g[data-edge-key]').forEach(g => {
        const p = g.querySelector('path:not(.graph-edge-hit)');
        out[g.getAttribute('data-edge-key')] = p ? (p.getAttribute('d') || '') : '(无path)';
      });
      return out;
    };
    const before = read();
    if (typeof _redrawEdges === 'function') _redrawEdges();
    const after = read();
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    let maxDiff = 0;
    const bad = [];
    for (const k of keys) {
      const a = before[k] || '', b = after[k] || '';
      if (a !== b) bad.push(k + ' | 增量=' + a.slice(0, 70) + ' | 全量=' + b.slice(0, 70));
      const na = (a.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      const nb = (b.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      for (let i = 0; i < Math.min(na.length, nb.length); i++) maxDiff = Math.max(maxDiff, Math.abs(na[i] - nb[i]));
    }
    return { label: lbl, edges: keys.size, mismatched: bad.length, maxCoordDiff: +maxDiff.toFixed(3), sample: bad.slice(0, 3) };
  }, label);

  await runRegen('通道B 留空直发（原管线整体重跑，真流式）', '', 'B', {
    watchMs: 12000,
    midwayAtMs: 3000,
    midway: async () => {
      const d = await driftCheck('B 流式进行中');
      console.log('\n===== 增量 vs 全量 一致性（' + d.label + '）=====');
      console.log('  边数=' + d.edges + ' 不一致=' + d.mismatched + ' 最大坐标偏差=' + d.maxCoordDiff + 'px');
      d.sample.forEach(s => console.log('    ! ' + s));
      return d;
    },
  });

  const props = await page.evaluate(() => window.__fx.transProps);
  console.log('\n===== 过渡触发统计（class首段:属性 → 次数）=====');
  for (const [k, v] of Object.entries(props).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('  ' + v + ' 次  ' + k);
  if (pageErrors.length) console.log('\n!! 页面 JS 错误：' + pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('诊断脚本失败：' + ((e && e.message) || e));
  console.log('serverLog 尾部：' + serverLog.slice(-400));
  console.log('mockLog 尾部：' + mockLog.slice(-200));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  mock.kill();
  proxy.close();
  console.log('抓帧目录保留：' + FRAME_DIR);
}
