// 学习笔记导出纯函数
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 8041–8140 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 学习笔记导出（2026-10-06）：纯函数用例，全程同步、不碰共享 localStorage 键，
// 追加在串行边界之后安全。正文函数在 app.js 顶层（function 声明＝沙箱全局属性），
// 直接经 sandbox.* 调用（与上面 sandbox.openQuiz 同款）。
check('note-export：noteMarkdown 结构（头部两行/概念节/$$ 块/剥定界符/条目内去重/标题 # 剥离）', () => {
  const md = sandbox.noteMarkdown([
    { title: '## 伪装成标题的定律', summary: '第一行\n第二行', formulas: ['$E=mc^2$', 'E=mc^2', '$$', ''] },
    { title: '弹簧振子', summary: '', formulas: ['$T=2\\pi\\sqrt{m/k}$'] },
  ], '简谐运动', '2026-10-06', '2026-10-06 14:30');
  if (!md.startsWith('# PhyMathia 学习笔记 · 简谐运动\n> 2026-10-06 14:30 生成 · 共 2 个概念\n')) {
    throw new Error('头部两行不符：' + JSON.stringify(md.slice(0, 80)));
  }
  if (!/^## 伪装成标题的定律$/m.test(md)) throw new Error('概念节标题未生成');
  if (md.includes('### ')) throw new Error('标题开头的 # 未剥净，会冒充 md 层级');
  if (md.split('$$\nE=mc^2\n$$').length - 1 !== 1) throw new Error('同公式（带/不带定界符）应条目内去重为一个 $$ 块');
  if (!md.includes('$$\nT=2\\pi\\sqrt{m/k}\n$$')) throw new Error('公式未按 $$ 块输出或未剥 $ 定界符');
  if (!md.includes('第一行') || !md.includes('第二行')) throw new Error('摘要缺失');
  return true;
});

check('note-export：noteHtmlDocument 单文件契约（DOCTYPE/转义/无外部 url/无 KaTeX 降级/内联样式/打印样式）', () => {
  // utils 的 escapeHtml 走 DOM，沙箱 loose document 下产物退化为代理，没法据此
  // 断言转义契约。本用例临时装一份与 utils 等价的转义（& < > " '，顺序一致），
  // 测完恢复原状，不依赖、也不改变全局环境。
  const prevEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  try {
    const html = sandbox.noteHtmlDocument(
      [{ title: '能量守恒', summary: '摘要带 <标签> 与 & 符号\n第二段', formulas: ['$E=mc^2$', '$x<y$'] }],
      '波&粒', '2026-10-06', '2026-10-06 09:05',
      '@font-face{src:url(data:font/woff2;base64,QUJD) format("woff2")}'
    );
    if (!html.startsWith('<!DOCTYPE html>')) throw new Error('缺 DOCTYPE');
    if (!html.includes('<html lang="zh-CN">')) throw new Error('缺 lang 声明');
    if (!html.includes('<meta charset="utf-8">')) throw new Error('缺 charset meta');
    if (!html.includes('<title>PhyMathia 学习笔记 · 波&amp;粒</title>')) throw new Error('title 缺失或会话名未转义');
    if (!html.includes('data:font/woff2;base64,QUJD')) throw new Error('传入的 katexCss 未进 <style>');
    if (/https?:\/\//.test(html)) throw new Error('文档含外部 http(s) url，破坏单文件契约');
    for (const m of html.matchAll(/url\(([^)]{0,32})/g)) {
      if (!m[1].startsWith('data:')) throw new Error('出现非 data: 的 url(' + m[1] + '...)');
    }
    // 沙箱无 katex：应走 <code class="note-tex"> 降级，且 latex 已转义、已剥定界符
    if (!html.includes('<code class="note-tex">x&lt;y</code>')) throw new Error('无 KaTeX 环境未降级为转义 code');
    if (html.includes('$x<y$')) throw new Error('降级输出未剥 $ 定界符');
    if (!html.includes('<code class="note-tex">E=mc^2</code>')) throw new Error('正常公式未渲染成降级 code');
    if (html.split('class="note-formula"').length - 1 !== 2) throw new Error('公式块数量不对');
    if (!html.includes('<p>摘要带 &lt;标签&gt; 与 &amp; 符号</p><p>第二段</p>')) throw new Error('摘要未按行切 <p> 或未转义');
    if (!html.includes('2026-10-06 09:05 生成 · 共 1 个概念')) throw new Error('元信息行缺失');
    if (!html.includes('@media print') || !html.includes('break-inside: avoid')) throw new Error('打印样式缺失');
    if (!html.includes('由 PhyMathia 导出 · 2026-10-06')) throw new Error('页脚生成信息缺失');
    return true;
  } finally {
    sandbox.escapeHtml = prevEsc;
  }
});

check('note-export：noteFileName 非法字符清洗与空会话名回退', () => {
  const names = [
    sandbox.noteFileName('简谐:运动?', '2026-10-06', 'md'),
    sandbox.noteFileName('  ', '2026-10-06', 'html'),
    sandbox.noteFileName(null, '2026-10-06', 'md'),
    sandbox.noteFileName('a\\b/c*d|e"f<g>h', '2026-10-06', 'html'),
  ];
  if (names[0] !== 'PhyMathia笔记-简谐_运动_-2026-10-06.md') throw new Error('非法字符未清洗：' + names[0]);
  if (names[1] !== 'PhyMathia笔记-2026-10-06.html') throw new Error('空白会话名应整段省略：' + names[1]);
  if (names[2] !== 'PhyMathia笔记-2026-10-06.md') throw new Error('null 会话名应整段省略：' + names[2]);
  if (names[3] !== 'PhyMathia笔记-a_b_c_d_e_f_g_h-2026-10-06.html') throw new Error('Windows 保留字符未全清洗：' + names[3]);
  return true;
});

check('note-export：filterSessionKnowledgeItems 口径（sessionIds 数组/legacy 单值/他会话排除/空壳跳过/createdAt 升序）', () => {
  const map = {
    a: { id: 'a', title: 'A', summary: 'sa', createdAt: 200, sessionIds: ['s0', 's1'] },
    b: { id: 'b', title: 'B', summary: '', formulas: [], sessionId: 's1' },          // 空壳：跳过
    c: { id: 'c', title: 'C', summary: 'sc', createdAt: 100, sessionId: 's1' },      // legacy 命中
    d: { id: 'd', title: 'D', summary: 'sd', createdAt: 50, sessionIds: ['s9'] },    // 他会话
    e: { id: 'e', title: 'E', summary: '', formulas: ['$f$'], createdAt: 300, sessionId: 's1' }, // 只剩公式也算
    f: { id: 'f', title: 'F', summary: 'sf', sessionId: 's1' },                      // 缺 createdAt 当 0 最先
  };
  const ids = sandbox.filterSessionKnowledgeItems(map, 's1').map((i) => i.id).join(',');
  if (ids !== 'f,c,a,e') throw new Error('过滤/排序结果不符：' + ids + '（应为 f,c,a,e）');
  if (sandbox.filterSessionKnowledgeItems(map, 's-none').length !== 0) throw new Error('无关会话应返回空');
  if (sandbox.filterSessionKnowledgeItems(null, 's1').length !== 0) throw new Error('空 map 应返回空');
  return true;
});

check('note-export：接线（知识菜单两入口 + 构建条目注册紧跟 knowledge.js）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const menu = html.slice(html.indexOf('id="knowledgeMenu"'), html.indexOf('id="moreMenu"'));
  if (!menu.includes("window.exportSessionNote('html')")) throw new Error('知识菜单缺「导出笔记 · HTML」入口');
  if (!menu.includes("window.exportSessionNote('md')")) throw new Error('知识菜单缺「导出笔记 · Markdown」入口');
  const build = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  const k = build.indexOf("'knowledge.js'");
  const n = build.indexOf("'note-export.js'");
  if (k < 0 || n < 0 || n < k) throw new Error('build 条目缺 note-export.js 或注册顺序不对');
  return true;
});

// ===== 会话历史导出（2026-11-24，backlog 575）：纯函数用例，全程同步、不碰共享 localStorage 键。
// 夹具与 tests/test_history_archive.py 是同一组——前端导出与服务端归档（storage.py）的
// 正文口径靠两侧同夹具钉成一样。escapeHtml 走 DOM，同上面临时装一份等价转义。
const _hx = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

check('history-export：historyEntries 取材（类型中文名/问题分析/清单/同文消息去重/时间排序/空节点略）', () => {
  const text = '力 <formula>F=-kx</formula> 作用\n\n<formula>\nT=2\\pi\\sqrt{\\frac{m}{k}}\n</formula>\n\n收尾 <formula> a &lt; b </formula>';
  const nodes = [
    { kind: 'user', content: '简谐运动是什么', timestamp: 1000 },
    { kind: 'hub', content: '', timestamp: 2000 },  // 空节点：不列
    { kind: 'summary', content: text, timestamp: 3000 },
    { kind: 'note', content: '# 齿轮基本参数', timestamp: 4000 },
    { kind: 'answer', content: '', analysis: '题意歧义：……', timestamp: 5000 },
    { kind: 'module', content: '', timestamp: 6000,
      items: [{ levelName: '基础', question: '为什么周期与振幅无关？' }, { kind: 'image', fileName: 'a.png' }] },
  ];
  const messages = [
    { role: 'user', content: '简谐运动\n是什么', timestamp: 1000 },  // 与节点同文：不重复列
    { role: 'assistant', content: '好问题', timestamp: 1500 },
    { role: 'system', content: '系统提示不进导出', timestamp: 1600 },
  ];
  const es = sandbox.historyEntries(messages, nodes);
  const heads = es.map((e) => e.head).join('|');
  if (heads !== '我|AI|AI 总结|我的总结|问题分析|模块') throw new Error('条目标题序列不符：' + heads);
  const summary = es[2].content;
  if (!summary.includes('力 $F=-kx$ 作用')) throw new Error('夹在句中的公式应转 inline');
  if (!summary.includes('$$\nT=2\\pi\\sqrt{\\frac{m}{k}}\n$$')) throw new Error('独占一行的公式应转 display：' + JSON.stringify(summary));
  if (!summary.endsWith('收尾 $a < b$')) throw new Error('实体未解码或首尾空白未剥：' + JSON.stringify(summary.slice(-16)));
  if (summary.includes('<formula>')) throw new Error('<formula> 标签残留');
  if (es[4].content !== '题意歧义：……') throw new Error('问题分析卡正文应取自 analysis');
  if (es[5].content !== '- [基础] 为什么周期与振幅无关？\n- 图片「a.png」') throw new Error('清单条目不符：' + JSON.stringify(es[5].content));
  if (es[0].content !== '简谐运动是什么') throw new Error('去重应留节点、略消息');
  return true;
});

check('history-export：_historyText 规范化（思考块/summary/分节标签/<viz> 与完整网页/双层定界/未闭合公式）', () => {
  const page = '<!DOCTYPE html><html><body>' + 'x'.repeat(120) + '</body></html>';
  const vizInner = '\n```html\n' + page + '\n```\n';
  const raw = '<think>内部推理</think>正文<physics>甲</physics><summary>摘要标签</summary>'
    + '<viz>' + vizInner + '</viz>后文\n\n```html\n<b>片段</b>\n```\n'
    + '$$<formula>E=mc^2</formula>$$\n\n结尾 <formula>\\frac{a}{b}';
  const out = sandbox._historyText(raw);
  if (out.includes('内部推理') || out.includes('摘要标签')) throw new Error('思考块／summary 未剥');
  if (!out.includes('正文甲')) throw new Error('分节标签应剥掉、内容留着');
  if (!out.includes('（交互可视化，' + vizInner.length + ' 字代码，正文见画布）')) throw new Error('viz 段未换成说明：' + out.slice(0, 80));
  if (!out.includes('```html\n<b>片段</b>\n```')) throw new Error('短代码块应保留');
  if (!out.includes('$$\nE=mc^2\n$$')) throw new Error('双层定界应收成 display 块');
  if (out.includes('\\frac{a}{b}') || !out.endsWith('结尾')) throw new Error('未闭合公式应从标签起截掉：' + JSON.stringify(out.slice(-20)));
  const wholeSrc = '```html\n<!DOCTYPE html><html></html>';
  if (sandbox._historyText('  ' + wholeSrc + '  ') !== '（交互可视化，' + wholeSrc.length + ' 字代码，正文见画布）') throw new Error('整条是网页时应只留说明');
  if (sandbox._historyText(null) !== '' || sandbox._historyText('   ') !== '') throw new Error('空正文应返回空串');
  return true;
});

check('history-export：类型中文名表与 storage.py 一致（前后端口径不漂移）', () => {
  const py = fs.readFileSync('src/server/storage.py', 'utf8');
  const block = py.match(/_HISTORY_KIND_LABEL = \{([^}]*)\}/);
  if (!block) throw new Error('storage.py 里找不到 _HISTORY_KIND_LABEL');
  const pairs = Array.from(block[1].matchAll(/"([a-z_]+)":\s*"([^"]+)"/g));
  if (pairs.length < 20) throw new Error('storage.py 的类型表条目数异常：' + pairs.length);
  for (const [, k, v] of pairs) {
    if (sandbox.historyKindLabel(k) !== v) throw new Error('类型「' + k + '」两侧叫法不一致：前端 ' + sandbox.historyKindLabel(k) + ' / 服务端 ' + v);
  }
  if (sandbox.historyKindLabel('whatever_new') !== 'whatever_new' || sandbox.historyKindLabel('') !== '节点') throw new Error('未知类型应退回原词、空类型退回「节点」');
  return true;
});

