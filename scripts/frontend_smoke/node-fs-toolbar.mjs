// 节点全屏划词快捷工具（node-fs-toolbar.js，2026-10-25）静态/沙箱契约。
// 范围：本页全屏阅读层浮条 ＋ 新窗口预览页内嵌浮条 ＋ 预览壳转发桥。
// 只写同步用例——共享沙箱教训：异步用例不能和重置沙箱的同步用例同文件（AGENTS.md）；
// 行为验证靠浏览器真机档（当日日志有验收清单），这里守住「符号在、接线对、坏拼接当场炸」。
import { check, code, sandbox, fs } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');

export function run() {
  // T420 假 KaTeX 节点：annotation 带 tex；replaceWith 把替换文本写回所在 fragment 的
  // textContent（沙箱无真 DOM，按替换后的可见文本模拟）。display 决定 $ 还是 $$。
  const fakeKatex = (tex, display) => {
    const k = {
      nodeType: 1,
      textContent: 'Ω→R2',
      classList: { contains: (c) => c === 'katex' || (!!display && c === 'katex-display') },
      closest: (sel) => (display && sel === '.katex-display' ? k : null),
      querySelector: (sel) => (String(sel).indexOf('annotation') >= 0 ? { textContent: tex } : null),
      parentNode: null,
      parentElement: null,
    };
    return k;
  };
  const fakeFrag = (katex, visible) => {
    const f = {
      _text: visible,
      get textContent() { return f._text; },
      querySelectorAll: () => (katex ? [katex] : []),
      querySelector: () => katex,
    };
    if (katex) katex.replaceWith = (tn) => { f._text = String(tn && tn.textContent != null ? tn.textContent : ''); };
    return f;
  };
  const fakeRangeInKatex = (katex, frag) => {
    const textNode = { nodeType: 3, parentElement: katex };
    return {
      startContainer: textNode,
      endContainer: textNode,
      commonAncestorContainer: { nodeType: 1 },
      cloneRange: () => ({
        setStartBefore: () => {},
        setEndAfter: () => {},
        cloneContents: () => frag,
      }),
      cloneContents: () => frag,
    };
  };

  check('node-fs-toolbar: 动作层符号挂上全局（选区提取/浮条/输入行/桥接收端/预览脚本生成器）', () => {
    for (const fn of ['_nodeFsPickSelection', '_nodeFsPickSearchText', '_nodeFsKatexFragmentText', '_nodeFsExpandRangeToFormulas', '_nodeFsCopySelectionText', '_nodeFsHideBar', '_nodeFsExpandInput', '_nodeFsRunAction', '_buildNodeFsPreviewScript', '_setNodeFsPreviewCtx', '_nodeFsComposeFollowup']) {
      if (typeof sandbox[fn] !== 'function') throw new Error(fn + ' 未暴露');
    }
    return true;
  });

  check('node-fs-toolbar: 桥上白名单＝追问/查找两枚；收藏公式/复制为引用/解释/摘录不许回潮', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!/NODE_FS_BRIDGE_ACTIONS\s*=\s*\['followup',\s*'search'\]/.test(src)) return false;
    // 只拦动作字符串字面量（'delquote' 之类的普通命名不算回潮）
    if (/'(collectFormula|quote|explain|excerpt)'/.test(src)) return false;
    if (src.includes("'收藏公式'") || src.includes("'复制为引用'")) return false;
    return true;
  });

  check('node-fs-toolbar: 追问点击必须接到展开输入行（首版漏分支真机事故，双端都要有）', () => {
    if (!sandbox._nodeFsRunAction.toString().includes('_nodeFsExpandInput')) return false;
    const bridge = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!bridge.includes('expandInput') || !bridge.includes('sendFollowup')) return false;
    return true;
  });

  check('node-fs-toolbar: 查找碰公式喂 LaTeX 本体（符号片段「Ω→R2」不再拿渲染字形去撞 LaTeX 索引；T420）', () => {
    const prevCreate = sandbox.document.createTextNode;
    sandbox.document.createTextNode = (v) => ({ textContent: String(v) });
    try {
      // 部分公式选段（端点落 .katex 内）→ 扩整条 → tex 本体，不带 $ 定界符
      const k = fakeKatex('\\Omega\\to\\mathbb R^2', false);
      const frag = fakeFrag(k, 'Ω→R2');
      if (sandbox._nodeFsPickSearchText(fakeRangeInKatex(k, frag)) !== '\\Omega\\to\\mathbb R^2') return false;
      // 没碰公式的选段原样返回所选可见字符
      if (sandbox._nodeFsPickSearchText({ cloneContents: () => ({ textContent: '常量' }) }) !== '常量') return false;
      // 空选段/异常兜底：不炸、返回空串（调用侧退复制文本）
      if (sandbox._nodeFsPickSearchText({ cloneContents: () => null }) !== '') return false;
      if (sandbox._nodeFsPickSearchText({ cloneContents: () => { throw new Error('x'); } }) !== '') return false;
      return true;
    } finally {
      sandbox.document.createTextNode = prevCreate;
    }
  });

  check('node-fs-toolbar: 查找查询接线——选段单独一份（searchText）双端喂它，公式喂 tex 本体不带 $', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!/return \{ text, searchText, rect \};/.test(src)) return false;
    if (!src.includes('searchText: picked.searchText || picked.text')) return false;
    if (!src.includes('_nodeFsSearchCanvas(st.searchText || st.fullText)')) return false;
    // 查找与复制共用扩公式口径，但写文本节点时不包 $——索引侧把 $ 剥掉了，带 $ 恒失配
    if (!/function _nodeFsPickSearchText[\s\S]*?_nodeFsKatexFragmentText\(frag, false\)/.test(src)) return false;
    // 预览页双胞胎同款：pickSearchText 在场、查找 postAction 用 searchText 兜底 picked.text
    const bridge = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!bridge.includes('function pickSearchText(range)')) return false;
    if (!bridge.includes('fragText(frag,false)')) return false;
    if (!bridge.includes('picked.searchText||picked.text')) return false;
    return true;
  });

  check('node-fs-toolbar: 系统复制碰公式按胶囊口径重写纯文本（完整 $tex$/$$tex$$、半截扩整条；T420）', () => {
    const prevCreate = sandbox.document.createTextNode;
    const prevSel = sandbox.window.getSelection;
    sandbox.document.createTextNode = (v) => ({ textContent: String(v) });
    const setSel = (sel) => { sandbox.window.getSelection = () => sel; };
    try {
      // 端点落公式内（半截 DOM）→ 扩整条 + display 公式 $$...$$
      const k = fakeKatex('(X,Y):\\Omega\\to\\mathbb R^2', true);
      const frag = fakeFrag(k, '(X,Y):Ω→R2');
      const range = fakeRangeInKatex(k, frag);
      range.commonAncestorContainer = { nodeType: 1 };
      setSel({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range });
      if (sandbox._nodeFsCopySelectionText() !== '$$(X,Y):\\Omega\\to\\mathbb R^2$$') return false;
      // 半截扩公式时克隆片段没有 .katex-display 祖先——display 要能认 MathML 的
      // <math display="block">，否则 display 公式会降级成 $...$（真实 Chromium 踩到）
      const kBlock = fakeKatex('x^2', false);
      kBlock.querySelector = (sel) => (sel === 'math[display="block"]'
        ? {}
        : (String(sel).indexOf('annotation') >= 0 ? { textContent: 'x^2' } : null));
      setSel({ rangeCount: 1, isCollapsed: false, getRangeAt: () => fakeRangeInKatex(kBlock, fakeFrag(kBlock, 'x2')) });
      if (sandbox._nodeFsCopySelectionText() !== '$$x^2$$') return false;
      // 没碰公式：返回空串＝不拦截，默认复制零变化
      const plainRange = {
        commonAncestorContainer: {},
        startContainer: {},
        endContainer: {},
        cloneContents: () => ({ textContent: '普通文字' }),
      };
      setSel({ rangeCount: 1, isCollapsed: false, getRangeAt: () => plainRange });
      if (sandbox._nodeFsCopySelectionText() !== '') return false;
      // 折叠选区不拦
      setSel({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range });
      if (sandbox._nodeFsCopySelectionText() !== '') return false;
      // 双端接线：主应用与预览页脚本都注册 copy 拦截并写 text/plain
      const src = readSrc('src/static/js/node-fs-toolbar.js');
      if (!src.includes("document.addEventListener('copy'")) return false;
      if (!src.includes("ev.clipboardData.setData('text/plain'")) return false;
      const bridge = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
      if (!bridge.includes('addEventListener("copy"')) return false;
      if (!bridge.includes('setData("text/plain"')) return false;
      return true;
    } finally {
      sandbox.document.createTextNode = prevCreate;
      sandbox.window.getSelection = prevSel;
    }
  });

  check('node-fs-toolbar: 画布搜索查询与索引同管归一——手贴/桥上带 $ 的公式查询也能命中（graph-search.js）', () => {
    const src = readSrc('src/static/js/graph-search.js');
    if (!src.includes('_graphSearchPlainText(raw) || raw.trim()')) return false;
    return true;
  });

  check('node-fs-toolbar: 索引归一模拟 markdown 转义——公式内 \\; 类反斜杠标点双侧同形（T420 补漏，用户真实数据）', () => {
    const norm = sandbox._graphSearchPlainText;
    if (typeof norm !== 'function') return false;
    // 用户场景（kv 原文 vs KaTeX annotation）：marked 吃掉 \; 的反斜杠后，查询
    // F_{X,Y}(x,y)=\mathbb P(X\le x,;Y\le y) 与索引原文差一个 \，恒失配——
    // 归一补上转义模拟后两侧必须同形可命中。
    const indexText = norm('$$F_{X,Y}(x,y)=\\mathbb P(X\\le x,\\;Y\\le y)$$');
    const query = norm('F_{X,Y}(x,y)=\\mathbb P(X\\le x,;Y\\le y)');
    if (!indexText.includes(query)) return false;
    // 转义口径：标点/空白前的反斜杠吃掉，字母命令不动；\\ 还原成 \
    if (norm('x,\\;Y') !== 'x,;Y') return false;
    if (norm('\\le x') !== '\\le x') return false;
    if (norm('\\\\text{常量}') !== '\\text{常量}') return false;
    // $ 定界符剥除与 CJK 的老口径不回归
    if (norm('$x$') !== 'x') return false;
    if (norm('常量') !== '常量') return false;
    return true;
  });

  check('node-fs-toolbar: 预览脚本生成器两模式产物都能编译、标题带 </script> 被转义', () => {
    const bridge = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 'tok_smoke', nodeId: 'n1', title: '含 </script> 的标题' });
    new Function(bridge); // 只编译不执行——字符串拼接坏了这里当场炸
    const plain = sandbox._buildNodeFsPreviewScript({ bridge: false, nodeId: 'n1', title: 'T' });
    new Function(plain);
    if (bridge.indexOf('</script') !== -1) return false;
    return true;
  });

  check('node-fs-toolbar: _buildContentPreviewPage 传 ctx 含 token/脚本/data-node-id，不传不含（viewer 老调用零变化）', () => {
    const realEsc = sandbox.escapeHtml;
    // 沙箱裸 escapeHtml 解析到 loose 代理（恒返回 0）——recipes 全屏用例同款先桩掉
    sandbox.escapeHtml = t => (t == null ? '' : String(t));
    try {
      const plain = sandbox._buildContentPreviewPage('标题', '<p>正文</p>');
      if (plain.includes('node-fs-action') || plain.includes('data-node-id')) return false;
      const ctxd = sandbox._buildContentPreviewPage('标题', '<p>正文</p>', { nodeId: 'n1', token: 'tok_smoke', title: '标题', bridge: true });
      if (!ctxd.includes('data-node-id="n1"') || !ctxd.includes('tok_smoke') || !ctxd.includes('node-fs-action')) return false;
      return true;
    } finally {
      sandbox.escapeHtml = realEsc;
    }
  });

  check('node-fs-toolbar: 桥四道校验都在场（壳认 source、主应用认 source+token+白名单、800ms 兜底）', () => {
    const shell = readSrc('src/static/content-preview.html');
    if (!shell.includes('ev.source !== frame.contentWindow')) return false;
    if (!shell.includes("'node-fs-action'") || !shell.includes("'node-fs-ack'")) return false;
    if (!shell.includes('800')) return false;
    const bar = readSrc('src/static/js/node-fs-toolbar.js');
    if (!bar.includes('ev.source !== ctx.win')) return false;
    if (!bar.includes('d.token !== ctx.token')) return false;
    if (!bar.includes("NODE_FS_BRIDGE_ACTIONS.indexOf(d.action) < 0")) return false;
    return true;
  });

  check('node-fs-toolbar: Esc capture 先收浮条并 stopPropagation（ui.js 关全屏这轮不触发）', () => {
    const bar = readSrc('src/static/js/node-fs-toolbar.js');
    const idx = bar.indexOf("'Escape'");
    if (idx < 0) return false;
    const seg = bar.slice(idx, idx + 400);
    const stopAt = seg.indexOf('stopPropagation');
    const hideAt = seg.indexOf('_nodeFsHideBar');
    if (stopAt < 0 || hideAt < 0) return false;
    if (bar.slice(idx, idx + 900).indexOf('}, true);') < 0) return false; // capture 注册
    return true;
  });

  check('node-fs-toolbar: 构建顺序在 graph-custom 之后、app.js 产物已含本模块', () => {
    const bf = readSrc('scripts/build_frontend.mjs');
    const a = bf.indexOf("'graph-custom.js'");
    const b = bf.indexOf("'node-fs-toolbar.js'");
    if (a < 0 || b < 0 || b < a) return false;
    if (!code.includes('NODE_FS_BRIDGE_ACTIONS')) return false;
    return true;
  });

  check('node-fs-toolbar: graph-custom 集成点（overlay 带节点上下文/新窗口造 token/file:// 关桥/浮条随层收）', () => {
    const src = readSrc('src/static/js/graph-custom.js');
    if (!src.includes('overlay.dataset.nodeFsId') || !src.includes('attachNodeFsSelectionBar(overlay)')) return false;
    if (!src.includes('bridge: true') || !src.includes('bridge: false')) return false;
    if (!src.includes('_buildContentPreviewPage(title, contentHtml, ctx)')) return false;
    if (!src.includes('_nodeFsMintPreviewToken()')) return false;
    if (!src.includes('typeof _nodeFsHideBar === \'function\'')) return false;
    return true;
  });

  check('node-fs-toolbar: 浮条样式进 graph-override.css（胶囊＋引文输入行＋窄屏图标化）', () => {
    const css = readSrc('src/static/css/graph-override.css');
    if (css.includes('.node-fs-more') || css.includes('node-fs-menu-item')) return false; // ⋯ 菜单已随工具条收窄退役
    return css.includes('.node-fs-bar')
      && css.includes('.node-fs-input')
      && css.includes('.node-fs-quote-chip')
      && css.includes('@media (max-width: 520px)');
  });
}
