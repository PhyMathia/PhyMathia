// 输入节点（素材篮）出口几何验收：看得见、点得到、连线锚点对得上。
//
//   node scripts/verify_source_ports.mjs        （需真机服务在 5050；本机无头浏览器在 .tools/pw-browsers）
//
// 为什么单独一支：出口长在条目行里（`.graph-source-row-port`）＋折叠态改由输出列渲染，
// 这两件事的正确性全在**布局层**——DOM 里查得到不等于看得见/点得到（首版 right:-18px
// 被 .graph-source-list 的滚动裁剪整颗吃掉，冒烟的宽松 DOM 代理抓不到，用户报的
// 「输入节点没有输出端口」就是这个）。所以断言按 elementFromPoint 与 getBoundingClientRect
// 走真几何，另加「每个 out-i 恰好一份 DOM」防隐藏重复口把边锚点带跑。
//
// 覆盖：空篮 / 有素材（行内口可点）/ 折叠（输出列口可点）/ 展开（回行内）/ 边锚点跟随
// 三种形态 / 旧版输入节点（只读）出口照旧在输出列。
// 安全：全程在注入的临时会话 id 下操作（替换 window.getCurrentSessionId + 断 fetch），
// 不碰真实会话、不写服务端，可随时重跑。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// 无头浏览器按目录扫（版本号目录会随 playwright 升级变，别写死）——同 visual_baseline.mjs
function findShell() {
  const base = path.join(ROOT, '.tools', 'pw-browsers');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('缺少 .tools/pw-browsers/*/chrome-headless-shell-linux64/chrome-headless-shell（本机没有可用的无头浏览器）');
}
const EXE = findShell();
const BASE = process.env.PHYMATHIA_BASE || 'http://localhost:5050/';
const TEST_SID = 'sess_selftest_portcheck';

let fails = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '✓ ' : '❌ ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  if (!cond) fails++;
};

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.createManualNode === 'function' && typeof graphInner !== 'undefined', null, { timeout: 20000 });
await page.evaluate(sid => {
  try { typeof endOnboarding === 'function' && endOnboarding(); } catch (e) {}
  window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  window.getCurrentSessionId = () => sid;
  try { localStorage.removeItem('phymathia_graph_' + sid); } catch (e) {}
}, TEST_SID);
await page.evaluate(() => renderGraphCanvas());
await page.waitForTimeout(200);

const ids = await page.evaluate(() => {
  addBlankNodePoint = { x: 0, y: 0 };
  createManualNode('source');
  const src = _graphState().customNodes.filter(n => n.kind === 'source').pop();
  addBlankNodePoint = { x: 700, y: 0 };
  createManualNode('human_note');
  const dst = _graphState().customNodes.filter(n => n.kind === 'human_note').pop();
  return { src: src.id, dst: dst.id };
});
ok(!!ids.src && !!ids.dst, '临时会话下建点成功（不碰真实会话）', ids);

// ---- A. 空素材篮 ----
const empty = await page.evaluate(id => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  return {
    ports: el.querySelectorAll('.graph-port').length,
    hint: (el.querySelector('.graph-source-empty') || {}).textContent || '',
  };
}, ids.src);
ok(empty.ports === 0, '空素材篮没有出口（设计如此）', empty.ports);
ok(/每加一条素材/.test(empty.hint), '空态文案明示「每加一条素材，右侧就长出一个出口」', empty.hint);

