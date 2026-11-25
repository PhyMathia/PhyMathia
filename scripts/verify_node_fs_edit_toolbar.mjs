#!/usr/bin/env node
// 渲染态编辑·格式工具条（backlog 591①②，2026-11-25）真机回归：两处编辑面（本页全屏层＋
// 新窗口预览页）逐按钮验证到「保存→重开」。自带临时数据目录的隔离实例（收敛口
// scripts/lib/test_server.mjs，端口先探后占），不碰 data/、不连 5050。
// 跑法：node scripts/verify_node_fs_edit_toolbar.mjs      （约 1 分钟，全绿 exit 0）
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';
import { resolveChromiumExecutable } from './lib/chromium.mjs';

const SID = 'sess_nfs_fmt';
const BASE_MD = [
  '# 标题一', '',
  '第一段文字甲乙丙丁。第二句在这里。', '',
  '## 二级标题', '',
  '- 列表项一', '- 列表项二', '- 列表项三', '',
  '1. 有序一', '2. 有序二', '3. 有序三', '',
  '- [ ] 待办甲', '- [x] 待办乙', '',
  '> 引用一句', '',
  '| 列A | 列B |', '| --- | --- |', '| 1 | 2 |', '',
  '```python', 'print(1)', '```', '',
  '- 外层一', '  - 内层一', '  - 内层二', '- 外层二', '',
  '末尾段落，含公式 $E=mc^2$ 与 **加粗** 与 [链接](https://example.com)。',
].join('\n');
const ATOMS = '.katex, .katex-display, .mermaid-container, .viz-card, pre, img, input';

