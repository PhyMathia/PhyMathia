// 导入写满浏览器本地存储（2026-11-24 用户实测）：导入分两步——先 POST /api/backup/import
// 写服务端（电脑存档，真相源），再把备份回放进本机 localStorage 缓存。浏览器给
// localStorage 的配额只有约 5MB，账号数据（画布状态＋撤销历史）轻易超过，第二步写满是
// 常态。修前：_applyLocalSettings 里几处裸 localStorage.setItem 写满即抛，被 confirmImport
// 的 catch 一律报「导入失败：The quota has been exceeded.」——而服务端早已写成功（刷新后
// 数据都在），且收尾步骤（删除登记表除名等）被整段跳过。修后：缓存写入全走登记口不抛、
// 结论只看服务端——服务端收下＝导入完成＋一句缓存说明；离线只写本机且没写全才报未完成。
// 行为用例真跑 confirmImport（换 fetch/localStorage.setItem/document/showToast/
// setTimeout/location.reload 桩，用毕还原）；本域自带收口线且放在全流程末尾。
import fs from 'node:fs';
import { check, drain, sandbox, vm, storageData, loose } from './_runner.mjs';

const SID = 'bq_s1';
const DOM_IDS = ['importConfirmBtn', 'importCancelBtn', 'importPreviewResult'];
const WROTE_KEYS = [
  'phymathia_sessions', 'phymathia_knowledge', 'phymathia_formulas',
  'phymathia_msgs_' + SID, 'phymathia_graph_' + SID, 'phymathia_theme',
  'phymathia_user_models', 'phymathia_active_models', 'phymathia_quiz_bank',
  'phymathia_knowledge_deleted',
];
const TOMB_KEYS = ['phymathia_knowledge_deleted', 'phymathia_formulas_deleted'];
// 配额满的三种形态
const QUOTA_ALL = () => true;                                    // 彻底满：连一行设置都写不进
const QUOTA_EXCEPT_TOMBS = (k) => !TOMB_KEYS.includes(k);         // 数据与设置全失败，只有删除登记表写得起
const QUOTA_BIG = (k) => k.startsWith('phymathia_graph_') || k.startsWith('phymathia_msgs_'); // 只有大块写不进
const QUOTA_FORMULA_GRAPH = (k) => k === 'phymathia_formulas' || k.startsWith('phymathia_graph_');

function backupData() {
  return {
    sessions: { [SID]: { id: SID, title: '配额用例', createdAt: 1700000000000, updatedAt: 1700000000000 } },
    messages: { [SID]: [{ id: 'm1', role: 'user', content: '问题', timestamp: 1700000000000 }] },
    knowledge: { ki_1: { id: 'ki_1', concept: '动量', createdAt: 1700000000000, updatedAt: 1700000000000 } },
    formulas: { f_1: { id: 'f_1', latex: 'p=mv', createdAt: 1700000000000, updatedAt: 1700000000000 } },
    graphs: { [SID]: { version: 1, updatedAt: 1700000000000, customNodes: [] } },
    graphHistories: {},
    quizStats: { total: 1 },
    quizBank: { items: [] },
    userModels: [{ id: 'um_1', provider: 'openai', model: 'gpt-x', name: 'x', apiKey: '' }],
    activeModels: { main: 'um_1' },
    settings: { phymathia_theme: 'dark' },
    theme: 'dark',
  };
}