check('history-export：historyMarkdown 结构（标题/元信息/条目头/时间跨度/正文不截断）', () => {
  const collected = {
    entries: [
      { ts: Date.UTC(2026, 9, 31, 2, 0), head: '我', label: '', content: '齿轮啮合参数' },
      { ts: Date.UTC(2026, 9, 31, 2, 57), head: '模块', label: '物理视角', content: '长'.repeat(9000) },
      { ts: Infinity, head: '模块', label: '模块', content: '无时间戳' },
    ],
    nodes: new Array(5).fill({}), messages: [{}, {}],
  };
  const md = sandbox.historyMarkdown('sess_abc', '齿轮啮合参数', collected, '2026-11-24 12:00');
  if (!md.startsWith('# 齿轮啮合参数\n\n- 会话 ID：`sess_abc`\n- 条目：3 条（画布节点 5 个、聊天消息 2 条，空条目已略）\n')) {
    throw new Error('头部不符：' + JSON.stringify(md.slice(0, 90)));
  }
  if (!md.includes('- 导出时间：2026-11-24 12:00\n\n---\n')) throw new Error('导出时间或分隔线缺失');
  const heads = md.split('\n').filter((l) => /^## \d+\. /.test(l));
  if (heads.length !== 3) throw new Error('条目头数量不符：' + heads.length);
  if (!/^## 1\. 我 · \d\d-\d\d \d\d:\d\d$/m.test(md)) throw new Error('条目头 1 格式不符');
  if (!/^## 2\. 模块 · 物理视角 · \d\d-\d\d \d\d:\d\d$/m.test(md)) throw new Error('条目头 2 应带小标题与时间');
  if (heads[2] !== '## 3. 模块') throw new Error('小标题与类型同名、无时间戳时应省略：' + heads[2]);
  if (!md.includes('- 时间跨度：') || !md.includes(' → ')) throw new Error('时间跨度缺失');
  if (!md.includes('长'.repeat(9000)) || md.includes('已截断')) throw new Error('导出不应截断正文');
  return true;
});

check('history-export：historyTameHtml＋_historyMathHtml（外链图片→链接、data 图留、媒体与 style url 摘除、标题降级、math-raw 预排/降级）', () => {
  const prevEsc = sandbox.escapeHtml;
  const prevKatex = sandbox.katex;
  sandbox.escapeHtml = _hx;
  try {
    const tamed = sandbox.historyTameHtml(
      '<h1>卡</h1><h2>节</h2><h3>目</h3><h6>底</h6>'
      + '<img src="https://x/a.png" alt="图&quot;注">'
      + "<img src='//x/b.png'>"
      + '<img src="data:image/png;base64,AAA" srcset="https://x/a.png 2x">'
      + '<img alt="无 src">'
      + '<video controls><source src="https://x/v.mp4" type="video/mp4"></video>'
      + '<picture><img src="https://x/c.png"></picture>'
      + '<div style="color:red;background:url(https://x/bg.png)">块</div>'
      + '<span style="height:0.68em">高</span>'
      + '<a href="https://x/">链接</a>'
    );
    const want = '<h3>卡</h3><h4>节</h4><h5>目</h5><h6>底</h6>'
      + '<a href="https://x/a.png" target="_blank" rel="noopener">图片：图&quot;注</a>'
      + '<a href="//x/b.png" target="_blank" rel="noopener">//x/b.png</a>'
      + '<img src="data:image/png;base64,AAA">'
      + '<img alt="无 src">'
      + '<a href="https://x/c.png" target="_blank" rel="noopener">https://x/c.png</a>'
      + '<div>块</div>'
      + '<span style="height:0.68em">高</span>'
      + '<a href="https://x/">链接</a>';
    if (tamed !== want) throw new Error('收口结果不符：' + tamed);
    // 沙箱无 katex：math-raw 退成转义 code，定界符剥掉、实体解码；空公式抹掉
    const fell = sandbox._historyMathHtml('<p>行内<span class="math-raw" data-mmode="inline">$a&lt;b$</span>与空<span class="math-raw" data-mmode="display">$$</span></p>'
      + '<p><span class="math-raw" data-mmode="display">$$\\frac{a}{b}$$</span></p>');
    if (fell !== '<p>行内<code class="note-tex">a&lt;b</code>与空</p><p><code class="note-tex">\\frac{a}{b}</code></p>') throw new Error('无 KaTeX 未降级：' + fell);
    // 有 KaTeX：按 data-mmode 选 display／inline
    sandbox.katex = { renderToString: (latex, opt) => '<k d="' + opt.displayMode + '">' + latex + '</k>' };
    const rendered = sandbox._historyMathHtml('<p><span class="math-raw" data-mmode="display">$$E=mc^2$$</span> <span class="math-raw" data-mmode="inline">\\(x^2\\)</span></p>');
    if (rendered !== '<p><k d="true">E=mc^2</k> <k d="false">x^2</k></p>') throw new Error('预排结果不符：' + rendered);
    // 公式本身坏了：KaTeX 抛错 → 退成 code，不丢
    sandbox.katex = { renderToString: () => { throw new Error('ParseError'); } };
    const broken = sandbox._historyMathHtml('<span class="math-raw" data-mmode="display">$$\\frac{$$</span>');
    if (broken !== '<code class="note-tex">\\frac{</code>') throw new Error('坏公式应退成 code：' + broken);
    return true;
  } finally {
    sandbox.escapeHtml = prevEsc;
    sandbox.katex = prevKatex;
  }
});

check('history-export：historyHtmlDocument 单文件契约（DOCTYPE/转义/零脚本/联网资源收口/类型徽标/打印样式）', () => {
  const prevEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = _hx;
  try {
    const collected = {
      entries: [
        { ts: Date.UTC(2026, 9, 31, 2, 57), head: '模块', label: '物理视角', content: '正文甲' },
        { ts: Infinity, head: '我', label: '', content: '正文乙 <b>' },
      ],
      nodes: [], messages: [],
    };
    const html = sandbox.historyHtmlDocument('波&粒', collected, '2026-11-24 12:00', '2026-11-24',
      '@font-face{src:url(data:font/woff2;base64,QUJD) format("woff2")}',
      (t) => '<p>' + _hx(t) + '</p><img src="https://x/a.png">');
    if (!html.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')) throw new Error('缺 DOCTYPE／lang');
    if (!html.includes('<meta charset="utf-8">')) throw new Error('缺 charset meta');
    if (!html.includes('<title>PhyMathia 会话历史 · 波&amp;粒</title>')) throw new Error('title 缺失或会话名未转义');
    if (!html.includes('<h1>PhyMathia 会话历史 · 波&amp;粒</h1>')) throw new Error('页标题缺失');
    if (!html.includes('data:font/woff2;base64,QUJD')) throw new Error('传入的 katexCss 未进 <style>');
    if (/<script\b|<iframe\b|<link\b/i.test(html)) throw new Error('成品不得带脚本／iframe／外链样式');
    if (!html.includes('2026-11-24 12:00 导出 · 共 2 条 · ')) throw new Error('元信息行缺失');
    if (html.split('class="note-item history-item"').length - 1 !== 2) throw new Error('条目节数量不对');
    if (!html.includes('<h2><span class="history-kind">模块</span>物理视角<span class="history-time">')) throw new Error('条目头（徽标＋小标题＋时间）不符');
    if (!html.includes('<h2><span class="history-kind">我</span></h2>')) throw new Error('无时间戳条目头不符');
    // 渲染桩给的外链图片被整档函数收口成链接；正文本身已转义
    if (!html.includes('<p>正文甲</p><a href="https://x/a.png" target="_blank" rel="noopener">https://x/a.png</a>')) throw new Error('外链图片未换成链接');
    if (!html.includes('<p>正文乙 &lt;b&gt;</p>')) throw new Error('第二条正文缺失');
    for (const m of html.matchAll(/url\(([^)]{0,40})/g)) {
      if (!m[1].startsWith('data:')) throw new Error('出现非 data: 的 url(' + m[1] + ')');
    }
    if (!html.includes('/* 会话历史样式 */') || !html.includes('.note-body .katex-display')) throw new Error('会话历史样式缺失');
    if (!html.includes('.history-item { break-inside: auto; }')) throw new Error('打印样式缺失');
    if (!html.includes('由 PhyMathia 导出 · 2026-11-24')) throw new Error('页脚缺失');
    return true;
  } finally {
    sandbox.escapeHtml = prevEsc;
  }
});

check('history-export：historyBodyHtml（无 Markdown 环境退成转义原文；有环境时公式预排、mermaid 以源码块放回）', () => {
  const prevEsc = sandbox.escapeHtml;
  const prevRender = sandbox.renderMarkdown;
  const prevKatex = sandbox.katex;
  sandbox.escapeHtml = _hx;
  try {
    const fell = sandbox.historyBodyHtml('正文 <b>&');
    if (fell !== '<pre class="history-raw">正文 &lt;b&gt;&amp;</pre>') throw new Error('无渲染环境应退成转义原文：' + fell);
    // 临时装一个「产物形态同 renderMarkdown」的桩：公式包 math-raw、段落按空行切（沙箱没有 marked）
    sandbox.renderMarkdown = (t) => t.split(/\n{2,}/).map((p) => '<p>'
      + _hx(p).replace(/\$([^$\n]+)\$/g, (m, l) => '<span class="math-raw" data-mmode="inline">$' + _hx(l) + '$</span>')
      + '</p>').join('');
    const out = sandbox.historyBodyHtml('前文 $x$\n\n```mermaid\ngraph TD; A-->B\n```\n\n后文');
    const want = '<p>前文 <code class="note-tex">x</code></p>'
      + '<pre class="history-mermaid"><code>graph TD; A--&gt;B</code></pre><p>后文</p>';
    if (out !== want) throw new Error('正文渲染结果不符：' + out);
    return true;
  } finally {
    sandbox.escapeHtml = prevEsc;
    sandbox.renderMarkdown = prevRender;
    sandbox.katex = prevKatex;
  }
});

check('history-export：historyFileName 非法字符清洗与空会话名回退（笔记导出文件名不被共用函数带偏）', () => {
  const a = sandbox.historyFileName('齿轮:啮合?', '2026-11-24', 'md');
  const b = sandbox.historyFileName('  ', '2026-11-24', 'html');
  if (a !== 'PhyMathia会话历史-齿轮_啮合_-2026-11-24.md') throw new Error('非法字符未清洗：' + a);
  if (b !== 'PhyMathia会话历史-2026-11-24.html') throw new Error('空白会话名应整段省略：' + b);
  if (sandbox.noteFileName('简谐运动', '2026-10-06', 'md') !== 'PhyMathia笔记-简谐运动-2026-10-06.md') throw new Error('笔记导出文件名被带偏');
  return true;
});

check('history-export：接线（知识菜单两入口 + 入口函数已挂全局）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const menu = html.slice(html.indexOf('id="knowledgeMenu"'), html.indexOf('id="moreMenu"'));
  if (!menu.includes("window.exportSessionHistory('html')")) throw new Error('知识菜单缺「导出会话历史 · HTML」入口');
  if (!menu.includes("window.exportSessionHistory('md')")) throw new Error('知识菜单缺「导出会话历史 · Markdown」入口');
  if (typeof sandbox.exportSessionHistory !== 'function') throw new Error('exportSessionHistory 未挂到全局');
  return true;
});
}