let passed = 0;
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      '));
    if (process.env.NFS_DEBUG) {
      try { const f = await facts(page, '.graph-node-fs-content', '.nfs-fmt'); console.log('      html: ' + f.html.slice(0, 900)); } catch (e2) { /* 没有全屏层就跳过 */ }
    }
  }
};
const must = (cond, msg, extra) => {
  if (cond) return;
  throw new Error(msg + (extra !== undefined ? '\n      ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''));
};
const withWord = (base, from, to) => {
  must(base.includes(from), '基准里找不到：' + from);
  return base.replace(from, to);
};

const srv = await startIsolatedServer({ port: 5095, label: 'phymathia-nfs-fmt' });
process.on('exit', () => srv.stop());
const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(({ sid, content }) => {
  try {
    if (sessionStorage.getItem('__nfs_fmt_seeded')) return;
    sessionStorage.setItem('__nfs_fmt_seeded', '1');
    const now = Date.now();
    localStorage.setItem('phymathia_sessions', JSON.stringify({ [sid]: { id: sid, sessionId: sid, title: '工具条回归', createdAt: now, updatedAt: now } }));
    localStorage.setItem('phymathia_current_session', sid);
    localStorage.setItem('phymathia_graph_' + sid, JSON.stringify({
      customNodes: [{ id: 'n1', kind: 'module', label: '回归节点', timestamp: now, content }],
      connections: [], positions: { n1: { x: 200, y: 200 } },
    }));
    localStorage.setItem('phymathia_msgs_' + sid, JSON.stringify([]));
    localStorage.setItem('phymathia_onboarding_done', '1');
  } catch (e) { /* ignore */ }
}, { sid: SID, content: BASE_MD });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction((sid) => typeof window.openNodeFullscreen === 'function' && typeof _graphState === 'function'
  && window.getCurrentSessionId() === sid, SID, { timeout: 30000 });
await page.waitForFunction(() => typeof _findGraphNode === 'function' && !!_findGraphNode('n1'), null, { timeout: 30000 });
await page.waitForTimeout(600);

const toastTextOf = (p) => p.evaluate(() => {
  const t = document.getElementById('phymathia_toast');
  if (!t) return '';
  const span = t.querySelector('.toast-msg-text');
  return String((span || t).textContent || '');
});
// 编辑面的当前事实：拼回的 md／自检结论／选区（字符序）／按钮按下态／下拉显示值
const facts = (p, rootSel, barSel) => p.evaluate(({ rootSel, barSel, ATOMS }) => {
  const c = document.querySelector(rootSel);
  const md = typeof _nodeFsSerializeContent === 'function' ? _nodeFsSerializeContent(c) : null;
  const s = window.getSelection();
  const r = s && s.rangeCount ? s.getRangeAt(0) : null;
  let sel = null;
  if (r && c && c.contains(r.commonAncestorContainer)) {
    const off = (n, o) => { const x = document.createRange(); x.setStart(c, 0); x.setEnd(n, o); return x.toString().length; };
    sel = off(r.startContainer, r.startOffset) + (r.collapsed ? '' : '-' + off(r.endContainer, r.endOffset));
  }
  const pressed = {};
  const bar = barSel ? document.querySelector(barSel) : null;
  if (bar) for (const b of bar.querySelectorAll('[data-fmt][aria-pressed]')) pressed[b.getAttribute('data-fmt')] = b.getAttribute('aria-pressed') === 'true';
  const block = bar ? bar.querySelector('.nfs-fmt-block') : null;
  return {
    md,
    mis: (typeof _nodeFsEditMismatchBlock === 'function' && c) ? (_nodeFsEditMismatchBlock(md, c) != null) : null,
    bad: (typeof _nodeFsSerializeVerified === 'function' && c) ? _nodeFsSerializeVerified(c).bad : null,
    sel,
    pressed,
    block: block ? block.value : null,
    html: c ? c.innerHTML.replace(/\n+/g, '⏎') : '',
    editing: c ? c.getAttribute('contenteditable') : null,
    dirty: (typeof _nodeFsEditSession !== 'undefined' && _nodeFsEditSession) ? !!_nodeFsEditSession.dirty : null,
  };
}, { rootSel, barSel, ATOMS });

// ============================================================
// ① 本页全屏层
// ============================================================
console.log('① 本页全屏层');
await page.evaluate(() => { openNodeFullscreen('n1'); });
await page.waitForSelector('.graph-node-fs-content', { timeout: 15000 });
const openEdit = async () => {
  await page.evaluate(() => { openNodeFsEdit('n1'); });
  try {
    await page.waitForSelector('.graph-node-fs-content[contenteditable="true"]', { timeout: 5000 });
  } catch (e) {
    const why = await page.evaluate(() => ({
      toast: String((document.getElementById('phymathia_toast') || {}).textContent || ''),
      overlay: !!document.querySelector('.graph-node-fs-overlay'),
      content: String((_findGraphNode('n1') || {}).content || '').slice(0, 200),
    }));
    throw new Error('进不了编辑：' + JSON.stringify(why));
  }
  await page.waitForSelector('.nfs-fmt[data-fmt], .nfs-fmt [data-fmt]', { timeout: 5000 });
};
await openEdit();
const BASE_HTML = await page.evaluate(() => document.querySelector('.graph-node-fs-content').innerHTML);
const F = () => facts(page, '.graph-node-fs-content', '.nfs-fmt');

// 光标落进第 idx 个 sel 的第 offset 个可编辑字（公式里的字不算；超出＝落到末尾）。
// 只摆选区不点击，后面的工具条操作走真实鼠标
const placeAt = `(rootSel, sel, idx, offset, endOffset, ATOMS) => {
  const c = document.querySelector(rootSel);
  const el = c.querySelectorAll(sel)[idx];
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const tns = [];
  let n;
  while ((n = tw.nextNode())) if (n.nodeValue.trim() && !n.parentElement.closest('svg') && !n.parentElement.closest(ATOMS)) tns.push(n);
  const at = (k) => {
    for (const t of tns) {
      if (k <= t.nodeValue.length) return [t, k];
      k -= t.nodeValue.length;
    }
    const last = tns[tns.length - 1];
    return [last, last.nodeValue.length];
  };
  const [a, ao] = at(offset);
  const r = document.createRange();
  r.setStart(a, ao);
  if (endOffset != null) { const [b, bo] = at(endOffset); r.setEnd(b, bo); }
  else r.collapse(true);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  c.focus({ preventScroll: true });
  s.removeAllRanges();
  s.addRange(r);
}`;
const caret = (sel, idx, offset, endOffset) => page.evaluate(`(${placeAt})('.graph-node-fs-content', ${JSON.stringify(sel)}, ${idx}, ${offset}, ${endOffset == null ? 'null' : endOffset}, ${JSON.stringify(ATOMS)})`);
const caretCtx = () => page.evaluate(() => {
  const c = document.querySelector('.graph-node-fs-content');
  const s = window.getSelection();
  if (!s.rangeCount) return 'no-range';
  const r = s.getRangeAt(0);
  if (!c || !c.contains(r.commonAncestorContainer)) return 'outside';
  const a = document.createRange(); a.selectNodeContents(c); a.setEnd(r.startContainer, r.startOffset);
  const endp = document.createRange(); endp.selectNodeContents(c); endp.collapse(false);
  const b = document.createRange(); b.setStart(r.endContainer, r.endOffset); b.setEnd(endp.endContainer, endp.endOffset);
  return JSON.stringify(String(a).replace(/\n+/g, '\\n').slice(-1) + '|' + String(b).replace(/\n+/g, '\\n').slice(0, 1));
});
// 跨块选区：第 a 个 selA 的起点 → 第 b 个 selB 的第 end 字
const span = (selA, a, selB, b, end) => page.evaluate(({ selA, a, selB, b, end }) => {
  const c = document.querySelector('.graph-node-fs-content');
  const firstText = (el) => {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) if (n.nodeValue.trim()) return n;
    return null;
  };
  const ea = c.querySelectorAll(selA)[a];
  const eb = c.querySelectorAll(selB)[b];
  const r = document.createRange();
  r.setStartBefore(ea);
  const tb = firstText(eb);
  if (tb) r.setEnd(tb, Math.min(end, tb.nodeValue.length));
  else r.setEndAfter(eb);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  c.focus({ preventScroll: true });
  s.removeAllRanges();
  s.addRange(r);
}, { selA, a, selB, b, end });
const click = (name) => page.click('.nfs-fmt [data-fmt="' + name + '"]');
const pick = (value) => page.selectOption('.nfs-fmt-block', value);
// 节点正文回到基准（走真实写回链路），再重开编辑
const resetToBase = async () => {
  if (!(await page.evaluate(() => !!document.querySelector('.graph-node-fs-content')))) {
    await page.evaluate(() => { openNodeFullscreen('n1'); });
    await page.waitForSelector('.graph-node-fs-content', { timeout: 15000 });
  }
  await page.evaluate(({ html, ATOMS }) => {
    if (!document.querySelector('.graph-node-fs-content[contenteditable="true"]')) openNodeFsEdit('n1');
    const c = document.querySelector('.graph-node-fs-content');
    c.innerHTML = html;
    c.querySelectorAll(ATOMS).forEach((n) => n.setAttribute('contenteditable', 'false'));
    saveNodeFsEdit();
  }, { html: BASE_HTML, ATOMS });
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  await openEdit();
};
// 每个场景：回基准→落光标→操作→查 md 与自检→保存→查写回→重开→查往返
const scenario = async (name, pos, act, expected, extra) => step(name, async () => {
  await resetToBase();
  if (pos) await pos();
  if (extra && extra.pre) await extra.pre();
  if (typeof act === 'string') { if (act.startsWith('block:')) await pick(act.slice(6)); else await click(act); }
  else if (act) await act();
  const f = await F();
  if (extra && extra.post) await extra.post(f);
  const g = await F();
  const want = typeof expected === 'function' ? expected(BASE_MD) : expected;
  if (want !== null) must(g.md === want, '拼回的 md 不对', { got: g.md, want });
  must(g.mis === false, '保存自检没过（mis）', { html: g.html.slice(0, 600), md: g.md });
  if (!(extra && extra.noSave)) {
    await page.click('.graph-node-fs-head-actions button:has-text("保存")');
    await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
    const saved = await page.evaluate(() => _findGraphNode('n1').content);
    must(saved === (want !== null ? want : g.md), '写回节点的正文不对', { saved });
    await openEdit();
    const again = await page.evaluate(() => _nodeFsSerializeContent(document.querySelector('.graph-node-fs-content')));
    must(again === saved, '重开后拼回的 md 与存的不一致（往返不稳）', { again, saved });
  }
});

await step('工具条挂上：14 枚按钮＋段落类型下拉＋链接/公式两行（都收着）＋符号面板', async () => {
  const info = await page.evaluate(() => ({
    fmts: Array.from(document.querySelectorAll('.nfs-fmt [data-fmt]')).map((b) => b.getAttribute('data-fmt')),
    opts: Array.from(document.querySelectorAll('.nfs-fmt-block option')).map((o) => o.value),
    linkHidden: document.querySelector('.nfs-fmt-link').hidden,
    texHidden: document.querySelector('.nfs-fmt-tex').hidden,
    syms: document.querySelectorAll('.nfs-fmt-tex-sym').length,
    pos: getComputedStyle(document.querySelector('.nfs-fmt')).position,
  }));
  must(info.fmts.join(',') === 'bold,italic,strike,code,link,quote,hr,table,formula,tbl-row-add,tbl-col-add,tbl-row-del,tbl-col-del,lang-ok,link-ok,link-no,tex-ok,tex-no', '按钮名单不对', info.fmts);
  must(info.opts.join(',') === ',p,h1,h2,h3,h4,h5,h6,ul,ol,task,code', '下拉选项不对', info.opts);
  must(info.linkHidden === true, '链接输入行默认应收着');
  must(info.texHidden === true, '公式编辑行默认应收着');
  must(info.syms >= 50, '符号面板应挂上常用符号', info.syms);
  must(info.pos === 'sticky', '工具条应吸顶', info.pos);
  const f = await F();
  must(f.md === BASE_MD, '基准正文拼回应与原文一致', f.md);
  must(f.block === '', '刚进编辑下拉显示「段落类型」', f.block);
});

await scenario('加粗→斜体→删除线叠三层，再点一次加粗拆掉', () => caret('p', 0, 5, 8), null, (b) => withWord(b, '甲乙丙丁', '*~~甲乙丙~~*丁'), {
  pre: async () => { await click('bold'); await click('italic'); await click('strike'); },
  post: async (f) => {
    must(f.pressed.bold && f.pressed.italic && f.pressed.strike && !f.pressed.code && !f.pressed.link, '三枚按下态不对', f.pressed);
    must(f.sel === '9-12', '选区应原样留住', f.sel);
    await click('bold');
  },
});
await scenario('标题里点加粗：拒绝并说明，正文不动、不算改动', () => caret('h2', 0, 0, 2), 'bold', (b) => b, {
  post: async () => must((await toastTextOf(page)) === '标题本来就是粗体', '提示语不对：' + await toastTextOf(page)),
});
await step('拒绝操作后 dirty 仍为 false', async () => {
  const f = await F();
  must(f.dirty === false, '拒绝的操作不该标脏', f.dirty);
});
await scenario('行内代码：包上', () => caret('p', 0, 10, 13), 'code', (b) => withWord(b, '第二句', '`第二句`'), {
  post: async (f) => must(f.pressed.code === true && f.sel === '14-17', '代码钮应按下、选区留住', { pressed: f.pressed, sel: f.sel }),
});
await scenario('行内代码：再点一次拆掉，正文还原', () => caret('p', 0, 10, 13), 'code', (b) => b, {
  pre: async () => { await click('code'); },
  post: async (f) => must(f.pressed.code === false, '代码钮应弹起', f.pressed),
});
await scenario('新建链接：没写协议自动补 https://，括号转义', () => caret('p', 2, 0, 4), null, (b) => withWord(b, '末尾段落，', '[末尾段落](https://example.com/a%28b%29)，'), {
  pre: async () => {
    await click('link');
    await page.waitForSelector('.nfs-fmt-link:not([hidden])', { timeout: 3000 });
    await page.fill('.nfs-fmt-url', 'example.com/a(b)');
    await page.keyboard.press('Enter');
  },
  post: async (f) => must(f.pressed.link === true, '链接钮应按下', f.pressed),
});
await scenario('改已有链接地址：光标点进链接→预填→改掉', () => caret('a', 0, 1), null, (b) => withWord(b, '(https://example.com)', '(https://example.org)'), {
  pre: async () => {
    await click('link');
    await page.waitForSelector('.nfs-fmt-link:not([hidden])', { timeout: 3000 });
    const pre = await page.inputValue('.nfs-fmt-url');
    must(pre === 'https://example.com', '应预填原地址', pre);
    await page.fill('.nfs-fmt-url', 'example.org');
    await click('link-ok');
  },
});
await scenario('去掉链接：地址清空＝只留文字', () => caret('a', 0, 1), null, (b) => withWord(b, '[链接](https://example.com)', '链接'), {
  pre: async () => {
    await click('link');
    await page.waitForSelector('.nfs-fmt-link:not([hidden])', { timeout: 3000 });
    await page.fill('.nfs-fmt-url', '');
    await click('link-ok');
  },
});
await scenario('Esc 先收链接输入行，编辑态不动', () => caret('p', 0, 0, 2), null, (b) => b, {
  pre: async () => {
    await click('link');
    await page.waitForSelector('.nfs-fmt-link:not([hidden])', { timeout: 3000 });
    await page.keyboard.press('Escape');
  },
  post: async () => {
    const st = await page.evaluate(() => ({ hidden: document.querySelector('.nfs-fmt-link').hidden, editing: !!document.querySelector('.graph-node-fs-content[contenteditable="true"]') }));
    must(st.hidden && st.editing, 'Esc 应只收输入行', st);
  },
});
await scenario('正文→标题 3（原生 formatBlock）', () => caret('p', 0, 4), 'block:h3', (b) => withWord(b, '\n第一段文字', '\n### 第一段文字'), {
  post: async (f) => must(f.block === 'h3', '下拉应显示 h3', f.block),
});
await scenario('标题 2→正文', () => caret('h2', 0, 2), 'block:p', (b) => withWord(b, '## 二级标题', '二级标题'));
await scenario('标题 2→无序列表：后面紧挨着无序列表→并进去（渲染器本来就会并）', () => caret('h2', 0, 2), 'block:ul',
  (b) => withWord(b, '## 二级标题\n\n- 列表项一', '- 二级标题\n- 列表项一'));
await scenario('标题 2→标题 4', () => caret('h2', 0, 2), 'block:h4', (b) => withWord(b, '## 二级标题', '#### 二级标题'));
await scenario('跨块选区（标题＋列表项）→标题 3：原生的走原生，列表项手改拆出', () => span('h2', 0, 'li', 0, 2), 'block:h3',
  (b) => withWord(withWord(b, '## 二级标题', '### 二级标题'), '- 列表项一\n- 列表项二', '### 列表项一\n\n- 列表项二'));
await scenario('正文→无序列表', () => caret('p', 0, 4), 'block:ul', (b) => withWord(b, '\n第一段文字', '\n- 第一段文字'));
await scenario('两段先后转列表：第二张并进第一张（不产生相邻同类列表）', () => caret('p', 0, 4), 'block:ul',
  (b) => withWord(withWord(b, '\n第一段文字', '\n- 第一段文字'), '## 二级标题\n\n- 列表项一', '- 二级标题\n- 列表项一').replace('在这里。\n\n- 二级标题', '在这里。\n- 二级标题'), {
    post: async () => { await caret('h2', 0, 2); await pick('ul'); },
  });
await scenario('有序列表中间一项→正文：前截留、后截续编号', () => caret('ol li', 1, 2), 'block:p', (b) => withWord(b, '1. 有序一\n2. 有序二\n3. 有序三', '1. 有序一\n\n有序二\n\n3. 有序三'));
await scenario('无序列表→待办列表（整表加勾选框）', () => caret('ul li', 0, 2), 'block:task', (b) => withWord(b, '- 列表项一\n- 列表项二\n- 列表项三', '- [ ] 列表项一\n- [ ] 列表项二\n- [ ] 列表项三'));
await scenario('待办列表→有序列表：紧挨着上一张有序列表→并成一张、编号续下去', () => caret('ul li', 3, 1), 'block:ol',
  (b) => withWord(b, '3. 有序三\n\n- [ ] 待办甲\n- [x] 待办乙', '3. 有序三\n4. 待办甲\n5. 待办乙'));
await scenario('待办项→正文：勾选框不带走', () => caret('ul li', 3, 1), 'block:p', (b) => withWord(b, '- [ ] 待办甲\n- [x] 待办乙', '待办甲\n\n- [x] 待办乙'));
await scenario('带子列表的项→正文：子列表升上来、与后半截并成一张', () => caret('ul li', 5, 2), 'block:p',
  (b) => withWord(b, '- 外层一\n  - 内层一\n  - 内层二\n- 外层二', '外层一\n\n- 内层一\n- 内层二\n- 外层二'));
await scenario('引用：包进去', () => caret('p', 0, 2), 'quote', (b) => withWord(b, '\n第一段文字', '\n> 第一段文字'), {
  post: async (f) => must(f.pressed.quote === true, '引用钮应按下', f.pressed),
});
await scenario('引用：再点一次拆出来', () => caret('blockquote p', 0, 2), 'quote', (b) => withWord(b, '> 引用一句', '引用一句'), {
  pre: async () => { await page.waitForTimeout(150); must((await F()).pressed.quote === true, '引用里应按下'); },
  post: async (f) => must(f.pressed.quote === false, '引用钮应弹起', f.pressed),
});
await scenario('引用：整张列表一起包进去', () => caret('ul li', 1, 2), 'quote', (b) => withWord(b, '- 列表项一\n- 列表项二\n- 列表项三', '> - 列表项一\n> - 列表项二\n> - 列表项三'));
await scenario('正文→代码块，光标落到下一块', () => caret('p', 0, 4), 'block:code', (b) => withWord(b, '第一段文字甲乙丙丁。第二句在这里。', '```\n第一段文字甲乙丙丁。第二句在这里。\n```'));
await scenario('点代码块＝整块选中，下拉显示「代码块」', null, null, null, {
  pre: async () => {
    await page.locator('.graph-node-fs-content pre').first().scrollIntoViewIfNeeded();
    const box = await page.locator('.graph-node-fs-content pre').first().boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
  },
  post: async (f) => must(f.block === 'code' && f.pressed.quote === false, '下拉应显示代码块', f.block),
  noSave: true,
});
await step('代码块→列表：点选整块再换，与后面的嵌套列表并成一张', async () => {
  await resetToBase();
  await page.locator('.graph-node-fs-content pre').first().scrollIntoViewIfNeeded();
  const box = await page.locator('.graph-node-fs-content pre').first().boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await pick('ul');
  const f = await F();
  must(f.md === withWord(BASE_MD, '```python\nprint(1)\n```', '- print(1)').replace('- print(1)\n\n- 外层一', '- print(1)\n- 外层一'), '代码块应变成列表项并与后面并表', JSON.stringify(f.md));
  must(f.mis === false, '自检应过');
});
await scenario('列表项→代码块：从列表里拆出来', () => caret('ul li', 1, 2), 'block:code',
  (b) => withWord(b, '- 列表项一\n- 列表项二\n- 列表项三', '- 列表项一\n\n```\n列表项二\n```\n\n- 列表项三'));
await scenario('含公式的段落→代码块：拒绝并说明', () => caret('p', 2, 0), 'block:code', (b) => b, {
  post: async () => must((await toastTextOf(page)).includes('纯文字'), '提示语不对：' + await toastTextOf(page)),
});
await scenario('段末插分隔线（原生）：光标落进线后空段，接着打字', () => caret('p', 0, 17), null, (b) => withWord(b, '第一段文字甲乙丙丁。第二句在这里。', '第一段文字甲乙丙丁。第二句在这里。\n\n---\n\n新段'), {
  pre: async () => { await click('hr'); await page.keyboard.type('新段'); },
});
await scenario('段中插分隔线：段落从光标处分开', () => caret('p', 0, 5), 'hr', (b) => withWord(b, '第一段文字甲乙丙丁', '第一段文字\n\n---\n\n甲乙丙丁'));
await scenario('标题末插分隔线', () => caret('h2', 0, 4), 'hr', (b) => withWord(b, '## 二级标题', '## 二级标题\n\n---'));
await scenario('列表项里插分隔线：落在整张列表后面', () => caret('ul li', 1, 4), 'hr', (b) => withWord(b, '- 列表项三', '- 列表项三\n\n---'));
await scenario('全文最后一段末插分隔线（原生会落错位置→回滚改手插）', () => caret('p', 2, 99), 'hr', (b) => b + '\n\n---');
await scenario('标题后插表格：空格子直接打字、Tab 换格', () => caret('h2', 0, 4), null,
  (b) => withWord(b, '## 二级标题', '## 二级标题\n\n| 表头 | 乙 |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'), {
    pre: async () => {
      await click('table');
      await page.keyboard.type('表头');
      await page.keyboard.press('Tab');
      await page.keyboard.type('乙');
    },
  });
await scenario('列表项里插表格：落在整张列表后面', () => caret('ul li', 1, 2), 'table', (b) => withWord(b, '- 列表项三', '- 列表项三\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'));
await scenario('表格里不换段落类型：拒绝并说明', () => caret('td', 0, 0), 'block:h2', (b) => b, {
  post: async () => must((await toastTextOf(page)).includes('表格'), '提示语不对：' + await toastTextOf(page)),
});
await step('表格里 Tab／Shift+Tab 换格', async () => {
  await resetToBase();
  await caret('td', 0, 0);
  const md0 = (await F()).md;
  must((await caretCtx()) === JSON.stringify('n|1'), '落点应在第 3 格（"1"前）', (await caretCtx()) + ' md=' + md0.slice(0, 120).replace(/\n/g, '⏎'));
  await page.keyboard.press('Tab');
  must((await caretCtx()) === JSON.stringify('n|2'), 'Tab 后光标应落到第 4 格（"2"前）', await caretCtx());
  await page.keyboard.press('Shift+Tab');
  must((await caretCtx()) === JSON.stringify('n|1'), 'Shift+Tab 后光标应回到第 3 格（"1"前）', await caretCtx());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  must((await caretCtx()) === JSON.stringify('n|2'), '最后一格再按 Tab：焦点不跳出正文', await caretCtx());
});
await step('选完字先点了别处（焦点离开正文）再点加粗：仍加在刚才选的字上', async () => {
  await resetToBase();
  await caret('p', 0, 0, 4);
  await page.click('.graph-node-fs-edit-hint');
  await click('bold');
  const f = await F();
  must(f.md === withWord(BASE_MD, '第一段文字', '**第一段文**字'), '应加粗刚才的选区', f.md.slice(0, 60));
});
await scenario('段中回车＋打字后能存（老 bug：块间没空白被拦）', () => caret('p', 0, 4), null, (b) => withWord(b, '第一段文字甲乙丙丁', '第一段文\n\n新段字甲乙丙丁'), {
  pre: async () => { await page.keyboard.press('Enter'); await page.keyboard.type('新段'); },
});
await scenario('标题末回车＋打字后能存', () => caret('h2', 0, 4), null, (b) => withWord(b, '## 二级标题', '## 二级标题\n\n标题后'), {
  pre: async () => { await page.keyboard.press('Enter'); await page.keyboard.type('标题后'); },
});
await scenario('列表项末回车＋打字后能存', () => caret('ul li', 2, 4), null, (b) => withWord(b, '- 列表项三', '- 列表项三\n- 新项'), {
  pre: async () => { await page.keyboard.press('Enter'); await page.keyboard.type('新项'); },
});
await step('没手改之前：Ctrl+Z 是浏览器原生撤销（打字能撤）', async () => {
  await resetToBase();
  await caret('p', 0, 4);
  await page.keyboard.type('插');
  await page.keyboard.press('Control+z');
  const f = await F();
  must(f.md === BASE_MD, '原生撤销应把打的字撤掉', f.md.slice(0, 60));
});
await step('没手改之前：加粗后 Ctrl+Z 撤得掉', async () => {
  await resetToBase();
  await caret('p', 0, 0, 4);
  await click('bold');
  await page.keyboard.press('Control+z');
  const f = await F();
  must(f.md === BASE_MD, '原生撤销应把加粗撤掉', f.md.slice(0, 60));
});
await step('手改之后接管撤销：打字→Ctrl+Z 撤打字→再 Ctrl+Z 退回工具条那一步→重做回来', async () => {
  await resetToBase();
  await caret('p', 0, 16);
  await pick('ul');
  let f = await F();
  must(f.md === withWord(BASE_MD, '\n第一段文字', '\n- 第一段文字'), '应先变成列表', f.md.slice(0, 60));
  await page.keyboard.type('尾');
  f = await F();
  must(f.md.includes('在这里尾。'), '应在列表项里接着打字', f.md.slice(0, 60));
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+z');
  f = await F();
  must(f.md.includes('在这里。') && !f.md.includes('在这里尾'), '第一次 Ctrl+Z 应只撤打字', f.md);
  must(f.md.includes('- 第一段文字'), '列表应还在', f.md.slice(0, 60));
  await page.keyboard.press('Control+z');
  f = await F();
  must(f.md === BASE_MD, '第二次 Ctrl+Z 应退回工具条那一步', f.md);
  await page.keyboard.press('Control+Shift+z');
  f = await F();
  must(f.md.includes('- 第一段文字'), '重做应把列表做回来', f.md.slice(0, 60));
  must(f.mis === false, '自检应过');
});
await step('取消：放弃工具条的全部改动', async () => {
  await page.click('.graph-node-fs-head-actions button:has-text("取消")');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  const st = await page.evaluate(() => ({
    content: _findGraphNode('n1').content,
    bar: !!document.querySelector('.nfs-fmt'),
    editing: document.querySelector('.graph-node-fs-content').getAttribute('contenteditable'),
  }));
  must(st.content === BASE_MD, '取消后正文应回基准', st.content.slice(0, 60));
  must(!st.bar && st.editing === null, '退出编辑应摘掉工具条与编辑标记', st);
});

// ---------- 公式可改可插＋符号面板（591②）----------
// 双击用 evaluate 直接派发（真机 dblclick 命中测试被 <p>/滚动稳定性拖死），事件照走
// kit 挂在容器上的真监听器
const texOpen = async () => page.waitForSelector('.nfs-fmt-tex:not([hidden])', { timeout: 3000 });
const dblKatex = () => page.evaluate(() => {
  const k = document.querySelector('.graph-node-fs-content .katex');
  if (!k) throw new Error('找不到公式');
  k.scrollIntoView({ block: 'center' });
  k.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
});
const symClick = (tex) => page.evaluate((t) => {
  const b = Array.from(document.querySelectorAll('.nfs-fmt-tex-sym')).find((x) => x.getAttribute('data-sym') === t);
  if (!b) throw new Error('找不到符号钮：' + t);
  b.click();
}, tex);

await scenario('双击公式＝改 TeX：预填原式、改完落回原位', () => dblKatex(), null,
  (b) => withWord(b, '$E=mc^2$', '$E=mc^3$'), {
    pre: async () => {
      await texOpen();
      const pre = await page.inputValue('.nfs-fmt-tex-in');
      must(pre === 'E=mc^2', '应预填原 TeX', pre);
      await page.fill('.nfs-fmt-tex-in', 'E=mc^3');
      await click('tex-ok');
    },
    post: async (f) => must(f.md.includes('$E=mc^3$'), 'md 应含新公式', f.md.slice(-80)),
  });
// 光标 offset 4＝「第一段文|字」之间（第一段文字共 5 字）。scenario 钩子顺序是
// pos→pre→act：开公式行的点击在 act 里做完一整串，「等行开」不能放 pre（会死等）
await scenario('插入行内公式：落在光标处', () => caret('p', 0, 4), async () => {
  await click('formula');
  await texOpen();
  await page.fill('.nfs-fmt-tex-in', 'v=v_0+at');
  await click('tex-ok');
}, (b) => withWord(b, '第一段文', '第一段文$v=v_0+at$'));
await scenario('插入独立公式：档位切「独立」，存 $$ 定界', () => caret('p', 0, 4), async () => {
  await click('formula');
  await texOpen();
  await page.selectOption('.nfs-fmt-tex-mode', 'display');
  await page.fill('.nfs-fmt-tex-in', 'F=ma');
  await click('tex-ok');
}, (b) => b.replace('第一段文', () => '第一段文$$F=ma$$')); // $$ 在替换串里是特殊记号，走函数形态
await scenario('符号面板：点 α 插 \\alpha 进 TeX，确定成公式', () => caret('p', 0, 4), async () => {
  await click('formula');
  await texOpen();
  await symClick('\\alpha');
  const val = await page.inputValue('.nfs-fmt-tex-in');
  must(val === '\\alpha', '符号应插进输入框', val);
  await click('tex-ok');
}, (b) => withWord(b, '第一段文', '第一段文$\\alpha$'));
await scenario('无效 TeX：确定被拒、编辑行不收、md 不动', () => caret('p', 0, 4), async () => {
  await click('formula');
  await texOpen();
  await page.fill('.nfs-fmt-tex-in', '\\frac{');
  await click('tex-ok');
}, (b) => b, {
  post: async (f) => {
    must((await toastTextOf(page)) === 'TeX 写错了，改一改再确定', '提示语不对：' + await toastTextOf(page));
    must(await page.evaluate(() => document.querySelector('.nfs-fmt-tex').hidden === false), '编辑行应收着不动');
    must(f.md === BASE_MD, '拒绝后 md 不该动', f.md.slice(0, 60));
    await click('tex-no'); // 收行再走保存
  },
});
await scenario('清空 TeX＝删掉这条公式（与链接行同语）', () => dblKatex(), null,
  (b) => withWord(b, '末尾段落，含公式 $E=mc^2$ 与', '末尾段落，含公式  与'), {
    pre: async () => {
      await texOpen();
      await page.fill('.nfs-fmt-tex-in', '');
      await click('tex-ok');
    },
  });
await scenario('已有公式改档位：行内→独立（$ 变 $$）', () => dblKatex(), null,
  (b) => b.replace('$E=mc^2$', () => '$$E=mc^2$$'), { // $$ 在替换串里是特殊记号，走函数形态
    pre: async () => {
      await texOpen();
      must((await page.$eval('.nfs-fmt-tex-mode', (el) => el.value)) === 'inline', '应预选行内');
      await page.selectOption('.nfs-fmt-tex-mode', 'display');
      await click('tex-ok');
    },
  });
await scenario('Esc 先收公式编辑行，编辑态不动', () => caret('p', 0, 0, 2), async () => {
  await click('formula');
  await texOpen();
  await page.keyboard.press('Escape');
}, (b) => b, {
  post: async () => {
    const st = await page.evaluate(() => ({ hidden: document.querySelector('.nfs-fmt-tex').hidden, editing: !!document.querySelector('.graph-node-fs-content[contenteditable="true"]') }));
    must(st.hidden && st.editing, 'Esc 应只收公式行', st);
  },
});
await step('公式替换进撤销栈：Ctrl+Z 退回旧公式、重做回来', async () => {
  await resetToBase();
  await dblKatex();
  await texOpen();
  await page.fill('.nfs-fmt-tex-in', 'E=mc^3');
  await click('tex-ok');
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+z');
  const f = await F();
  must(f.md.includes('$E=mc^2$') && !f.md.includes('$E=mc^3$'), 'Ctrl+Z 应回旧公式', f.md.slice(-80));
  await page.keyboard.press('Control+Shift+z');
  const f2 = await F();
  must(f2.md.includes('$E=mc^3$') && f2.mis === false, '重做应回新公式且过自检', f2.md.slice(-80));
});

// ---------- ③④ 结构补全＋小修余项（2026-11-25）----------

await step('591④ 手打 # 按字面存：新段落行首打 #，保存自动转义、重开还是普通文字', async () => {
  await resetToBase();
  await caret('p', 0, 4);
  await page.keyboard.press('Enter');
  await page.keyboard.type('# 手打的标题');
  await page.waitForTimeout(400);
  // 保存：对账先不符（拼回会变标题），转义修补后放行
  await page.click('.graph-node-fs-head-actions button:has-text("保存")');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved.includes('\\# 手打的标题'), '手打的 # 应转义成普通文字', saved);
  must(!saved.includes('\n# 手打的标题'), '不该变成真标题', saved);
  await openEdit();
  const again = await page.evaluate(() => _nodeFsSerializeVerified(document.querySelector('.graph-node-fs-content')).md);
  must(again === saved, '重开（带转义修补）应与存的一致（往返稳）', { again, saved });
});

