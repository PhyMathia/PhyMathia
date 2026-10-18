// 本机会话缓存 LRU（T348，2026-10-16）：本机 msgs_/graph_/graph_history_ 只留当前
// 会话＋最近 N 个会话，清理点在启动与切会话（严禁退出时机），服务端镜像一字不动
// （T212）；切回旧画布时消息/画布/撤销历史按需从服务端补回。回归四面：键→会话
// id 归类（history 不误判成 graph）、保留窗口选择、按窗口真删、源码契约
// （T342 删除回收 history 键 / 清理点无退出钩子）。
import { check, drain, sandbox, storageData, fs, vm } from './_runner.mjs';

export async function run() {
  const realActive = sandbox.window.getCurrentSessionId;
  const restoreActive = () => { sandbox.window.getCurrentSessionId = realActive; };

  check('T348: 保留窗口＝当前会话＋最近 N（history 键按会话 id 归类，不误判）', () => {
    const f = sandbox.window._localCacheEvictKeys;
    if (typeof f !== 'function') throw new Error('_localCacheEvictKeys 未暴露');
    const keys = [
      'phymathia_msgs_lru_a', 'phymathia_graph_lru_a', 'phymathia_graph_history_lru_a',
      'phymathia_msgs_lru_b', 'phymathia_graph_history_lru_b',
      'phymathia_msgs_lru_c', 'phymathia_graph_history_lru_c',
    ];
    sandbox.window.getCurrentSessionId = () => '';
    keys.forEach(k => { storageData[k] = 'x'; });
    try {
      const evict = f({ lru_a: { updatedAt: 1 }, lru_b: { updatedAt: 2 }, lru_c: { updatedAt: 3 } }, 'lru_a', '', 1);
      const set = new Set(evict);
      // lru_b 不在当前（a）也不在最近 1 个（c）里 → 它的键全清
      if (!set.has('phymathia_msgs_lru_b') || !set.has('phymathia_graph_history_lru_b')) return false;
      // a（当前）与 c（最近 1）全留；history_lru_a 必须被当 lru_a 的键留下，
      // 不能解析成会话 'history_lru_a' 而漏留/误删
      for (const k of ['phymathia_msgs_lru_a', 'phymathia_graph_lru_a', 'phymathia_graph_history_lru_a',
        'phymathia_msgs_lru_c', 'phymathia_graph_history_lru_c']) {
        if (set.has(k)) return false;
      }
      return true;
    } finally {
      keys.forEach(k => { delete storageData[k]; });
      restoreActive();
    }
  });

  check('T348: _pruneLocalSessionCachesCore 按窗口真删本地键、保留窗口内原样', () => {
    const f = sandbox.window._pruneLocalSessionCachesCore;
    if (typeof f !== 'function') throw new Error('_pruneLocalSessionCachesCore 未暴露');
    const snapshot = JSON.parse(JSON.stringify(storageData));
    sandbox.window.getCurrentSessionId = () => '';
    storageData['phymathia_msgs_lru_o'] = 'o';
    storageData['phymathia_graph_lru_o'] = '{}';
    storageData['phymathia_graph_history_lru_o'] = '[]';
    storageData['phymathia_msgs_lru_keep'] = 'k';
    storageData['phymathia_graph_history_lru_keep'] = '[]';
    try {
      const removed = f({ lru_o: { updatedAt: 1 }, lru_keep: { updatedAt: 2 } }, 'lru_keep', '', 1);
      const set = new Set(removed);
      if (!set.has('phymathia_msgs_lru_o') || !set.has('phymathia_graph_lru_o') || !set.has('phymathia_graph_history_lru_o')) return false;
      if (set.has('phymathia_msgs_lru_keep') || set.has('phymathia_graph_history_lru_keep')) return false;
      if (storageData['phymathia_msgs_lru_o'] !== undefined) return false;
      if (storageData['phymathia_graph_history_lru_o'] !== undefined) return false;
      if (storageData['phymathia_msgs_lru_keep'] === undefined) return false;
      return true;
    } finally {
      for (const k of Object.keys(storageData)) delete storageData[k];
      Object.assign(storageData, snapshot);
      restoreActive();
    }
  });

  check('T348/T342: 清理点只在启动/切会话/同步（无退出钩子）＋删除回收 history 键', () => {
    const src = fs.readFileSync('src/static/js/session.js', 'utf8');
    const calls = src.match(/pruneLocalSessionCaches\('([a-z]+)'/g) || [];
    const allowed = new Set(["pruneLocalSessionCaches('startup'", "pruneLocalSessionCaches('switch'", "pruneLocalSessionCaches('sync'"]);
    if (calls.length !== 3) throw new Error('清理点应为启动/切会话/同步三处，实为 ' + calls.join(','));
    for (const c of calls) if (!allowed.has(c)) throw new Error('非法清理点：' + c);
    const bu = src.indexOf("window.addEventListener('beforeunload'");
    if (bu >= 0 && src.slice(bu, bu + 900).includes('pruneLocalSessionCaches')) {
      throw new Error('LRU 不得挂在 beforeunload/退出时机（T348 补充约束②）');
    }
    if (!src.includes("localStorage.removeItem('phymathia_graph_history_' + id)")) {
      throw new Error('_purgeSessionData 未回收 history 键（T342）');
    }
    if (!src.includes("localStorage.removeItem('phymathia_graph_history_' + dsid)")) {
      throw new Error('墓碑清理未回收 history 键（T342 同口径）');
    }
    if (!src.includes('lruKeepSids.has(sid)')) {
      throw new Error('15 秒同步缺保留窗口闸门，LRU 会被灌回');
    }
    if (!src.includes('_serverKnownLocalCacheSids = new Set(serverSessionIds)')) {
      throw new Error('LRU 缺「服务端确认存在」安全闸（本地独有画布是唯一副本，不可删）');
    }
    if (!src.includes('_serverKnownLocalCacheSids, _serverMsgGapSids);')) {
      throw new Error('LRU 未把服务端确认集喂给清理核（T356 起连缺口名单一起喂）');
    }
    return true;
  });

  check('T348: 服务端撤销镜像补回链路未动（跨开关页面撤销靠它）', () => {
    const src = fs.readFileSync('src/static/js/graph.js', 'utf8');
    const ensure = src.slice(src.indexOf('function _ensureGraphHistory'), src.indexOf('function _graphHistoryDedupe'));
    if (!ensure.includes('_upgradeGraphHistoryFromServer(sid)')) throw new Error('切会话/加载未接服务端历史补回');
    const slim = src.slice(src.indexOf('function _graphHistoryMirrorSlim'), src.indexOf('function _scheduleGraphHistoryMirror'));
    if (!slim.includes('pruned')) throw new Error('T212 服务端镜像减重口径被动过');
    return true;
  });

  // ===== T356：消息镜像缺口（2026-10-17 答辩后修复轮） =====
  check('T356: LRU 缺口护栏——服务端确认缺消息文件的会话，msgs 本地键不清、graph 照常回收', () => {
    const f = sandbox.window._localCacheEvictKeys;
    if (typeof f !== 'function') throw new Error('_localCacheEvictKeys 未暴露');
    const keys = [
      'phymathia_msgs_gap_s', 'phymathia_graph_gap_s', 'phymathia_graph_history_gap_s',
      'phymathia_msgs_ok_s',
    ];
    sandbox.window.getCurrentSessionId = () => '';
    keys.forEach(k => { storageData[k] = 'x'; });
    const gapSids = new Set(['gap_s']);
    try {
      // 两会话都不在保留窗口（当前空＋keep 0），都在服务端名录里（serverKnownSids 放行）
      const evict = f({ gap_s: { updatedAt: 1 }, ok_s: { updatedAt: 2 } }, '', '', 0,
        new Set(['gap_s', 'ok_s']), gapSids);
      const set = new Set(evict);
      // gap_s 的消息键是最后一份副本：不清；它的画布/撤销键服务端有镜像，照常回收
      if (set.has('phymathia_msgs_gap_s')) throw new Error('缺口会话的 msgs 键被 LRU 清了');
      if (!set.has('phymathia_graph_gap_s') || !set.has('phymathia_graph_history_gap_s')) {
        throw new Error('缺口护栏误伤同会话的 graph/history 键回收');
      }
      // 服务端有消息文件的会话（不在缺口名单）：msgs 照旧回收
      if (!set.has('phymathia_msgs_ok_s')) throw new Error('非缺口会话的 msgs 键没按旧口径回收');
      // 不传缺口名单（旧调用方）：行为与 T348 原口径完全一致
      const evictOld = f({ gap_s: { updatedAt: 1 } }, '', '', 0, new Set(['gap_s']));
      if (!new Set(evictOld).has('phymathia_msgs_gap_s')) throw new Error('旧口径被改动（应照清）');
      return true;
    } finally {
      keys.forEach(k => { delete storageData[k]; });
      restoreActive();
    }
  });

  check('T356: 同步缺口补传三件套在源码里（pushGapIds 名单＋循环放行＋切会话补传）', () => {
    const src = fs.readFileSync('src/static/js/session.js', 'utf8');
    if (!src.includes('const pushGapIds = new Set()')) throw new Error('同步循环缺补传名单');
    if (!src.includes("serverSessions[sid].msgSaved === false")) {
      throw new Error('补传判据没接服务端 msgSaved 标注');
    }
    if (!src.includes("_serverMsgGapSids.clear()")) throw new Error('缺口名单每轮不重建，补传后护栏永不解除');
    if (!src.includes('!pullIds.includes(sid) && !pushGapIds.has(sid)')) {
      throw new Error('合并循环没放行补传名单会话');
    }
    if (!src.includes('_serverMsgGapSids.has(id)')) throw new Error('切会话没有打开即补传');
    if (!src.includes('msgGapSids && msgGapSids.has(sid)')) throw new Error('LRU 清理核缺缺口护栏');
    return true;
  });

  // ===== T349：清空画布回收撤销历史（2026-10-17）=====
  check('T349: discardGraphHistoryForSession 三清——内存栈/本地键/在途镜像，服务端镜像发 DELETE', () => {
    if (typeof sandbox.window.discardGraphHistoryForSession !== 'function') {
      throw new Error('graph.js 未暴露 discardGraphHistoryForSession');
    }
    const sid = 'sess_clear_hist';
    const histKey = 'phymathia_graph_history_' + sid;
    sandbox.window.getCurrentSessionId = () => sid;
    const posts = [];
    const realFetch = sandbox.fetch;
    sandbox.fetch = (url, opts) => { posts.push({ url, opts }); return realFetch(url, opts); };
    storageData[histKey] = '[]';
    try {
      vm.runInContext('graphHistorySession = ' + JSON.stringify(sid) + ';'
        + 'graphUndoStack = [{ sessionId: ' + JSON.stringify(sid) + ', state: { a: 1 }, messages: null, meta: { source: "user", summary: "x", ts: 1 } }];'
        + 'graphHistoryCursor = 1;'
        + 'graphHistoryLive = { sessionId: ' + JSON.stringify(sid) + ', state: { b: 2 }, messages: null, meta: { source: "now", summary: "最新状态", ts: 2 } };'
        + '_scheduleGraphHistoryMirror(' + JSON.stringify(sid) + ', { v: 2, e: [{ sessionId: ' + JSON.stringify(sid) + ', state: {}, meta: null }], c: 1, l: null });', sandbox);
      sandbox.window.discardGraphHistoryForSession(sid);   // 同步副作用当场生效，DELETE 浮空走桩
      if (vm.runInContext('graphUndoStack.length + "/" + graphHistoryCursor + "/" + graphHistoryLive', sandbox) !== '0/0/null') {
        throw new Error('内存撤销栈/游标/最新锚点没清');
      }
      if (storageData[histKey] !== undefined) throw new Error('本地 history 键没删');
      if (vm.runInContext('_graphHistoryMirrorPending', sandbox) !== null) {
        throw new Error('在途镜像没作废（800ms 防抖会把旧栈 POST 回服务端）');
      }
      if (posts.length !== 1 || posts[0].opts.method !== 'DELETE') throw new Error('服务端镜像没发 DELETE');
      if (posts[0].url !== '/api/kv/' + encodeURIComponent('graph_history:' + sid)) {
        throw new Error('DELETE 键不对：' + posts[0].url);
      }
      return true;
    } finally {
      sandbox.fetch = realFetch;
      delete storageData[histKey];
      restoreActive();
    }
  });

  check('T349: clearChat 接撤销历史回收（与 T342 删除画布同口径）', () => {
    const src = fs.readFileSync('src/static/js/session.js', 'utf8');
    if (!src.includes('await window.discardGraphHistoryForSession(currentSessionId)')) {
      throw new Error('clearChat 未接 discardGraphHistoryForSession');
    }
    return true;
  });

  // 本文件唯一的异步用例，放最后：check 不 await 异步断言，放中间会与后续同步用例
  // 并发跑同一沙箱（AGENTS 混排坑）
  check('T349: 清空后迟到的服务端存档补回被纪元号作废', async () => {
    const sid = 'sess_wipe_epoch';
    sandbox.window.getCurrentSessionId = () => sid;
    let release;
    const gate = new Promise(r => { release = r; });
    const old = [{ sessionId: sid, state: { old: 1 }, meta: null }];
    const realFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => {
      if (opts && opts.method === 'DELETE') return realFetch(url, opts);  // 清空的 DELETE 放行
      await gate;                                                          // 存档 GET 停在闸门
      return { ok: true, status: 200, json: async () => ({ value: old }) };
    };
    try {
      vm.runInContext('graphHistorySession = ' + JSON.stringify(sid) + '; graphUndoStack = []; graphHistoryCursor = 0; graphHistoryLive = null;', sandbox);
      sandbox._upgradeGraphHistoryFromServer(sid);
      await new Promise(r => setTimeout(r, 5));          // 补回起飞、停在闸门
      sandbox.window.discardGraphHistoryForSession(sid); // 清空：纪元号 +1（不 await）
      release();
      await new Promise(r => setTimeout(r, 10));
      if (vm.runInContext('graphUndoStack.length', sandbox) !== 0) {
        throw new Error('迟到存档把清空后的栈接回来了（纪元号闸失效）');
      }
      return true;
    } finally {
      sandbox.fetch = realFetch;
      release();
      restoreActive();
    }
  });

  await drain();
}
