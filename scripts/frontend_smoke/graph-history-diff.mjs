// 修改历史对比（2026-10-24，R2/R3/R4/R5/R6；同日简化批次改口）：本域钉「差异说人话」——
//   ①内容投影：拖动/自动整理不进差异，正文改动才进；旧条目降级只比自定义节点；
//   ②方向：回到那一步 = 现在有的会消失、那时有的会回来、两边不同会改写；
//   ③清单/计数/图例与点行定位；④两向切换（回到这里会怎样/这一步改了什么），
//     历史「幽灵虚影」已随简化批次退役（_graphDiffGhost* 一族仍服务 Φ 的向前对比）；
//   ⑤800ms 深比较只算一次（脏标记缓存；布局存盘 {layout:true} 不置脏——拖拽/缩放不付全图投影，T219 补刀）；
//   ⑥行摘要回退到正文前 22 字，不再吐节点 ID。
// 异步用例（点行定位）放最后：前面同步例各自 try/finally 自清理，别在异步让出微任务
// 期间重置共享沙箱（AGENTS 冒烟混排坑）。
import { check, drain, sandbox, vm, storageData, restoreWindowStub } from './_runner.mjs';

const SID = 'sess_history_diff';
const HIST_KEY = 'phymathia_graph_history_' + SID;

function _note(id, extra) {
  return Object.assign({ id: id, kind: 'note', manual: true, messageIndex: -1, timestamp: 100, content: '正文 ' + id, title: '', status: 'done', x: 100, y: 100 }, extra || {});
}
function _state(nodes, extra) {
  return Object.assign({ hidden: {}, connections: [], removedEdges: [], groups: [], customNodes: nodes || [] }, extra || {});
}
function _mkEl(tag) {
  return {
    tagName: tag, className: '', innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {}, children: [],
    classList: {
      _s: new Set(),
      add: function () { for (var i = 0; i < arguments.length; i++) this._s.add(arguments[i]); },
      remove: function () { for (var i = 0; i < arguments.length; i++) this._s.delete(arguments[i]); },
      contains: function (c) { return this._s.has(c); },
    },
    appendChild: function (c) { this.children.push(c); return c; },
    remove: function () { this.removed = true; },
    addEventListener: function () {}, setAttribute: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 1200, height: 900, left: 0, top: 0 }; },
    scrollIntoView: function () { this.scrolled = true; },
  };
}