await step('591④ 手打 - 与 1. 同口径：转义存普通文字', async () => {
  await resetToBase();
  await caret('p', 0, 4);
  await page.keyboard.press('Enter');
  await page.keyboard.type('- 手打的列表');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. 手打的序号');
  await page.waitForTimeout(400);
  await page.click('.graph-node-fs-head-actions button:has-text("保存")');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved.includes('\\- 手打的列表') && saved.includes('1\\. 手打的序号'), '手打 - 与 1. 应按字面转义', saved);
  must(!saved.includes('\n- 手打的列表') && !saved.includes('\n1. 手打的序号'), '不该变成真列表/真序号', saved);
});

await step('591④ 拒存指明哪段：转不动的坏写法指段落＋闪框＋留在编辑态', async () => {
  await resetToBase();
  // 手打行内图记号（![]()）＝转义修不动的那种：拼回重渲会把这行变成真 <img>，和 DOM
  // 里的普通文字对不上账，且三种转义档都救不了（转义不删图）——如实拒存。手打 <u>
  // 这类反而没事：渲染器把裸 HTML 按字面转义，能对上账、正常存（2026-11-25 实测）
  await caret('p', 2, 0);
  await page.keyboard.type('![图](https://example.com/i.png)');
  await page.waitForTimeout(300);
  await page.click('.graph-node-fs-head-actions button:has-text("保存")');
  await page.waitForTimeout(400);
  const toast = await toastTextOf(page);
  must(toast.includes('对不上') && toast.includes('![图]('), '拒存话应带段落开头文字', toast);
  must(await page.evaluate(() => !!document.querySelector('.nfs-edit-badblock')), '对不上的段落应闪框');
  must(await page.evaluate(() => !!document.querySelector('.graph-node-fs-content[contenteditable="true"]')), '拒存后应留在编辑态');
});

