#!/usr/bin/env node
// 会话历史导出「真导出 → 真打开」真机回归（backlog 575，2026-11-24）。
//
// 为什么要它：冒烟沙箱里没有 marked／DOMPurify／KaTeX，网页版的正文渲染、公式预排、
// 单文件离线这几条在沙箱里只能测降级分支——静态绿不等于真能用（单文件网页空白 21 天
// 的教训，见 verify_utopia_html_export.mjs 头注）。这支脚本走完整条真链路：
//   ① 隔离实例里种一份覆盖各节点类型的画布（localStorage 预置，应用照常加载）
//   ② 知识菜单的真按钮触发「导出会话历史 · HTML／Markdown」→ 接住下载文件
//   ③ 成品结构核对：条目数、公式预排数、零脚本零外链资源、mermaid 源码块、外链图片换链接
//   ④ 当场生成：改一笔画布再导，新内容必须在
//   ⑤ 前后端逐字对拍：同一份夹具喂服务端归档（storage.message_archive_markdown），
//      除「导出时间」一行外两份 Markdown 必须一字不差（前后端口径不漂移的牙）
//   ⑥ 停掉服务 → file:// 打开（没有服务端＝证明离线自包含）→ 数条目、验公式真排出来、
//      查零联网零报错
//   ⑦ 空会话只提示不下载；KaTeX 样式取不到只提示不下载；笔记导出没被带偏
//
// 用法：node scripts/verify_history_export.mjs
//       先 npm run build:js——隔离实例拷的是构建产物，不是源码。
// 隔离口径：scripts/lib/test_server.mjs（临时数据目录第二实例），真实 data/ 全程不碰；
// ⑤ 的 Python 只调纯函数，不读写任何数据目录。
// 本脚本不调模型。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const PORT = 5093; // 避开其他脚本已占口（5066–5099 段见各脚本头）与 undici 坏端口
const SID = 'sess_history_export_fixture';
const TITLE = '会话导出回归';
const T0 = Date.UTC(2026, 9, 31, 2, 0);

const results = [];
function ok(name) { results.push(true); console.log('✓ ' + name); }
function fail(name, err) { results.push(false); console.log('❌ ' + name + ' -> ' + (err && err.message || err)); }
const count = (s, needle) => s.split(needle).length - 1;
const toastTextOf = (page) => page.evaluate(() => {
  const t = document.getElementById('phymathia_toast');
  if (!t) return '';
  const span = t.querySelector('.toast-msg-text');
  return String((span || t).textContent || '');
});