export async function run() {
  const prevSid = sandbox.window.getCurrentSessionId, prevGet = sandbox.window.getGraphState;
  const prevSave = sandbox.window.saveGraphState, prevChat = sandbox.window.getChatHistory;
  const prevReplace = sandbox.window.replaceChatHistory, prevToast = sandbox.showToast;
  const prevDoc = sandbox.document, prevEsc = sandbox.escapeHtml;
  const prevFlash = sandbox.window.flashGraphHistoryDiff;
  const prevHist = storageData[HIST_KEY];
  delete storageData[HIST_KEY];
  let mem = _state([]);
  let chat = [];
  const els = {};
  const nodeEls = {};
  const fakeInner = {
    kids: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector: function (sel) {
      const m = /data-node-id="([^"]+)"/.exec(sel || '');
      if (m) return nodeEls[m[1]] || null;
      return null;
    },
    querySelectorAll: function (sel) {
      if (!sel || sel.indexOf('graph-diff-ghost-layer') >= 0) return [];
      return Object.keys(nodeEls).map(function (k) { return nodeEls[k]; });
    },
    appendChild: function (el) { this.kids.push(el); },
    getBoundingClientRect: function () { return { width: 1200, height: 900, left: 0, top: 0 }; },
  };
  const fakeCanvas = {
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 1200, height: 900, left: 0, top: 0 }; },
  };
  sandbox.__fakeInner = fakeInner;
  sandbox.__fakeCanvas = fakeCanvas;
  sandbox.window.getCurrentSessionId = () => SID;
  sandbox.window.getGraphState = () => mem;
  sandbox.window.saveGraphState = (_sid, state) => { Object.assign(mem, JSON.parse(JSON.stringify(state))); };
  sandbox.window.getChatHistory = () => chat.slice();
  sandbox.window.replaceChatHistory = async (msgs) => { chat = JSON.parse(JSON.stringify(msgs)); };
  sandbox.showToast = () => {};
  sandbox.escapeHtml = t => String(t == null ? '' : t);
  sandbox.document = {
    createElement: tag => _mkEl(tag),
    createElementNS: (_ns, tag) => _mkEl(tag),
    getElementById: id => els[id] || null,
    getSelection: () => null,
    body: { appendChild: () => {} },
  };
  const runCtx = code => vm.runInContext(code, sandbox);
  const tick = () => new Promise(r => setTimeout(r, 10));
  const reset = () => {
    mem = _state([]);
    chat = [];
    Object.keys(els).forEach(k => delete els[k]);
    Object.keys(nodeEls).forEach(k => delete nodeEls[k]);
    runCtx('graphCanvas = null; graphInner = null;'
      + 'graphHistorySession = ' + JSON.stringify(SID) + '; graphUndoStack = [];'
      + ' graphHistoryCursor = 0; graphHistoryLive = null;'
      + ' graphPendingLiveMeta = null; graphHistoryPendingTruncate = false;'
      + ' graphHistoryPreviewing = -1; graphHistoryDiffModel = null; graphHistoryCompareDir = "back";'
      + ' graphHistoryLiveDirty = true;');
    delete storageData[HIST_KEY];
  };
  const projOf = state => JSON.parse(runCtx('JSON.stringify(_graphProjectionOf(' + JSON.stringify(state) + ', []))'));
  const diffOf = (a, b) => JSON.parse(runCtx('JSON.stringify(_graphDiffFromProjections(' + JSON.stringify(a) + ',' + JSON.stringify(b) + '))'));

  try {
    check('2.1 内容投影：拖动只算「仅位置变化」，正文改动才进差异', () => {
      const a = _state([_note('n1'), _note('n2')]);
      const movedB = _state([_note('n1'), _note('n2', { x: 900, y: 700 })]);
      const p1 = projOf(a), p2 = projOf(movedB);
      if (p1.n.n2.s !== p2.n.n2.s) {
        throw new Error('投影把坐标算进签名了：' + JSON.stringify([p1.n.n2.s, p2.n.n2.s]));
      }
      const movedDiff = diffOf(p1, p2);
      if (movedDiff.ops.length) throw new Error('拖动被算成内容修改：' + JSON.stringify(movedDiff.ops));
      if (!movedDiff.layoutOnly || movedDiff.layoutChanges !== 1) throw new Error('仅位置变化没单独归类');
      if (movedDiff.summary !== '仅位置变化') throw new Error('摘要不对：' + movedDiff.summary);
      const edited = _state([_note('n1', { content: '改过的正文' }), _note('n2')]);
      const editDiff = diffOf(p1, projOf(edited));
      const upd = editDiff.ops.filter(o => o.op === 'update_node');
      if (upd.length !== 1 || upd[0].id !== 'n1') throw new Error('正文改动没识别成 update');
      if (upd[0].before === upd[0].after) throw new Error('旧→新预览相同');
      if (editDiff.counts.change !== 1 || editDiff.counts.vanish !== 0) throw new Error('计数不对：' + JSON.stringify(editDiff.counts));
      const added = _state([_note('n1'), _note('n2'), _note('n3')]);
      if (diffOf(p1, projOf(added)).ops[0].op !== 'create_node') throw new Error('新增节点没识别成 create');
      return true;
    });

    check('R3/降级：旧条目没投影没消息时只比自定义节点，不把消息派生节点报成新增', () => {
      const oldEntry = JSON.parse(runCtx('JSON.stringify(_graphVersionProjection({ state: '
        + JSON.stringify(_state([_note('n1')])) + ', messages: null }))'));
      if (!oldEntry.degraded) throw new Error('无消息旧条目没打降级标');
      const live = projOf(_state([_note('n1')]));
      live.n['a-123'] = { id: 'a-123', k: 'answer', l: '回答', p: '', s: 'x', v: 0, m: 1, x: 0, y: 0 };
      const diff = diffOf(oldEntry, live);
      if (diff.ops.length) throw new Error('降级对比把派生节点报成差异：' + JSON.stringify(diff.ops));
      return true;
    });

    check('R5 方向：回到那一步——现在有的会消失、那时有的会回来、两边不同会改写', () => {
      const target = _state([_note('keep'), _note('back', { content: '旧的回来' })]);
      const live = _state([_note('keep', { content: '改写后' }), _note('gone')]);
      const diff = diffOf(projOf(target), projOf(live));
      const by = {};
      diff.ops.forEach(o => { by[o.op] = o; });
      if (!by.create_node || by.create_node.will !== 'vanish') throw new Error('现在有的节点没标「会消失」');
      if (!by.delete_node || by.delete_node.will !== 'return') throw new Error('那时有的节点没标「会回来」');
      if (!by.update_node || by.update_node.will !== 'change') throw new Error('两边不同的节点没标「会改写」');
      if (diff.counts.vanish !== 1 || diff.counts.ret !== 1 || diff.counts.change !== 1) {
        throw new Error('三向计数不对：' + JSON.stringify(diff.counts));
      }
      return true;
    });

    check('2.2/2.3 清单：可点列表＋分组计数图例；两向切换就位，步进/幽灵/单节点恢复已退役', () => {
      reset();
      runCtx('graphUndoStack = ['
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([_note("keep"), _note("back")])) + ', messages: null, meta: { source: "user", summary: "两步前", ts: 1, pushedAt: 1 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([_note("keep")])) + ', messages: null, meta: { source: "user", summary: "上一步", ts: 2, pushedAt: 2 } }'
        + ']; graphHistoryCursor = 2; graphHistoryLive = null; graphHistoryLiveDirty = true; graphHistoryLiveMetaCache = null;');
      mem = _state([_note('keep', { content: '改写后' }), _note('gone')]);
      els.graphHistoryList = _mkEl('div');
      els.graphHistoryDiffText = _mkEl('div');
      els.graphHistoryPos = _mkEl('span');
      runCtx('openGraphHistoryPanel(); graphHistoryLastSignature = ""; _refreshGraphHistoryPanel();');
      runCtx('_previewGraphVersion(0);');
      const html = els.graphHistoryDiffText.innerHTML;
      if (!html.includes('对比：回到')) throw new Error('清单没有标题');
      if (!html.includes('会消失') || !html.includes('会回来') || !html.includes('会改写')) throw new Error('三向分组/图例缺失');
      if (!html.includes('g-hd-count')) throw new Error('计数行缺失');
      // 简化批次：两向切换钮在；步进/幽灵开关/「恢复这一颗」不再渲染
      if (!html.includes("setGraphHistoryCompareDir('back')") || !html.includes("setGraphHistoryCompareDir('step')")) {
        throw new Error('两向切换钮缺失');
      }
      if (!html.includes('jumpGraphVersion(0)')) throw new Error('回到这一步缺失');
      if (html.includes('stepGraphHistoryDiff') || html.includes('toggleGraphHistoryGhosts') || html.includes('recoverGraphHistoryNode')) {
        throw new Error('已退役的步进/幽灵/单节点恢复还出现在对比面板');
      }
      const model = JSON.parse(runCtx('JSON.stringify({ items: graphHistoryDiffModel.items.length, will: graphHistoryDiffModel.items.map(i => i.will), counts: graphHistoryDiffModel.counts })'));
      if (!model.items) throw new Error('差异清单为空');
      if (model.will[0] !== 'vanish' || model.will.indexOf('return') < 0) throw new Error('清单分组顺序不对：' + JSON.stringify(model.will));
      if (model.counts.vanish !== 1 || model.counts.ret !== 1 || model.counts.change !== 1) {
        throw new Error('计数没从清单数：' + JSON.stringify(model.counts));
      }
      runCtx('exitGraphVersionPreview(); closeGraphHistoryPanel();');
      return true;
    });

    check('两向切换（简化批次）：step＝上一版→这一版，措辞反向；第一步回落 back', () => {
      reset();
      runCtx('graphUndoStack = ['
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([_note("a")])) + ', messages: null, meta: { source: "user", summary: "初始", ts: 1, pushedAt: 1 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([_note("a", { content: "改了" }), _note("b")])) + ', messages: null, meta: { source: "user", summary: "那一步", ts: 2, pushedAt: 2 } }'
        + ']; graphHistoryCursor = 2; graphHistoryLive = null; graphHistoryLiveDirty = true;');
      mem = _state([_note('a', { content: '改了' }), _note('b')]);
      els.graphHistoryList = _mkEl('div');
      els.graphHistoryDiffText = _mkEl('div');
      els.graphHistoryPos = _mkEl('span');
      runCtx('openGraphHistoryPanel(); graphHistoryLastSignature = ""; _refreshGraphHistoryPanel();');
      try {
        // 第一步没有上一版：对比面板把 step 钮置灰，切换被拒，方向仍是 back
        runCtx('_previewGraphVersion(0);');
        if (!els.graphHistoryDiffText.innerHTML.includes('disabled')) throw new Error('第一步的 step 钮没置灰');
        if (runCtx('setGraphHistoryCompareDir("step")') !== false) throw new Error('第一步竟然切进了 step');
        if (runCtx('graphHistoryCompareDir') !== 'back') throw new Error('第一步切换后方向没留在 back');
        runCtx('exitGraphVersionPreview();');
        // 第二步：step＝上一版→这一版（新增 b＝新出现/return，改写 a＝change）
        runCtx('_previewGraphVersion(1);');
        if (runCtx('setGraphHistoryCompareDir("step")') !== true) throw new Error('step 切换失败');
        const model = JSON.parse(runCtx('JSON.stringify({ dir: graphHistoryDiffModel.dir, will: graphHistoryDiffModel.items.map(i => i.will) })'));
        if (model.dir !== 'step') throw new Error('模型没记 step 方向');
        if (model.will.indexOf('return') < 0) throw new Error('这一步新出现的节点没标 return：' + JSON.stringify(model.will));
        if (model.will.indexOf('change') < 0) throw new Error('这一步改写的节点没标 change：' + JSON.stringify(model.will));
        const html = els.graphHistoryDiffText.innerHTML;
        if (!html.includes('这一步改了什么') || !html.includes('新出现') || !html.includes('被改了')) throw new Error('step 措辞缺失');
        // 切回 back：回到「会消失/会回来」口径
        runCtx('setGraphHistoryCompareDir("back");');
        if (!els.graphHistoryDiffText.innerHTML.includes('会改写')) throw new Error('切回 back 后措辞没回来');
      } finally {
        runCtx('exitGraphVersionPreview(); closeGraphHistoryPanel();');
      }
      return true;
    });

    check('R6 幽灵（Φ 向前对比仍在用）：挂进 graphInner，坐标是图坐标（不预乘 pan/zoom）', () => {
      const tr = runCtx('_graphDiffGhostTranslate(' + JSON.stringify({ id: 'g1', kind: 'note', x: 300, y: 200, w: 220, h: 72 }) + ')');
      if (tr !== 'translate(190px, 164px)') throw new Error('幽灵坐标不对：' + tr);
      const hostSrc = runCtx('_graphDiffGhostLayerHost.toString()');
      if (!/graphInner/.test(hostSrc) || !/graphCanvas/.test(hostSrc)) throw new Error('幽灵层宿主没有优先 graphInner');
      const trSrc = runCtx('_graphDiffGhostTranslate.toString()');
      if (trSrc.indexOf('pan') >= 0 || trSrc.indexOf('zoom') >= 0) throw new Error('幽灵坐标还在预乘 pan/zoom');
      return true;
    });

    check('2.3 聚光灯与角标：变化节点亮、未变化压暗、角标 − 就位', () => {
      reset();
      nodeEls.n1 = _mkEl('div');
      nodeEls.n2 = _mkEl('div');
      nodeEls.n1.style.contentVisibility = 'auto';
      runCtx('graphInner = __fakeInner; graphView.nodes = [{ id: "n1" }, { id: "n2" }]; graphView.edges = []; graphView.nodeById = { n1: graphView.nodes[0], n2: graphView.nodes[1] };');
      runCtx('applyGraphHistoryDiff(' + JSON.stringify({
        ops: [
          { op: 'create_node', id: 'n1', label: '新节点', will: 'vanish' },
          { op: 'update_groups', will: 'change', label: '分组' },
        ],
      }) + ', { ghostVisible: false });');
      const n1 = nodeEls.n1, n2 = nodeEls.n2;
      if (!n1.classList.contains('graph-diff-will-vanish')) throw new Error('会消失的节点没上描边');
      if (n1.classList.contains('graph-diff-dim')) throw new Error('变化节点不该压暗');
      if (!n2.classList.contains('graph-diff-dim')) throw new Error('未变化节点没压暗（聚光灯失效）');
      const badge = n1.children.find(c => c.className && c.className.indexOf('graph-diff-badge') >= 0);
      if (!badge || badge.textContent !== '−') throw new Error('缺「−」角标');
      // T395：c-v:auto 的 paint 包含会裁掉角标，标记节点须临时关掉懒渲染
      if (n1.style.contentVisibility !== 'visible') throw new Error('标记节点没临时关掉 c-v，角标会被裁成小三角');
      if (n2.style.contentVisibility) throw new Error('未标记节点不该动 c-v');
      runCtx('clearGraphDiffHighlights();');
      if (n1.style.contentVisibility !== 'auto') throw new Error('clear 没还原标记节点的 c-v');
      if (n2.classList.contains('graph-diff-dim')) throw new Error('clear 没摘掉聚光灯');
      runCtx('graphInner = null; graphView.nodes = []; graphView.edges = []; graphView.nodeById = {};');
      return true;
    });

    check('2.6 摘要可读：节点名回退正文前 22 字，不再吐 user-custom ID', () => {
      const longText = '这是一个很长很长的正文，用来验证节点名会回退到正文前二十二字而不是吐出一串 ID';
      const label = runCtx('_graphNodeLabelOf(' + JSON.stringify(_note('user-custom-1697999', { content: longText })) + ', "user-custom-1697999")');
      if (label.indexOf('user-custom') >= 0) throw new Error('节点名还是 ID：' + label);
      if (label.length > 24) throw new Error('节点名没截断：' + label.length);
      const mod = runCtx('_graphNodeLabelOf({ kind: "module", moduleKey: "physics", content: "" }, "m1")');
      if (mod !== '物理视角') throw new Error('模块节点没用中文名：' + mod);
      return true;
    });

    check('R9/T219 深比较：只在图真被写过时重算，其余吃缓存', () => {
      reset();
      runCtx('graphUndoStack = [{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([])) + ', messages: null, meta: { source: "init", summary: "初始状态", ts: 1, pushedAt: 1 } }];'
        + 'graphHistoryCursor = 1; graphHistoryLiveDirty = true; graphHistoryLiveMetaCache = null;');
      mem = _state([_note('n1')]);
      const first = JSON.parse(runCtx('JSON.stringify(_graphVersions()[1].meta)'));
      if (first.summary === '当前状态') throw new Error('第一版没算出差异摘要');
      mem = _state([_note('n1'), _note('n2'), _note('n3')]);
      const cached = JSON.parse(runCtx('JSON.stringify(_graphVersions()[1].meta)'));
      if (cached.summary !== first.summary) throw new Error('未落盘的改动绕过了缓存（还在每轮深比较）');
      runCtx('_saveGraphState(_graphState());');
      const fresh = JSON.parse(runCtx('JSON.stringify(_graphVersions()[1].meta)'));
      if (fresh.summary === first.summary) throw new Error('落盘后没有重算当前状态摘要');
      return true;
    });

    check('R9/T219 补刀：布局存盘（layout:true）不置脏，未落盘改动的缓存原样保住', () => {
      reset();
      runCtx('graphUndoStack = [{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([])) + ', messages: null, meta: { source: "init", summary: "初始状态", ts: 1, pushedAt: 1 } }];'
        + 'graphHistoryCursor = 1; graphHistoryLiveDirty = true; graphHistoryLiveMetaCache = null;');
      mem = _state([_note('n1')]);
      const first = JSON.parse(runCtx('JSON.stringify(_graphVersions()[1].meta)'));
      if (first.summary === '当前状态') throw new Error('第一版没算出差异摘要');
      // 未落盘的内容改动在侧，布局存盘（拖拽/缩放那一类）：脏标记必须保持干净
      mem = _state([_note('n1'), _note('n2'), _note('n3')]);
      runCtx('_saveGraphState(_graphState(), { layout: true });');
      if (runCtx('graphHistoryLiveDirty') !== false) throw new Error('布局存盘把脏标记置真了（下一拍会白付一次全图投影）');
      const held = JSON.parse(runCtx('JSON.stringify(_graphVersions()[1].meta)'));
      if (held.summary !== first.summary) throw new Error('布局存盘打掉了缓存');
      // 普通存盘照旧置脏、下一拍重算
      runCtx('_saveGraphState(_graphState());');
      if (runCtx('graphHistoryLiveDirty') !== true) throw new Error('普通存盘没有置脏');
      const fresh = JSON.parse(runCtx('JSON.stringify(_graphVersions()[1].meta)'));
      if (fresh.summary === first.summary) throw new Error('普通存盘后没有重算');
      return true;
    });

    check('R9/T219 补刀：时间旅行待截断不被布局存盘吞掉，真编辑才截断', () => {
      reset();
      runCtx('graphUndoStack = ['
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([])) + ', messages: null, meta: { source: "init", summary: "初始", ts: 1, pushedAt: 1 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([_note('keep')])) + ', messages: null, meta: { source: "user", summary: "上一步", ts: 2, pushedAt: 2 } }'
        + ']; graphHistoryCursor = 1; graphHistoryLive = null; graphHistoryPendingTruncate = true; graphHistoryLiveDirty = false; graphHistoryLiveMetaCache = { meta: null, counts: null };');
      mem = _state([_note('keep', { content: '改过的正文' })]);
      runCtx('_saveGraphState(_graphState(), { layout: true });');
      if (runCtx('graphHistoryPendingTruncate') !== true) throw new Error('布局存盘吞掉了待截断标记');
      if (runCtx('graphHistoryCursor') !== 1) throw new Error('布局存盘截断了未来');
      runCtx('_saveGraphState(_graphState());');
      if (runCtx('graphHistoryPendingTruncate') !== false) throw new Error('真编辑没有消费待截断标记');
      if (runCtx('graphHistoryCursor') !== 2) throw new Error('真编辑没有落截断');
      return true;
    });

    check('R9/T219 补刀：预览态一拍不重灌对比 DOM，空 footer 不再反复写 innerHTML', () => {
      reset();
      runCtx('graphUndoStack = ['
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([_note("keep"), _note("back")])) + ', messages: null, meta: { source: "user", summary: "两步前", ts: 1, pushedAt: 1 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(_state([_note("keep")])) + ', messages: null, meta: { source: "user", summary: "上一步", ts: 2, pushedAt: 2 } }'
        + ']; graphHistoryCursor = 2; graphHistoryLive = null; graphHistoryLiveDirty = true;');
      mem = _state([_note('keep', { content: '改写后' }), _note('gone')]);
      els.graphHistoryList = _mkEl('div');
      els.graphHistoryPos = _mkEl('span');
      els.graphHistoryDiffText = _mkEl('div');
      runCtx('openGraphHistoryPanel(); graphHistoryLastSignature = ""; _refreshGraphHistoryPanel();');
      runCtx('_previewGraphVersion(0);');
      if (!els.graphHistoryDiffText.innerHTML) throw new Error('预览态 footer 没内容');
      let sets = 0;
      let val = els.graphHistoryDiffText.innerHTML;
      Object.defineProperty(els.graphHistoryDiffText, 'innerHTML', {
        configurable: true, get: () => val, set: v => { sets++; val = v; },
      });
      runCtx('_renderGraphHistoryFooter(); _renderGraphHistoryFooter();');
      if (sets !== 0) throw new Error('内容没变还在整份重灌 DOM（写 ' + sets + ' 次）');
      runCtx('exitGraphVersionPreview();');
      if (sets !== 1 || val !== '') throw new Error('退出预览没清空 footer');
      runCtx('_renderGraphHistoryFooter();');
      if (sets !== 1) throw new Error('空 footer 每次 tick 还在写 innerHTML');
      runCtx('closeGraphHistoryPanel();');
      return true;
    });

    // ===== 异步用例放最后（点行定位要读 graphCanvas 的 rect）=====
    check('2.2 点清单一行＝镜头飞过去并请求闪烁', async () => {
      reset();
      runCtx('graphCanvas = __fakeCanvas; graphInner = __fakeInner;'
        + 'graphView.nodes = [{ id: "n1", x: 100, y: 100, w: 200, h: 80 }, { id: "n2", x: 900, y: 700, w: 200, h: 80 }];'
        + 'graphView.nodeById = { n1: graphView.nodes[0], n2: graphView.nodes[1] }; graphView.edges = [];');
      let flashed = null;
      sandbox.window.flashGraphHistoryDiff = ids => { flashed = ids; };
      runCtx('graphHistoryDiffModel = { index: 0, items: [{ will: "vanish", nodeId: "n2", label: "远节点" }, { will: "change", nodeId: "n1", label: "近节点" }], ghostNodes: [], focusIndex: -1 };');
      runCtx('focusGraphHistoryDiff(0);');
      if (!flashed || flashed[0] !== 'n2') throw new Error('点行没请求闪烁');
      const view = JSON.parse(runCtx('JSON.stringify({ zoom: _graphState().zoom, pan: _graphState().pan })'));
      if (!(view.zoom > 0 && Number.isFinite(view.pan.x) && Number.isFinite(view.pan.y))) throw new Error('镜头没动：' + JSON.stringify(view));
      runCtx('graphHistoryDiffModel = null; graphCanvas = null; graphInner = null;');
      await tick();
      return true;
    });

    await drain();
  } finally {
    restoreWindowStub('getCurrentSessionId', prevSid);
    restoreWindowStub('getGraphState', prevGet);
    restoreWindowStub('saveGraphState', prevSave);
    restoreWindowStub('getChatHistory', prevChat);
    restoreWindowStub('replaceChatHistory', prevReplace);
    if (prevToast === undefined) delete sandbox.showToast; else sandbox.showToast = prevToast;
    if (prevFlash === undefined) delete sandbox.window.flashGraphHistoryDiff; else restoreWindowStub('flashGraphHistoryDiff', prevFlash);
    sandbox.document = prevDoc;
    sandbox.escapeHtml = prevEsc;
    delete sandbox.__fakeInner;
    delete sandbox.__fakeCanvas;
    if (prevHist === undefined) delete storageData[HIST_KEY]; else storageData[HIST_KEY] = prevHist;
  }
}