// ---- B. 加两条素材 + 真实连线入口建边 ----
const connectInfo = await page.evaluate(({ src, dst }) => {
  addSourceText(src, '第一条素材：滑块在斜面上');
  addSourceText(src, '第二条素材：F = ma');
  _connectPorts(src, 'out-1', dst, 'in-0');   // 拖线落点走的就是这条
  return { conns: (_graphState().connections || []).length };
}, ids);
await page.waitForTimeout(400);
const withItems = await page.evaluate(({ src }) => {
  const el = document.querySelector('[data-node-id="' + src + '"]');
  const listRect = el.querySelector('.graph-source-list').getBoundingClientRect();
  const innerRect = graphInner.getBoundingClientRect();
  const ports = Array.from(el.querySelectorAll('.graph-source-row-port'));
  const probe = ports.map(p => {
    const r = p.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const anchor = _portAnchor(graphView.nodeById[src], p, true, innerRect);
    return {
      portId: p.dataset.portId,
      insideList: r.right <= listRect.right + 0.5 && r.left >= listRect.left - 0.5,
      hitIsPort: !!(hit && (hit === p || p.contains(hit))),
      anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
    };
  });
  const paths = Array.from(graphEdgeLayer.querySelectorAll('.graph-edge path:not(.graph-edge-hit)')).map(p => p.getAttribute('d'));
  const start = paths.length ? paths[0].match(/^M([-\d.]+)[ ,]([-\d.]+)/) : null;
  return { probe, edgeStart: start ? { x: Math.round(+start[1]), y: Math.round(+start[2]) } : null, edgeCount: paths.length };
}, ids);
ok(connectInfo.conns === 1, '真实连线入口建边成功', connectInfo.conns);
ok(withItems.probe.length === 2, '两条素材＝两枚行内出口', withItems.probe.length);
ok(withItems.probe.every(p => p.insideList), '行内出口整颗落在列表裁剪区内（不再被 overflow 吃掉）', withItems.probe.map(p => p.insideList));
ok(withItems.probe.every(p => p.hitIsPort), '行内出口可点（elementFromPoint 命中端口本身）', withItems.probe.map(p => p.hitIsPort));
ok(withItems.edgeCount === 1 && !!withItems.edgeStart && !!withItems.probe[1]
  && Math.abs(withItems.edgeStart.x - withItems.probe[1].anchor.x) <= 2
  && Math.abs(withItems.edgeStart.y - withItems.probe[1].anchor.y) <= 2,
  '连线锚点＝out-1 出口中心', { edge: withItems.edgeStart, port: withItems.probe[1] && withItems.probe[1].anchor });

let el = await page.$('[data-node-id="' + ids.src + '"]');
await el.screenshot({ path: path.join(ROOT, '.cache/fix-source-node.png') });

// ---- C. 折叠：出口改走输出列，且不得留下重复端口 ----
await page.evaluate(id => graphModuleAction('minimize', id), ids.src);
await page.waitForTimeout(400);
const mini = await page.evaluate(({ src }) => {
  const el = document.querySelector('[data-node-id="' + src + '"]');
  const colPorts = Array.from(el.querySelectorAll('.graph-port-col .graph-port.graph-output-port'));
  const innerRect = graphInner.getBoundingClientRect();
  const r = colPorts[1] ? colPorts[1].getBoundingClientRect() : null;
  const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  const anchor = colPorts[1] ? _portAnchor(graphView.nodeById[src], colPorts[1], true, innerRect) : null;
  const d = graphEdgeLayer.querySelector('.graph-edge path:not(.graph-edge-hit)');
  const m = d ? d.getAttribute('d').match(/^M([-\d.]+)[ ,]([-\d.]+)/) : null;
  return {
    minimizedClass: el.classList.contains('minimized'),
    rows: el.querySelectorAll('.graph-source-row').length,
    colPorts: colPorts.length,
    dupOut0: el.querySelectorAll('[data-port-id="out-0"]').length,
    dupOut1: el.querySelectorAll('[data-port-id="out-1"]').length,
    hitIsPort: !!(hit && (hit === colPorts[1] || colPorts[1].contains(hit))),
    anchor: anchor ? { x: Math.round(anchor.x), y: Math.round(anchor.y) } : null,
    edgeStart: m ? { x: Math.round(+m[1]), y: Math.round(+m[2]) } : null,
  };
}, ids);
ok(mini.minimizedClass, '折叠生效');
ok(mini.rows === 0, '折叠卡不再建条目行（占位符）', mini.rows);
ok(mini.colPorts === 2, '折叠态出口改由输出列渲染（不再是死节点）', mini.colPorts);
ok(mini.dupOut0 === 1 && mini.dupOut1 === 1, '每个出口在 DOM 里只有一份（无隐藏重复口）', { out0: mini.dupOut0, out1: mini.dupOut1 });
ok(mini.hitIsPort, '折叠态出口可点');
ok(!!mini.edgeStart && !!mini.anchor && Math.abs(mini.edgeStart.x - mini.anchor.x) <= 2 && Math.abs(mini.edgeStart.y - mini.anchor.y) <= 2,
  '折叠态连线锚点跟着输出列口走', { edge: mini.edgeStart, port: mini.anchor });