await step('591④ Ctrl+S 快存：存完留在编辑态、写回节点；Esc 三选条「保存并退出」收尾', async () => {
  await resetToBase();
  await caret('p', 0, 5); // 0 基偏移：落在「第一段文字」之后
  await page.keyboard.type('快存甲');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(600);
  must(await page.evaluate(() => !!document.querySelector('.graph-node-fs-content[contenteditable="true"]')), '快存后应留在编辑态');
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved.includes('第一段文字快存甲'), '快存应写回节点', saved.slice(0, 80));
  must((await toastTextOf(page)).includes('仍在编辑'), '应说清还在编辑');
  await caret('p', 0, 99);
  await page.keyboard.type('乙');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.graph-node-fs-edit-confirm', { timeout: 3000 });
  await page.click('.graph-node-fs-edit-confirm [data-c="save"]');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  const saved2 = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved2.includes('在这里。乙'), '三选条的保存并退出应写回', saved2.slice(0, 80));
});

await step('591④ 三选条：继续编辑＝只收条；放弃修改＝还原基准', async () => {
  await resetToBase();
  await caret('p', 0, 4);
  await page.keyboard.type('不要我');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.graph-node-fs-edit-confirm', { timeout: 3000 });
  await page.click('.graph-node-fs-edit-confirm [data-c="stay"]');
  await page.waitForTimeout(200);
  must(await page.evaluate(() => !document.querySelector('.graph-node-fs-edit-confirm')), '继续编辑应收条');
  must(await page.evaluate(() => !!document.querySelector('.graph-node-fs-content[contenteditable="true"]')), '应还在编辑');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.graph-node-fs-edit-confirm', { timeout: 3000 });
  await page.click('.graph-node-fs-edit-confirm [data-c="discard"]');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  must((await page.evaluate(() => _findGraphNode('n1').content)) === BASE_MD, '放弃修改应还原基准');
});

