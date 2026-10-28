// 生成中断后的草稿回收（T359，2026-10-17 用户报「屏幕已见全文、换设备/刷新后回空」）。
// 四连环里落在前端的三条：
//   ① module 流式路原先只在 for-await 收尾落盘一次（blank 路有 400ms scheduleSave）；
//   ② 流式读帧无静默看门狗，上游字出完却不断连时收尾永不执行；
//   ④ 水合时 _sanitizeStaleBusyCustomNodes 只剥 busy/running，草稿/账本旧文没人结算。
// 本域回归：中断结算口径（草稿入账/旧版兜回/无账本原样）、module 路周期落盘行为、
// 看门狗行为（超时取消读流并抛 TimeoutError）、以及看门狗确实接在流式读帧上（静态契约）。
import { check, drain, addFailed, sandbox, fs, restoreWindowStub } from './_runner.mjs';

// 本域两条异步用例都要临时替换共享的 setTimeout/clearTimeout 桩，不能并发注册：
// 后一条会把前一条的桩换掉，流式用例的定时器就被看门狗用例的桩吞了（本轮实踩）。
// 用一条串行队列逐条 await，结果按 runner 同款格式打印。
let _serialTail = Promise.resolve();
function serialCheck(name, fn) {
  _serialTail = _serialTail.then(async () => {
    try {
      const r = await fn();
      if (r === false) throw new Error('断言未通过');
      console.log('✓', name);
    } catch (e) {
      addFailed();
      console.error('❌', name, '->', (e && e.message) || e);
    }
  });
  return _serialTail;
}

