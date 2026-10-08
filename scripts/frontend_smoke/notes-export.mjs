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
}