await step('591③ 表格加减行列：光标进格子亮行，加行/加列/删列写回后重开还在', async () => {
  await resetToBase();
  await caret('td', 0, 0);
  await page.waitForTimeout(300);
  must(await page.evaluate(() => document.querySelector('.nfs-fmt-tbl').hidden === false), '光标进格子应亮出表格行');
  await click('tbl-row-add');
  let f = await F();
  must(f.md === withWord(BASE_MD, '| 1 | 2 |', '| 1 | 2 |\n|  |  |'), '加行应落在当前行下面', f.md);
  await click('tbl-row-del');
  f = await F();
  must(f.md === BASE_MD, '删掉当前行（刚加的）应回基准', f.md);
  await caret('td', 0, 0);
  await click('tbl-col-add');
  f = await F();
  must(f.md.includes('| 列A |  | 列B |') && f.md.includes('| 1 |  | 2 |'), '加列应落在当前列右边', f.md);
  await click('tbl-col-del');
  f = await F();
  must(f.md === BASE_MD, '删掉当前列（刚加的）应回基准', f.md);
  await caret('td', 0, 0);
  await click('tbl-row-add');
  await page.click('.graph-node-fs-head-actions button:has-text("保存")');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  await openEdit();
  const again = await page.evaluate(() => _nodeFsSerializeContent(document.querySelector('.graph-node-fs-content')));
  must(again.includes('| 1 | 2 |\n|  |  |'), '加的一行重开还在', again);
});

