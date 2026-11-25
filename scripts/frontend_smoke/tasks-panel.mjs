// 491（2026-11-25）：任务面板「转圈不连续」修复（87d9f1d）的冒烟守卫。
// 背景：tick 每秒整面板 innerHTML 重写会把 .task-spin 的 CSS 动画从头再来，
// 用户看到的是转圈每秒跳回起点。修法是结构指纹不变时只就地改时钟文字。
// 全同步用例：①静态契约（tick 比对指纹、结构变了才整渲染、时钟只改 textContent）；
// ②沙箱行为（指纹忽略时间、只随状态/备注/节点/展开/页签变化；时钟刷新不碰字形节点）。
import fs from 'node:fs';
import { check, sandbox, vm } from './_runner.mjs';

function _body(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j); }
  }
  return null;
}

export function run() {
  check('491 tasks 转圈：tick 只在结构不变时就地改时钟，结构变了才整渲染（静态契约）', () => {
    const src = fs.readFileSync('src/static/js/tasks.js', 'utf8');
    const tick = _body(src, '_taskTickStart');
    if (!tick) throw new Error('找不到 _taskTickStart');
    if (!/if \(_taskStructureSig\(\) === _taskRenderSig\) _taskTickClockTexts\(\);/.test(tick)) {
      throw new Error('tick 没有先比对结构指纹（整面板重写会重置转圈动画）');
    }
    if (!/else _renderTaskPanel\(\);/.test(tick)) {
      throw new Error('tick 结构变化时没有回落到整渲染');
    }
    const clock = _body(src, '_taskTickClockTexts');
    if (!clock) throw new Error('找不到 _taskTickClockTexts');
    if (/innerHTML/.test(clock)) {
      throw new Error('时钟刷新仍在写 innerHTML（会重建 DOM、转圈从头再来）');
    }
    if (!/stateText\.textContent = line/.test(clock) || !/st\.textContent = text \+ timing/.test(clock)) {
      throw new Error('时钟刷新没有只改文字节点');
    }
    const render = _body(src, '_renderTaskPanel');
    if (!render) throw new Error('找不到 _renderTaskPanel');
    if (!/_taskRenderSig = _taskStructureSig\(\);/.test(render)) {
      throw new Error('整渲染后没有记下结构指纹，tick 永远只能整渲染');
    }
  });

  check('491 tasks 转圈：结构指纹忽略时间，只随状态/备注/节点/展开/页签变化（行为）', () => {
    try {
      vm.runInContext(`
        _taskTab = 'active';
        _taskExpanded = {};
        _taskActive = [{ id: 't1', state: 'running', kind: 'workflow', paused: false,
          cancelRequested: false, title: '生成物理视角', sessionTitle: '会话 A', note: '',
          startedAt: 995000, nodes: [{ id: 'n1', state: 'running', note: '', startedAt: 995000 }] }];
        _taskHistory = [];
      `, sandbox);
      const sig0 = vm.runInContext('_taskStructureSig()', sandbox);
      const sigOf = (mutate) => { vm.runInContext(mutate, sandbox); return vm.runInContext('_taskStructureSig()', sandbox); };

      const same = sigOf('_taskActive[0].startedAt = 900000; _taskActive[0].nodes[0].startedAt = 900000;');
      if (same !== sig0) throw new Error('耗时时间戳变化被当成结构变化（每秒都会整渲染）');

      const s1 = sigOf('_taskActive[0].state = "done"');
      if (s1 === sig0) throw new Error('任务状态变化没进指纹');
      const s2 = sigOf('_taskActive[0].note = "排队中"');
      if (s2 === s1) throw new Error('任务备注变化没进指纹');
      const s3 = sigOf('_taskActive[0].nodes[0].state = "done"');
      if (s3 === s2) throw new Error('节点状态变化没进指纹');
      const s4 = sigOf('_taskExpanded[_taskActive[0].id] = true');
      if (s4 === s3) throw new Error('展开态变化没进指纹');
      const s5 = sigOf('_taskTab = "done"');
      if (s5 === s4) throw new Error('页签切换没进指纹');
    } finally {
      vm.runInContext('_taskActive = []; _taskHistory = []; _taskExpanded = {}; _taskTab = "active";', sandbox);
    }
  });

  check('491 tasks 转圈：时钟刷新只改文字节点，字形/动画节点原样保留（行为）', () => {
    const prevGet = sandbox.document.getElementById;
    let glyph, nodeGlyph, stateText, nodeState;
    try {
      // 冻结时钟，让 _taskElapsed 的读数可断言（用毕在 finally 还原）
      vm.runInContext('globalThis.__realNow491 = Date.now; Date.now = () => 1000000;', sandbox);
      vm.runInContext(`
        _taskTab = 'active';
        _taskExpanded = {};
        _taskActive = [{ id: 't1', state: 'running', kind: 'workflow', paused: false,
          cancelRequested: false, title: '生成物理视角', sessionTitle: '会话 A', note: '',
          startedAt: 995000, nodes: [{ id: 'n1', state: 'running', note: '', startedAt: 997000 }] }];
        _taskHistory = [];
      `, sandbox);

      glyph = { innerHTML: '<span class="task-spin"></span>' };
      nodeGlyph = { innerHTML: '<span class="task-spin task-spin--sm"></span>' };
      stateText = { textContent: '进行中 · 0s' };
      nodeState = { textContent: '生成中 0s' };
      const row = {
        getAttribute: k => (k === 'data-node-id' ? 'n1' : null),
        querySelector: sel => (sel === '.task-node-state' ? nodeState
          : (sel === '.task-node-glyph' ? nodeGlyph : null)),
      };
      const item = {
        getAttribute: k => (k === 'data-task-id' ? 't1' : null),
        classList: { contains: () => false },
        querySelector: sel => (sel === '.task-state-text' ? stateText
          : (sel === '.task-glyph' ? glyph : null)),
        querySelectorAll: sel => (sel === '.task-node-row[data-node-id]' ? [row] : []),
      };
      const panel = {
        querySelectorAll: sel => (sel === '.task-item[data-task-id]' ? [item] : []),
      };
      sandbox.document.getElementById = id => (id === 'taskPanel' ? panel : null);

      vm.runInContext('_taskTickClockTexts()', sandbox);

      if (stateText.textContent !== '进行中 · 5s') {
        throw new Error('任务耗时文字没更新：' + JSON.stringify(stateText.textContent));
      }
      if (nodeState.textContent !== '生成中 3s') {
        throw new Error('节点耗时文字没更新：' + JSON.stringify(nodeState.textContent));
      }
      if (glyph.innerHTML !== '<span class="task-spin"></span>'
        || nodeGlyph.innerHTML !== '<span class="task-spin task-spin--sm"></span>') {
        throw new Error('时钟刷新碰了字形节点（转圈动画会断）');
      }
    } finally {
      sandbox.document.getElementById = prevGet;
      vm.runInContext('Date.now = globalThis.__realNow491; delete globalThis.__realNow491;', sandbox);
      vm.runInContext('_taskActive = []; _taskHistory = []; _taskExpanded = {}; _taskTab = "active";', sandbox);
    }
  });
}
