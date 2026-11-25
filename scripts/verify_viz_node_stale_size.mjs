// 真机复现（2026-11-25）：viz 卡「等待壳尺寸」残留 → 自动整理后真身盖住下面的卡。
// 链路：pending 壳（≈200/234）被存进 sizes → 卡长到 594 后发生全量重建（刷新/切会话/
// 其它模块生成都会触发）→ 重建时卡在视口内，_applyNodeLazyLayout 插入即强制布局，
// __cvPlaceholder 盖戳记到的是**真身盒** → _measureNodes 判据「读数==盖戳⇒还没排真身」
// 把每次真读数当占位扔掉 → 陈旧 234 永不自愈，整理按 234 排 → 594 真身压住邻居，
// 「长高让位」也永不触发（系统从没记到尺寸变化）。
// 判据：修复前 v1 的 node.h 停在 234 且整理后两卡 DOM 盒相交；修复后 v1.h≈594 且不相交。
// 用法：node scripts/verify_viz_node_stale_size.mjs（隔离实例＋临时数据目录，约 40 秒）
import { startIsolatedServer } from './lib/test_server.mjs';
import { chromium } from 'playwright';

const results = [];
const ok = n => { results.push(true); console.log('✓ ' + n); };
const bad = (n, e) => { results.push(false); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };

