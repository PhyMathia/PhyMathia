#!/usr/bin/env node
// 渲染态编辑·格式工具条（backlog 591①，2026-11-25）真机回归：两处编辑面（本页全屏层＋
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
    mis: (typeof _nodeFsEditVisibleMismatch === 'function' && c) ? _nodeFsEditVisibleMismatch(md, c) : null,
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

await step('工具条挂上：11 枚按钮＋段落类型下拉＋链接输入行（收着）', async () => {
  const info = await page.evaluate(() => ({
    fmts: Array.from(document.querySelectorAll('.nfs-fmt [data-fmt]')).map((b) => b.getAttribute('data-fmt')),
    opts: Array.from(document.querySelectorAll('.nfs-fmt-block option')).map((o) => o.value),
    linkHidden: document.querySelector('.nfs-fmt-link').hidden,
    pos: getComputedStyle(document.querySelector('.nfs-fmt')).position,
  }));
  must(info.fmts.join(',') === 'bold,italic,strike,code,link,quote,hr,table,link-ok,link-no', '按钮名单不对', info.fmts);
  must(info.opts.join(',') === ',p,h1,h2,h3,h4,h5,h6,ul,ol,task,code', '下拉选项不对', info.opts);
  must(info.linkHidden === true, '链接输入行默认应收着');
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
await pOpen();
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
    return { md, mis: _nodeFsEditVisibleMismatch(md, d) };
  }, html);
};
const pEnter = async () => {
  await frame.evaluate(() => { if (document.getElementById('cpEdit')) document.getElementById('cpEdit').click(); });
  await win.waitForTimeout(200);
  await frame.waitForSelector('.nfs-fmt [data-fmt]', { timeout: 5000 });
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

await step('预览页：铅笔进编辑后工具条挂上（同一份 kit）', async () => {
  await frame.waitForSelector('#cpEdit', { timeout: 15000 });
  await pEnter();
  const info = await frame.evaluate(() => ({
    fmts: Array.from(document.querySelectorAll('.nfs-fmt [data-fmt]')).map((b) => b.getAttribute('data-fmt')),
    pos: getComputedStyle(document.querySelector('.nfs-fmt')).position,
    bg: getComputedStyle(document.querySelector('.nfs-fmt')).backgroundColor,
  }));
  must(info.fmts.join(',') === 'bold,italic,strike,code,link,quote,hr,table,link-ok,link-no', '按钮名单不对', info.fmts);
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

await step('全程无页面脚本报错', async () => {
  must(pageErrors.length === 0, '页面报错：' + pageErrors.slice(0, 3).join(' | '));
});
await browser.close();
srv.stop();
console.log('\n渲染态编辑格式工具条回归：' + passed + ' ✓ / ' + failed + ' ✗');
process.exit(failed ? 1 : 0);