// ---- 夹具：覆盖取材口径的每一支 ----
// 9 个节点＋3 条消息 → 9 条目：n1 提问（同文消息去重）、n2 问题分析（正文在 analysis）、
// n3 模块（句中公式／独占一行公式／行内定界符）、n4 直接回答（行内公式＋mermaid＋短代码块）、
// n5 AI 总结（思考块＋外链图片＋内嵌图片）、n6 我的总结、n7 交互可视化（整条是网页）、
// n8 只有清单的模块、n9 空节点（不列）；另有一条支线对话消息、一条系统消息（不列）。
function makeFixture() {
  const nodes = [
    { id: 'n1', kind: 'user', content: '简谐运动是什么？', timestamp: T0 },
    { id: 'n2', kind: 'answer', content: '', analysis: '题意：问的是定义，不是计算。', timestamp: T0 + 1000 },
    { id: 'n3', kind: 'module', label: '物理视角', timestamp: T0 + 2000,
      content: '## 物理视角\n\n回复力 <formula>F=-kx</formula>。\n\n<formula>\nT=2\\pi\\sqrt{\\frac{m}{k}}\n</formula>\n\n圆频率 \\(\\omega_0\\) 与位移 $x(t)$。' },
    { id: 'n4', kind: 'direct', timestamp: T0 + 3000,
      content: '一句话：**周期**只由 $m$ 与 $k$ 决定。\n\n```mermaid\ngraph TD; A-->B\n```\n\n```html\n<b>短片段</b>\n```' },
    { id: 'n5', kind: 'summary', timestamp: T0 + 4000,
      content: '<think>内部推理不导出</think>**核心**：机械能守恒。\n\n<img src="https://example.invalid/x.png" alt="外链图">\n\n<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="内嵌图">' },
    { id: 'n6', kind: 'note', timestamp: T0 + 5000, content: '# 我的总结\n\n- 周期公式 <formula>T=2\\pi\\sqrt{m/k}</formula>' },
    { id: 'n7', kind: 'module', label: '交互可视化', timestamp: T0 + 6000,
      content: '```html\n<!DOCTYPE html><html><body>' + 'v'.repeat(200) + '</body></html>\n```' },
    { id: 'n8', kind: 'module', timestamp: T0 + 7000, items: [{ levelName: '基础', question: '为什么周期与振幅无关？' }] },
    { id: 'n9', kind: 'hub', timestamp: T0 + 8000 },
  ];
  const messages = [
    { role: 'system', content: '系统提示不导出', timestamp: T0 + 100 },
    { role: 'user', content: '简谐运动是什么？', timestamp: T0 },
    { role: 'assistant', content: '抓住要害了：这里的「线性」说的是方程对位移是线性的。', timestamp: T0 + 4500 },
  ];
  return {
    sid: SID, title: TITLE, nodes, messages,
    expected: 9,
    // 网页版预排公式 7 处：n3 四处（独占一行的公式 1 处 display；句中 <formula>、\(\) 与 $ 各 1 处
    // inline）、n4 两处、n6 一处（句中 <formula>）。句中公式按上下文转 inline，不整块居中。
    katex: 7, display: 1,
  };
}

// ⑤ 的服务端一侧：只调纯函数 message_archive_markdown（节点与消息随 stdin 进）
const PY_MARKDOWN = [
  'import json, sys',
  "sys.path.insert(0, 'src')",
  'from server import storage',
  'd = json.load(sys.stdin)',
  "sys.stdout.write(storage.message_archive_markdown(d['sid'], d['messages'], d['title'], d['nodes']))",
].join('\n');

// 在页面脚本之前预置会话、画布与聊天流（default 账号：逻辑键＝物理键）。
// sessionStorage 旗标防重入：页面内刷新不得把应用改过的状态盖回夹具。
function seed({ sid, title, nodes, messages }) {
  try {
    if (sessionStorage.getItem('__history_export_seeded')) return;
    sessionStorage.setItem('__history_export_seeded', '1');
    const now = Date.now();
    localStorage.setItem('phymathia_sessions', JSON.stringify({
      [sid]: { id: sid, sessionId: sid, title: title, createdAt: now, updatedAt: now },
    }));
    localStorage.setItem('phymathia_current_session', sid);
    localStorage.setItem('phymathia_graph_' + sid, JSON.stringify({ customNodes: nodes, connections: [], positions: {} }));
    localStorage.setItem('phymathia_msgs_' + sid, JSON.stringify(messages));
    localStorage.setItem('phymathia_onboarding_done', '1');
  } catch (e) { /* 页面自己会报 */ }
}

// 走知识菜单的真按钮（DOM 级 click：首访引导层可能浮在菜单上方挡住真鼠标）。
// 返回本次接到的下载；expectDownload=false 时等一小会儿就回，调用方断言「一个文件都不交」。
async function exportViaMenu(page, label, expectDownload) {
  const downloads = [];
  const onDownload = (d) => downloads.push(d);
  page.on('download', onDownload);
  try {
    const click = page.evaluate((text) => {
      const el = Array.from(document.querySelectorAll('#knowledgeMenu .level-option'))
        .find((x) => String(x.textContent || '').includes(text));
      if (!el) throw new Error('知识菜单里找不到「' + text + '」');
      el.click();
    }, label);
    if (!expectDownload) {
      await click;
      await page.waitForTimeout(2500);
    } else {
      await Promise.all([page.waitForEvent('download', { timeout: 30000 }), click]);
    }
    return downloads;
  } finally {
    page.off('download', onDownload);
  }
}

