#!/usr/bin/env node
// 单文件网页导出「真导出 → 真打开」真机回归（backlog 574，2026-11-23）。
//
// 为什么要它：11-02 调整构建目录后，导出的单文件网页空白了 21 天——期间冒烟全绿，因为
// 冒烟只查源码里有没有某几个词，没有真的导出一次打开看。这支脚本走完整条真链路：
//   ① 结构核对的判定（纯函数，逐条喂成品的坏形状）
//   ② 隔离实例里导入一份合法 .pmu 成画布
//   ③ 导出菜单的真按钮触发「单文件网页 .html」→ 接住下载文件
//   ④ 把四种「坏文件」逐个制造出来，证明成品自检拦得住、且一个文件都不交出去
//   ⑤ 停掉服务 → file:// 打开（没有服务端＝证明离线自包含）→ 数节点、试交互、
//      查零联网零报错、可视化卡里的公式真渲出来
//
// 用法：node scripts/verify_utopia_html_export.mjs
//       先 npm run build:js——隔离实例拷的是构建产物，不是源码。
// 隔离口径：scripts/lib/test_server.mjs（临时数据目录第二实例），真实 data/ 全程不碰。
// 本脚本不调模型——画布由 importUtopiaSnapshotText 从手工造的合法 .pmu 导入，
// 节点由 _buildGraphData 从 messages 真实派生。

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const PORT = 5092; // 避开 test_server.mjs 头注列出的已占口与 undici 坏端口

const results = [];
function ok(name) { results.push(true); console.log('✓ ' + name); }
function fail(name, err) { results.push(false); console.log('❌ ' + name + ' -> ' + (err && err.message || err)); }

// ---- 快照夹具：形状照 buildUtopiaSnapshot（utopia.js）----
// 三轮问答：第二轮正文里夹着 </script> 和 <!--（内嵌快照的防截断转义要是失效，
// 成品自检当场拦下、这支脚本变红）；第三轮带一个完整 HTML 代码块 → 可视化卡，
// 走「KaTeX 资产预内联」那条路。节点数不写死，导入后从真实画布上读。
function makeSnapshot() {
  const t0 = 1789300000000;
  const vizPage = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>弹簧振子</title>',
    '<style>body{font-family:sans-serif;padding:16px}</style></head>',
    '<body><h3>弹簧振子</h3><p>位移随时间变化：</p>',
    '<p>$$x(t) = A\\cos(\\omega t)$$</p>',
    '<script>document.body.insertAdjacentHTML("beforeend","<p id=\\"viz-ok\\">可视化页面已运行</p>");</script>',
    '</body></html>',
  ].join('\n');
  // 消息形态照真实链路：assistant 正文带 XML 模块段，模块节点由 parseXmlSections 派生
  // （graph-data.js:1071 viz 模块取 <viz> 段里的 ```html 代码块长出可视化卡）。
  const qa = (question, sections, at) => [
    { role: 'user', content: question, timestamp: at },
    { role: 'assistant', content: sections, timestamp: at + 1000 },
  ];
  const messages = [
    ...qa('请详细讲解简谐振动', [
      '<physics>', '## 物理视角', '回复力与位移成正比且方向相反，于是往复运动。', '</physics>',
      '<math>', '## 数学本质', '方程 $m\\ddot{x}+kx=0$，解为 $x(t)=A\\cos(\\omega t+\\varphi)$。', '</math>',
    ].join('\n'), t0),
    ...qa('网页里 </script> 和 <!-- 分别是什么意思？', [
      '<physics>', '## 物理视角', '网页里成对出现的记号，形如 </script> 与 <!--。', '</physics>',
      '<math>', '## 数学本质', '记号本身不含公式。', '</math>',
    ].join('\n'), t0 + 2000),
    ...qa('画一个弹簧振子的可视化', [
      '<viz>', '## 交互探索', '', '```html', vizPage, '```', '</viz>',
    ].join('\n'), t0 + 4000),
    // 581 毒饵：AI 内容自带的外链字体（齿轮会话实测形态——外发页一打开就发 5 个外网请求）。
    // link 三件套照真实会话原样抄；@import 是同族的另一种写法。导出链必须全数剔除。
    ...qa('网页里怎么引入漂亮的中文字体？', [
      '<physics>', '## 物理视角', '排版常用 Google Fonts：',
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600;900&display=swap" rel="stylesheet">',
      '<style>@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&display=swap");</style>',
      '这类外链在离线页面里要么发外网请求、要么静默失效。', '</physics>',
      '<math>', '## 数学本质', '字体外链不含公式。', '</math>',
    ].join('\n'), t0 + 6000),
  ];
  return {
    format: 'phymath-utopia/graph',
    version: 1,
    exportedAt: new Date().toISOString(),
    // 输入夹具的 app 标签刻意写成哨兵值：导出的 app 标签必须跟当前 APP_VERSION 走，
    // 不能被快照里的旧值带跑（2026-11-25 版本进位时顺手去掉写死的旧版本号）。
    app: 'PhyMathia/0.0.0-fixture',
    title: '单文件导出回归用快照',
    meta: { sessionId: '', level: 'university', theme: 'dark', messagesComplete: true,
            counts: { nodes: 0, edges: 0, groups: 0, messages: messages.length } },
    viewport: { pan: { x: 80, y: 80 }, zoom: 0.9 },
    graph: { layoutVersion: 4, positions: {}, sizes: {}, collapsed: {}, hidden: {},
             pinned: {}, portCounts: {}, inputPortCounts: {}, groups: [], customNodes: [], connections: [] },
    nodes: [], edges: [], groups: [],
    messages,
  };
}

