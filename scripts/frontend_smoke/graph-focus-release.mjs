// 画布按下补「输入框失焦」（2026-11-24 用户实测）：卡头/空白/端口/分组这些手势入口都在
// pointerdown 上 preventDefault（防拖拽时选中文本、触发原生拖放），而浏览器的「点别处 →
// 输入框失焦」是 mousedown 的默认动作，被一并吞掉——点进问题节点的输入栏后，点卡头、点
// 空白焦点都退不出：Delete/Backspace 走 _handleGraphKeydown 的输入框放行＝删字符不删节点；
// textarea 的 change 永不触发＝「失焦即存」的内容不落盘、刷新即丢。修法：画布 pointerdown
// 入口（button 过滤之后、任何手势入口之前）调 _releaseGraphTextFocus(e.target) 照浏览器
// 原口径补一次 blur。回归两面：真派发 pointerdown 的行为（换记录型假画布重挂处理器，
// 用毕还原——纯同步、不碰任何 window 桩）、接线契约。焦点与光标是浏览器行为，沙箱只能证
// 「blur 在该在的时机被调用」；真机口径（隔离实例）见 docs/日志/2026-11-24.md。
import fs from 'node:fs';
import { check, sandbox, vm } from './_runner.mjs';

export function run() {
check('graph-focus-release: 画布按下补失焦——焦点在输入框时点卡头/空白/端口先 blur 再进手势；点输入框/按钮/链接不抢；焦点不在输入框不动', () => {
  if (typeof sandbox._releaseGraphTextFocus !== 'function') throw new Error('_releaseGraphTextFocus 未暴露');
  // 最小假元素：closest(sel) 按「选择器列表里有没有自己的名字」应答
  const mkEl = (name, extra) => Object.assign({
    dataset: {},
    closest(sel) { return sel.split(',').map(s => s.trim()).includes(name) ? this : null; },
  }, extra || {});
  // graphCanvas/graphView 是 let 绑定、不挂在全局对象上，换桩只能在 vm 上下文里做；
  // 跨边界共享件 Node 侧建、沙箱内按全局名取，还原闭包由沙箱内生成（finally 倒序执行）
  const seq = [];
  const handlers = {};
  const restore = [];
  const prevDoc = sandbox.document;
  sandbox.__fxSeq = seq;
  sandbox.__fxHandlers = handlers;
  sandbox.__fxRestore = restore;
  sandbox.__fxMK = mkEl;
  try {
    const got = vm.runInContext([
      '(function () {',
      '  var prevCanvas = graphCanvas;',
      '  __fxRestore.push(function () { graphCanvas = prevCanvas; });',
      // 换记录型假画布重挂处理器，把 pointerdown 监听抓在手里
      '  graphCanvas = { addEventListener: function (type, fn) { __fxHandlers[type] = fn; } };',
      '  _initGraphCanvasEvents();',
      '  graphCanvas = prevCanvas;',
      '  var prevDrag = _startNodeDrag, prevPan = _startCanvasPan, prevLink = _startLinkDrag;',
      '  __fxRestore.push(function () { _startNodeDrag = prevDrag; _startCanvasPan = prevPan; _startLinkDrag = prevLink; });',
      '  _startNodeDrag = function () { __fxSeq.push("node"); };',
      '  _startCanvasPan = function () { __fxSeq.push("pan"); };',
      '  _startLinkDrag = function () { __fxSeq.push("link"); };',
      '  var prevMode = graphView.selectMode, prevBound = graphView.keyHandlerBound;',
      '  __fxRestore.push(function () { graphView.selectMode = prevMode; graphView.keyHandlerBound = prevBound; });',
      '  graphView.selectMode = false;',
      '  return typeof __fxHandlers.pointerdown;',
      '})()',
    ].join('\n'), sandbox);
    if (got !== 'function') throw new Error('没抓到画布 pointerdown 处理器：' + got);
    const press = (activeEl, targetName) => {
      // document 整体换成「原型＝原桩、只盖 activeElement」的临时对象，用毕原样换回
      sandbox.document = Object.assign(Object.create(prevDoc), { activeElement: activeEl });
      return vm.runInContext('__fxSeq.length = 0;'
        + ' __fxHandlers.pointerdown({ button: 0, target: __fxMK("' + targetName + '"), preventDefault: function () {}, stopPropagation: function () {} });'
        + ' __fxSeq.join(",")', sandbox);
    };
    const ta = () => mkEl('textarea', { blur() { seq.push('blur'); } });
    const editable = () => mkEl('div', { isContentEditable: true, blur() { seq.push('blur'); } });
    const plain = () => mkEl('div', { isContentEditable: false });
    const out = {
      head: press(ta(), '.graph-node'),               // 点卡头：先失焦再进节点拖拽
      blank: press(ta(), 'div'),                      // 点空白：先失焦再进画布平移
      port: press(ta(), '.graph-input-port'),         // 点端口（连线拖拽入口，同样 preventDefault）
      editableHead: press(editable(), '.graph-node'), // 富文本编辑态同口径
      otherInput: press(ta(), 'textarea'),            // 点另一个输入框：焦点交给浏览器，不补
      button: press(ta(), 'button'),                  // 点按钮/链接：同上（走不走焦点是浏览器自己的事）
      link: press(ta(), 'a'),
      plainHead: press(plain(), '.graph-node'),       // 焦点不在输入框：只进手势，不碰焦点
      body: press(undefined, '.graph-node'),
    };
    const want = {
      head: 'blur,node', blank: 'blur,pan', port: 'blur,link', editableHead: 'blur,node',
      otherInput: '', button: '', link: '', plainHead: 'node', body: 'node',
    };
    for (const key of Object.keys(want)) {
      if (out[key] !== want[key]) throw new Error(key + '：得「' + want[key] + '」，实得「' + out[key] + '」 ' + JSON.stringify(out));
    }
  } finally {
    sandbox.document = prevDoc;
    for (let i = restore.length - 1; i >= 0; i--) restore[i]();
    delete sandbox.__fxSeq;
    delete sandbox.__fxHandlers;
    delete sandbox.__fxRestore;
    delete sandbox.__fxMK;
  }
  return true;
});

check('graph-focus-release: 接线契约——失焦补在 button 过滤之后、首个手势入口之前；Delete 的输入框放行不撤', () => {
  const wf = fs.readFileSync('src/static/js/graph-events.js', 'utf8');
  const pd = wf.indexOf("graphCanvas.addEventListener('pointerdown'");
  if (pd < 0) throw new Error('pointerdown 监听未找到');
  const body = wf.slice(pd, wf.indexOf("graphCanvas.addEventListener('contextmenu'", pd));
  const filterAt = body.indexOf('if (e.button !== 0) return;');
  const releaseAt = body.indexOf('_releaseGraphTextFocus(e.target);');
  const gestureAt = body.search(/_startCanvasPan\(|_startNodeDrag\(|_startLinkDrag\(/);
  if (filterAt < 0 || releaseAt < 0) throw new Error('pointerdown 入口缺 button 过滤或失焦补丁调用');
  if (releaseAt < filterAt) throw new Error('失焦补丁必须排在 button 过滤之后（右键不补）');
  if (gestureAt >= 0 && gestureAt < releaseAt) throw new Error('失焦补丁必须排在首个手势入口之前（手势入口的 preventDefault 会吞掉浏览器默认失焦）');
  const fnAt = wf.indexOf('function _releaseGraphTextFocus');
  if (fnAt < 0) throw new Error('_releaseGraphTextFocus 未找到');
  const fn = wf.slice(fnAt, wf.indexOf('function _initGraphCanvasEvents', fnAt));
  for (const frag of [
    "el.closest('input, textarea, select, iframe')", 'el.isContentEditable === true',
    'if (!isTextEntry(active)) return;', 'if (isTextEntry(target)) return;',
    "target.closest('button, a')) return;", 'active.blur()',
  ]) {
    if (!fn.includes(frag)) throw new Error('_releaseGraphTextFocus 缺: ' + frag);
  }
  // 两层各司其职：失焦补丁管「焦点该走」，这里管「焦点还在输入框时让路」——
  // 输入框里按退格永远是删字，删节点只发生在焦点已经不在输入框之后。
  const khBody = wf.slice(wf.indexOf('function _handleGraphKeydown'), fnAt);
  const delAt = khBody.indexOf("if (!_graphKeyMatches(event, 'delete')) return;");
  const yieldAt = khBody.indexOf('if (inTextInput) return;', delAt);
  const runAt = khBody.indexOf('_deleteSelectedGraphNodes(', delAt);
  if (delAt < 0 || yieldAt < 0 || runAt < 0 || !(delAt < yieldAt && yieldAt < runAt)) {
    throw new Error('Delete 分支必须先过输入框放行再删节点');
  }
  return true;
});
}