await step('591③ 代码块选语言：点代码块亮语言行（预填 python），改 js 写回；坏语言拒绝', async () => {
  await resetToBase();
  await page.click('.graph-node-fs-content pre');
  await page.waitForSelector('.nfs-fmt-lang:not([hidden])', { timeout: 3000 });
  must((await page.inputValue('.nfs-fmt-lang-in')) === 'python', '应预填当前语言');
  await page.fill('.nfs-fmt-lang-in', 'a b');
  await click('lang-ok');
  await page.waitForTimeout(200);
  must((await toastTextOf(page)).includes('语言用字母数字'), '坏语言应拒绝', await toastTextOf(page));
  await page.fill('.nfs-fmt-lang-in', 'js');
  await click('lang-ok');
  const f = await F();
  must(f.md === withWord(BASE_MD, '```python', '```js'), '语言应写进围栏', f.md);
  await page.click('.graph-node-fs-head-actions button:has-text("保存")');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  await openEdit();
  const again = await page.evaluate(() => _nodeFsSerializeContent(document.querySelector('.graph-node-fs-content')));
  must(again === withWord(BASE_MD, '```python', '```js'), '重开语言还在', again);
  await page.click('.graph-node-fs-content pre');
  await page.waitForSelector('.nfs-fmt-lang:not([hidden])', { timeout: 3000 });
  must((await page.inputValue('.nfs-fmt-lang-in')) === 'js', '重开后语言行应显示 js');
});

