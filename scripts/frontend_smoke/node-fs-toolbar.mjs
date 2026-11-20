// 节点全屏划词快捷工具（node-fs-toolbar.js，2026-10-25）静态/沙箱契约。
// 范围：本页全屏阅读层浮条 ＋ 新窗口预览页内嵌浮条 ＋ 预览壳转发桥。
// 只写同步用例——共享沙箱教训：异步用例不能和重置沙箱的同步用例同文件（AGENTS.md）；
// 行为验证靠浏览器真机档（当日日志有验收清单），这里守住「符号在、接线对、坏拼接当场炸」。
import { check, code, sandbox, fs, vm } from './_runner.mjs';

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

  check('node-fs-toolbar: 桥上白名单＝追问/查找/加粗/整篇编辑四枚；收藏公式/复制为引用/解释/摘录不许回潮', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!/NODE_FS_BRIDGE_ACTIONS\s*=\s*\['followup',\s*'search',\s*'bold',\s*'edit'\]/.test(src)) return false; // edit＝渲染态编辑过桥（2026-11-20）
    // 只拦动作字符串字面量（'delquote' 之类的普通命名不算回潮）
    if (/'(collectFormula|quote|explain|excerpt)'/.test(src)) return false;
    if (src.includes("'收藏公式'") || src.includes("'复制为引用'")) return false;
    return true;
  });

  check('node-fs-toolbar: 选段加粗定位——渲染文字映射回原文下标（强调符/空白/formula 折 $ 后可比）', () => {
    const scan = sandbox._nodeFsBoldScan;
    const locate = sandbox._nodeFsBoldLocate;
    if (typeof scan !== 'function' || typeof locate !== 'function') throw new Error('加粗定位 API 未挂出');
    // 纯文字：下标直接落在原串上
    if (!scan('我们来看重点内容。').text.includes('重点内容')) return false;
    const plain = locate('我们来看重点内容。', '重点内容', {});
    if (!plain || plain.start !== 4 || plain.end !== 8) throw new Error('纯文字定位错：' + JSON.stringify(plain));
    // 原文带行内格式：`**重点**` 里的「重点」要落到没有星号的下标上
    const inBold = locate('这是 **重点** 内容。', '重点', {});
    if (!inBold || '这是 **重点** 内容。'.slice(inBold.start, inBold.end) !== '重点') {
      throw new Error('已有加粗里的定位错：' + JSON.stringify(inBold));
    }
    // 软换行：原文是两行、渲染后是一个空格——同管压空白后仍要命中
    const folded = locate('我们来看\n重点内容', '重点内容', {});
    if (!folded || '我们来看\n重点内容'.slice(folded.start, folded.end) !== '重点内容') return false;
    // 公式折成 $ 再比：<formula> 与 \( \) 两条口径
    if (scan('前<formula>a+b</formula>后').text !== '前$a+b$后') return false;
    if (scan('前\\(a+b\\)后').text !== '前$a+b$后') return false;
    // 同一段出现两次：按上下文挑中第二处
    const twice = locate('甲句重点。乙句重点。', '重点', { before: '乙句', after: '' });
    if (!twice || '甲句重点。乙句重点。'.slice(twice.start, twice.end) !== '重点') return false;
    if (twice.start !== 7) throw new Error('多命中没按上下文挑：' + twice.start);
    return true;
  });

  check('node-fs-toolbar: 加粗定位拒绝二义——上下文在手还同分就如实拒绝，不猜第一处（485）', () => {
    const locate = sandbox._nodeFsBoldLocate;
    if (typeof locate !== 'function') throw new Error('加粗定位 API 未挂出');
    // 真二义：两处上下文完全对称 → {ambiguous:true}，绝不再「同分取第一处」
    const amb = locate('甲句重点。乙句重点。', '重点', { before: '句', after: '。' });
    if (!amb || amb.ambiguous !== true || amb.start != null) throw new Error('同分没拒绝：' + JSON.stringify(amb));
    // 拿不到上下文（before/after 全空）保持老口径：取第一处
    const noCtx = locate('甲句重点。乙句重点。', '重点', {});
    if (!noCtx || noCtx.start !== 2) throw new Error('无上下文不该拒绝：' + JSON.stringify(noCtx));
    // 能分清时不误伤：前文不同 → 照旧挑中那一处
    const clear = locate('甲句重点。乙句重点。', '重点', { before: '乙句', after: '' });
    if (!clear || clear.start !== 7) throw new Error('能分清却被拒：' + JSON.stringify(clear));
    return true;
  });

  check('node-fs-toolbar: 加粗定位顶住 KaTeX 双份文本污染——被污染的上下文宁可拒绝也不加粗错字（485）', () => {
    const locate = sandbox._nodeFsBoldLocate;
    // 原文：同一短语紧挨两条公式各出现一次，用户选的是第二处
    const src = '甲 $E$ 的句子，乙 $E$ 的句子';
    // 修复前 DOM 上下文＝渲染字形×2（KaTeX 的 MathML+HTML 双份），没有 $ 锚——
    // 两处全打 0 分打平，旧逻辑取第一处＝加粗错字；现在必须拒绝
    const polluted = locate(src, '的句子', { before: '甲EE的句子乙EE', after: '' });
    if (!polluted || polluted.ambiguous !== true) throw new Error('污染上下文没拒绝：' + JSON.stringify(polluted));
    // 修复后上下文按选区同款口径折 $tex$，与原文索引同形——正确挑中第二处
    const folded = locate(src, '的句子', { before: '甲$E$的句子，乙$E$', after: '' });
    if (!folded || folded.ambiguous) throw new Error('折 $ 上下文反而拒绝：' + JSON.stringify(folded));
    if (folded.start !== 16 || src.slice(folded.start, folded.end) !== '的句子') {
      throw new Error('折 $ 后没挑中第二处：' + JSON.stringify(folded));
    }
    return true;
  });

  check('node-fs-toolbar: 加粗上下文取文过公式——.katex 折 $tex$，双份文本不进 12 字窗口（485）', () => {
    const ctx = sandbox._nodeFsBoldContext;
    const fold = sandbox._nodeFsBoldFold;
    if (typeof ctx !== 'function' || typeof fold !== 'function') throw new Error('加粗上下文 API 未挂出');
    const realCreate = sandbox.document.createRange;
    const realCreateTextNode = sandbox.document.createTextNode;
    sandbox.document.createTextNode = (v) => ({ textContent: String(v) });
    // 假片段＝「前文＋公式双份文本＋后文」，replaceWith 只把占位那段换成折好的 $tex$
    const mkFrag = (k, naive, marker) => {
      const f = {
        _text: naive,
        get textContent() { return f._text; },
        querySelectorAll: () => [k],
        querySelector: () => k,
      };
      // 替换串走函数形态：'$' 在 replacement 里是转义符，display 公式的 $$ 会被吃掉
      k.replaceWith = (tn) => { f._text = String(f._text).replace(marker, () => String(tn && tn.textContent != null ? tn.textContent : '')); };
      return f;
    };
    const k1 = fakeKatex('a^2', false);
    const preFrag = mkFrag(k1, '有 a2a^2 重点甲', 'a2a^2');    // MathML+HTML 双份的污染态
    const k2 = fakeKatex('F=ma', true);
    const postFrag = mkFrag(k2, 'F=maF=ma重点乙收', 'F=maF=ma');
    // 两次 createRange 按实现顺序＝pre（选区前）→ post（选区后）
    const queue = [
      { selectNodeContents() {}, setEnd() {}, cloneContents: () => preFrag, toString: () => preFrag._text },
      { selectNodeContents() {}, setStart() {}, cloneContents: () => postFrag, toString: () => postFrag._text },
    ];
    sandbox.document.createRange = () => queue.shift();
    try {
      const got = ctx({}, { startContainer: {}, startOffset: 0, endContainer: {}, endOffset: 0 });
      if (got.before !== '有$a^2$重点甲') throw new Error('前文没折公式（双份文本还在）：' + JSON.stringify(got));
      if (got.after !== '$$F=ma$$重点乙收') throw new Error('后文没折公式：' + JSON.stringify(got));
      // 掉底兜底：cloneContents 拿不到时退回 toString 老口径
      const boom = { cloneContents: () => { throw new Error('x'); }, toString: () => '普通  文字' };
      if (fold(boom) !== '普通  文字') throw new Error('兜底口径变了');
      return true;
    } finally {
      sandbox.document.createRange = realCreate;
      sandbox.document.createTextNode = realCreateTextNode;
    }
  });

  check('node-fs-toolbar: 二义拒绝双端接线——本页浮条与预览桥各给如实文案，内嵌定位同源拒绝（485）', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!src.includes("span && span.ambiguous")) return false;
    if (!src.includes('这段出现多处，分不清是哪一处——多选几个字再试')) return false;
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!script.includes('function boldFold(r)')) return false;   // 内嵌上下文也走折公式
    if (!script.includes('return {ambiguous:true}')) return false; // 内嵌定位同源拒绝
    return true;
  });

  check('node-fs-toolbar: 加粗拒绝口径——挨着已有格式/跨空行/代码里都不插 **（宁可拒绝不制造半对）', () => {
    const locate = sandbox._nodeFsBoldLocate;
    const blocked = sandbox._nodeFsBoldBlockedReason;
    if (typeof blocked !== 'function') throw new Error('加粗拒绝口径未挂出');
    const src = '这是**重点**内容。';
    const span = locate(src, '内容', {});
    if (!blocked(src, span)) return false;          // 紧挨 ** ：要拒绝
    // 跨空行：选区真带上了空行（正常已被单段闸拦住，这是兜底）也不插
    if (!blocked('甲\n\n乙', locate('甲\n\n乙', '甲 乙', {}))) return false;
    if (!blocked('```js\nconst a = 1;\n```', locate('```js\nconst a = 1;\n```', 'const a = 1;', {}))) return false; // 代码块
    if (!blocked('行内 `code` 之后', locate('行内 `code` 之后', 'code', {}))) return false;                    // 行内代码
    // 干净的散文段：不拦
    if (blocked('我们来看重点内容。', locate('我们来看重点内容。', '重点内容', {}))) return false;
    return true;
  });

  check('node-fs-toolbar: 加粗双端接线（B 图标钮＋取消加粗拆对＋预览页过桥带 inBold/bt/undo；T507）', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    // 钮面不写中文（2026-11-17 用户拍板）：一枚粗衬线 B，语义走 aria/title
    if (!src.includes('<span class="node-fs-btn-b"')) return false;
    if (src.includes("_nodeFsButtonHtml('bold'")) return false;
    if (!src.includes("if (act === 'bold') { _nodeFsBoldInPage({ range: st.range }); return; }")) return false;
    // 取消加粗走同一条写回管道（undo 摘要分开记）；DOM 判定/拆包/去标记三件都在场
    if (!src.includes('_nodeFsBoldWrite(node, message, next)')) return false;
    if (!src.includes('_nodeFsBoldWrite(node, message, plain, { undo: true })')) return false;
    if (!src.includes('function _nodeFsBoldUnmark(')) return false;
    if (!src.includes('_nodeFsBoldUnwrapEl(strongEl)')) return false;
    // 写回自检：读回不一致就回滚（别留「看着变粗、重开就没了」）；493 起读回走展示
    // 管道、预期值按同一管道算（answer 节点剥 <extend>/建议追问后比对），故对 expected
    if (!src.includes('if (after !== expected)')) return false;
    if (!src.includes("else if (d.action === 'bold')")) return false;
    // 桥：inBold/bt 进消息体，undo 随 ack 回预览页（那边好拆 <strong> 而不是再包一层）
    if (!src.includes('d.inBold === true')) return false;
    if (!src.includes('ok, message, undo, nextToken')) return false;
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!script.includes('function boldSel()') || !script.includes('function boldLocate(')) return false;
    if (!script.includes('postAction("bold",text,"",{before:ctx.before,after:ctx.after')) return false;
    if (!script.includes('inBold:stEl?true:false') || !script.includes('unwrapBold(stEl)')) return false;
    if (!script.includes('wrapBold(range)')) return false;
    if (!script.includes('onDone(!!d.ok,d.message||"",d.undo===true,d)')) return false; // 2026-11-20 起第 4 参＝完整 ack（edit 拿成品 html）
    // file:// 单文件（无桥）不给这颗钮：写不回原文的粗体是假的
    if (!script.includes('if(BRIDGE&&!READONLY)html+="<button type=\\"button\\" class=\\"cp-nfs-btn\\" data-act=\\"bold\\"')) return false;
    return true;
  });

  check('node-fs-toolbar: 取消加粗拆对——**/__/标签三种原文都拆得到；斜体不碰、隔山错配拒绝（T507，2026-11-17 用户报去不掉）', () => {
    const locate = sandbox._nodeFsBoldLocate;
    const unmark = sandbox._nodeFsBoldUnmark;
    if (typeof locate !== 'function' || typeof unmark !== 'function') throw new Error('拆对 API 未挂出');
    // 整段粗体：两侧 ** 一起拆，内容留住
    const full = '这是 **重点** 内容。';
    if (unmark(full, locate(full, '重点', {}), '重点') !== '这是 重点 内容。') throw new Error('整段拆对错');
    // 只选中粗体的一半：拆整段（加粗成段，取消也整段取消）
    const half = '**重点内容** 后文';
    if (unmark(half, locate(half, '内容', {}), '重点内容') !== '重点内容 后文') throw new Error('半截拆对错');
    // ***粗斜体***：只剥粗那层，斜体保留
    const bi = '***重点*** 后文';
    if (unmark(bi, locate(bi, '重点', {}), '重点') !== '*重点* 后文') throw new Error('粗斜体拆对错');
    // 斜体不是粗体：不动
    if (unmark('*重点* 后文', locate('*重点* 后文', '重点', {}), '重点') !== null) throw new Error('斜体被误拆');
    // 隔壁一句的闭 ** 不能被当成新开口（翼规则旁证）
    if (unmark('**甲** *乙* 后文', locate('**甲** *乙* 后文', '乙', {}), '乙') !== null) throw new Error('隔壁闭符被误配');
    // 相邻两段粗体（**甲****乙**）各拆各的
    if (unmark('**甲****乙**', locate('**甲****乙**', '乙', {}), '乙') !== '**甲**乙') throw new Error('相邻粗体拆串了');
    // __…__：整段紧贴可拆
    const u = '前 __重点__ 后';
    if (unmark(u, locate(u, '重点', {}), '重点') !== '前 重点 后') throw new Error('__ 拆对错');
    // 粗体元素可见文字跟标记内原文对不上（嵌套/隔山）不动手——宁可拒绝
    if (unmark('**乙 __重点内容__** 后文', locate('**乙 __重点内容__** 后文', '内容', {}), '重点内容') !== null) {
      throw new Error('隔山错配没被拦下');
    }
    // <strong>/<b> 直写标签：紧贴两侧可拆（标签拆掉、内容留住）
    const tag = '前<strong>重点</strong>后';
    if (unmark(tag, locate(tag, '重点', {}), '重点') !== '前重点后') throw new Error('标签拆对错');
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
    if (!/return \{ text, searchText, rect, range \};/.test(src)) return false;
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

  check('node-fs-toolbar: <formula> 内裸 < 不再被标签剥离吞整条公式——矩形概率公式整条查询命中（T421，用户真实数据）', () => {
    const norm = sandbox._graphSearchPlainText;
    if (typeof norm !== 'function') return false;
    // 用户场景：索引侧 <formula> 内 \mathbb P(a<X\le b,...) 的裸 < 被当标签起点，
    // <[^>]+> 一路吃到 </formula> 的 >，整条公式从索引消失＝「未找到」；修剪成
    // \mathbb P 只能命中同节点另一条无 < 的公式＝「搜到的不是对应的那个」。
    const content = '增量得到：\n<formula>\\mathbb P(a<X\\le b,\\;c<Y\\le d)=F_{X,Y}(b,d)</formula>\n当 \\(f_Y(y)>0\\) 时';
    const indexText = norm(content);
    if (!indexText.includes('a<X\\le b')) return false;
    if (!indexText.includes('F_{X,Y}(b,d)')) return false;
    // 查询侧＝KaTeX annotation 形态（marked 已吃 \; 的反斜杠）过同一根管道，必须命中
    const query = norm('\\mathbb P(a<X\\le b,;c<Y\\le d)=F_{X,Y}(b,d)');
    if (!indexText.includes(query)) return false;
    // 掏块后正文与公式互不干扰：后文 \(...\) 的 > 不再被拖去凑一对
    if (!indexText.includes('当 (f_Y(y)>0) 时')) return false;
    // T420 补漏口径零回归：无 < 的公式照旧、转义模拟照旧
    const joint = norm('$$F_{X,Y}(x,y)=\\mathbb P(X\\le x,\\;Y\\le y)$$');
    if (!joint.includes(norm('F_{X,Y}(x,y)=\\mathbb P(X\\le x,;Y\\le y)'))) return false;
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
      // 2026-11-14：阅读页随主题明暗＋页内明暗开关；ctx 不带 theme 时仍落深色（viewer 老调用）
      const light = sandbox._buildContentPreviewPage('标题', '<p>正文</p>', { nodeId: 'n1', theme: 'light' });
      if (!light.includes('data-theme="light"') || !light.includes('id="cpTheme"')) return false;
      if (!sandbox._buildContentPreviewPage('标题', '<p>正文</p>').includes('data-theme="dark"')) return false;
      return true;
    } finally {
      sandbox.escapeHtml = realEsc;
    }
  });

  check('node-fs-toolbar: 桥四道校验都在场（壳认 source、主应用认 token＋source＋白名单、超时兜底）', () => {
    const shell = readSrc('src/static/content-preview.html');
    if (!shell.includes('ev.source !== frame.contentWindow')) return false;
    if (!shell.includes("'node-fs-action'") || !shell.includes("'node-fs-ack'")) return false;
    if (!shell.includes('3200')) return false; // 兜底比 iframe 自己那枚晚一拍
    const bar = readSrc('src/static/js/node-fs-toolbar.js');
    // 2026-11-17 起 source 校验挪进 _nodeFsPreviewCtxFor（按 token 找窗、已绑定的只认那一个）
    if (!bar.includes('function _nodeFsPreviewCtxFor')) return false;
    if (!bar.includes('if (c.win && c.win !== source) continue;')) return false;
    if (!bar.includes('NODE_FS_BRIDGE_ACTIONS.indexOf(d.action) < 0')) return false;
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

  check('node-fs-toolbar: 正文滚动收浮条，但浮条自身滚动不收（输入框超宽横滚曾把浮条自己关掉，2026-11-17）', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    const live = src.indexOf("document.addEventListener('scroll'");
    if (live < 0) return false;
    if (!src.slice(live, live + 400).includes('_nfsBar.contains(t)')) return false;
    // 预览页内嵌浮条同口径（scroll 不冒泡但 capture 收得到 input 的自身滚动）
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!script.includes('bar.contains(t))return;hideBar();')) return false;
    return true;
  });

  check('node-fs-toolbar: resize 不打断打字（手机软键盘弹出即 resize，展开态只重摆位不收浮条）', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    const live = src.indexOf("window.addEventListener('resize'");
    if (live < 0) return false;
    const seg = src.slice(live, live + 320);
    if (!seg.includes('_nfsState.expanded') || !seg.includes('_nodeFsPlaceBar')) return false;
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!script.includes('state&&state.expanded') || !script.includes('placeBar(picked?picked.rect:null)')) return false;
    return true;
  });

  check('node-fs-toolbar: 桥上下文按 token 认窗（多窗并存 / 刷新后认回 / 旧 token 兜底）', () => {
    const set = sandbox._setNodeFsPreviewCtx;
    const find = sandbox._nodeFsPreviewCtxFor;
    if (typeof set !== 'function' || typeof find !== 'function') throw new Error('上下文 API 未挂出');
    set({ token: 'tkA', nodeId: 'nA', sessionId: 'sA', title: 'A' });
    const winA = { closed: false, tag: 'A' };
    const cA = find('tkA', winA);
    if (!cA || cA.win !== winA) throw new Error('首条消息没能把窗口认回来');
    if (find('tkA', { closed: false, tag: 'B' })) throw new Error('已绑定的窗被别的窗顶替');
    if (find('tkUnknown', winA)) throw new Error('陌生 token 也被认了');
    // 第二个窗并存：不顶掉第一个
    set({ token: 'tkB', nodeId: 'nB', sessionId: 'sB', title: 'B' });
    const winB = { closed: false, tag: 'B' };
    if (!find('tkB', winB)) throw new Error('第二个窗登记失败');
    if (!find('tkA', winA)) throw new Error('开第二个窗把第一个顶掉了（旧单槽病）');
    // 刷新后重建：win=null 的上下文靠第一条消息认窗
    set({ token: 'tkC', nodeId: 'nC', sessionId: 'sC', title: 'C' });
    const rehydrated = find('tkC', winA);
    if (!rehydrated || rehydrated.win !== winA) throw new Error('刷新后重建的上下文认不回来');
    // 静态口径：快照进 sessionStorage、prevToken 兜底、两端超时值
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!src.includes('phymathia_node_fs_preview_ctx')) return false;
    if (!src.includes('sessionStorage.setItem(NODE_FS_PREVIEW_CTX_STORE')) return false;
    if (!src.includes('ctx.prevToken = ctx.token')) return false;
    const shell = readSrc('src/static/content-preview.html');
    if (!shell.includes('3200')) return false;
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!script.includes('2500') || !script.includes('if(d.nextToken)TOKEN=d.nextToken;')) return false;
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

  check('node-fs-toolbar: 开窗补绑按 token 认槽（486：连开两扇，后登记的先开窗不绑错）', () => {
    const set = sandbox._setNodeFsPreviewCtx;
    const attach = sandbox._attachNodeFsPreviewWin;
    const find = sandbox._nodeFsPreviewCtxFor;
    if (typeof set !== 'function' || typeof attach !== 'function' || typeof find !== 'function') throw new Error('上下文 API 未挂出');
    // 真实时序：A 先登记（渲染 await 里），B 插队登记并先开窗——旧「第一个空槽」口径会把
    // A 的窗绑到 B 的槽上，加粗/追问跟着落到别的节点
    set({ token: 'tk486A', nodeId: 'nA', sessionId: 'sA', title: 'A' });
    set({ token: 'tk486B', nodeId: 'nB', sessionId: 'sB', title: 'B' });
    const winA = { closed: false, tag: 'A' };
    const winB = { closed: false, tag: 'B' };
    attach(winA, 'tk486A');
    attach(winB, 'tk486B');
    if (!find('tk486A', winA)) throw new Error('A 窗没绑到 A 槽（旧口径会绑去 B）');
    if (!find('tk486B', winB)) throw new Error('B 窗没绑到 B 槽');
    if (find('tk486A', winB) || find('tk486B', winA)) throw new Error('窗和槽交叉串绑');
    // 收尾：弹掉本次两条，别漏给后面的用例
    set(null); set(null);
    return true;
  });

  check('node-fs-toolbar: 新窗口交接键按 token 分键（486：静态单键连开两扇必串窗）', () => {
    const gc = readSrc('src/static/js/graph-custom.js');
    // 键带 token 后缀；token 走 URL（window.open 那一刻唯一可靠的逐窗通道）
    if (!gc.includes("'phymathia_content_preview_' + handoffToken")) return false;
    if (!gc.includes("'phymathia_content_preview_theme_' + handoffToken")) return false;
    if (!gc.includes("'/content-preview.html?t='")) return false;
    if (!gc.includes('_attachNodeFsPreviewWin(win, ctx && ctx.token)')) return false;
    // 写键失败/弹窗被拦两条路径都收自己的键，不给同标签页留孤儿键吃配额
    if (!gc.includes('sessionStorage.removeItem(handoffKey)')) return false;
    const shell = readSrc('src/static/content-preview.html');
    if (!shell.includes("location.search.match(/[?&]t=([^&]+)/)")) return false;
    if (!shell.includes("'phymathia_content_preview_' + t")) return false;
    if (!shell.includes('A-Za-z0-9_-]')) return false; // token 白名单过滤后才拼键
    return true;
  });

  check('node-fs-toolbar: 回答方式可选（直接回答／问题分析／自动判断），选择沿用上次（2026-11-17 用户报）', () => {
    const set = sandbox._nodeFsRouteSet;
    const cur = sandbox._nodeFsRouteCurrent;
    if (typeof set !== 'function' || typeof cur !== 'function') throw new Error('回答方式 API 未挂出');
    const auto = () => sandbox.followupAutoRouteEnabled();
    const saved = () => sandbox.localStorage.getItem('phymathia_node_fs_followup_route');
    sandbox.localStorage.removeItem('phymathia_followup_auto_route');
    sandbox.localStorage.removeItem('phymathia_node_fs_followup_route');
    if (auto()) throw new Error('总开关默认应为关');
    // 手动档：选中即记，且落盘（下次划词沿用）
    set('direct');
    if (cur() !== 'direct') throw new Error('选了直接回答却没生效');
    if (saved() !== 'direct') throw new Error('选择没落盘，下次划词会丢');
    // 总开关关时 auto 不收（不许悄悄发那次判断请求）
    set('auto');
    if (cur() !== 'direct') throw new Error('总开关关着还接受了自动判断');
    // 总开关开：auto 可用；关掉后自动降级 analysis，不把人锁在已退役的档上
    sandbox.localStorage.setItem('phymathia_followup_auto_route', '1');
    set('auto');
    if (cur() !== 'auto') throw new Error('总开关开着却选不了自动判断');
    sandbox.localStorage.removeItem('phymathia_followup_auto_route');
    if (cur() !== 'analysis') throw new Error('总开关关掉后 auto 应降级 analysis');
    // 降级只发生在返回值、缓存仍存原始档（492）：再开总开关要回到 auto，
    // 旧实现把降级结果 'analysis' 写进缓存，重开开关也不恢复（要刷新）
    sandbox.localStorage.setItem('phymathia_followup_auto_route', '1');
    if (cur() !== 'auto') throw new Error('总开关重开没恢复自动判断（缓存粘滞）');
    sandbox.localStorage.removeItem('phymathia_followup_auto_route');
    // 复位，别让本用例的残留影响后续用例
    set('analysis');
    sandbox.localStorage.removeItem('phymathia_node_fs_followup_route');
    return true;
  });

  check('node-fs-toolbar: 回答方式接线（本页浮条→followupRoute；预览窗带 route 过桥并过白名单）', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    // 本页全屏浮条：展开行渲染三档，发送时把当前档交给 startQuestionWorkflow
    if (!src.includes("_nodeFsRouteButtonsHtml('node-fs-route')")) return false;
    if (!src.includes('followupRoute: route || _nodeFsRouteCurrent()')) return false;
    // 桥：预览页带来的 route 先过白名单（非法值当没选）
    if (!src.includes("d.route === 'direct'")) return false;
    if (!src.includes('_nodeFsBridgedFollowup(node, text, route)')) return false;
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T', route: 'direct' });
    if (!script.includes('var ROUTE=') || !script.includes('var ROUTE_AUTO=')) return false;
    if (!script.includes('routeHtml()')) return false;              // 胶囊进输入行
    if (!script.includes('postAction("followup",composed,ROUTE)')) return false; // 档位随消息走
    if (!script.includes('route:String(route||"")')) return false;  // 消息体带 route 字段
    if (!/"route":"direct"/.test(script)) return false;             // 初始值按主应用那档带过去
    const css = readSrc('src/static/css/graph-override.css');
    if (!css.includes('.node-fs-route-btn.is-current')) return false;
    return true;
  });

  check('node-fs-toolbar: 浮条样式进 graph-override.css（胶囊＋引文输入行＋窄屏图标化＋加粗 B 字形）', () => {
    const css = readSrc('src/static/css/graph-override.css');
    if (css.includes('.node-fs-more') || css.includes('node-fs-menu-item')) return false; // ⋯ 菜单已随工具条收窄退役
    return css.includes('.node-fs-bar')
      && css.includes('.node-fs-input')
      && css.includes('.node-fs-quote-chip')
      && css.includes('.node-fs-btn-b')
      && css.includes('@media (max-width: 520px)');
  });

  // ---------- 渲染态直接编辑（node-fs-edit.js，2026-11-18）----------

  // 序列化器吃的是最小 DOM 面（nodeType/tagName/childNodes/textContent/getAttribute/
  // classList.contains/querySelector），用假节点就能做行为断言——不依赖真 DOM。
  const editEl = (tag, kids, extra) => Object.assign({
    nodeType: 1,
    tagName: tag,
    childNodes: kids || [],
    classList: { contains: () => false },
    getAttribute: () => null,
    querySelector: () => null,
    textContent: '',
  }, extra || {});
  const editT = (v) => ({ nodeType: 3, nodeValue: v });
  const editKatex = (tex, display) => editEl('SPAN', [], {
    classList: { contains: (c) => c === 'katex' || (!!display && c === 'katex-display') },
    closest: () => null,
    querySelector: (sel) => (String(sel).indexOf('annotation') >= 0 ? { textContent: tex } : null),
    textContent: tex,
  });

  check('node-fs-edit: 序列化往返——标题/强调/链接/列表/引用/代码/分割线/公式都拼回原文', () => {
    const ser = sandbox._nodeFsSerializeContent;
    if (typeof ser !== 'function') throw new Error('序列化 API 未挂出');
    const codeEl = editEl('CODE', [], { className: 'language-js', textContent: 'const a = 1;' });
    const doc = editEl('DIV', [
      editEl('H2', [editT('恒定电流')]),
      editEl('P', [
        editT('电流的 '),
        editEl('STRONG', [editT('定义')]),
        editT(' 是 '),
        editEl('EM', [editT('电荷')]),
        editT(' 的定向移动，见 '),
        editEl('A', [editT('维基')], { getAttribute: (a) => (a === 'href' ? 'https://w.org' : null) }),
        editT('。'),
      ]),
      editEl('UL', [
        editEl('LI', [editT('第一项')]),
        editEl('LI', [editT('第二项'), editEl('UL', [editEl('LI', [editT('子项')])])]),
      ]),
      editEl('OL', [editEl('LI', [editT('有序甲')]), editEl('LI', [editT('有序乙')])]),
      editEl('BLOCKQUOTE', [editEl('P', [editT('引用一句')])]),
      // pre 的代码文本从 code 子元素读（querySelector 取不到就读空）
      editEl('PRE', [codeEl], { querySelector: (sel) => (sel === 'code' ? codeEl : null) }),
      editEl('HR', []),
      editEl('P', [editT('行内公式 '), editKatex('E=mc^2', false), editT(' 与展示公式 '), editKatex('F=ma', true), editT(' 收尾。')]),
    ]);
    const got = ser(doc);
    const want = '## 恒定电流\n\n'
      + '电流的 **定义** 是 *电荷* 的定向移动，见 [维基](https://w.org)。\n\n'
      + '- 第一项\n- 第二项\n  - 子项\n\n'
      + '1. 有序甲\n2. 有序乙\n\n'
      + '> 引用一句\n\n'
      + '```js\nconst a = 1;\n```\n\n'
      + '---\n\n'
      + '行内公式 $E=mc^2$ 与展示公式 $$F=ma$$ 收尾。';
    if (got !== want) throw new Error('序列化不一致：\n【得】' + got + '\n【期】' + want);
    return true;
  });

  check('node-fs-edit: 管道表/mermaid/viz 原子块还原（viz 存的是成品 iframe 源，桥剥离由源码口径守）', () => {
    const ser = sandbox._nodeFsSerializeContent;
    const doc = editEl('DIV', [
      editEl('TABLE', [
        editEl('THEAD', [
          editEl('TR', [
            editEl('TH', [editT('名称')], { getAttribute: (a) => (a === 'style' ? 'text-align: center' : null) }),
            editEl('TH', [editT('值')]),
          ]),
        ]),
        editEl('TBODY', [
          editEl('TR', [editEl('TD', [editT('质量')]), editEl('TD', [editT('1 kg')])]),
        ]),
      ]),
      editEl('DIV', [], {
        classList: { contains: (c) => c === 'mermaid-container' },
        querySelector: (sel) => (sel === '.mermaid-source'
          ? { getAttribute: (a) => (a === 'data-mermaid-src' ? encodeURIComponent('<b>&gt;</b>') : null) }
          : null),
      }),
      editEl('DIV', [], {
        id: 'viz_fs_smoke',
        classList: { contains: (c) => c === 'viz-card' },
      }),
    ]);
    // _vizStore 是 render.js 顶层 const（词法全局，不在 VM global 对象上）——
    // 种值/清桩都必须进 VM 跑，沙箱外读 sandbox._vizStore 恒 undefined
    vm.runInContext('_vizStore.viz_fs_smoke = "<html><body>成品源（含桥）</body></html>"', sandbox);
    // _unescapeHtmlEntities 走 textarea 的 innerHTML→value DOM 往返，冒烟混合桩下
    // 取值会被归成 0（README T431 同款坑）——按 escapeHtml 用例先例换真实现
    const realUnesc = sandbox._unescapeHtmlEntities;
    sandbox._unescapeHtmlEntities = (s) => String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    try {
      const got = ser(doc);
      const want = '| 名称 | 值 |\n| :---: | --- |\n| 质量 | 1 kg |'
        + '\n\n```mermaid\n<b>></b>\n```'   // decodeURIComponent ＋实体还原（&gt; 呛 KaTeX 的老坑）
        + '\n\n```html\n<html><body>成品源（含桥）</body></html>\n```';
      if (got !== want) throw new Error('原子块序列化不一致：\n【得】' + got + '\n【期】' + want);
    } finally {
      sandbox._unescapeHtmlEntities = realUnesc;
      vm.runInContext('delete _vizStore.viz_fs_smoke', sandbox);
    }
    // 桥剥离认 render.js 顶层 const（词法全局，不在 window 上）——直接按名引用
    const src = readSrc('src/static/js/node-fs-edit.js');
    for (const name of ['_VIZ_MATH_BRIDGE', '_VIZ_THEME_BRIDGE', '_VIZ_CHECK_BRIDGE']) {
      if (!src.includes("typeof " + name + " === 'string'")) return false;
    }
    return true;
  });

  check('node-fs-edit: 资格闸——blank 直接拒绝；API 挂出；保存走加粗同一条写回链路（换文案不换机制）', () => {
    const avail = sandbox._nodeFsEditAvailable;
    for (const fn of ['_nodeFsEditAvailable', '_nodeFsEditActive', '_nodeFsEditCloseGuard', '_nodeFsEditRoundTripDiff', 'openNodeFsEdit', 'saveNodeFsEdit', 'cancelNodeFsEdit', '_nodeFsEditVisibleFacts']) {
      if (typeof sandbox[fn] !== 'function') throw new Error(fn + ' 未暴露');
    }
    if (avail(null) !== false) return false;
    if (avail({ kind: 'blank' }) !== false) throw new Error('blank 节点必须拒绝渲染态编辑（整篇写回会丢 XML 分节）');
    const src = readSrc('src/static/js/node-fs-edit.js');
    if (!src.includes('_nodeFsBoldAvailable(node)')) return false;       // 与划词加粗同闸
    if (!src.includes("summary: '渲染态编辑'")) return false;
    // 可见文本自检（2026-11-20 真机重写）：两边都取「渲染后的可见文字」按加粗同管归一对撞；入场往返校验过 renderMarkdown 管道
    if (!src.includes("_nodeFsBoldScan(left.text).text") || !src.includes("_nodeFsBoldScan(right.text).text")) return false;
    if (!src.includes('_nodeFsEditSignature(src)') || !src.includes('_nodeFsEditSignature(domMd)')) return false;
    // 人工定稿（T355）＋自有节点落盘，双 typeof 守卫
    if (!src.includes("_markNodeHumanFinalized(node)") || !src.includes('_saveCustomNodes()')) return false;
    return true;
  });

  check('node-fs-edit: 接线三处——头部按钮资格闸/关闭守卫/浮条编辑态收声，加粗老调用零变化', () => {
    const gc = readSrc('src/static/js/graph-custom.js');
    if (!gc.includes("typeof _nodeFsEditAvailable === 'function' && _nodeFsEditAvailable(node)")) return false;
    if (!gc.includes("openNodeFsEdit(\\''")) return false; // onclick="openNodeFsEdit('id')"
    if (!gc.includes("typeof _nodeFsEditCloseGuard === 'function' && _nodeFsEditCloseGuard()")) return false;
    const bar = readSrc('src/static/js/node-fs-toolbar.js');
    if (!bar.includes("typeof _nodeFsEditActive === 'function' && _nodeFsEditActive()")) return false;
    // 加粗调用点保持原样（老契约）：冒烟上一条断言认这个串
    if (!bar.includes('_nodeFsBoldWrite(node, message, next)')) return false;
    if (!bar.includes("function _nodeFsBoldWrite(node, message, next, opts)")) return false;
    if (!bar.includes("(opts && opts.okMessage) || (undo ? '已取消加粗' : '已加粗')")) return false;
    // 编辑态 Esc capture：有改动拦下指路、干净退出编辑（关全屏是下一拍）
    const edit = readSrc('src/static/js/node-fs-edit.js');
    const escAt = edit.indexOf("ev.key !== 'Escape'");
    if (escAt < 0) return false;
    if (edit.slice(escAt, escAt + 300).indexOf('stopPropagation') < 0) return false;
    if (edit.slice(escAt, escAt + 700).indexOf('}, true);') < 0) return false;
    // 编辑态样式与 hint 进 CSS（编辑面虚线框＋原子块 hover 描边）
    const css = readSrc('src/static/css/graph-override.css');
    if (!css.includes('.graph-node-fs-content[data-editing="1"]')) return false;
    if (!css.includes('.graph-node-fs-edit-hint')) return false;
    if (!css.includes('.mermaid-container:hover')) return false;
    return true;
  });

  check('node-fs-edit: 构建顺序在 node-fs-toolbar 之后、app.js 产物已含本模块', () => {
    const bf = readSrc('scripts/build_frontend.mjs');
    const a = bf.indexOf("'node-fs-toolbar.js'");
    const b = bf.indexOf("'node-fs-edit.js'");
    if (a < 0 || b < 0 || b < a) return false;
    if (!code.includes('_nodeFsSerializeContent')) return false; // 漏注册守卫之外的行为面确认
    return true;
  });

  // ---------- 生成中写回防护＋预览桥加固（2026-11-18 排查修复）----------

  check('node-fs-toolbar: 忙态闸——生成中拒加粗/拒编辑，写回路径再查一次（流式截断防护）', () => {
    const realState = sandbox._graphState;
    const realUndo = sandbox._pushGraphUndo;
    const realSave = sandbox._saveGraphState;
    const realRender = sandbox.renderGraphCanvas;
    const realReadonly = sandbox.phyIsReadonly;
    const state = {
      nodes: [
        { id: 'n_busy', kind: 'answer', messageIndex: 0, busy: true },
        { id: 'n_idle', kind: 'answer', messageIndex: 1, busy: false },
        { id: 'n_regen', kind: 'answer', messageIndex: 2, busy: false },
      ],
      customNodes: [],
      harnessNodeOverrides: {},
    };
    try {
      sandbox._graphState = () => state;
      sandbox._pushGraphUndo = () => {};
      sandbox._saveGraphState = () => {};
      sandbox.renderGraphCanvas = () => {};
      sandbox.phyIsReadonly = () => false;
      // _regeneratingNodes 是 graph-interact.js 顶层 const（词法全局）——种值进 VM
      vm.runInContext('_regeneratingNodes.add("n_regen")', sandbox);
      const busy = sandbox._nodeFsNodeBusy;
      const avail = sandbox._nodeFsBoldAvailable;
      if (typeof busy !== 'function') throw new Error('忙态闸 API 未挂出');
      if (!busy({ id: 'n_busy' })) return false;   // 活节点 busy（从 state 取，不信入参快照）
      if (!busy({ id: 'n_regen' })) return false;  // 重生成名单
      if (busy({ id: 'n_idle' })) return false;
      if (avail(state.nodes[0])) return false;     // 生成中拒加粗
      if (avail(state.nodes[2])) return false;
      if (!avail(state.nodes[1])) throw new Error('空闲节点被误拒');
      // 渲染态编辑继承同闸（_nodeFsEditAvailable 委托 _nodeFsBoldAvailable）
      if (sandbox._nodeFsEditAvailable(state.nodes[0])) return false;
      if (!sandbox._nodeFsEditAvailable(state.nodes[1])) throw new Error('空闲节点编辑被误拒');
      // 写回再查一次：可用性判定之后生成才启动也拦得住，且不落覆盖
      const res = sandbox._nodeFsBoldWrite(state.nodes[0], { role: 'assistant', content: '半截回答' }, '半截**回答**');
      if (res.ok) throw new Error('生成中写回没拦住');
      if (!String(res.message).includes('生成')) return false;
      if (state.harnessNodeOverrides['n_busy']) throw new Error('拦下了却仍写了覆盖');
      return true;
    } finally {
      sandbox._graphState = realState;
      sandbox._pushGraphUndo = realUndo;
      sandbox._saveGraphState = realSave;
      sandbox.renderGraphCanvas = realRender;
      sandbox.phyIsReadonly = realReadonly;
      vm.runInContext('_regeneratingNodes.delete("n_regen")', sandbox);
    }
  });

  check('node-fs-toolbar: 加粗写回不吃展示剥口——override 保留建议追问与 meta（493）', () => {
    const realState = sandbox._graphState;
    const realHistory = sandbox._getChatHistory;
    const realUndo = sandbox._pushGraphUndo;
    const realSave = sandbox._saveGraphState;
    const realRender = sandbox.renderGraphCanvas;
    const realReadonly = sandbox.phyIsReadonly;
    // socratic 反馈 answer：展示文本剥建议追问＋meta（graph-data 展示管道），
    // 旧实现把剥后版当节点正文落 override，Φ 快照/apply 从此只见剥后版
    const content = '讲解正文，关键结论是勾股定理。'
      + '\n1. [基础] 什么是直角三角形？\n2. [进阶] 如何证明？'
      + '\n<socratic_meta correct="correct" />';
    const state = {
      nodes: [{ id: 'n_sq', kind: 'answer', messageIndex: 0, busy: false }],
      customNodes: [],
      harnessNodeOverrides: {},
    };
    const messages = [{ role: 'assistant', branchType: 'socratic', content }];
    try {
      sandbox._graphState = () => state;
      sandbox._getChatHistory = () => messages;
      sandbox._pushGraphUndo = () => {};
      sandbox._saveGraphState = () => {};
      sandbox.renderGraphCanvas = () => {};
      sandbox.phyIsReadonly = () => false;
      const display = sandbox._nodeFsSourceText(state.nodes[0], messages[0]);
      if (display.includes('[基础]')) throw new Error('展示管道没剥建议追问，用例前提不成立');
      const res = sandbox._nodeFsBoldFromBridge(state.nodes[0], '勾股定理', '关键结论是', '。');
      if (!res.ok) throw new Error('加粗被拒：' + res.message);
      const ov = state.harnessNodeOverrides['n_sq'];
      if (!ov) throw new Error('覆盖没落盘');
      // 插入位置按真原文算：标记插进未剥原文，剥掉的建议追问与 meta 原样保留
      if (!ov.content.includes('**勾股定理**')) throw new Error('标记没插进原文');
      if ((ov.content.match(/\*\*/g) || []).length !== 2) throw new Error('标记不成对');
      if (!ov.content.includes('[基础]') || !ov.content.includes('<socratic_meta')) {
        throw new Error('override 吃了展示剥口，建议追问/meta 被剥掉落盘');
      }
      return true;
    } finally {
      sandbox._graphState = realState;
      sandbox._getChatHistory = realHistory;
      sandbox._pushGraphUndo = realUndo;
      sandbox._saveGraphState = realSave;
      sandbox.renderGraphCanvas = realRender;
      sandbox.phyIsReadonly = realReadonly;
    }
  });

  check('node-fs-toolbar: 快照带 prevToken＋登记前先认回旧窗（超时+刷新／先开新窗两场景）', () => {
    // 沙箱默认无 sessionStorage（源码 typeof 守卫静默退纯内存）——本用例临时种一个，
    // finally 拆掉还原；_nfsPreviewCtxs 是词法 let，清表进 VM
    const hadSession = Object.prototype.hasOwnProperty.call(sandbox, 'sessionStorage');
    const realSession = sandbox.sessionStorage;
    const mem = {};
    sandbox.sessionStorage = {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; },
    };
    try {
      vm.runInContext('_nfsPreviewCtxs = []', sandbox);
      const set = sandbox._setNodeFsPreviewCtx;
      // 场景①：token 轮换后超时，预览窗继续用旧 token——prevToken 必须一起落盘
      set({ token: 'tkNew', nodeId: 'n1', sessionId: 's1', title: '窗' });
      vm.runInContext('_nfsPreviewCtxs[0].prevToken = "tkOld"; _nodeFsPersistPreviewCtx();', sandbox);
      const stored = JSON.parse(mem['phymathia_node_fs_preview_ctx'] || '[]');
      if (!stored.length || stored[0].prevToken !== 'tkOld') throw new Error('prevToken 没落快照');
      // 刷新：表清空后从快照认回，旧 token 仍放行（否则永久锁窗）
      vm.runInContext('_nfsPreviewCtxs = []; _nodeFsRestorePreviewCtx();', sandbox);
      if (!sandbox._nodeFsPreviewCtxFor('tkOld', { closed: false })) throw new Error('刷新后旧 token 认不回');
      // 场景②：刷新后先开新窗——登记前必须先合并旧窗快照，旧窗不能失联
      vm.runInContext('_nfsPreviewCtxs = []', sandbox);
      set({ token: 'tkFresh', nodeId: 'n2', sessionId: 's1', title: '新窗' });
      const tokens = vm.runInContext('_nfsPreviewCtxs.map(c => c.token)', sandbox);
      if (!tokens.includes('tkNew') || !tokens.includes('tkFresh')) throw new Error('先开新窗把旧窗快照挤掉了');
      if (!sandbox._nodeFsPreviewCtxFor('tkOld', { closed: false })) throw new Error('旧窗永久失联');
      return true;
    } finally {
      vm.runInContext('_nfsPreviewCtxs = []', sandbox);
      if (hadSession) sandbox.sessionStorage = realSession;
      else delete sandbox.sessionStorage;
    }
  });

  check('node-fs-toolbar: ack 按序号认领——并发动作不串台（主应用回显/壳转发/内嵌认领三处同改）', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!src.includes('seq: d.seq, ok, message, undo, nextToken')) return false; // 主应用回显（T507 起带 undo）
    if (!src.includes('seq:++SEQ')) return false;                          // 内嵌自增序号
    if (!src.includes('d.seq!==msg.seq')) return false;                    // 内嵌只认自己的
    const shell = readSrc('src/static/content-preview.html');
    if (!shell.includes('ad.seq !== d.seq')) return false;                 // 壳只转发本动作
    if (!shell.includes('seq: d.seq, ok: false')) return false;            // 合成失败也带序号
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!script.includes('var SEQ=0;')) return false;
    // 老主应用不回显 seq 时照旧放行（typeof 守卫）——刷新后的旧预览窗向后兼容
    if (!script.includes('typeof d.seq==="number"')) return false;
    return true;
  });

  // ---------- 渲染态编辑过桥（新窗口预览页，2026-11-20）----------

  check('node-fs-edit 新窗口: 桥收口——edit 进动作表，接收端异步收口带成品 html，壳兜底放宽', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!src.includes("const NODE_FS_BRIDGE_ACTIONS = ['followup', 'search', 'bold', 'edit']")) return false;
    if (!src.includes('async function _nodeFsPreviewAction(d, source, ctx)')) return false; // 收口拆出（edit 要等成品重渲）
    if (!src.includes('await _nodeFsEditRenderFresh(node, res.src)')) return false;
    // ack 里 nextToken 仍紧跟 undo（既有 seq 断言认这个串），成品 html 排在其后
    if (!src.includes('undo, nextToken, html }')) return false;
    // 校验/写回（同步段）＋重渲（异步段）分居 node-fs-edit.js，五件套全暴露
    const edit = readSrc('src/static/js/node-fs-edit.js');
    for (const fn of ['_nodeFsEditSrcSig', '_nodeFsEditParseProbe', '_nodeFsEditFromBridge', '_nodeFsEditRenderFresh', '_nodeFsEditRefreshOverlayBody']) {
      if (!edit.includes('function ' + fn)) throw new Error(fn + ' 未定义');
      if (typeof sandbox[fn] !== 'function') throw new Error(fn + ' 未暴露');
    }
    if (!edit.includes('NODE_FS_EDIT_HTML_MAX = 2000000')) return false; // innerHTML 不截断，超限硬拒
    if (!edit.includes("summary: '渲染态编辑（新窗口）'")) return false;
    const shell = readSrc('src/static/content-preview.html');
    if (!shell.includes("d.action === 'edit' ? 11000 : 3200")) return false;
    return true;
  });

  check('node-fs-edit 新窗口: 内嵌编辑面——铅笔/保存取消/Esc 守卫/浮条收声/html 过桥', () => {
    const script = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T', editable: true, srcSig: 'sig1' });
    if (!script.includes('"editable":true') || !script.includes('"srcSig":"sig1"')) return false; // conf 带过去
    const scriptOff = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 't', nodeId: 'n', title: 'T' });
    if (!scriptOff.includes('"editable":false')) return false; // 没传就缺省 false＝铅笔缺席
    new Function(script); new Function(scriptOff); // 坏拼接当场炸
    for (const s of ['id="cpEdit"', 'cpEditSave', 'cpEditCancel', 'cp-edit-hint', 'function enterEdit()', 'function saveEdit()', 'function cancelEdit()', 'msg.html=String(extra.html)', 'var TMO=action==="edit"?10000:2500', 'if(EDITING)return;if(state&&state.expanded)return']) {
      if (!script.includes(s)) throw new Error('生成脚本缺：' + s);
    }
    // 编辑中 Esc 先管编辑（文案与全屏层同款）；onDone 第 4 参拿完整 ack（成品 html 在上面）
    if (!script.includes('if(EDITING){ev.preventDefault();ev.stopPropagation();')) return false;
    if (!script.includes('onDone(!!d.ok,d.message||"",d.undo===true,d)')) return false;
    // 开窗侧接线：资格闸＋入场往返校验＋原文指纹，boot 暴露 recalcMeta
    const gc = readSrc('src/static/js/graph-custom.js');
    if (!gc.includes('!_nodeFsEditRoundTripDiff(text, _nodeFsSerializeContent(holder))')) return false;
    if (!gc.includes('srcSig = _nodeFsEditSrcSig(text)')) return false;
    if (!gc.includes('window.recalcMeta=recalcMeta')) return false;
    return true;
  });

  check('node-fs-edit 新窗口: 桥上保存行为——custom 轨写回＋人工定稿＋全屏刷新；指纹变过/全屏冲突拒', () => {
    const realState = sandbox._graphState;
    const realHistory = sandbox._getChatHistory;
    const realUndo = sandbox._pushGraphUndo;
    const realSave = sandbox._saveGraphState;
    const realRender = sandbox.renderGraphCanvas;
    const realReadonly = sandbox.phyIsReadonly;
    const realFinalize = sandbox._markNodeHumanFinalized;
    const realSaveCustom = sandbox._saveCustomNodes;
    const realFresh = sandbox._nodeFsEditRenderFresh;
    const realOverlay = sandbox._nodeFsEditRefreshOverlayBody;
    const state = {
      nodes: [{ id: 'n_cp', kind: 'summary', messageIndex: -1, busy: false, content: '原始正文' }],
      customNodes: [{ id: 'n_cp', kind: 'summary', content: '原始正文' }],
      harnessNodeOverrides: {},
    };
    let finalized = 0; let savedCustom = 0; const overlayRefresh = [];
    try {
      sandbox._graphState = () => state;
      sandbox._getChatHistory = () => [];
      sandbox._pushGraphUndo = () => {};
      sandbox._saveGraphState = () => {};
      sandbox.renderGraphCanvas = () => {};
      sandbox.phyIsReadonly = () => false;
      sandbox._markNodeHumanFinalized = () => { finalized++; };
      sandbox._saveCustomNodes = () => { savedCustom++; };
      sandbox._nodeFsEditRenderFresh = () => null;   // 异步重渲段不进本用例（域文件只写同步用例）
      sandbox._nodeFsEditRefreshOverlayBody = (id) => { overlayRefresh.push(id); };
      // probe 根用假 DOM 最小面；textContent 要给真值——可见文本自检读的是它
      const probe = editEl('DIV', [editEl('P', [editT('改过的正文')])], { textContent: '改过的正文' });
      const sig = sandbox._nodeFsEditSrcSig('原始正文');
      // 指纹不对（开窗后原文被更新过）：拒绝且不写
      const stale = sandbox._nodeFsEditFromBridge(state.nodes[0], '<p>x</p>', 'bad_sig', probe);
      if (stale.ok || !String(stale.message).includes('更新')) throw new Error('指纹对账没拦住: ' + stale.message);
      if (state.customNodes[0].content !== '原始正文') throw new Error('拒绝却动了正文');
      // 本页全屏层正在编辑同一节点：拒绝（否则桥上写回会被那边的旧 DOM 保存整篇冲掉）
      vm.runInContext('_nodeFsEditSession = { nodeId: "n_cp", dirty: true }', sandbox);
      const conflict = sandbox._nodeFsEditFromBridge(state.nodes[0], '<p>x</p>', sig, probe);
      if (conflict.ok || !String(conflict.message).includes('全屏')) throw new Error('全屏冲突没拦住');
      vm.runInContext('_nodeFsEditSession = null', sandbox);
      // 正常路：写回 custom 轨＋人工定稿＋落盘钩子＋全屏刷新都被调
      const ok = sandbox._nodeFsEditFromBridge(state.nodes[0], '<p>x</p>', sig, probe);
      if (!ok.ok) throw new Error('正常保存被拒：' + ok.message);
      if (state.customNodes[0].content !== '改过的正文') throw new Error('正文没写进 custom 轨');
      if (state.nodes[0].content !== '改过的正文') throw new Error('节点 content 没跟上');
      if (!finalized || !savedCustom) throw new Error('人工定稿/落盘钩子没走');
      if (overlayRefresh[overlayRefresh.length - 1] !== 'n_cp') throw new Error('全屏层刷新没调');
      return true;
    } finally {
      sandbox._graphState = realState;
      sandbox._getChatHistory = realHistory;
      sandbox._pushGraphUndo = realUndo;
      sandbox._saveGraphState = realSave;
      sandbox.renderGraphCanvas = realRender;
      sandbox.phyIsReadonly = realReadonly;
      sandbox._markNodeHumanFinalized = realFinalize;
      sandbox._saveCustomNodes = realSaveCustom;
      sandbox._nodeFsEditRenderFresh = realFresh;
      sandbox._nodeFsEditRefreshOverlayBody = realOverlay;
      vm.runInContext('_nodeFsEditSession = null', sandbox);
    }
  });
}