el = await page.$('[data-node-id="' + ids.src + '"]');
await el.screenshot({ path: path.join(ROOT, '.cache/fix-source-node-min.png') });

// ---- D. 展开：回到行内口，锚点仍对得上 ----
await page.evaluate(id => graphModuleAction('minimize', id), ids.src);
await page.waitForTimeout(400);
const back = await page.evaluate(src => {
  const el = document.querySelector('[data-node-id="' + src + '"]');
  const innerRect = graphInner.getBoundingClientRect();
  const rowPorts = Array.from(el.querySelectorAll('.graph-source-row-port'));
  const anchor = rowPorts[1] ? _portAnchor(graphView.nodeById[src], rowPorts[1], true, innerRect) : null;
  const d = graphEdgeLayer.querySelector('.graph-edge path:not(.graph-edge-hit)');
  const m = d ? d.getAttribute('d').match(/^M([-\d.]+)[ ,]([-\d.]+)/) : null;
  return {
    rows: el.querySelectorAll('.graph-source-row').length,
    rowPorts: rowPorts.length,
    colPorts: el.querySelectorAll('.graph-port-col .graph-port.graph-output-port').length,
    dupOut0: el.querySelectorAll('[data-port-id="out-0"]').length,
    anchor: anchor ? { x: Math.round(anchor.x), y: Math.round(anchor.y) } : null,
    edgeStart: m ? { x: Math.round(+m[1]), y: Math.round(+m[2]) } : null,
  };
}, ids.src);
ok(back.rows === 2 && back.rowPorts === 2, '展开回到条目行出口', { rows: back.rows, rowPorts: back.rowPorts });
ok(back.colPorts === 0, '展开后输出列不留残影', back.colPorts);
ok(back.dupOut0 === 1, '展开后每口仍只有一份 DOM', back.dupOut0);
ok(!!back.edgeStart && !!back.anchor && Math.abs(back.edgeStart.x - back.anchor.x) <= 2 && Math.abs(back.edgeStart.y - back.anchor.y) <= 2,
  '展开后连线锚点回到行内口', { edge: back.edgeStart, port: back.anchor });

// ---- E. 旧版输入节点（知识点 items）：知识点节点退役后不再出口，只读保留 ----
const legacy = await page.evaluate(() => {
  addBlankNodePoint = { x: 0, y: 500 };
  createManualNode('source');
  const node = _graphState().customNodes.filter(n => n.kind === 'source').pop();
  node.items = [{ title: '旧知识点甲' }, { title: '旧知识点乙' }];
  _saveGraphState(_graphState());
  renderGraphCanvas();
  return node.id;
});
await page.waitForTimeout(300);
const legacyRes = await page.evaluate(id => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  return {
    legacy: _sourceIsLegacyNode(_graphState().customNodes.find(n => n.id === id)),
    colPorts: el.querySelectorAll('.graph-port-col .graph-port.graph-output-port').length,
    rowPorts: el.querySelectorAll('.graph-source-row-port').length,
    readOnlyHint: !!el.querySelector('.graph-source-legacy-hint'),
  };
}, legacy);
ok(legacyRes.legacy && legacyRes.colPorts === 0 && legacyRes.rowPorts === 0 && legacyRes.readOnlyHint,
  '旧版输入节点（只读）：不再出口（知识点链路已退役）', legacyRes);

console.log(fails ? '\n❌ 失败 ' + fails + ' 项' : '\n全部通过');
await browser.close();
process.exit(fails ? 1 : 0);
