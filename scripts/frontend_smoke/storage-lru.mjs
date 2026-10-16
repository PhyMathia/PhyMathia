// 本机会话缓存 LRU（T348，2026-10-16）：本机 msgs_/graph_/graph_history_ 只留当前
// 会话＋最近 N 个会话，清理点在启动与切会话（严禁退出时机），服务端镜像一字不动
// （T212）；切回旧画布时消息/画布/撤销历史按需从服务端补回。回归四面：键→会话
// id 归类（history 不误判成 graph）、保留窗口选择、按窗口真删、源码契约
// （T342 删除回收 history 键 / 清理点无退出钩子）。
import { check, drain, sandbox, storageData, fs } from './_runner.mjs';

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
    if (!src.includes('_serverKnownLocalCacheSids);')) {
      throw new Error('LRU 未把服务端确认集喂给清理核');
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

  await drain();
}
