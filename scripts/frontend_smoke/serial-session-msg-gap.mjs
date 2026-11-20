// T356 补传竞态回归（2026-11-20）：打开一张「服务端缺消息文件」的缺口画布 A，
// 图状态还在加载（真实网络请求）时切到画布 B。旧实现在 await 回来后直接读模块级
// chatHistory（此时已被 B 的 switchToSession 改写成 B 的消息）并补传到 A——A 的
// 服务端存档被写入 B 的对话，再随 15 秒并集同步扩散到其他设备。
// 本用例真跑 switchToSession：graph:<A> 请求停在闸门 → 切 B（完整走完）→ 放行 A，
// 断言没有任何发往 A 的消息 POST 带 B 的内容（切走即放弃，交给 15 秒同步兜底）；
// 随后单独打开 A，仍应把 A 自己的历史补传上去（守卫不许误伤正常功能）。
import { check, drain, sandbox, storageData, restoreWindowStub, vm } from './_runner.mjs';

const A = 'sess_gap_race_a';
const B = 'sess_gap_race_b';
const C = 'sess_gap_race_c';
const A_MSGS = [{ role: 'user', content: 'A 的旧问题', timestamp: 1001 }];
const B_MSGS = [{ role: 'user', content: 'B 的新问题', timestamp: 2001 }];
const SESSIONS = {
  [A]: { id: A, title: '画布 A', sessionId: 'p_' + A, createdAt: 1, updatedAt: 1 },
  [B]: { id: B, title: '画布 B', sessionId: 'p_' + B, createdAt: 2, updatedAt: 2 },
  [C]: { id: C, title: '画布 C', sessionId: 'p_' + C, createdAt: 3, updatedAt: 3 },
};