const stripExportTime = (t) => t.split('\n').filter((l) => !l.startsWith('- 导出时间：')).join('\n');

async function run() {
  const srv = await startIsolatedServer({ port: PORT, label: 'phymathia-history-export' });
  process.on('exit', () => srv.stop());
  const outDir = mkdtempSync(join(tmpdir(), 'phymathia-history-export-out-'));
  const htmlPath = join(outDir, 'history.html');
  const mdPath = join(outDir, 'history.md');
  const browser = await chromium.launch();
  const fx = makeFixture();
  const step = async (name, fn) => { try { await fn(); ok(name); } catch (e) { fail(name, e); } };
  let md = '';

  try {
    // ===== ⑦a 空会话：必须排在种夹具之前——夹具会话一旦推上隔离实例，新开的空页面会把它同步回来 =====
    await step('空会话：只提示「本会话还没有可导出的内容」，一个文件都不交', async () => {
      const emptyCtx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
      await emptyCtx.addInitScript(() => { try { localStorage.setItem('phymathia_onboarding_done', '1'); } catch (e) { /* 忽略 */ } });
      const empty = await emptyCtx.newPage();
      try {
        await empty.goto(srv.base, { waitUntil: 'domcontentloaded' });
        await empty.waitForFunction(() => typeof window.exportSessionHistory === 'function', null, { timeout: 30000 });
        const dl = await exportViaMenu(empty, '导出会话历史 · Markdown', false);
        if (dl.length) throw new Error('空会话照样交出了 ' + dl.length + ' 个文件');
        const toast = await toastTextOf(empty);
        if (toast !== '本会话还没有可导出的内容') throw new Error('提示语不对："' + toast + '"');
      } finally {
        await emptyCtx.close();
      }
    });

    // ===== ① 夹具长成真实画布 =====
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(seed, { sid: SID, title: TITLE, nodes: fx.nodes, messages: fx.messages });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((sid) => typeof window.exportSessionHistory === 'function'
      && typeof window.exportSessionNote === 'function'
      && typeof _graphState === 'function'
      && window.getCurrentSessionId() === sid, SID, { timeout: 30000 });
    const shape = await page.evaluate(() => ({
      nodes: ((_graphState() || {}).customNodes || []).length,
      msgs: (_getChatHistory() || []).length,
    }));
    if (shape.nodes !== fx.nodes.length) throw new Error('夹具没长成画布：' + JSON.stringify(shape));
    ok('夹具长成真实画布（' + shape.nodes + ' 节点 / ' + shape.msgs + ' 条聊天消息）');

    // ===== ②③ 真导出两版并核对成品 =====
    let html = '';
    await step('知识菜单真按钮导出 Markdown（文件名带日期）', async () => {
      const dl = await exportViaMenu(page, '导出会话历史 · Markdown', true);
      if (!dl.length) throw new Error('没有文件下载');
      if (!/^PhyMathia会话历史-会话导出回归-\d{4}-\d{2}-\d{2}\.md$/.test(dl[0].suggestedFilename())) {
        throw new Error('文件名不符：' + dl[0].suggestedFilename());
      }
      await dl[0].saveAs(mdPath);
      md = readFileSync(mdPath, 'utf8');
    });
    await step('知识菜单真按钮导出 HTML（文件名带日期）', async () => {
      const dl = await exportViaMenu(page, '导出会话历史 · HTML', true);
      if (!dl.length) throw new Error('没有文件下载');
      if (!/^PhyMathia会话历史-会话导出回归-\d{4}-\d{2}-\d{2}\.html$/.test(dl[0].suggestedFilename())) {
        throw new Error('文件名不符：' + dl[0].suggestedFilename());
      }
      await dl[0].saveAs(htmlPath);
      html = readFileSync(htmlPath, 'utf8');
    });

    await step('Markdown 成品：条目序列／公式转 $$ 与 $／同文去重／思考块与结构标签不外露／可视化只留说明', async () => {
      if (!md) throw new Error('上一步没拿到成品');
      if (!md.startsWith('# ' + TITLE + '\n\n- 会话 ID：`' + SID + '`\n- 条目：' + fx.expected + ' 条（画布节点 ' + fx.nodes.length + ' 个、聊天消息 ' + fx.messages.length + ' 条，空条目已略）\n')) {
        throw new Error('头部不符：' + JSON.stringify(md.slice(0, 110)));
      }
      const heads = Array.from(md.matchAll(/^## (\d+)\. (.+?) · (\d\d-\d\d \d\d:\d\d)$/gm)).map((m) => m[2]);
      const want = ['我', '问题分析', '模块 · 物理视角', 'AI', 'AI 总结', 'AI', '我的总结', '模块 · 交互可视化', '模块'];
      if (heads.join('|') !== want.join('|')) throw new Error('条目序列不符：' + heads.join(' | '));
      // Markdown 是纯文本：外链图片保持原链接写法（单文件不联网的契约只管网页版）
      for (const leak of ['<formula>', '内部推理不导出', '系统提示不导出', '<think>']) {
        if (md.includes(leak)) throw new Error('不该外露的内容出现了：' + leak);
      }
      if (!md.includes('回复力 $F=-kx$。')) throw new Error('句中公式应转 inline');
      if (!md.includes('$$\nT=2\\pi\\sqrt{\\frac{m}{k}}\n$$')) throw new Error('独占一行的公式应转 display');
      if (count(md, '\n$$\n') !== 2) throw new Error('display 块应恰好一个，实得 ' + count(md, '\n$$\n') / 2);
      if (!md.includes('- [基础] 为什么周期与振幅无关？')) throw new Error('清单条目缺失');
      if (!md.includes('（交互可视化，') || md.includes('<!DOCTYPE')) throw new Error('可视化节点应只留说明');
      if (count(md, '简谐运动是什么？') !== 1) throw new Error('与节点同文的消息应去重');
    });

    await step('网页成品：' + fx.expected + ' 条目／公式预排 ' + fx.katex + ' 处（display ' + fx.display + '）零报错／零脚本零外链资源／mermaid 源码块／外链图片换链接／标题降级', async () => {
      if (!html) throw new Error('上一步没拿到成品');
      if (!html.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')) throw new Error('缺 DOCTYPE／lang');
      if (!html.includes('<title>PhyMathia 会话历史 · ' + TITLE + '</title>')) throw new Error('title 不对');
      if (count(html, 'class="note-item history-item"') !== fx.expected) {
        throw new Error('条目节数不对：' + count(html, 'class="note-item history-item"'));
      }
      if (count(html, '<span class="katex">') !== fx.katex) {
        throw new Error('预排公式数不对：' + count(html, '<span class="katex">'));
      }
      if (count(html, '<span class="katex-display">') !== fx.display) {
        throw new Error('display 公式数不对：' + count(html, '<span class="katex-display">'));
      }
      if (html.includes('katex-error')) throw new Error('有公式渲染成了报错');
      if (/<script\b|<iframe\b|<link\b/i.test(html)) throw new Error('成品带脚本／iframe／外链样式');
      for (const m of html.matchAll(/url\(([^)]{0,40})/g)) {
        if (!m[1].startsWith('data:')) throw new Error('出现非 data: 的 url(' + m[1] + ')');
      }
      if (!html.includes('<pre class="history-mermaid"><code>graph TD; A--&gt;B</code></pre>')) throw new Error('mermaid 应以源码块放回');
      if (!html.includes('&lt;b&gt;短片段&lt;/b&gt;')) throw new Error('短代码块应保留');
      if (!html.includes('<a href="https://example.invalid/x.png" target="_blank" rel="noopener">图片：外链图</a>')) throw new Error('外链图片应换成链接');
      if (/<img\b[^>]*example\.invalid/.test(html)) throw new Error('外链图片还在自动加载');
      if (!html.includes('<img src="data:image/gif;base64,')) throw new Error('内嵌图片应保留');
      // 每条正文到自己的 </div> 为止——别把后面条目的 <h2> 条目头也算进「正文」
      const bodies = html.split('<div class="note-body">').slice(1).map((s) => s.split('\n      </div>')[0]).join('');
      if (/<h[12][\s>]/.test(bodies)) throw new Error('正文里的标题没降级，会打乱大纲');
      if (!bodies.includes('<h3>我的总结</h3>') || !bodies.includes('<h4>物理视角</h4>')) throw new Error('正文标题降级结果不对');
    });

    await step('前后端逐字对拍：同一份夹具喂服务端归档，除「导出时间」外与导出的 Markdown 一字不差', async () => {
      if (!md) throw new Error('没有导出的 Markdown');
      const py = spawnSync('python3', ['-c', PY_MARKDOWN], { input: JSON.stringify(fx), encoding: 'utf8' });
      if (py.status !== 0) throw new Error('服务端一侧生成失败：' + String(py.stderr || '').slice(-400));
      const mine = stripExportTime(md);
      const theirs = stripExportTime(py.stdout);
      if (mine !== theirs) {
        let i = 0;
        while (i < mine.length && i < theirs.length && mine[i] === theirs[i]) i++;
        throw new Error('第 ' + i + ' 字起不同：导出「' + mine.slice(Math.max(0, i - 30), i + 40) + '」 vs 归档「' + theirs.slice(Math.max(0, i - 30), i + 40) + '」');
      }
    });

    // ===== ④ 当场生成 =====
    await step('当场生成：改一笔画布再导，新内容立刻在（不等后台归档）', async () => {
      await page.evaluate(({ sid, t0 }) => {
        const st = window.getGraphState(sid);
        st.customNodes = (st.customNodes || []).concat([{ id: 'n10', kind: 'note', content: '刚写的新笔记', timestamp: t0 + 9000 }]);
        window.saveGraphState(sid, st);
      }, { sid: SID, t0: T0 });
      const dl = await exportViaMenu(page, '导出会话历史 · Markdown', true);
      if (!dl.length) throw new Error('没有文件下载');
      await dl[0].saveAs(join(outDir, 'history-2.md'));
      const again = readFileSync(join(outDir, 'history-2.md'), 'utf8');
      if (!again.includes('刚写的新笔记') || !/\n## 10\. 我的总结 · \d\d-\d\d \d\d:\d\d\n/.test(again)) {
        throw new Error('改动画布后再导，新内容没进来');
      }
    });

    // ===== ⑦b 只提示不下载 =====
    await step('KaTeX 样式取不到：网页版不交文件，只提示', async () => {
      const pattern = '**/vendor/katex/katex.min.css';
      const handler = (route) => route.fulfill({ status: 404, body: '' });
      await page.route(pattern, handler);
      let dl;
      try {
        dl = await exportViaMenu(page, '导出会话历史 · HTML', false);
      } finally {
        await page.unroute(pattern, handler);
      }
      if (dl.length) throw new Error('样式取不到照样交出了文件');
      const toast = await toastTextOf(page);
      if (toast !== '导出失败：无法读取本地 KaTeX 样式') throw new Error('提示语不对："' + toast + '"');
    });
    await step('笔记导出没被共用函数带偏（无知识条目照旧只提示）', async () => {
      const downloads = [];
      const onDownload = (d) => downloads.push(d);
      page.on('download', onDownload);
      try {
        await page.evaluate(() => window.exportSessionNote('md'));
        await page.waitForTimeout(2500);
      } finally {
        page.off('download', onDownload);
      }
      if (downloads.length) throw new Error('没有知识条目却交出了文件');
      const toast = await toastTextOf(page);
      if (!toast.startsWith('本会话暂无知识条目')) throw new Error('提示语不对："' + toast + '"');
    });
    if (pageErrors.length) fail('导出过程页面零报错', new Error(pageErrors.slice(0, 3).join(' | ')));
    else ok('导出过程页面零报错');
    await ctx.close();

    // ===== ⑥ 停掉服务，file:// 真打开：没有服务端＝证明离线自包含 =====
    if (!html) throw new Error('没有网页成品，离线这一段无从测起');
    srv.stop();
    const stillUp = await fetch(srv.base + '/health', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (stillUp) throw new Error('隔离实例没停掉，file:// 这一段证明不了离线');

    const viewCtx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    const view = await viewCtx.newPage();
    const viewErrors = [];
    const netRequests = [];
    view.on('pageerror', (e) => viewErrors.push(String(e && e.message || e)));
    view.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u)) netRequests.push(u); });
    await view.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 60000 });
    await view.waitForFunction((n) => document.querySelectorAll('.history-item').length === n, fx.expected, { timeout: 30000 });
    await view.evaluate(() => document.fonts.ready);
    const shot1 = join(tmpdir(), 'phymathia-history-export-1.png');
    const shot2 = join(tmpdir(), 'phymathia-history-export-2.png');
    await view.screenshot({ path: shot1 });
    await view.evaluate(() => {
      const el = document.querySelector('.note-body .katex-display');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await view.screenshot({ path: shot2 });

    await step('file:// 打开：' + fx.expected + ' 条目齐全、公式用包里的字体真排出来、零报错', async () => {
      const opened = await view.evaluate(() => {
        const ks = Array.from(document.querySelectorAll('.note-body .katex'));
        return {
          items: document.querySelectorAll('.history-item').length,
          katex: ks.length,
          display: document.querySelectorAll('.note-body .katex-display').length,
          drawn: ks.filter((k) => k.getBoundingClientRect().height > 8).length,
          katexFonts: Array.from(document.fonts).filter((f) => /KaTeX/.test(f.family) && f.status === 'loaded').length,
          errors: document.querySelectorAll('.katex-error').length,
          external: document.querySelectorAll('script, iframe, link[rel="stylesheet"]').length,
          imgs: document.querySelectorAll('.note-body img').length,
          links: document.querySelectorAll('.note-body a[href^="http"]').length,
        };
      });
      if (opened.items !== fx.expected) throw new Error('条目数不对：' + JSON.stringify(opened));
      if (opened.katex !== fx.katex || opened.display !== fx.display) throw new Error('公式数不对：' + JSON.stringify(opened));
      if (opened.drawn !== fx.katex) throw new Error('有公式没排出来（高度为 0）：' + JSON.stringify(opened));
      if (opened.katexFonts < 1) throw new Error('包里的 KaTeX 字体一张都没加载，离线打不开会退成系统字体：' + JSON.stringify(opened));
      if (opened.errors) throw new Error('离线打开后有公式渲染成报错');
      if (opened.external) throw new Error('还留着外链脚本／样式');
      if (opened.imgs !== 1 || opened.links !== 1) throw new Error('图片口径不对（应 1 张内嵌图＋1 条外链）：' + JSON.stringify(opened));
    });
    await step('file:// 打开：零联网、零报错', async () => {
      if (netRequests.length) throw new Error('向外取了资源：' + netRequests.slice(0, 5).join(' , '));
      if (viewErrors.length) throw new Error('页面抛错：' + viewErrors.slice(0, 3).join(' | '));
    });
    await viewCtx.close();
    console.log('截图：' + shot1 + ' 、' + shot2);
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
