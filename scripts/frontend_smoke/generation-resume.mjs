// 484 生成断点续跑（2026-11-19）：续跑接线的冒烟守卫。
// 全同步用例：①源码级静态契约（清扫暂缓/任务 id 落盘/重接流/停止掐服务端/水合钩子）；
// ②沙箱行为（sanitizer 暂缓-登记-去重与旧口径回落、取消口按 busy+genTaskId 打 DELETE）。
// 端到端（刷新重接流、宽限自动停、服务重启回落）在真机档 scripts/verify_generation_resume.mjs。
import fs from 'node:fs';
import { check, sandbox, vm } from './_runner.mjs';

function _read(path) { return fs.readFileSync('src/static/js/' + path, 'utf8'); }
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

export async function run() {
  check('484 静态契约：断点续跑接线全在（源码级）', () => {
    const gjs = _read('graph.js');
    const gen = _read('graph-workflow-generate.js');
    const stream = _read('graph-workflow-stream.js');
    const entry = _read('graph-workflow-entry.js');
    const tasks = _read('tasks.js');
    const session = _read('session.js');
    // 清扫：sanitizer 带 sid/defer 双参，启动清扫与服务端水合 heal 都开暂缓
    if (!/function _sanitizeStaleBusyCustomNodes\(list, sid, deferGenTask\)/.test(gjs)) {
      throw new Error('sanitizer 没有 sid/deferGenTask 双参（484）');
    }
    if (!gjs.includes('_sanitizeStaleBusyCustomNodes(parsed.customNodes, sid, true)')) {
      throw new Error('启动清扫没开暂缓（484）');
    }
    if (!session.includes("_sanitizeStaleBusyCustomNodes(state.customNodes, sid || '', true)")) {
      throw new Error('服务端水合 heal 没开暂缓（484）');
    }
    // 生成入口：分析/正文两处开跑落 genTaskId，请求带 gen_task_id
    if ((gen.match(/node\.genTaskId = _newGenTaskId\(\)/g) || []).length < 2) {
      throw new Error('两个生成入口没有都落 genTaskId（484）');
    }
    if (!gen.includes('gen_task_id: node.genTaskId')
        || !gen.includes('const extra = { gen_task_id: node.genTaskId };')) {
      throw new Error('正文/分析请求没带 gen_task_id（484）');
    }
    // 收编：探活→重接流喂共享流式函数→共享结算；任务不在回落旧结算口径
    if (!gen.includes("'/api/generations/' + encodeURIComponent(entry.genTaskId)")) {
      throw new Error('重接没打 /api/generations/{id} 端点（484）');
    }
    if (!gen.includes('_streamCustomNodeResponse(resp, live)')) {
      throw new Error('重接流没喂给共享流式函数（484）');
    }
    if (!gen.includes('_finishCustomNodeGeneration(live, {')) {
      throw new Error('重接收口没走共享结算（484）');
    }
    if (!gen.includes('_settleInterruptedCustomNode(live)')) {
      throw new Error('服务端任务不在时没回落旧中断结算口径（484）');
    }
    // 停止链：总闸与单节点停都要 DELETE 后台任务（订阅断开≠取消）
    if (!stream.includes("method: 'DELETE'") || !stream.includes('/api/generations/')) {
      throw new Error('取消口没发 DELETE /api/generations/{id}（484）');
    }
    if (!entry.includes('_cancelBusyNodesServerGenerations()')) {
      throw new Error('总闸停止没扫后台任务（484）');
    }
    if (!tasks.includes('_cancelServerGeneration(node.genTaskId)')) {
      throw new Error('单节点停没取消后台任务（484）');
    }
    // 水合钩子：loader 收口唤收编器
    if (!session.includes('_maybeReattachPendingGenerations(sid)')) {
      throw new Error('水合收口没唤收编器（484）');
    }
    return true;
  });

  check('484 行为：带 genTaskId 的水合残留暂缓结算并登记（去重）；不带的一照旧结算', () => {
    vm.runInContext('graphView.nodes = []; undefined', sandbox);
    const busyNode = {
      id: 'n1', kind: 'module', moduleKey: 'learn', messageIndex: -1,
      busy: true, status: 'running', content: '半截草稿',
      genTaskId: '11111111-1111-1111-1111-111111111111', genTaskKind: 'content',
      versions: [{ content: '旧版', at: 1 }], activeVersion: 0,
    };
    const plainNode = {
      id: 'n2', kind: 'module', moduleKey: 'math', messageIndex: -1,
      busy: true, status: 'running', content: '另一段草稿',
      versions: [{ content: '旧版二', at: 1 }], activeVersion: 0,
    };
    const sanitize = vm.runInContext('_sanitizeStaleBusyCustomNodes', sandbox);
    const out = sanitize([busyNode, plainNode], 's1', true);
    // n1 暂缓：原样带回（busy 保留等探活），登记进队列；n2 照旧结算（T275/T359 口径不动）
    if (out[0] !== busyNode) throw new Error('带 genTaskId 的残留被就地结算了（应暂缓）');
    if (out[1].busy !== false || out[1].status !== 'error') throw new Error('无任务 id 的残留没有照旧结算');
    const queue = vm.runInContext('_pendingGenerationReattach', sandbox);
    if (queue.length !== 1 || queue[0].nodeId !== 'n1' || queue[0].sid !== 's1' || queue[0].kind !== 'content') {
      throw new Error('暂缓登记没进队列/字段不对：' + JSON.stringify(queue));
    }
    // 同节点同 id 重复水合（启动清扫与服务端 heal 先后过同一份数据）：去重
    sanitize([{ ...busyNode }], 's1', true);
    if (vm.runInContext('_pendingGenerationReattach', sandbox).length !== 1) throw new Error('重复登记没去重');
    // 历史回放路（defer 不开）：带 genTaskId 也照旧结算（回放里不该重接流）
    const out3 = sanitize([{ ...busyNode }], 's1', false);
    if (out3[0].busy !== false) throw new Error('历史回放路没有照旧结算');
    // 清队列，别污染后续域
    vm.runInContext('_pendingGenerationReattach.length = 0', sandbox);
    return true;
  });

  check('484 行为：停止生成扫 busy+genTaskId 节点逐个 DELETE 后台任务', () => {
    const calls = [];
    const prevFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: opts && opts.method });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      vm.runInContext(`graphView.nodes = [
        { id: 'a1', busy: true, genTaskId: '22222222-2222-2222-2222-222222222222' },
        { id: 'a2', busy: true },
        { id: 'a3', busy: false, genTaskId: '33333333-3333-3333-3333-333333333333' },
      ]; undefined`, sandbox);
      vm.runInContext('_cancelBusyNodesServerGenerations()', sandbox);
      if (calls.length !== 1) throw new Error('DELETE 次数不对：' + JSON.stringify(calls));
      if (calls[0].method !== 'DELETE'
          || calls[0].url.indexOf('/api/generations/22222222-2222-2222-2222-222222222222') < 0) {
        throw new Error('取消口没打到 /api/generations/{id}');
      }
    } finally {
      sandbox.fetch = prevFetch;
      vm.runInContext('graphView.nodes = []; undefined', sandbox);
    }
    return true;
  });

  return true;
}