export async function run() {
  check('T356 竞态：打开缺口画布 A 时切到 B，A 的补传不得写入 B 的对话', async () => {
    const keys = ['phymathia_sessions', 'phymathia_current_session',
      'phymathia_msgs_' + A, 'phymathia_msgs_' + B, 'phymathia_msgs_' + C];
    const prevStorage = {};
    for (const k of keys) prevStorage[k] = storageData[k];

    const prevFetch = sandbox.fetch;
    const prevAbortSignal = sandbox.AbortSignal;
    const prevStubs = {
      notifyHarnessCanvasChanged: sandbox.window.notifyHarnessCanvasChanged,
      resetSocraticBranch: sandbox.window.resetSocraticBranch,
      clearBranchAnchor: sandbox.window.clearBranchAnchor,
      renderGraphCanvas: sandbox.window.renderGraphCanvas,
    };
    const prevState = JSON.parse(vm.runInContext(
      'JSON.stringify({ sessions: sessions, currentSessionId: currentSessionId,'
      + ' chatHistory: chatHistory, SESSION_ID: SESSION_ID,'
      + ' serverAvailable: _serverAvailable, serverCheckedAt: _serverAvailableCheckedAt,'
      + ' serverKnown: _serverKnownLocalCacheSids ? Array.from(_serverKnownLocalCacheSids) : null,'
      + ' gapSids: Array.from(_serverMsgGapSids), tombstones: Array.from(_tombstonedSids),'
      + ' pushed: Array.from(_lastPushedMsgsSig) })', sandbox));

    let releaseGraphA = null;
    const graphAGate = new Promise(resolve => { releaseGraphA = resolve; });
    let markGraphAStarted = null;
    const graphAStarted = new Promise(resolve => { markGraphAStarted = resolve; });
    let holdGraphA = true;
    const posts = [];

    // vm 沙箱没有 Web 全局 AbortSignal（session.js 的 fetch 选项要用）
    sandbox.AbortSignal = AbortSignal;
    sandbox.window.notifyHarnessCanvasChanged = () => {};
    sandbox.window.resetSocraticBranch = () => {};
    sandbox.window.clearBranchAnchor = () => {};
    sandbox.window.renderGraphCanvas = () => {};
    sandbox.fetch = async (url, opts) => {
      const u = String(url || '');
      const method = (opts && opts.method) || 'GET';
      const okJson = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      const msgMatch = u.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (msgMatch && method === 'POST') {
        let body = {};
        try { body = JSON.parse(opts.body || '{}'); } catch (e) {}
        posts.push({ sid: decodeURIComponent(msgMatch[1]), msgs: Array.isArray(body.messages) ? body.messages : [] });
        return { ok: true, status: 200, headers: { get: () => '1' }, json: async () => ({}), text: async () => '{}' };
      }
      if (u === '/api/sessions' && method === 'GET') return okJson(SESSIONS);
      if (u.indexOf('/api/kv/') === 0 && method === 'GET') {
        const key = decodeURIComponent(u.slice('/api/kv/'.length));
        if (holdGraphA && key === 'graph:' + A) {
          if (markGraphAStarted) { const fn = markGraphAStarted; markGraphAStarted = null; fn(); }
          await graphAGate;
        }
        return okJson({ value: null });
      }
      return okJson({});
    };

    try {
      storageData['phymathia_sessions'] = JSON.stringify(SESSIONS);
      storageData['phymathia_current_session'] = C;
      storageData['phymathia_msgs_' + A] = JSON.stringify(A_MSGS);
      storageData['phymathia_msgs_' + B] = JSON.stringify(B_MSGS);
      storageData['phymathia_msgs_' + C] = '[]';
      vm.runInContext('sessions = ' + JSON.stringify(SESSIONS) + ';'
        + ' currentSessionId = ' + JSON.stringify(C) + '; chatHistory = [];'
        + ' SESSION_ID = ' + JSON.stringify(SESSIONS[C].sessionId) + ';'
        + ' _serverAvailable = true; _serverAvailableCheckedAt = Date.now();'
        + ' _serverKnownLocalCacheSids = new Set(' + JSON.stringify([A, B, C]) + ');'
        + ' _serverMsgGapSids.clear(); _serverMsgGapSids.add(' + JSON.stringify(A) + ');'
        + ' _tombstonedSids.clear();', sandbox);

      // A 打开：图状态请求卡在闸门（模拟慢网络），用户随即切到 B
      const switchA = sandbox.window.switchToSession(A);
      await Promise.race([
        graphAStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('A 的图状态请求没有发出，前置链路已断')), 1000)),
      ]);
      await sandbox.window.switchToSession(B);

      // 放行 A 的图状态请求：旧实现在这里读回已被改写成 B 的 chatHistory 并补传
      releaseGraphA();
      await switchA;

      const leaked = posts.filter(p => p.sid === A
        && p.msgs.some(m => m && m.content === 'B 的新问题'));
      if (leaked.length) {
        throw new Error('切到 B 后 A 的补传写入了 B 的对话：' + JSON.stringify(leaked));
      }

      // 正常路径不能因守卫被砍：单独打开 A 仍要自动补传它自己的历史
      holdGraphA = false;
      posts.length = 0;
      vm.runInContext(' currentSessionId = ' + JSON.stringify(C) + '; chatHistory = [];'
        + ' SESSION_ID = ' + JSON.stringify(SESSIONS[C].sessionId) + ';'
        + ' _serverMsgGapSids.clear(); _serverMsgGapSids.add(' + JSON.stringify(A) + ');', sandbox);
      await sandbox.window.switchToSession(A);
      const ownPush = posts.filter(p => p.sid === A
        && p.msgs.length === 1 && p.msgs[0].content === 'A 的旧问题');
      if (!ownPush.length) {
        throw new Error('正常打开缺口画布 A 没有补传自己的历史（守卫误伤功能）');
      }
      return true;
    } finally {
      releaseGraphA();
      sandbox.fetch = prevFetch;
      sandbox.AbortSignal = prevAbortSignal;
      restoreWindowStub('notifyHarnessCanvasChanged', prevStubs.notifyHarnessCanvasChanged);
      restoreWindowStub('resetSocraticBranch', prevStubs.resetSocraticBranch);
      restoreWindowStub('clearBranchAnchor', prevStubs.clearBranchAnchor);
      restoreWindowStub('renderGraphCanvas', prevStubs.renderGraphCanvas);
      for (const k of keys) {
        if (prevStorage[k] === undefined) delete storageData[k];
        else storageData[k] = prevStorage[k];
      }
      vm.runInContext(' sessions = ' + JSON.stringify(prevState.sessions) + ';'
        + ' currentSessionId = ' + JSON.stringify(prevState.currentSessionId) + ';'
        + ' chatHistory = ' + JSON.stringify(prevState.chatHistory) + ';'
        + ' SESSION_ID = ' + JSON.stringify(prevState.SESSION_ID) + ';'
        + ' _serverAvailable = ' + JSON.stringify(prevState.serverAvailable) + ';'
        + ' _serverAvailableCheckedAt = ' + Number(prevState.serverCheckedAt || 0) + ';'
        + ' _serverKnownLocalCacheSids = '
        + (prevState.serverKnown ? 'new Set(' + JSON.stringify(prevState.serverKnown) + ')' : 'null') + ';'
        + ' _serverMsgGapSids.clear();'
        + prevState.gapSids.map(s => '_serverMsgGapSids.add(' + JSON.stringify(s) + ');').join('')
        + ' _tombstonedSids.clear();'
        + prevState.tombstones.map(s => '_tombstonedSids.add(' + JSON.stringify(s) + ');').join('')
        + ' _lastPushedMsgsSig.clear();'
        + prevState.pushed.map(([s, v]) => '_lastPushedMsgsSig.set(' + JSON.stringify(s) + ',' + JSON.stringify(v) + ');').join(''),
        sandbox);
    }
  });
  await drain();
}