await step('591③ 粘贴保格式：标题/粗体/列表/表格转进来，外链图收、截图内嵌不收', async () => {
  await resetToBase();
  await caret('p', 2, 0);
  await page.evaluate(() => {
    const c = document.querySelector('.graph-node-fs-content');
    const dt = new DataTransfer();
    dt.setData('text/html', '<h3>贴的标题</h3><p>有<b>粗体</b>和'
      + '<img src="https://example.com/x.png" alt="图"><img src="data:image/png;base64,AAAA"></p>'
      + '<ul><li>贴项一</li></ul><table><tr><td>甲</td><td>乙</td></tr><tr><td>1</td><td>2</td></tr></table>');
    dt.setData('text/plain', '纯文本不该走这条');
    c.focus();
    c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(400);
  const f = await F();
  const tail = '末尾段落，含公式 $E=mc^2$ 与 **加粗** 与 [链接](https://example.com)。';
  const want = BASE_MD.replace(tail, '### 贴的标题\n\n有**粗体**和![图](https://example.com/x.png)\n\n- 贴项一\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n' + tail);
  must(f.md === want, '粘贴应按白名单转成结构', { got: f.md, want });
  must(!f.md.includes('data:image'), '截图内嵌图不收（拍板口径）', f.md);
  must(f.mis === false, '粘贴产物应过自检');
  await page.click('.graph-node-fs-head-actions button:has-text("保存")');
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved === want, '粘贴后写回一致', saved.slice(-160));
});

// ============================================================
// ② 新窗口预览页（哑编辑面：同一份 kit 嵌在内嵌脚本里）
// ============================================================
console.log('② 新窗口预览页');
// 预览窗的内容交接是一次性的（外壳读完 sessionStorage 就删），重开＝关旧窗开新窗
let win = null;
let frame = null;
const pOpen = async () => {
  if (win && !win.isClosed()) { try { await win.close(); } catch (e) { /* 已关 */ } }
  const popupPromise = ctx.waitForEvent('page', { timeout: 15000 });
  await page.evaluate(() => { closeNodeFullscreen(); openNodeNewWindow('n1'); });
  const w = await popupPromise;
  w.on('pageerror', (e) => pageErrors.push('preview: ' + String(e && e.message || e)));
  let f = null;
  for (let i = 0; i < 80 && !f; i++) {
    await w.waitForTimeout(250);
    for (const fr of w.frames()) {
      if (fr === w.mainFrame()) continue;
      try { if (await fr.evaluate(() => !!document.querySelector('.cp-body'))) { f = fr; break; } } catch (e) { /* 还没加载好 */ }
    }
  }
  must(f, '预览页没载出来');
  win = w;
  frame = f;
};
const pReset = async () => {
  await page.evaluate(() => { closeNodeFullscreen(); openNodeFullscreen('n1'); });
  await page.waitForSelector('.graph-node-fs-content', { timeout: 15000 });
  await page.evaluate((html) => {
    if (!document.querySelector('.graph-node-fs-content[contenteditable="true"]')) openNodeFsEdit('n1');
    const c = document.querySelector('.graph-node-fs-content');
    c.innerHTML = html;
    c.querySelectorAll('.katex, .katex-display, .mermaid-container, .viz-card, pre, img, input').forEach((n) => n.setAttribute('contenteditable', 'false'));
    saveNodeFsEdit();
  }, BASE_HTML);
  await page.waitForFunction(() => !document.querySelector('.graph-node-fs-content[contenteditable="true"]'), null, { timeout: 5000 });
  await pOpen();
};
await pReset(); // 先把节点摁回基准——上一段 591③④ 全屏用例可能已把节点内容改掉并保存（2026-11-25 实踩：铅笔步对着粘贴版内容对基准断言）
const PF = () => facts(win, '.cp-body', '.nfs-fmt').catch((e) => ({ err: String(e) }));
const pClick = (name) => frame.click('.nfs-fmt [data-fmt="' + name + '"]');
const pCaret = (sel, idx, offset, endOffset) => frame.evaluate(`(${placeAt})('.cp-body', ${JSON.stringify(sel)}, ${idx}, ${offset}, ${endOffset == null ? 'null' : endOffset}, ${JSON.stringify(ATOMS)})`);
const pToast = () => frame.evaluate(() => String((document.getElementById('cp-nfs-toast') || {}).textContent || ''));
// 预览页没有序列化器：md 由主应用侧的同一套函数算（探针把 innerHTML 交给主应用页面）
const pMd = async () => {
  const html = await frame.evaluate(() => document.querySelector('.cp-body').innerHTML);
  return page.evaluate((html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    const md = _nodeFsSerializeContent(d);
    return { md, mis: _nodeFsEditMismatchBlock(md, d) != null };
  }, html);
};
const pEnter = async () => {
  await frame.evaluate(() => { if (document.getElementById('cpEdit')) document.getElementById('cpEdit').click(); });
  await win.waitForTimeout(200);
  await frame.waitForSelector('.nfs-fmt [data-fmt]', { timeout: 5000 });
};

await step('预览页：铅笔进编辑后工具条挂上（同一份 kit）', async () => {
  await frame.waitForSelector('#cpEdit', { timeout: 15000 });
  await pEnter();
  const info = await frame.evaluate(() => ({
    fmts: Array.from(document.querySelectorAll('.nfs-fmt [data-fmt]')).map((b) => b.getAttribute('data-fmt')),
    pos: getComputedStyle(document.querySelector('.nfs-fmt')).position,
    bg: getComputedStyle(document.querySelector('.nfs-fmt')).backgroundColor,
  }));
  must(info.fmts.join(',') === 'bold,italic,strike,code,link,quote,hr,table,formula,tbl-row-add,tbl-col-add,tbl-row-del,tbl-col-del,lang-ok,link-ok,link-no,tex-ok,tex-no', '按钮名单不对', info.fmts);
  must(info.pos === 'sticky' && info.bg !== 'rgba(0, 0, 0, 0)', '工具条应吸顶且有底色', info);
  const m = await pMd();
  must(m.md === BASE_MD && m.mis === false, '基准正文应能原样拼回', m.md.slice(0, 80));
});
const pScenario = async (name, pos, act, expected, extra) => step(name, async () => {
  await pReset();
  await pEnter();
  await pos();
  if (extra && extra.pre) await extra.pre();
  if (typeof act === 'string') { if (act.startsWith('block:')) await frame.selectOption('.nfs-fmt-block', act.slice(6)); else await pClick(act); }
  else await act();
  if (extra && extra.post) await extra.post();
  const m = await pMd();
  must(m.md === expected(BASE_MD), '拼回的 md 不对', { got: m.md, want: expected(BASE_MD) });
  must(m.mis === false, '保存自检没过', m.md);
  await frame.click('#cpEditSave');
  await win.waitForTimeout(600);
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved === expected(BASE_MD), '桥上写回的正文不对', saved.slice(0, 120));
  must(await frame.evaluate(() => !document.querySelector('.cp-body[contenteditable="true"]') && !document.querySelector('.nfs-fmt')), '保存后应退出编辑并摘掉工具条');
});
await step('预览页：加粗→保存→写回主应用', async () => {
  await pReset();
  await pEnter();
  await pCaret('p', 0, 0, 4);
  await pClick('bold');
  const want = withWord(BASE_MD, '第一段文', '**第一段文**');   // 选区 0..4＝「第一段文」四个字
  const m = await pMd();
  must(m.md === want, '拼回的 md 不对', { got: m.md, want });
  must(m.mis === false, '保存自检没过', m.md);
  await frame.click('#cpEditSave');
  await win.waitForTimeout(600);
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved === want, '桥上写回的正文不对', saved.slice(0, 120));
  must(await frame.evaluate(() => !document.querySelector('.cp-body[contenteditable="true"]') && !document.querySelector('.nfs-fmt')), '保存后应退出编辑并摘掉工具条');
});
await pScenario('预览页：正文→标题 3', () => pCaret('p', 0, 4), 'block:h3', (b) => withWord(b, '\n第一段文字', '\n### 第一段文字'));
await pScenario('预览页：正文→待办列表（手改）', () => pCaret('p', 0, 4), 'block:task', (b) => withWord(b, '\n第一段文字', '\n- [ ] 第一段文字'));
await pScenario('预览页：引用包进去', () => pCaret('p', 0, 2), 'quote', (b) => withWord(b, '\n第一段文字', '\n> 第一段文字'));
await pScenario('预览页：插表格', () => pCaret('h2', 0, 4), 'table', (b) => withWord(b, '## 二级标题', '## 二级标题\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'));
await step('预览页：Esc 先收链接输入行，编辑态不动', async () => {
  await pReset();
  await pEnter();
  await pCaret('p', 0, 0, 2);
  await pClick('link');
  await frame.waitForSelector('.nfs-fmt-link:not([hidden])', { timeout: 3000 });
  await win.keyboard.press('Escape');
  const st = await frame.evaluate(() => ({ hidden: document.querySelector('.nfs-fmt-link').hidden, editing: !!document.querySelector('.cp-body[contenteditable="true"]') }));
  must(st.hidden && st.editing, 'Esc 应只收输入行', st);
});
await step('预览页：取消＝放弃改动', async () => {
  await pCaret('p', 0, 0, 4);
  await pClick('bold');
  await frame.click('#cpEditCancel');
  await win.waitForTimeout(200);
  const m = await pMd();
  must(m.md === BASE_MD, '取消后应回基准', m.md.slice(0, 80));
  must(!(await frame.evaluate(() => !!document.querySelector('.nfs-fmt'))), '取消后应摘掉工具条');
});