export async function run() {
  check('T359: 水合结算——账本有版而盘上没内容 → 兜回旧版并标失败', () => {
    const list = [{
      id: 'r1', kind: 'module', moduleKey: 'physics', busy: true, status: 'running',
      content: '', summary: '', humanDone: true,
      versions: [{ content: '旧文一版<summary>旧文摘要</summary>', at: 1, humanDone: true }], activeVersion: 0,
    }];
    const out = sandbox._sanitizeStaleBusyCustomNodes(list);
    if (out === list) throw new Error('脏节点必须返回新列表');
    const node = out[0];
    if (node.content !== '旧文一版<summary>旧文摘要</summary>') return false;
    if (node.summary !== '旧文摘要') return false;
    if (node.status !== 'error') return false;
    if (node.busy !== false) return false;
    if (node.humanDone !== true) return false;   // 标记随内容版本（T355 不变量）
    // 入参一字不动（历史快照是共享对象）
    if (list[0].content !== '' || list[0].busy !== true || list[0].status !== 'running') return false;
    return true;
  });

  check('T359: 水合结算——盘上有草稿 → 草稿入账当最新一版（不回退成旧文）', () => {
    const list = [{
      id: 'd1', kind: 'module', moduleKey: 'math', busy: true, status: 'running',
      content: '屏幕上见过的半截草稿', humanDone: false,
      versions: [{ content: '旧文一版', at: 1, humanDone: false }], activeVersion: 0,
    }];
    const node = sandbox._sanitizeStaleBusyCustomNodes(list)[0];
    if (node.content !== '屏幕上见过的半截草稿') return false;
    if (node.versions.length !== 2) return false;
    if (node.versions[1].content !== '屏幕上见过的半截草稿') return false;
    if (node.activeVersion !== 1) return false;
    if (node.status !== 'error') return false;
    if (list[0].versions.length !== 1) return false;   // 入参账本未被改
    return true;
  });

  check('T359: 水合结算——草稿恰是当前版（内容一致）不重复入账', () => {
    const list = [{
      id: 's1', kind: 'module', moduleKey: 'math', busy: true, status: 'running',
      content: '旧文一版',
      versions: [{ content: '旧文一版', at: 1 }], activeVersion: 0,
    }];
    const node = sandbox._sanitizeStaleBusyCustomNodes(list)[0];
    if (node.versions.length !== 1) return false;
    if (node.activeVersion !== 0) return false;
    if (node.content !== '旧文一版') return false;
    if (node.status !== 'error') return false;
    return true;
  });

  check('T359: 水合结算——无账本（首次生成被打断）草稿留着、状态仍按 T275 归空', () => {
    const list = [
      { id: 'f1', kind: 'module', moduleKey: 'math', busy: true, status: 'running', content: '半截' },
      { id: 'f2', kind: 'module', moduleKey: 'math', busy: true, status: 'running', content: '' },
    ];
    const out = sandbox._sanitizeStaleBusyCustomNodes(list);
    if (out[0].content !== '半截') return false;      // 屏幕上见过的字不删
    if (out[0].status !== '') return false;           // 不硬造账本、不硬标失败
    if (out[0].versions !== undefined) return false;
    if (out[1].status !== '' || out[1].content !== '') return false;
    return true;
  });

  serialCheck('T359: module 流式路补 400ms 周期落盘（每片一次＋收尾一次）', async () => {
    const realSetTimeout = sandbox.setTimeout;
    const realSave = sandbox.window.saveGraphState;
    const realGetState = sandbox.window.getGraphState;
    let saves = 0;
    // 沙箱的 setTimeout 是空实现（定时器不跑）——这里临时换成「立即执行」，用来观察
    // 流式过程中有没有落盘动作；测完原样还原。
    // 短延时（250ms 渲染／400ms 落盘）立即执行；120s 看门狗只登记不触发（否则读第一帧
    // 前就被自己的看门狗掐断——真实浏览器里它显然不会立刻到点）
    sandbox.setTimeout = (fn, ms) => {
      if (!(ms >= 120000)) { try { fn(); } catch (e) { /* 渲染桩无 DOM：忽略 */ } }
      return 0;
    };
    sandbox.window.saveGraphState = () => { saves++; };
    sandbox.window.getGraphState = () => ({ customNodes: [], connections: [], updatedAt: 1 });
    try {
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"choices":[{"delta":{"content":"第一片"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"第二片"}}]}\n\n',
      ];
      let i = 0;
      const reader = {
        read: async () => (i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true }),
        cancel: async () => {},
      };
      const node = { id: 'stream-1', kind: 'module', moduleKey: 'physics', busy: true, status: 'running', content: '' };
      await sandbox._streamCustomNodeResponse({ body: { getReader: () => reader } }, node);
      // 两片各一拍 + 收尾一次：旧实现只有收尾那一次
      if (saves !== chunks.length + 1) throw new Error('落盘次数＝' + saves + '，期望 ' + (chunks.length + 1));
    } finally {
      sandbox.setTimeout = realSetTimeout;
      restoreWindowStub('saveGraphState', realSave);
      restoreWindowStub('getGraphState', realGetState);
    }
    return true;
  });

  serialCheck('T359: 看门狗——静默超时取消读流并抛 TimeoutError', async () => {
    const realSetTimeout = sandbox.setTimeout;
    const realClearTimeout = sandbox.clearTimeout;
    let armed = null;
    let cleared = 0;
    let cancelled = 0;
    sandbox.setTimeout = (fn, ms) => { armed = { fn, ms }; return 7; };
    sandbox.clearTimeout = () => { cleared++; };
    try {
      const reader = { read: () => new Promise(() => {}), cancel: () => { cancelled++; } };
      const pending = sandbox._readStreamChunk(reader);
      if (!armed || armed.ms !== 120000) throw new Error('未按 120 秒注册静默看门狗');
      armed.fn();
      let err = null;
      try { await pending; } catch (e) { err = e; }
      if (!err) throw new Error('超时应当抛错');
      if (err.name !== 'TimeoutError') return false;   // 不能是 AbortError（中止＝用户动作）
      if (cancelled !== 1) return false;
      if (cleared !== 0) return false;                 // 超时路径不再清定时器
      // 正常路径：读到帧即清定时器、不抛错
      armed = null;
      const okReader = { read: async () => ({ done: true }), cancel: () => {} };
      const result = await sandbox._readStreamChunk(okReader);
      if (!result || result.done !== true) return false;
      if (cleared !== 1) return false;
    } finally {
      sandbox.setTimeout = realSetTimeout;
      sandbox.clearTimeout = realClearTimeout;
    }
    return true;
  });

  check('T359: 静态契约——流式读帧必须走看门狗、module 路必须有周期落盘', () => {
    const src = fs.readFileSync('src/static/js/graph-workflow-stream.js', 'utf8');
    const framesStart = src.indexOf('async function* _sseContentFrames');
    const framesEnd = src.indexOf('async function _streamCustomNodeResponse');
    if (framesStart === -1 || framesEnd === -1 || framesEnd <= framesStart) throw new Error('找不到流式读帧段');
    if (!src.slice(framesStart, framesEnd).includes('_readStreamChunk(reader)')) {
      throw new Error('读帧没接看门狗（reader.read() 裸调＝挂死时收尾永不执行）');
    }
    const modStart = src.indexOf('async function _streamCustomNodeResponse');
    const modEnd = src.indexOf('async function _streamAnalysisResponse');
    const seg = src.slice(modStart, modEnd);
    if (!seg.includes('function scheduleSave') || !seg.includes('scheduleSave();')) {
      throw new Error('module 流式路没接周期落盘');
    }
    return true;
  });

  await _serialTail;
  await drain();
}