const srv = await startIsolatedServer({ port: 5093, label: 'phymathia-viz-stale' });
process.on('exit', () => srv.stop());

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  // 会话初始化晚于脚本加载：必须等 sid 就绪再种（直接取会是 null，种进错键=白种）
  await page.waitForFunction(() => !!(window.getCurrentSessionId && window.getCurrentSessionId()), null, { timeout: 30000 });
  const sid = await page.evaluate(() => window.getCurrentSessionId());

  // 种一份「整理过但按陈旧尺寸排」的画布：v1（viz 卡，存档高 234＝等待壳口径，真身 594）
  // 与 s1（苏格拉底卡，存档 400）同列按 48 缝排好——按存档数字不重叠，按真身重叠 132。
  // f1 是远处自由卡（y=-2000 视口外），只用来验证「真跳过的卡子元素没有布局盒」这一前提。
  await page.evaluate(async (sid) => {
    const vizMd = '```html\n<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#fff6fa;color:#a3456b;margin:0;padding:18px}h1{font-size:20px}</style></head><body><h1>渐开线演示</h1><p id="t">交互内容占位</p></body></html>\n```';
    const socraticMd = '### 苏格拉底追问\n\n为什么渐开线的形状只由基圆决定？请从发生圆在基圆上纯滚动出发，写出接触点的轨迹方程，并说明压力角与基圆半径的关系、以及啮合线为什么是基圆的公切线。'.repeat(5);
    window.saveGraphState(sid, {
      layoutVersion: 4,
      pan: { x: 400, y: 350 },
      zoom: 0.55,
      positions: { v1: { x: 360, y: 0 }, s1: { x: 360, y: 365 }, f1: { x: 800, y: -2000 } },
      sizes: { v1: { w: 640, h: 234, u: 0 }, s1: { w: 640, h: 400, u: 0 }, f1: { w: 300, h: 200, u: 0 } },
      layerOf: { v1: 0, s1: 0 },
      freeNodes: { f1: 1 },
      pinned: {},
      groups: [],
      customNodes: [
        { id: 'v1', kind: 'module', moduleKey: 'viz', manual: false, source: 'ai', label: '交互可视化', content: vizMd, status: 'done', busy: false, summary: '', analysis: '', x: 360, y: 0, depth: 3, timestamp: 1000, pinned: false, customWidth: 640, customHeight: null },
        { id: 's1', kind: 'module', moduleKey: 'socratic', manual: false, source: 'ai', label: '苏格拉底追问', content: socraticMd, status: 'done', busy: false, summary: '', analysis: '', x: 360, y: 365, depth: 3, timestamp: 1001, pinned: false, customWidth: 640, customHeight: null },
        { id: 'f1', kind: 'note', manual: true, label: '远处的卡', content: '远处自由卡，验证屏外占位口径。', x: 800, y: -2000, depth: 3, timestamp: 1002, pinned: false },
      ],
      connections: [],
      updatedAt: Date.now(),
    });
    await window.flushGraphStateServerSave();
  }, sid);

  // 重载 → 画布按存档重建（复现链路的关键一步：视口内的卡插入即被强制布局、盖真身戳）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!(window.getCurrentSessionId && window.getCurrentSessionId())
      && typeof window.saveGraphState === 'function'
      && document.querySelector('.graph-node[data-node-id="v1"]')
      && document.querySelector('.graph-node[data-node-id="s1"]'),
    null, { timeout: 30000 });
  await page.waitForTimeout(1500); // 首帧 measure＋ResizeObserver 拍子落完

  const probe = await page.evaluate(() => {
    const intersects = (el) => {
      const cr = graphCanvas.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.left < cr.right && r.right > cr.left && r.top < cr.bottom && r.bottom > cr.top;
    };
    const elV = document.querySelector('.graph-node[data-node-id="v1"]');
    const elF = document.querySelector('.graph-node[data-node-id="f1"]');
    return {
      v1_h: graphView.nodeById['v1'].h,
      v1_on_screen: intersects(elV),
      f1_present: !!elF,
      f1_off_screen: elF ? !intersects(elF) : null,
      f1_h: graphView.nodeById['f1'] ? graphView.nodeById['f1'].h : null,
      s1_h: graphView.nodeById['s1'].h,
    };
  });
  console.log('  探针：v1.h=' + probe.v1_h.toFixed(0) + ' s1.h=' + probe.s1_h.toFixed(0)
    + ' f1.h=' + (probe.f1_h == null ? '?' : probe.f1_h.toFixed(0))
    + ' v1在视口内=' + probe.v1_on_screen + ' f1在视口外=' + probe.f1_off_screen);

  // 注意：前提只读卡自身的盒。别去读屏外卡的子元素盒——几何查询会把 c-v 跳过的
  // 内容强迫排版，探出假「已排版」（首版探针实测踩过）。
  if (probe.v1_on_screen) ok('前提 P1：v1 卡在画布视口内（盖戳记到的必是真身盒）');
  else bad('前提 P1', new Error('v1 不在视口内——复现前提不成立（盖戳记的是占位就复现不了）'));
  if (probe.f1_present && probe.f1_off_screen) ok('前提 P2：f1 卡整盒在画布视口外（此口径下 c-v 才真跳过、读数才是占位）');
  else bad('前提 P2', new Error('f1 没在视口外——把 y 再挪远些'));

  if (probe.v1_h > 500) ok('自愈 A1：加载后 v1 量到真身（h=' + probe.v1_h.toFixed(0) + ' ≥500，陈旧 234 被纠正）');
  else bad('自愈 A1', new Error('v1.h 停在 ' + probe.v1_h.toFixed(0) + '（陈旧值未被真读数纠正）——用户所见的压叠根源'));

  if (probe.f1_h != null && Math.abs(probe.f1_h - 200) <= 1) ok('T376 保持 A3：屏外 f1 卡继续沿用存档尺寸（' + probe.f1_h.toFixed(0) + '，不被占位读数污染）');
  else bad('T376 保持 A3', new Error('f1.h=' + probe.f1_h + '——屏外卡的占位跳过口径被破坏'));

  // 用户动作：自动整理
  await page.evaluate(() => window.autoArrangeGraph());
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => {
    const a = document.querySelector('.graph-node[data-node-id="v1"]').getBoundingClientRect();
    const b = document.querySelector('.graph-node[data-node-id="s1"]').getBoundingClientRect();
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const v = graphView.nodeById['v1'];
    const s = graphView.nodeById['s1'];
    return {
      overlap_px: Math.max(0, w) * Math.max(0, h),
      v1_h: v.h, s1_h: s.h, dy: Math.abs(v.y - s.y), need: (v.h + s.h) / 2 + 48,
    };
  });
  console.log('  整理后：DOM 交叠 ' + Math.round(after.overlap_px) + 'px²；模型缝 dy=' + after.dy.toFixed(0)
    + ' 应≥' + after.need.toFixed(0) + '（v1.h=' + after.v1_h.toFixed(0) + ' s1.h=' + after.s1_h.toFixed(0) + '）');

  if (after.overlap_px < 1) ok('整理 A2a：真身 DOM 盒不相交（屏幕上看得见的口径）');
  else bad('整理 A2a', new Error('整理后 v1 与 s1 的真身仍压着 ' + Math.round(after.overlap_px) + 'px²——用户报告的现象'));
  if (after.dy >= after.need - 1) ok('整理 A2b：模型口径同列缝 ≥48');
  else bad('整理 A2b', new Error('模型缝 ' + after.dy.toFixed(0) + ' < 应有 ' + after.need.toFixed(0)));
} catch (e) {
  bad('真机流程异常', e);
} finally {
  await browser.close();
  srv.stop();
}

console.log(results.every(Boolean) ? '\nviz 卡陈旧尺寸真机验证全部通过' : '\nviz 卡陈旧尺寸真机验证失败');
process.exit(results.every(Boolean) ? 0 : 1);