const toastTextOf = (page) => page.evaluate(() => {
  const t = document.getElementById('phymathia_toast');
  if (!t) return '';
  const span = t.querySelector('.toast-msg-text');
  return String((span || t).textContent || '');
});

async function run() {
  const srv = await startIsolatedServer({ port: PORT, label: 'phymathia-utopia-html' });
  process.on('exit', () => srv.stop());
  const outDir = mkdtempSync(join(tmpdir(), 'phymathia-utopia-html-out-'));
  const okPath = join(outDir, 'export-ok.html');
  const browser = await chromium.launch();
  let expected = 0;

  try {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    // 581：夹具带外链字体毒饵——字体域名在本上下文内拦掉，测试全程不发真外网请求
    // （file:// 那一段用的是新开的 viewCtx，不受这里影响，零联网断言照旧全权）
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    const page = await ctx.newPage();
    const downloads = [];
    const pageErrors = [];
    page.on('download', (d) => downloads.push(d));
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.importUtopiaSnapshotText === 'function'
      && typeof window.exportUtopiaStandaloneHtml === 'function'
      && typeof window.utopiaHtmlVerifyPacked === 'function', null, { timeout: 20000 });

    // ===== ① 结构核对的判定 =====
    try {
      const unit = await page.evaluate(() => {
        const verify = window.utopiaHtmlVerifyPacked;
        const snap = { format: 'phymath-utopia/graph', nodes: [{ id: 'a' }, { id: 'b' }], edges: [], messages: [] };
        const embedOf = (s) => 'window.__UTOPIA_EMBEDDED__ = ' + JSON.stringify(s) + ';';
        const reader = 'console.log(window.__UTOPIA_EMBEDDED__)';
        const doc = (body) => '<!DOCTYPE html><html><head></head><body>' + body + '</body></html>';
        const out = {};
        const run = (name, html, opts) => { out[name] = verify(html, snap, opts); };
        // 可视化段按「引导脚本」认（含 data-pm-katex 标记查找），不再按字节块
        const vizBlock = '<script>var q=document.querySelector("style[data-pm-katex]");</script>';
        const good = '<script>' + embedOf(snap) + '</script><script>' + reader + '</script>';
        run('ok', doc(good), { entrySeen: 1 });
        run('vizOk', doc(vizBlock + good), { entrySeen: 1, hasViz: true });
        run('entryRenamed', doc('<script>' + reader + '</script>'), { entrySeen: 0 });
        run('embedAfterEntry', doc('<script>' + reader + '</script><script>' + embedOf(snap) + '</script>'), { entrySeen: 1 });
        run('doubleEmbed', doc('<script>' + embedOf(snap) + '</script>' + good), { entrySeen: 2 });
        run('truncated', doc('<script>window.__UTOPIA_EMBEDDED__ = {"format":"x","nodes":[{"id":"a"},'
          + '</script><script>' + reader + '</script>'), { entrySeen: 1 });
        run('mismatch', doc('<script>' + embedOf({ format: 'phymath-utopia/graph', nodes: [{ id: 'a' }] })
          + '</script><script>' + reader + '</script>'), { entrySeen: 1 });
        run('leftoverLink', doc('<link rel="stylesheet" href="/dist/styles.min.css">' + good), { entrySeen: 1 });
        run('leftoverScript', doc('<script src="/vendor/x.js"></script>' + good), { entrySeen: 1 });
        run('resourceFailed', doc(good), { entrySeen: 1, failed: [{ kind: '脚本', name: '/dist/viewer.js', error: 'HTTP 404' }] });
        run('vizMissing', doc(good), { entrySeen: 1, hasViz: true });
        run('readerMissing', doc('<script>' + embedOf(snap) + '</script>'), { entrySeen: 1 });
        return out;
      });
      const why = (k) => (unit[k] ? (unit[k].problems || []).join(' | ') : '（没有结果）');
      if (!unit.ok || unit.ok.ok !== true || why('ok') !== '') throw new Error('完好成品被误判：「' + why('ok') + '」');
      if (!unit.vizOk || unit.vizOk.ok !== true) throw new Error('带可视化资源的完好成品被误判：「' + why('vizOk') + '」');
      const bad = [
        ['entryRenamed', /没认出查看器入口脚本（viewer\.js）.*内嵌快照没打进文件/],
        ['embedAfterEntry', /内嵌快照排到了查看器脚本后面/],
        ['doubleEmbed', /内嵌快照打进了 2 份/],
        ['truncated', /内嵌快照不完整/],
        ['mismatch', /节点应有 2 个，读回 1 个/],
        ['leftoverLink', /样式表没打进文件：\/dist\/styles\.min\.css/],
        ['leftoverScript', /脚本没打进文件：\/vendor\/x\.js/],
        ['resourceFailed', /脚本没取到：\/dist\/viewer\.js（HTTP 404）/],
        ['vizMissing', /可视化公式资源没打进文件/],
        ['readerMissing', /查看器入口脚本不读内嵌快照/],
      ];
      const missed = bad.filter(([k, re]) => !unit[k] || unit[k].ok !== false || !re.test(why(k)))
        .map(([k]) => k + ' →「' + why(k) + '」');
      if (missed.length) throw new Error('坏成品没被拦下或原因不对：\n  ' + missed.join('\n  '));
      ok('结构核对：2 种完好形状放行，' + bad.length + ' 种坏形状逐条拦下且原因点名');
    } catch (e) { fail('结构核对的判定', e); }

    // ===== ② 夹具导入成真实画布 =====
    const imported = await page.evaluate((text) => window.importUtopiaSnapshotText(text, 'fixture.pmu', { title: '单文件导出回归' }),
      JSON.stringify(makeSnapshot()));
    if (imported !== true) {
      throw new Error('夹具导入失败：' + JSON.stringify(await page.evaluate(() => window.__lastUtopiaImportResult || null)));
    }
    await page.waitForFunction(() => {
      const nodes = (typeof graphView !== 'undefined' && graphView && graphView.nodes) || [];
      return nodes.length >= 6 && document.querySelectorAll('#graphCanvas .graph-node').length >= nodes.length;
    }, null, { timeout: 30000 });
    const shape = await page.evaluate(() => ({
      nodes: graphView.nodes.length,
      edges: (graphView.edges || []).length,
      rendered: document.querySelectorAll('#graphCanvas .graph-node').length,
      viz: document.querySelectorAll('#graphCanvas .viz-iframe').length,
    }));
    expected = shape.nodes;
    if (shape.viz < 1) throw new Error('夹具里没长出可视化卡，测不到 KaTeX 资产这条路：' + JSON.stringify(shape));
    // 577：导出元信息的 app 标签必须跟 config.js 的 APP_VERSION 走，不再写死
    const appTag = await page.evaluate(() => {
      try { const s = window.buildUtopiaSnapshot(); return { app: s && s.app, ver: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '' }; }
      catch (e) { return { app: 'ERR ' + e.message, ver: '' }; }
    });
    if (appTag.app !== 'PhyMathia/' + appTag.ver || !/^\d+\.\d+\.\d+$/.test(appTag.ver)) {
      throw new Error('快照 app 标签没跟着 APP_VERSION 走：' + JSON.stringify(appTag));
    }
    ok('夹具导入成真实画布（' + shape.nodes + ' 节点 / ' + shape.edges + ' 连线，可视化卡 ' + shape.viz + ' 张）；app 标签 ' + appTag.app);

    // ===== ②′ 581 毒饵就位：画布快照里确实带着外链字体 =====
    // 这条不立住，后面的剔除断言就是测了个寂寞（比如夹具在入库时就被洗掉了外链）
    const poisoned = await page.evaluate(() =>
      JSON.stringify(window.buildUtopiaSnapshot({ stripVersions: true })).includes('fonts.googleapis'));
    if (!poisoned) throw new Error('夹具里的外链字体没进画布快照（581 的剔除断言将空转）');
    ok('581 毒饵就位：画布快照确带 Google Fonts 外链，等导出链剔除');

    // ===== ③ 真导出：走导出菜单的真按钮 =====
    // 用 DOM 级点击：隔离实例是全新浏览器配置，首访引导层可能浮在菜单上方挡住真鼠标
    const startedAt = Date.now();
    await page.evaluate(() => window.toggleGraphExportMenu());
    await page.waitForSelector('#graphExportHtml', { timeout: 10000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 90000 }),
      page.evaluate(() => document.getElementById('graphExportHtml').click()),
    ]);
    const costMs = Date.now() - startedAt;
    await download.saveAs(okPath);
    const selfCheck = await page.evaluate(() => window.__utopiaLastSelfCheck || null);
    const card = await page.evaluate(() => {
      const c = document.getElementById('utopiaExportCard');
      if (!c) return null;
      const pick = (sel) => { const el = c.querySelector(sel); return el ? String(el.textContent || '').trim() : ''; };
      return {
        title: pick('.utopia-export-card-title'),
        sub: pick('.utopia-export-card-sub'),
        hint: pick('.utopia-export-card-hint'),
        hasOpenViewer: !!c.querySelector('#utopiaOpenViewerBtn'),
        hasReHtml: !!c.querySelector('#utopiaExportHtmlBtn'),
      };
    });
    const text = readFileSync(okPath, 'utf8');
    const bytes = statSync(okPath).size;
    if (!selfCheck || selfCheck.ok !== true) throw new Error('导出通过却没留下自检报告：' + JSON.stringify(selfCheck));
    if (!selfCheck.render || selfCheck.render.domNodes !== expected) {
      throw new Error('自检窗口里数到的节点与画布不一致：' + JSON.stringify(selfCheck.render) + '，应有 ' + expected);
    }
    // 580 一角（2026-11-23）：完成反馈走 .pmu 同款浮卡，文件名带日期不互相覆盖
    if (!/^PhyMathia_单文件导出回归_\d{8}_\d{4}\.html$/.test(download.suggestedFilename())) {
      throw new Error('文件名没按「<名>_<日期_时分>」走：' + download.suggestedFilename());
    }
    if (!card || card.title !== '网页版已保存') {
      throw new Error('完成浮卡没弹或标题不对：' + JSON.stringify(card));
    }
    if (!new RegExp('[\\d.]+ (KB|MB)').test(card.sub)) {
      throw new Error('完成浮卡没按真实体积报："' + card.sub + '"');
    }
    if (card.hasOpenViewer || card.hasReHtml) {
      throw new Error('网页版浮卡不该有「在查看器中打开／再存网页版」按钮：' + JSON.stringify(card));
    }
    if (!card.hint.includes('双击即可离线打开')) throw new Error('浮卡提示没交代怎么用："' + card.hint + '"');
    const embeds = text.split('window.__UTOPIA_EMBEDDED__ = ').length - 1;
    if (embeds !== 1) throw new Error('成品里内嵌快照有 ' + embeds + ' 份');
    // 578①：KaTeX 不再重复内联——成品里只该有「现取现转」引导脚本（认 data-pm-katex 标记），
    // 不该再出现打包好的资产块
    if (text.indexOf('data-pm-katex') < 0) throw new Error('成品里没有可视化公式资源（引导脚本没注入）');
    if (/window\.__PM_VIZ_ASSETS__\s*=\s*\{/.test(text)) throw new Error('成品里还在重复打包 KaTeX 资产块');
    // 579：外发快照不带节点旧版本账本（versions 两份合计是齿轮会话 14% 的体积）
    if (text.slice(text.indexOf('window.__UTOPIA_EMBEDDED__'), text.indexOf('</script>', text.indexOf('window.__UTOPIA_EMBEDDED__'))).includes('"versions"')) {
      throw new Error('外发快照还带着节点旧版本（versions）');
    }
    // 581：内容里的外网字体/样式表必须已剔除（只查内嵌快照那一段，别把查看器自己的代码误伤进来）
    const embedSlice = text.slice(text.indexOf('window.__UTOPIA_EMBEDDED__'), text.indexOf('</script>', text.indexOf('window.__UTOPIA_EMBEDDED__')));
    const fontHits = (embedSlice.match(/fonts\.(?:googleapis|gstatic)\.com/g) || []).length;
    if (fontHits) throw new Error('外发快照里还残留 ' + fontHits + ' 处 Google Fonts 外链（581 剔除没生效）');
    if (/@import\s*(?:url\s*\()?\s*["']?\s*(?:https?:)?\/\//i.test(embedSlice)) {
      throw new Error('外发快照里还有 @import 外网样式表（581 剔除没生效）');
    }
    if (/class="utopia-bar/.test(text)) throw new Error('成品里还留着查看器顶栏');
    // 内联器不得碰 data URI 内部：大陆噪点纹理的内嵌 SVG 自带 filter='url(%23g)'，
    // 修坏的特征是整个 URI 被换成空地址 url("data:,")
    if (text.indexOf("filter='url(%23g)'") < 0 || text.includes('url("data:,")')) {
      throw new Error('内联器把 data URI 内部的伪 url() 当真资源改坏了（噪点纹理会丢）');
    }
    if (pageErrors.length) throw new Error('导出过程页面抛错：' + pageErrors.slice(0, 3).join(' | '));
    ok('真导出通过两道自检并落盘（' + expected + ' 节点，' + (bytes / 1024 / 1024).toFixed(2) + ' MB，含自检共 '
      + (costMs / 1000).toFixed(1) + ' 秒）');

    // ===== ④ 坏文件逐个制造：自检必须拦下，且一个文件都不交出去 =====
    const refute = async (pattern, handler) => {
      const before = downloads.length;
      await page.route(pattern, handler);
      let ret = null;
      let toastNow = '';
      let report = null;
      try {
        ret = await page.evaluate(() => window.exportUtopiaStandaloneHtml());
        toastNow = await toastTextOf(page);
        report = await page.evaluate(() => window.__utopiaLastSelfCheck || null);
      } finally {
        await page.unroute(pattern, handler);
      }
      if (ret !== false) throw new Error('函数返回 ' + ret + '（应为 false）');
      if (downloads.length !== before) throw new Error('照样交出了文件');
      if (!report || report.ok !== false) throw new Error('没留下自检报告');
      if (!/导出失败——自检发现：/.test(toastNow)) throw new Error('没把原因告诉用户，提示条="' + toastNow + '"');
      return (report.problems || []).join(' | ');
    };
    const negatives = [
      ['入口脚本改了名（内嵌快照没处注入＝空白页）', '**/viewer.html', async (route) => {
        // 2026-11-23 实故同款：入口换了名字/目录，按旧口径认不出来
        const resp = await route.fetch();
        const source = await resp.text();
        const body = source.replace(/\/dist\/viewer\.js/, '/dist/viewer-main.js');
        if (body === source) throw new Error('viewer.html 里没找到 /dist/viewer.js，这条用例失效');
        await route.fulfill({ response: resp, body });
      }, /没认出查看器入口脚本（viewer\.js）/],
      ['一份样式表取不到', /\/dist\/styles-panels\.min\.css/, (route) => route.fulfill({ status: 404, body: '' }),
        /样式表没取到：\/dist\/styles-panels\.min\.css（CSS HTTP 404）/],
      ['查看器脚本取不到（空白页）', /\/dist\/viewer\.js/, (route) => route.fulfill({ status: 404, body: '' }),
        /脚本没取到：\/dist\/viewer\.js（JS HTTP 404）/],
      ['查看器脚本一启动就抛错（结构完好，靠真打开核对兜住）', /\/dist\/viewer\.js/, async (route) => {
        const resp = await route.fetch();
        const body = "throw new Error('utopia-selfcheck-boot-bomb');\n" + (await resp.text());
        await route.fulfill({ response: resp, body });
      }, /成品打开后只有 0\/\d+ 个节点/],
    ];
    for (const [name, pattern, handler, re] of negatives) {
      try {
        const problems = await refute(pattern, handler);
        if (!re.test(problems)) throw new Error('原因不对：「' + problems + '」');
        ok('坏文件被拦下：' + name + ' →「' + problems + '」');
      } catch (e) { fail('坏文件被拦下：' + name, e); }
    }
    // 拦下之后通道照常：同一条链再来一次必须能成（自检不能把好文件也拦了）
    const [again] = await Promise.all([
      page.waitForEvent('download', { timeout: 90000 }),
      page.evaluate(() => window.exportUtopiaStandaloneHtml()),
    ]);
    await again.saveAs(join(outDir, 'export-again.html'));
    ok('拦下四次之后再导一次照常成功（自检没有误伤好文件）');

    // ===== ⑤ 停掉服务，file:// 真打开：没有服务端＝证明离线自包含 =====
    await ctx.close();
    srv.stop();
    const stillUp = await fetch(srv.base + '/health', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (stillUp) throw new Error('隔离实例没停掉，file:// 这一段证明不了离线');

    const viewCtx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    const view = await viewCtx.newPage();
    const viewErrors = [];
    const netRequests = [];
    view.on('pageerror', (e) => viewErrors.push(String(e && e.message || e)));
    view.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) netRequests.push(u); });
    await view.goto(pathToFileURL(okPath).href, { waitUntil: 'load', timeout: 60000 });
    await view.waitForFunction((n) => document.querySelectorAll('.graph-node').length >= n, expected, { timeout: 30000 });

    const step = async (name, fn) => { try { await fn(); ok(name); } catch (e) { fail(name, e); } };

    await step('file:// 打开：节点数与画布一致、外链清零、顶栏已剔、悬浮钮在位', async () => {
      const opened = await view.evaluate(() => {
        const snap = (window.__UTOPIA__ || {}).snapshot || {};
        const gv = (typeof graphView !== 'undefined' && graphView) || { nodes: [], edges: [] };
        return {
          domNodes: document.querySelectorAll('.graph-node').length,
          dataNodes: (gv.nodes || []).length,
          edges: (gv.edges || []).length,
          snapNodes: (snap.nodes || []).length,
          snapMessages: (snap.messages || []).length,
          externalRefs: document.querySelectorAll('link[rel="stylesheet"], script[src]').length,
          bar: !!document.querySelector('.utopia-bar'),
          searchBtn: !!document.getElementById('utopiaSearchBtn'),
          themeBtn: !!document.getElementById('utopiaThemeBtn'),
          title: document.title,
          versionNavs: document.querySelectorAll('.graph-version-nav').length,
          versionsInSnap: JSON.stringify(snap).includes('"versions"'),
        };
      });
      if (opened.domNodes !== expected || opened.dataNodes !== expected || opened.snapNodes !== expected) {
        throw new Error('节点数对不上：' + JSON.stringify(opened) + '，画布 ' + expected);
      }
      if (opened.snapMessages !== 8) throw new Error('会话消息没带全：' + opened.snapMessages + ' 条');
      if (opened.externalRefs) throw new Error('还留着 ' + opened.externalRefs + ' 个外链');
      if (opened.bar || !opened.searchBtn || !opened.themeBtn) throw new Error('界面口径不对：' + JSON.stringify(opened));
      if (!String(opened.title).startsWith('单文件导出回归')) throw new Error('标题不对：' + opened.title);
      // 579 外发口径：旧版本账本不进快照——只读页既不渲染版本导航，快照里也没有 versions
      if (opened.versionNavs) throw new Error('只读页渲染出了版本导航（' + opened.versionNavs + ' 个，538 护栏盲区的入口）');
      if (opened.versionsInSnap) throw new Error('装载后的快照里还有 versions');
    });

    await step('file:// 打开：可视化卡里的公式用包里的 KaTeX 真渲出来', async () => {
      const frames = view.frames().filter((f) => f.parentFrame() === view.mainFrame());
      const cards = await view.evaluate(() => document.querySelectorAll('.viz-card').length);
      if (!cards) throw new Error('成品里没有可视化卡');
      if (!frames.length) throw new Error('可视化卡 ' + cards + ' 张，但一张都没装载（视口观察器没放行？）');
      const vf = frames[0];
      await vf.waitForSelector('#viz-ok', { timeout: 10000 });
      await vf.waitForFunction(() => document.querySelectorAll('.katex').length >= 1, null, { timeout: 10000 });
      const katex = await vf.evaluate(() => document.querySelectorAll('.katex').length);
      if (katex < 1) throw new Error('可视化页里一个公式都没渲染');
    });

    await step('file:// 打开：滚轮缩放 / 主题钮 / 搜索钮都可用', async () => {
      const zoomOf = () => view.evaluate(() => (typeof graphView !== 'undefined' && graphView ? graphView.zoom : null));
      const themeOf = () => view.evaluate(() => document.documentElement.getAttribute('data-theme'));
      // 滚轮直接派发到画布元素：真鼠标事件会落在节点卡上、被节点内滚动吞掉（同主应用语义）
      const z0 = await zoomOf();
      await view.evaluate(() => {
        const c = document.getElementById('graphCanvas');
        for (let i = 0; i < 5; i++) {
          c.dispatchEvent(new WheelEvent('wheel', {
            deltaY: -400, clientX: 60, clientY: 60, bubbles: true, cancelable: true,
          }));
        }
      });
      await view.waitForTimeout(700);
      if (!(await zoomOf() > z0)) throw new Error('滚轮缩放没生效');
      const t0 = await themeOf();
      await view.click('#utopiaThemeBtn');
      if (await themeOf() === t0) throw new Error('主题钮没切换主题');
      await view.click('#utopiaSearchBtn');
      const searchOpen = await view.evaluate(() => {
        const p = document.getElementById('graphSearchPanel');
        return !!p && !p.hidden;
      });
      if (!searchOpen) throw new Error('搜索钮没打开搜索面板');
    });

    await step('file:// 打开：零联网、零报错、真实 localStorage 零写入', async () => {
      if (netRequests.length) throw new Error('向外取了资源：' + netRequests.slice(0, 5).join(' , '));
      if (viewErrors.length) throw new Error('页面抛错：' + viewErrors.slice(0, 3).join(' | '));
      const polluted = await view.evaluate(() => Object.keys(window.__utopiaRealLocalStorage || {}).length);
      if (polluted) throw new Error('真实 localStorage 被写入 ' + polluted + ' 键');
    });
    await viewCtx.close();
  } catch (e) {
    fail('流程中断', e);
  } finally {
    await browser.close();
    srv.stop();
    try { rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* 下次系统清 */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 通过`);
  if (passed !== results.length) {
    console.log('\n--- 隔离实例日志尾部 ---\n' + srv.logTail(1200));
    process.exit(1);
  }
}

run().catch((err) => { console.error('运行失败：' + (err && err.message || err)); process.exit(1); });