// ---------- 预览页公式（591②）：无本地渲染器，确定走桥由主应用渲一回 ----------
const pDblKatex = () => frame.evaluate(() => {
  const k = document.querySelector('.cp-body .katex');
  if (!k) throw new Error('找不到公式');
  k.scrollIntoView({ block: 'center' });
  k.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
});
await step('预览页：双击公式改 TeX——确定走桥渲染，ack 落 DOM，保存写回', async () => {
  await pReset();
  await pEnter();
  await pDblKatex();
  await frame.waitForSelector('.nfs-fmt-tex:not([hidden])', { timeout: 3000 });
  const pre = await frame.inputValue('.nfs-fmt-tex-in');
  must(pre === 'E=mc^2', '应预填原 TeX', pre);
  must(await frame.evaluate(() => document.querySelector('.nfs-fmt-tex-pv').hidden === true), '预览区应收着（无本地渲染器）');
  await frame.fill('.nfs-fmt-tex-in', 'E=mc^3');
  await pClick('tex-ok');
  await frame.waitForFunction(() => {
    const ann = document.querySelector('.cp-body .katex annotation[encoding="application/x-tex"]');
    return !!ann && ann.textContent === 'E=mc^3';
  }, null, { timeout: 8000 });
  const m = await pMd();
  must(m.md.includes('$E=mc^3$') && m.mis === false, '桥上渲好的公式应落进正文且过自检', m.md.slice(-80));
  await frame.click('#cpEditSave');
  await win.waitForTimeout(600);
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved.includes('$E=mc^3$'), '写回主应用应带新公式', saved.slice(-80));
});
await step('预览页：坏 TeX 走桥被主应用拒，编辑行不收', async () => {
  await pReset();
  await pEnter();
  await pDblKatex();
  await frame.waitForSelector('.nfs-fmt-tex:not([hidden])', { timeout: 3000 });
  await frame.fill('.nfs-fmt-tex-in', '\\frac{');
  await pClick('tex-ok');
  await win.waitForTimeout(600);
  must((await pToast()).includes('写错'), '应收到主应用的拒绝话', await pToast());
  must(await frame.evaluate(() => document.querySelector('.nfs-fmt-tex').hidden === false), '编辑行应收着不动');
});
await step('预览页：插入公式＋符号面板——落在光标处，保存写回', async () => {
  await pReset();
  await pEnter();
  await pCaret('p', 0, 4);
  await pClick('formula');
  await frame.waitForSelector('.nfs-fmt-tex:not([hidden])', { timeout: 3000 });
  await frame.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.nfs-fmt-tex-sym')).find((x) => x.getAttribute('data-sym') === '\\alpha');
    if (!b) throw new Error('找不到 α 钮');
    b.click();
  });
  const val = await frame.inputValue('.nfs-fmt-tex-in');
  must(val === '\\alpha', '符号应插进输入框', val);
  await pClick('tex-ok');
  await frame.waitForFunction(() => {
    const p = document.querySelector('.cp-body p');
    return !!(p && p.querySelector('.katex'));
  }, null, { timeout: 8000 });
  const m = await pMd();
  must(m.md.includes('第一段文$\\alpha$字') && m.mis === false, '插入的公式应落在光标处', m.md.slice(0, 120));
  await frame.click('#cpEditSave');
  await win.waitForTimeout(600);
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved.includes('第一段文$\\alpha$字'), '写回应带插入的公式', saved.slice(0, 120));
});

// ---------- 预览页 ③④（2026-11-25）：同一份 kit／内嵌脚本的新四件 ----------
const pPasteHtml = (html) => frame.evaluate((html) => {
  const c = document.querySelector('.cp-body');
  const dt = new DataTransfer();
  dt.setData('text/html', html);
  dt.setData('text/plain', '纯文本不该走这条');
  c.focus();
  c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, html);

await step('预览页 591④：Ctrl+S 快存留编辑态，连存两次（ack.sig 刷新原文指纹）都成', async () => {
  await pReset();
  await pEnter();
  await pCaret('p', 0, 0, 4);
  await pClick('bold');
  await win.keyboard.press('Control+s');
  await win.waitForTimeout(900);
  must(await frame.evaluate(() => !!document.querySelector('.cp-body[contenteditable="true"]')), '快存后应留在编辑态');
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved.includes('**第一段文**'), '第一次快存应写回', saved.slice(0, 80));
  // 原文指纹已随 ack.sig 刷新：再改一处、再快存，不该被「开窗后有更新」的对账拒掉
  await pCaret('p', 0, 99);
  await win.keyboard.type('丙');
  await win.waitForTimeout(200);
  await win.keyboard.press('Control+s');
  await win.waitForTimeout(900);
  must(await frame.evaluate(() => !!document.querySelector('.cp-body[contenteditable="true"]')), '第二次快存也应留编辑态');
  const saved2 = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved2.includes('在这里。丙'), '第二次快存应写回（指纹已刷新）', saved2.slice(0, 160));
});

await step('预览页 591④：Esc 有改动弹三选条——继续编辑／放弃修改两路', async () => {
  await pReset();
  await pEnter();
  await pCaret('p', 0, 0, 4);
  await pClick('bold');
  await win.keyboard.press('Escape');
  await frame.waitForSelector('.cp-edit-confirm', { timeout: 3000 });
  await frame.click('.cp-edit-confirm [data-c="stay"]');
  await win.waitForTimeout(200);
  must(await frame.evaluate(() => !document.querySelector('.cp-edit-confirm') && !!document.querySelector('.cp-body[contenteditable="true"]')), '继续编辑应收条留编辑');
  await win.keyboard.press('Escape');
  await frame.waitForSelector('.cp-edit-confirm', { timeout: 3000 });
  await frame.click('.cp-edit-confirm [data-c="discard"]');
  await win.waitForTimeout(400);
  must(await frame.evaluate(() => !document.querySelector('.cp-body[contenteditable="true"]') && !document.querySelector('.nfs-fmt')), '放弃修改应退编辑');
  const m = await pMd();
  must(m.md === BASE_MD, '放弃后正文回基准', m.md.slice(0, 80));
});

await step('预览页 591③：粘贴保格式＋表格加行——桥上写回一致', async () => {
  await pReset();
  await pEnter();
  await pCaret('p', 2, 0);
  await pPasteHtml('<h2>贴标题</h2><p>有<b>粗</b><img src="https://example.com/p.png"><img src="data:image/png;base64,AA"></p><table><tr><td>一</td><td>二</td></tr></table>');
  await win.waitForTimeout(400);
  const m = await pMd();
  must(m.md.includes('## 贴标题') && m.md.includes('有**粗**![](https://example.com/p.png)'), '粘贴应转成结构', m.md.slice(-160));
  must(!m.md.includes('data:image'), '截图内嵌不收', m.md);
  must(m.mis === false, '粘贴产物应过自检');
  // 贴进来的表只有表头行（convTable 单行不造 tbody）：光标进它的 th（文档里第 3 个 th，
  // 前两个是基准表的列A/列B）——表头加行应补出表体、空行落表体开头
  await pCaret('th', 2, 0);
  await frame.waitForSelector('.nfs-fmt-tbl:not([hidden])', { timeout: 3000 });
  await pClick('tbl-row-add');
  const m2 = await pMd();
  must(m2.md.includes('| 一 | 二 |\n| --- | --- |\n|  |  |'), '预览页加行应生效', m2.md.slice(-140));
  await frame.click('#cpEditSave');
  await win.waitForTimeout(900);
  const saved = await page.evaluate(() => _findGraphNode('n1').content);
  must(saved.includes('| 一 | 二 |\n| --- | --- |\n|  |  |'), '桥上写回应带加的一行', saved.slice(-160));
});

await step('全程无页面脚本报错', async () => {
  must(pageErrors.length === 0, '页面报错：' + pageErrors.slice(0, 3).join(' | '));
});
await browser.close();
srv.stop();
console.log('\n渲染态编辑格式工具条回归：' + passed + ' ✓ / ' + failed + ' ✗');
process.exit(failed ? 1 : 0);