// 服务端口径：'ok'＝收下并回 autoBackup；'reject'＝500 带原因；'down'＝网络不通（fetch 抛）
function importFetch(server) {
  return async (url) => {
    const isImport = String(url).includes('/api/backup/import');
    if (server === 'down') throw new Error('network down');
    if (isImport && server === 'reject') {
      return { ok: false, status: 500, json: async () => ({ detail: '导入前自动备份失败，已取消导入：disk full' }) };
    }
    if (isImport) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions: 1, messages: 1, knowledge: 1, formulas: 1, autoBackup: { id: 'snap1' } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

// 装桩：返回 { out 观测值, capture 取数（还原前调）, restore }。
// quota(key, value) 为真＝这次 localStorage.setItem 抛 QuotaExceededError（Firefox 文案同款）。
function enter({ server, quota, tombstone, breakAfterApply }) {
  const storageSnap = { ...storageData };
  const prev = {
    fetch: sandbox.fetch, set: sandbox.localStorage.setItem, doc: sandbox.document,
    timeout: sandbox.setTimeout, reload: sandbox.location.reload, toast: sandbox.showToast,
    signal: sandbox.AbortSignal, invalidate: sandbox.invalidateKnowledgeCache,
  };
  const els = {};
  DOM_IDS.forEach(id => { els[id] = { textContent: '', style: {}, disabled: false }; });
  const out = { result: '', confirm: '', confirmDisabled: null, toasts: [], reloads: 0, timers: [], wrote: {} };
  storageData['phymathia_sessions'] = '{}';
  storageData['phymathia_knowledge'] = '{}';
  storageData['phymathia_formulas'] = '{}';
  if (tombstone) storageData['phymathia_knowledge_deleted'] = JSON.stringify({ ki_1: 1700000000000 });
  if (server) sandbox.fetch = importFetch(server);
  sandbox.localStorage.setItem = (k, v) => {
    if (quota && quota(k, v)) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return prev.set(k, v);
  };
  // getElementById 走外层代理、未登记的 id 给中性 loose 元素——替身函数绝不回摸
  // prev.doc（首版用 Object.create 原型回落，替身经链上摸回自身无限递归爆栈，
  // 报成无关的「Maximum call stack size exceeded」混进用例结果）。
  sandbox.document = new Proxy(prev.doc, {
    get(t, p) {
      if (p === 'getElementById') return (id) => els[id] || loose('element#' + String(id));
      return t[p];
    },
  });
  sandbox.setTimeout = (fn, ms) => { out.timers.push(ms); return 0; };
  sandbox.location.reload = () => { out.reloads++; };
  sandbox.showToast = (msg) => { out.toasts.push(String(msg)); };
  // 沙箱没有 AbortSignal（平台全局，不是 JS 内建），confirmImport 的 fetch 选项里用到
  sandbox.AbortSignal = prev.signal || { timeout: () => ({}) };
  if (breakAfterApply) sandbox.invalidateKnowledgeCache = () => { throw new Error('boom'); };
  sandbox.__bqBackup = backupData();
  const capture = () => {
    out.result = els['importPreviewResult'].textContent;
    out.confirm = els['importConfirmBtn'].textContent;
    out.confirmDisabled = els['importConfirmBtn'].disabled;
    WROTE_KEYS.forEach(k => { if (k in storageData) out.wrote[k] = storageData[k]; });
  };
  const restore = () => {
    sandbox.fetch = prev.fetch;
    sandbox.localStorage.setItem = prev.set;
    sandbox.document = prev.doc;
    sandbox.setTimeout = prev.timeout;
    sandbox.location.reload = prev.reload;
    sandbox.showToast = prev.toast;
    sandbox.invalidateKnowledgeCache = prev.invalidate;
    if (prev.signal) sandbox.AbortSignal = prev.signal; else delete sandbox.AbortSignal;
    delete sandbox.__bqBackup;
    // 共享存储整体还原：本例新写的键删掉、动过的键换回原值
    Object.keys(storageData).forEach(k => { delete storageData[k]; });
    Object.assign(storageData, storageSnap);
  };
  return { out, capture, restore };
}

async function runImport(opts) {
  const env = enter(opts);
  try {
    vm.runInContext('_pendingImport = { data: __bqBackup, fileName: "bq.json", fileSize: 4096, mode: "merge", conflict: "newer", preview: {} };'
      + ' _importBusy = false;', sandbox);
    await vm.runInContext('confirmImport()', sandbox);
    env.capture();
  } finally {
    env.restore();
  }
  return env.out;
}

function runApply(quota) {
  const env = enter({ quota });
  try {
    env.out.misses = vm.runInContext('_applyLocalBackup(__bqBackup, false)', sandbox);
  } finally {
    env.restore();
  }
  return env.out;
}

// 逐项选择（2026-11-24）：本机回放要和服务端同口径——用户翻面的条目按决定走，
// 没翻面的仍按「保留较新」。本地种子故意都比备份新，翻面才有可观测差异。
function runApplyManual(decisions) {
  const env = enter({});
  const T = 1700000000000;
  const newer = T + 1000;
  storageData['phymathia_sessions'] = JSON.stringify({
    [SID]: { id: SID, title: '当前会话', updatedAt: newer },
  });
  storageData['phymathia_knowledge'] = JSON.stringify({
    ki_1: { id: 'ki_1', title: '当前知识', source: 'manual', updatedAt: newer },
  });
  storageData['phymathia_msgs_' + SID] = JSON.stringify([
    { role: 'user', content: '当前同刻', timestamp: T },
  ]);
  try {
    env.out.misses = vm.runInContext(
      '_applyLocalBackup(__bqBackup, false, "manual", ' + JSON.stringify(decisions) + ')', sandbox);
    env.out.after = {
      sessions: JSON.parse(storageData['phymathia_sessions'] || '{}'),
      knowledge: JSON.parse(storageData['phymathia_knowledge'] || '{}'),
      messages: JSON.parse(storageData['phymathia_msgs_' + SID] || '[]'),
    };
  } finally {
    env.restore();
  }
  return env.out;
}

export async function run() {
  // 本域整体换全局桩：先等前面各域在途的异步用例落地，再串行跑自己的
  await drain();
  const noFailToast = (r) => !r.toasts.some(t => t.includes('导入失败'));

  check('backup-quota: 服务端已收下＋本机缓存全写不进——报「导入完成」带缓存说明并刷新；收尾的删除登记表除名照常执行', async () => {
    const r = await runImport({ server: 'ok', quota: QUOTA_EXCEPT_TOMBS, tombstone: true });
    if (!r.result.startsWith('导入完成：')) throw new Error('服务端已收下却没报导入完成：' + r.result);
    if (!r.result.includes('浏览器本地空间不足') || !r.result.includes('电脑存档')) throw new Error('回执缺缓存说明：' + r.result);
    if (r.wrote['phymathia_knowledge_deleted'] !== '{}') {
      throw new Error('收尾的删除登记表除名被跳过（下一轮同步会把刚导入的知识点再删掉）：' + r.wrote['phymathia_knowledge_deleted']);
    }
    if (!r.timers.includes(3600)) throw new Error('带缓存说明应留 3.6 秒再刷新，定时器：' + r.timers.join(','));
    if (!noFailToast(r)) throw new Error('出现「导入失败」toast：' + r.toasts.join(' | '));
    if (!r.toasts.some(t => t.includes('导入完成') && t.includes('不影响使用'))) throw new Error('toast 应说明已导入且不影响使用：' + r.toasts.join(' | '));
    return true;
  });
  await drain();

  check('backup-quota: 服务端已收下＋只有大块写不进——回执带缓存说明，写得进的小键照常落地', async () => {
    const r = await runImport({ server: 'ok', quota: QUOTA_BIG });
    if (!r.result.startsWith('导入完成：')) throw new Error('应报导入完成：' + r.result);
    if (!r.result.includes('浏览器本地空间不足')) throw new Error('回执缺缓存说明：' + r.result);
    if (!(r.wrote['phymathia_sessions'] || '').includes(SID)) throw new Error('写得进的小键（会话名单）应照常落地');
    if (('phymathia_graph_' + SID) in r.wrote) throw new Error('配额满的画布键不该写进去');
    if (!r.timers.includes(3600)) throw new Error('带缓存说明应留 3.6 秒再刷新，定时器：' + r.timers.join(','));
    return true;
  });
  await drain();

  check('backup-quota: 服务端已收下＋收尾步骤抛异常——仍算导入完成（本机缓存没有更新）并刷新，不报失败', async () => {
    const r = await runImport({ server: 'ok', breakAfterApply: true });
    if (!r.result.startsWith('导入完成：') || !r.result.includes('本机缓存没有更新')) throw new Error('回执口径不对：' + r.result);
    if (!r.timers.includes(3600)) throw new Error('带说明应留 3.6 秒再刷新，定时器：' + r.timers.join(','));
    if (!noFailToast(r)) throw new Error('出现「导入失败」toast：' + r.toasts.join(' | '));
    return true;
  });
  await drain();

  check('backup-quota: 服务端已收下＋缓存全写进——回执不带缓存说明，照旧 1.4 秒刷新', async () => {
    const r = await runImport({ server: 'ok' });
    if (!r.result.startsWith('导入完成：')) throw new Error('应报导入完成：' + r.result);
    if (r.result.includes('本地空间不足') || r.result.includes('本机缓存没有更新')) throw new Error('缓存全写进不该带说明：' + r.result);
    if (!(('phymathia_graph_' + SID) in r.wrote)) throw new Error('画布缓存应已写入');
    if (!r.timers.includes(1400) || r.timers.includes(3600)) throw new Error('无说明应照旧 1.4 秒刷新，定时器：' + r.timers.join(','));
    return true;
  });
  await drain();

  check('backup-quota: 服务端拒绝（500 带原因）——照旧报「导入失败：原因」，不回放本机缓存、不刷新、按钮复原', async () => {
    const r = await runImport({ server: 'reject' });
    if (r.result !== '导入失败：导入前自动备份失败，已取消导入：disk full') throw new Error('服务端拒绝的失败口径变了：' + r.result);
    if (r.reloads !== 0) throw new Error('服务端拒绝不该刷新');
    if (r.wrote['phymathia_knowledge'] !== '{}') throw new Error('服务端拒绝时不该回放本机缓存');
    if (r.confirmDisabled !== false || r.confirm !== '确认合并') throw new Error('失败后按钮应复原可重试');
    return true;
  });
  await drain();

  check('backup-quota: 服务端不通＋本机缓存全写不进——报「导入未完成…只存下了一部分」，不刷新、可重试', async () => {
    const r = await runImport({ server: 'down', quota: QUOTA_ALL });
    if (!r.result.startsWith('导入未完成')) throw new Error('离线且没存全不该报完成：' + r.result);
    if (!r.result.includes('只存下了一部分')) throw new Error('应照实说明只存下一部分：' + r.result);
    if (r.reloads !== 0) throw new Error('没存全不该刷新');
    if (r.confirmDisabled !== false) throw new Error('应可重试，按钮没复原');
    return true;
  });
  await drain();

  check('backup-quota: 服务端不通＋本机写得进——照旧「导入完成（服务端不可用，仅写入本机缓存）」并刷新', async () => {
    const r = await runImport({ server: 'down' });
    if (!r.result.startsWith('导入完成：') || !r.result.includes('服务端不可用')) throw new Error('离线回执口径变了：' + r.result);
    if (!r.timers.includes(1400)) throw new Error('导入完成应安排 1.4 秒后刷新，定时器：' + r.timers.join(','));
    return true;
  });
  await drain();

  check('backup-quota: _applyLocalBackup 不抛、返回没写进的键清单（公式缓存走 setFormulaCache 吞异常也要认出来）', () => {
    const a = runApply(QUOTA_FORMULA_GRAPH);
    if (!Array.isArray(a.misses)) throw new Error('_applyLocalBackup 应返回没写进的键清单，实际：' + a.misses);
    if (!a.misses.includes('phymathia_formulas')) throw new Error('公式缓存经 setFormulaCache 吞了异常，也要认出没写进：' + a.misses.join(','));
    if (!a.misses.includes('phymathia_graph_' + SID)) throw new Error('画布键写不进应登记：' + a.misses.join(','));
    if (a.misses.includes('phymathia_sessions')) throw new Error('写得进的键不该被登记：' + a.misses.join(','));
    const b = runApply(null);
    if (!Array.isArray(b.misses) || b.misses.length !== 0) throw new Error('全写得进应返回空清单：' + JSON.stringify(b.misses));
    const c = runApply(QUOTA_ALL);
    ['phymathia_theme', 'phymathia_msgs_' + SID, 'phymathia_sessions'].forEach(k => {
      if (!c.misses.includes(k)) throw new Error('彻底满时 ' + k + ' 应登记：' + c.misses.join(','));
    });
    return true;
  });
  await drain();

  check('backup-quota: 逐项选择回放——翻面项按决定取备份（本地较新也让步），消息同刻按内容翻面', () => {
    const r = runApplyManual({
      sessions: { [SID]: 'backup' },
      knowledge: { ki_1: 'backup' },
      messages: { [SID + '|ts:1700000000000']: 'backup' },
    });
    if (r.after.sessions[SID].title !== '配额用例') throw new Error('会话翻面没生效：' + r.after.sessions[SID].title);
    if (r.after.knowledge.ki_1.concept !== '动量') throw new Error('知识点翻面没生效：' + JSON.stringify(r.after.knowledge.ki_1));
    if (r.after.messages[0].content !== '问题') throw new Error('消息翻面没生效：' + JSON.stringify(r.after.messages));
    return true;
  });
  await drain();

  check('backup-quota: 逐项选择回放——没翻面的条目仍按「保留较新」，同刻消息保留现有', () => {
    const r = runApplyManual({});
    if (r.after.sessions[SID].title !== '当前会话') throw new Error('未翻面的会话应保留当前：' + r.after.sessions[SID].title);
    if (r.after.knowledge.ki_1.title !== '当前知识') throw new Error('未翻面的知识点应保留当前：' + r.after.knowledge.ki_1.title);
    if (r.after.messages[0].content !== '当前同刻') throw new Error('同刻消息应保留现有：' + JSON.stringify(r.after.messages));
    return true;
  });
  await drain();

  check('backup-quota: 静态契约（_applyLocalSettings 无裸 setItem；confirmImport 结论看服务端；导入后卸载冲刷不回写旧副本）', () => {
    const src = fs.readFileSync('src/static/js/ui-backup.js', 'utf8');
    const start = src.indexOf('function _applyLocalSettings');
    const body = src.slice(start, src.indexOf('function _clearLocalDataForReplace'));
    if (start < 0 || body.length < 100) throw new Error('找不到 _applyLocalSettings 函数体');
    if (body.includes('localStorage.setItem(')) throw new Error('_applyLocalSettings 出现裸 localStorage.setItem——写满即抛、整段导入被误报失败');
    if (!src.includes('const serverImported = !!(serverResp && serverResp.ok);')) throw new Error('confirmImport 缺「结论看服务端」判据 serverImported');
    if (!src.includes('window.__phySkipUnloadFlush = true')) throw new Error('导入/恢复后的刷新没有立「跳过卸载冲刷」标志——旧内存副本会把导入结果盖回去');
    const sessionSrc = fs.readFileSync('src/static/js/session.js', 'utf8');
    if (!sessionSrc.includes('window.__phySkipUnloadFlush')) throw new Error('beforeunload 冲刷未认「跳过卸载冲刷」标志');
    return true;
  });
  await drain();
}
