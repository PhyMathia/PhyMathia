// ====== 数据面板统计与备份导出/导入（2026-10-10 自 ui.js 拆出，T261 纯搬家）=====
// 开面板时 ui.js 的 toggleDataPanel 调 updateDataStats；index.html 导出/导入入口
// 直调 exportData/importData（全局函数，跨文件调用语义不变）。
// T227：localStorage 键可能因旧版脏数据/手改变成非法 JSON——裸 JSON.parse 一抛异常，
// 统计数字与整个数据面板一起没；统一走本文件 _safeParseJSON（157 行函数声明有提升，
// 前向调用无碍），解析失败按对应 fallback 计
function updateDataStats() {
  const sessions = _safeParseJSON(localStorage.getItem('phymathia_sessions'), {});
  const knowledge = _safeParseJSON(localStorage.getItem('phymathia_knowledge'), {});
  const formulas = (typeof getFormulaCache === 'function' ? getFormulaCache() : {}) || {};
  const quizStats = _safeParseJSON(localStorage.getItem('phymathia_quiz_stats'), {});
  const sessionCount = Object.keys(sessions).length;
  let msgCount = 0;
  Object.keys(sessions).forEach(sid => {
    // T227：某会话 msgs 键损坏按该会话 0 条计；内容非数组同样按 0 计，
    // 别让一条脏数据把整页统计打成 NaN
    const msgs = _safeParseJSON(localStorage.getItem('phymathia_msgs_' + sid), []);
    msgCount += Array.isArray(msgs) ? msgs.length : 0;
  });
  const knowledgeCount = Object.keys(knowledge).length;
  const formulaCount = Object.keys(formulas).length;
  const graphCount = lsKeys().filter(k => k.startsWith('phymathia_graph_')).length;
  const quizCount = Object.keys(quizStats).filter(k => k !== '_meta').length;
  const el = document.getElementById('dataStats');
  if (el) {
    el.innerHTML = `当前存储：${sessionCount} 张画布 · ${msgCount} 条消息 · ${knowledgeCount} 条知识点 · ${formulaCount} 条公式 · ${graphCount} 个探索网 · ${quizCount} 个检测主题`;
  }
  updateStorageDebug();
  updateHistoryBackupStats();
  updateBackupSnapshots();
}

// ====== 本机历史备份（2026-11-19）======
// 浏览器 phymathia_msgs_ 只是 LRU 缓存（只留最近 5 个会话），权威副本在服务端
// data/users/<账号>/messages/，可读副本在 data/history/。这里让用户看见本机还剩
// 多少条，并能一键推回服务端——保存接口落盘后会同步刷可读归档。
function _localHistoryEntries() {
  const out = [];
  lsKeys().forEach(key => {
    if (!key.startsWith('phymathia_msgs_')) return;
    const sid = key.slice('phymathia_msgs_'.length);
    const msgs = _safeParseJSON(localStorage.getItem(key), []);
    if (sid && Array.isArray(msgs) && msgs.length) out.push({ sid: sid, count: msgs.length });
  });
  return out.sort(function (a, b) { return b.count - a.count; });
}

function updateHistoryBackupStats() {
  const el = document.getElementById('historyBackupStats');
  if (!el) return;
  const entries = _localHistoryEntries();
  const total = entries.reduce(function (a, x) { return a + x.count; }, 0);
  el.textContent = entries.length
    ? ('本机缓存 ' + entries.length + ' 个会话 · ' + total + ' 条消息')
    : '本机缓存没有消息（服务端是唯一副本）';
}

async function backupLocalHistories() {
  const entries = _localHistoryEntries();
  if (!entries.length) {
    if (typeof showToast === 'function') showToast('本机没有可备份的消息');
    return;
  }
  const btn = document.getElementById('historyBackupBtn');
  if (btn) { btn.disabled = true; btn.textContent = '备份中…'; }
  let ok = 0, fail = 0;
  for (const item of entries) {
    const msgs = _safeParseJSON(localStorage.getItem('phymathia_msgs_' + item.sid), []);
    if (!Array.isArray(msgs) || !msgs.length) continue;
    try {
      // account_id 由 config.js 的 fetch 包装自动补，此处不必手拼
      const resp = await fetch('/api/sessions/' + encodeURIComponent(item.sid) + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs }),
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) ok++; else fail++;
    } catch (e) { fail++; }
  }
  if (btn) { btn.disabled = false; btn.textContent = '备份到项目文件夹'; }
  updateHistoryBackupStats();
  if (typeof showToast === 'function') {
    showToast(fail ? ('已备份 ' + ok + ' 个会话，' + fail + ' 个失败') : ('已备份 ' + ok + ' 个会话到项目文件夹'));
  }
}
window.updateHistoryBackupStats = updateHistoryBackupStats;
window.backupLocalHistories = backupLocalHistories;

function _safeParseJSON(raw, fallback) {
  try {
    const value = raw ? JSON.parse(raw) : fallback;
    return value === null || value === undefined ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function _mergeMaps(base, extra) {
  const result = { ...(base || {}) };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// ====== 备份设置白名单（583，2026-11-24）======
// 替换导入此前先删光当前账号全部 phymathia_*，再只回填 18 个字段——节点配方、
// 背景/皮肤、快捷键、读数偏好与设备编号一起没。现在 replace 只清数据类键；
// 设置按本白名单随备份走（设备编号/账号键刻意不入备份，避免跨机串号）。
const _BACKUP_SETTINGS_KEYS = [
  'phymathia_theme', 'phymathia_bg_dark', 'phymathia_bg_light',
  'phymathia_flip_slow_raster', 'phymathia_node_skin', 'phymathia_graph_text_scale',
  'phymathia_style_family', 'phymathia_theme_split', 'phymathia_style_family_dark',
  'phymathia_style_family_light', 'phymathia_level', 'phymathia_reader_theme',
  'phymathia_latex_repairs', 'phymathia_kp_tab', 'phymathia_quiz_source',
  'phymathia_trash_retention', 'phymathia_settings_tab', 'phymathia_hotkey_overrides',
  'phymathia_onboarding_done', 'phymathia_node_recipes', 'phymathia_recipe_draft',
  'phymathia_module_hint_done', 'phymathia_followup_auto_route',
  'phymathia_readout_speed', 'phymathia_readout_ttft', 'phymathia_readout_elapsed',
  'phymathia_readout_progress', 'phymathia_readout_percent',
  'phymathia_node_fs_followup_route', 'phymathia_harness_thinking',
  'phymathia_harness_fallback', 'phymathia_harness_health'
];
const _BACKUP_SETTINGS_SET = new Set(_BACKUP_SETTINGS_KEYS);
// replace 只清这些「数据」键；设置、账号、设备编号、引导标记全部保留。
const _BACKUP_DATA_KEYS = new Set([
  'phymathia_sessions', 'phymathia_knowledge', 'phymathia_formulas',
  'phymathia_quiz_stats', 'phymathia_quiz_bank', 'phymathia_current_session',
  'phymathia_knowledge_deleted', 'phymathia_formulas_deleted'
]);

function _collectBackupSettings() {
  const out = {};
  _BACKUP_SETTINGS_KEYS.forEach(key => {
    const value = localStorage.getItem(key);
    if (value !== null) out[key] = value;
  });
  return out;
}

function _backupItemTs(item) {
  if (!item || typeof item !== 'object') return 0;
  for (const field of ['updatedAt', 'createdAt']) {
    const value = Number(item[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function _mergeNewerMap(serverMap, localMap) {
  const out = { ...(serverMap || {}) };
  for (const [key, value] of Object.entries(localMap || {})) {
    const current = out[key];
    if (current === undefined || _backupItemTs(value) >= _backupItemTs(current)) out[key] = value;
  }
  return out;
}

function _mergeMessageArrays(primary, secondary) {
  const byKey = new Map();
  const order = [];
  for (const msg of [...(primary || []), ...(secondary || [])]) {
    if (!msg || typeof msg !== 'object') continue;
    const ts = msg.timestamp;
    const key = (typeof ts === 'number' && ts) ? ('ts:' + ts)
      : ('raw:' + String(msg.role || '') + '|' + String(msg.content || ''));
    if (!byKey.has(key)) { byKey.set(key, { ...msg }); order.push(key); }
    else {
      const base = byKey.get(key);
      for (const [field, value] of Object.entries(msg)) {
        const cur = base[field];
        const empty = cur === undefined || cur === null || cur === '' ||
          (Array.isArray(cur) && cur.length === 0);
        if (empty && value !== null && value !== '') base[field] = value;
      }
    }
  }
  const merged = order.map(key => byKey.get(key));
  if (merged.length && merged.every(m => typeof m.timestamp === 'number' && m.timestamp)) {
    merged.sort((a, b) => a.timestamp - b.timestamp);
  }
  return merged;
}

function _mergeMessageMaps(serverMap, localMap) {
  const out = {};
  const sids = new Set([...Object.keys(serverMap || {}), ...Object.keys(localMap || {})]);
  sids.forEach(sid => {
    out[sid] = _mergeMessageArrays((serverMap || {})[sid], (localMap || {})[sid]);
  });
  return out;
}

function _backupCounts(data) {
  const countMap = value => (value && typeof value === 'object') ? Object.keys(value).length : 0;
  const messages = data && data.messages && typeof data.messages === 'object' ? data.messages : {};
  // 586：技能/回收站按顶层条目计（目录型技能与单文件各算一条；回收站顶层
  // `_deleted_sessions.json` 是墓碑登记表，不算条目）
  const topLevel = (value, skipUnderscore) => {
    if (!value || typeof value !== 'object') return 0;
    const keys = new Set();
    Object.keys(value).forEach(rel => {
      const top = String(rel).split('/')[0];
      if (!top || (skipUnderscore && top.startsWith('_'))) return;
      keys.add(top);
    });
    return keys.size;
  };
  const uploads = data && data.uploads && typeof data.uploads === 'object' ? data.uploads : {};
  const models = data && data.models && typeof data.models === 'object' ? data.models : {};
  const hasModels = (Array.isArray(models.userModels) && models.userModels.length > 0) ||
    (models.activeModels && typeof models.activeModels === 'object' && Object.keys(models.activeModels).length > 0);
  return {
    sessions: countMap(data && data.sessions),
    messages: Object.values(messages).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
    knowledge: countMap(data && data.knowledge),
    formulas: countMap(data && data.formulas),
    graphs: countMap(data && data.graphs),
    profiles: countMap(data && data.profiles),
    skills: topLevel(data && data.skills, false),
    trash: topLevel(data && data.trash, true),
    usage: Array.isArray(data && data.usage) ? data.usage.length : 0,
    uploads: countMap(uploads.meta),
    models: hasModels ? 1 : 0
  };
}

function _formatBackupBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function _backupFileName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return 'phymathia_backup_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '_' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
}

function _collectLocalBackup() {
  // 画布状态本地落盘是防抖的：导出快照前先冲刷，否则最近 150ms 的画布改动不进备份
  if (typeof window.flushGraphStateLocalSave === 'function') window.flushGraphStateLocalSave();
  const sessions = _safeParseJSON(localStorage.getItem('phymathia_sessions'), {});
  const messages = {};
  Object.keys(sessions).forEach(sid => {
    messages[sid] = _safeParseJSON(localStorage.getItem('phymathia_msgs_' + sid), []);
  });
  const graphs = {};
  const graphHistories = {};
  lsKeys().forEach(key => {
    // 历史快照单独成桶：此前混进 graphs（键 history_<sid>）会被导入错写成
    // graph:history_<sid> 的服务端键
    if (key.startsWith('phymathia_graph_history_')) {
      graphHistories[key.slice('phymathia_graph_history_'.length)] = _safeParseJSON(localStorage.getItem(key), []);
    } else if (key.startsWith('phymathia_graph_')) {
      graphs[key.slice('phymathia_graph_'.length)] = _safeParseJSON(localStorage.getItem(key), {});
    }
  });
  const rawModels = _safeParseJSON(localStorage.getItem('phymathia_user_models'), []);
  const userModels = Array.isArray(rawModels) ? rawModels.map(m => ({ ...m, apiKey: '' })) : [];
  const activeModels = _safeParseJSON(localStorage.getItem('phymathia_active_models'), {});
  // T284：组密钥一并入快照（与既有条目 apiKey 抹空口径不同——组密钥是备份里
  // 唯一能原地恢复的密钥通道，缺失它「恢复备份＝组密钥全空」无解；快照本就
  // 明文含全部对话，密钥的边际暴露一致。要收紧时与 apiKey 抹空一起收）
  const modelGroupKeys = _safeParseJSON(localStorage.getItem('phymathia_model_group_keys'), {});
  const formulas = (typeof getFormulaCache === 'function' ? getFormulaCache() : {}) || {};
  return {
    sessions,
    messages,
    knowledge: _safeParseJSON(localStorage.getItem('phymathia_knowledge'), {}),
    formulas,
    graphs,
    graphHistories,
    quizStats: _safeParseJSON(localStorage.getItem('phymathia_quiz_stats'), {}),
    quizBank: _safeParseJSON(localStorage.getItem('phymathia_quiz_bank'), null),
    userModels,
    activeModels,
    modelGroupKeys,
    currentSession: localStorage.getItem('phymathia_current_session') || '',
    level: localStorage.getItem('phymathia_level') || 'university',
    theme: _getInitialTheme(),
    onboarding: localStorage.getItem('phymathia_onboarding_done') || '',
    // 583：本机设置随备份走；设备编号/账号键不在白名单内，永不进备份
    settings: _collectBackupSettings()
  };
}

function _downloadBackup(data) {
  const filename = _backupFileName();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  // 585：a 必须挂进 DOM 再 click（Firefox 对游离节点可能不触发下载），
  // revoke 也要等浏览器真正取走 blob 之后
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { a.remove(); } catch (e) {}
    try { URL.revokeObjectURL(url); } catch (e) {}
  }, 1000);
  return { filename: filename, bytes: blob.size };
}

function _pickNewerQuizBank(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return (Number(a.updatedAt || 0) >= Number(b.updatedAt || 0)) ? a : b;
}

function _showExportResult(text, isWarn) {
  const el = document.getElementById('exportResult');
  if (!el) return;
  el.textContent = text;
  el.style.color = isWarn ? 'var(--warning, #d08a2e)' : 'var(--text-secondary)';
}

async function exportData(options = {}) {
  // 查阅态拦下（T187 2026-10-07 拍板）：allowBrowse 的礼节是「只读查阅会话与
  // 知识」，整包导出是把对方全部内容一次带走，超出浏览语义（服务端同步 403）。
  // PNG 海报与单画布 .pmu 是纯前端产物，不受影响。
  if (phyIsReadonly()) { phyReadonlyBlock('导出数据'); return; }
  const local = _collectLocalBackup();
  let data = { ...local, version: 3, exportTime: new Date().toISOString() };
  let degraded = false;
  try {
    // device_id 恒传：服务端按账号圈定备份里的画像（只带走本账号归属的设备），
    // 顺手把当前设备登记进账号绑定——画像按账号隔离的圈定键
    const resp = await fetch('/api/backup/export?device_id=' + encodeURIComponent(getDeviceId()), { cache: 'no-cache' });
    if (!resp.ok) {
      if (options.requireServer) throw new Error('备份请求失败：' + resp.status);
      degraded = true;
    } else {
      const server = await resp.json();
      if (options.requireServer && (!server || !server.profiles || typeof server.profiles !== 'object' || Array.isArray(server.profiles))) {
        throw new Error('服务端备份缺少画像数据');
      }
      const serverGraphs = {};
      const kv = server.kv || {};
      for (const [key, value] of Object.entries(kv)) {
        if (key.startsWith('graph:')) serverGraphs[key.slice(6)] = value;
      }
      // 584：导出同样按时间取新。此前 messages/knowledge/graphs 都是本地整包覆盖
      // 服务端，旧设备导出会把自己缓存里的旧版本写进备份，再导入就回滚新数据。
      data = {
        version: 3,
        exportTime: new Date().toISOString(),
        sessions: _mergeNewerMap(server.sessions, local.sessions),
        messages: _mergeMessageMaps(server.messages, local.messages),
        knowledge: _mergeNewerMap(server.knowledge, local.knowledge),
        formulas: _mergeNewerMap(server.formulas, local.formulas),
        profiles: server.profiles || {},
        kv,
        graphs: _mergeNewerMap(serverGraphs, local.graphs),
        quizStats: _mergeNewerMap(kv['phymathia_quiz_stats'] || {}, local.quizStats),
        quizBank: _pickNewerQuizBank(kv['phymathia_quiz_bank'] || null, local.quizBank),
        userModels: (server.models && Array.isArray(server.models.userModels) && server.models.userModels.length)
          ? server.models.userModels : local.userModels,
        activeModels: (server.models && server.models.activeModels && typeof server.models.activeModels === 'object' &&
          Object.keys(server.models.activeModels).length) ? server.models.activeModels : local.activeModels,
        currentSession: local.currentSession,
        level: local.level,
        theme: local.theme,
        onboarding: local.onboarding,
        settings: local.settings,
        // 586：服务端覆盖补齐的五类（技能/模型槽位/回收站/用量/素材）。本机
        // 缓存没有这些副本，直接取服务端；降级到本机快照时自然缺省。
        skills: server.skills || {},
        skillsState: server.skillsState || {},
        models: server.models || {},
        trash: server.trash || {},
        usage: Array.isArray(server.usage) ? server.usage : [],
        uploads: server.uploads || {}
      };
    }
  } catch (e) {
    if (options.requireServer) throw e;
    console.warn('[Export] Server backup unavailable, use local snapshot:', e);
    degraded = true;
  }
  const downloaded = _downloadBackup(data);
  const counts = _backupCounts(data);
  const summary = downloaded.filename + ' · ' + _formatBackupBytes(downloaded.bytes) +
    ' · ' + counts.sessions + ' 张画布 / ' + counts.messages + ' 条消息' +
    (counts.uploads ? ' / ' + counts.uploads + ' 个素材' : '');
  // 585：成功要回执；服务端失败降级为本机快照时必须明说「可能不全」
  const text = degraded
    ? '服务端不可用，已导出本机快照（可能不全） · ' + summary
    : '已导出 ' + summary;
  _showExportResult(text, degraded);
  if (typeof showToast === 'function') showToast(text, 6000);
  return data;
}

function _normalizeBackup(data) {
  const result = { ...data };
  // 516（2026-11-21）：sessions 键＝session id，会进侧栏渲染的 data-sid 等属性——只放行
  // ^[A-Za-z0-9_-]+$（本地生成的 id 全落此字符集）；不合法键整条跳过不导入，脏数据不进
  // localStorage 也不上服务端（/api/backup/import 收到的已过滤）。渲染层另有委托总线兜底。
  const ID_SAFE = /^[A-Za-z0-9_-]+$/;
  // 519（2026-11-21）：`__proto__` 全落 ID_SAFE 字符集会过白名单（下划线在字符集内），
  // 但 JSON.parse/Object.fromEntries 造出的是自有键，_applyLocalBackup 的三处
  // Object.assign（sessions/knowledge/formulas）经 [[Set]] 触发原型 setter——导入备份
  // 会改写本地合并目标对象的自身原型。constructor/prototype 同理一并丢弃：这三键不是
  // 任何本地生成器的真实 id 形态。
  const UNSAFE_ID_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const idKeyOk = id => ID_SAFE.test(id) && !UNSAFE_ID_KEYS.has(id);
  // 517（2026-11-21）：knowledge/formulas 键＝条目 id、值内 id 字段是面板渲染/定位用的
  // 另一半——同 sessions 口径，键与值内 id 都只放行 ^[A-Za-z0-9_-]+$（ki_/f_+uuid 全落
  // 此字符集），不合法整条跳过。在 normalize 这一处过滤＝直写 localStorage
  // （_applyLocalBackup）与备用 POST（_pushBackupToExistingApis）同吃 normalize 后的
  // data，两处同源兜住；渲染面另有 knowledge.js _kpBindDelegates 委托兜底。
  const idMapFilter = map => Object.fromEntries(Object.entries(map).filter(([id, it]) =>
    idKeyOk(id) && !(it && typeof it === 'object' && 'id' in it && !ID_SAFE.test(String(it.id)))));
  result.sessions = result.sessions && typeof result.sessions === 'object' && !Array.isArray(result.sessions)
    ? Object.fromEntries(Object.entries(result.sessions).filter(([id]) => idKeyOk(id)))
    : Array.isArray(result.sessions)
      ? Object.fromEntries(result.sessions.map(item => [item.id, item]).filter(([id]) => id && idKeyOk(id)))
      : {};
  result.messages = result.messages && typeof result.messages === 'object' ? result.messages : {};
  result.knowledge = result.knowledge && typeof result.knowledge === 'object' && !Array.isArray(result.knowledge)
    ? idMapFilter(result.knowledge) : {};
  if (result.formulas && typeof result.formulas === 'object' && !Array.isArray(result.formulas) && result.formulas.items) {
    result.formulas = Array.isArray(result.formulas.items)
      ? Object.fromEntries(result.formulas.items.map(item => [item.id, item]).filter(([id]) => id && idKeyOk(id)))
      : result.formulas.items;
  }
  result.formulas = result.formulas && typeof result.formulas === 'object' && !Array.isArray(result.formulas)
    ? idMapFilter(result.formulas) : {};
  result.graphs = result.graphs && typeof result.graphs === 'object' ? result.graphs : {};
  result.quizStats = result.quizStats && typeof result.quizStats === 'object' ? result.quizStats : {};
  result.quizBank = result.quizBank && typeof result.quizBank === 'object' ? result.quizBank : null;
  // 583：设置只收白名单键与字符串值；账号/设备编号不在白名单，手编备份也塞不进来
  result.settings = {};
  if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
    for (const key of _BACKUP_SETTINGS_KEYS) {
      const value = data.settings[key];
      if (typeof value === 'string') result.settings[key] = value;
    }
  }
  return result;
}

// T449（2026-11-16）：逐键名清单是开发向内容，默认只给一行总占用；明细折叠进
// #storageDebug，点「查看明细」展开（toggleStorageDebug）。每次重画（开面板/导入后）
// 都收回折叠态，展开位不跨次记忆——诊断信息默认不该占版面。
function updateStorageDebug() {
  const el = document.getElementById('storageDebug');
  const summary = document.getElementById('storageSummary');
  if (!el || !summary) return;
  const keys = lsKeys().filter(k => k.startsWith('phymathia_'));
  let totalBytes = 0;
  const lines = keys.map(k => {
    const v = localStorage.getItem(k) || '';
    totalBytes += v.length * 2; // UTF-16
    const size = v.length > 0 ? (v.length * 2 / 1024).toFixed(1) + 'KB' : '0KB';
    return k + ': ' + size;
  });
  lines.unshift('localStorage keys: ' + keys.length);
  lines.push('Total: ' + (totalBytes / 1024).toFixed(1) + 'KB');
  el.innerHTML = lines.join('<br>');
  summary.textContent = '本机设置占用 ' + (totalBytes / 1024).toFixed(1) + 'KB（' + keys.length + ' 项）';
  _setStorageDebugOpen(false);
}

function toggleStorageDebug() {
  const el = document.getElementById('storageDebug');
  if (!el) return;
  _setStorageDebugOpen(el.style.display === 'none');
}

function _setStorageDebugOpen(open) {
  const el = document.getElementById('storageDebug');
  const btn = document.getElementById('storageDebugToggle');
  if (!el || !btn) return;
  el.style.display = open ? '' : 'none';
  btn.textContent = open ? '收起明细' : '查看明细';
}

function _applyLocalSettings(data) {
  // 583：先回填备份里的本机设置（白名单内），再用顶层的 theme/level 等覆盖。
  // 设备编号/账号键不在白名单，替换导入后仍是当前机器/当前账号。
  if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
    for (const key of _BACKUP_SETTINGS_KEYS) {
      const value = data.settings[key];
      if (typeof value === 'string') _importCacheSet(key, value);
    }
  }
  if (data.theme) _importCacheSet('phymathia_theme', data.theme);
  if (data.level) _importCacheSet('phymathia_level', data.level);
  if (data.currentSession) _importCacheSet('phymathia_current_session', data.currentSession);
  if (data.onboarding) _importCacheSet('phymathia_onboarding_done', data.onboarding);
  if (Array.isArray(data.userModels)) {
    // 备份导出时 apiKey 被安全抹空；导入时按 id（兜底 provider+model）匹配本地条目，
    // 把本地仍持有的密钥合并回去，避免“恢复一次备份 = 所有模型密钥清零”
    const incoming = data.userModels;
    const existing = _safeParseJSON(localStorage.getItem('phymathia_user_models'), []);
    const localList = Array.isArray(existing) ? existing : [];
    const byId = new Map(localList.map(m => [m.id, m]));
    const byProviderModel = new Map(localList.map(m => [String(m.provider) + '|' + String(m.model), m]));
    const merged = incoming.map(m => {
      const local = byId.get(m.id) || byProviderModel.get(String(m.provider) + '|' + String(m.model));
      if (local && local.apiKey && !m.apiKey) return { ...m, apiKey: local.apiKey };
      return m;
    });
    _importCacheSet('phymathia_user_models', JSON.stringify(merged));
    // T284：先把合并后的列表拉进内存，再恢复组密钥（importModelGroupKeys→
    // saveGroupKey 会把组密钥同步进组内条目并走统一保存出口；replace 模式刚清过
    // 存储，reload 保证内存与磁盘同源）
    if (typeof reloadModelsFromStorage === 'function') reloadModelsFromStorage();
    if (typeof importModelGroupKeys === 'function') importModelGroupKeys(data.modelGroupKeys);
  }
  if (data.activeModels && typeof data.activeModels === 'object') _importCacheSet('phymathia_active_models', JSON.stringify(data.activeModels));
  const quizStats = data.quizStats && typeof data.quizStats === 'object'
    ? data.quizStats
    : (data.kv && data.kv['phymathia_quiz_stats']) || {};
  if (quizStats && typeof quizStats === 'object') _importCacheSet('phymathia_quiz_stats', JSON.stringify(quizStats));
  const quizBank = data.quizBank || (data.kv && data.kv['phymathia_quiz_bank']) || null;
  if (quizBank && typeof quizBank === 'object') _importCacheSet('phymathia_quiz_bank', JSON.stringify(quizBank));
  // T284：导入绕过 save* 直写 localStorage——内存拉回最新后整包推服务端；
  // importData 在刷新前还会 await flushModelsSync 兜底（乐观同步戳已随
  // scheduleModelsSync 落地，即使这里没推成，刷新后也按「本地较新→补传」收敛）
  if (typeof reloadModelsFromStorage === 'function') reloadModelsFromStorage();
  if (typeof scheduleModelsSync === 'function') scheduleModelsSync(0);
}

function _clearLocalDataForReplace() {
  // 583：只清数据类键。此前删光 phymathia_* 会把账号键、设备编号、节点配方、
  // 背景/皮肤、快捷键、读数偏好一起清掉——替换导入后画像按旧 device 键落盘、
  // 当前设备却生成了新 id，AI 当场「失忆」。
  lsKeys().forEach(key => {
    if (_BACKUP_DATA_KEYS.has(key)) { localStorage.removeItem(key); return; }
    if (key.startsWith('phymathia_msgs_')) { localStorage.removeItem(key); return; }
    if (key.startsWith('phymathia_graph_history_')) { localStorage.removeItem(key); return; }
    // phymathia_graph_text_scale 是设置键，别被 graph_ 前缀误伤
    if (key.startsWith('phymathia_graph_') && key !== 'phymathia_graph_text_scale') {
      localStorage.removeItem(key);
    }
  });
}

// 导入写满浏览器本地存储（2026-11-24 用户实测）：导入分「服务端落盘」与「本机缓存回放」
// 两步，localStorage 配额（约 5MB）装不下大账号（画布状态＋撤销历史轻易超出），回放写满
// 是常态而非故障。此前 _applyLocalSettings 里几处裸 localStorage.setItem 一抛就被
// confirmImport 当成整次导入失败（「导入失败：The quota has been exceeded.」）——而服务端
// 早已收下（刷新后数据都在），收尾步骤还被整段跳过。现在：导入路径的缓存写入统一走
// _importCacheSet（写不进＝登记进 _importCacheMisses、不中断），结论只看服务端。
let _importCacheMisses = [];
function _importCacheSet(key, value) {
  if (safeLocalStorageSet(key, value)) return true;
  _importCacheMisses.push(key);
  return false;
}

function _forgetDeletedIds(storageKey, ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const map = _safeParseJSON(localStorage.getItem(storageKey), {});
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  let changed = false;
  ids.forEach(id => {
    if (id && Object.prototype.hasOwnProperty.call(map, id)) {
      delete map[id];
      changed = true;
    }
  });
  if (changed) _importCacheSet(storageKey, JSON.stringify(map));
}

function _forgetImportedTombstones(data) {
  // 导入是用户明确要回来的数据：本地已删清单若还记着这些 id，下一轮同步会
  // 把刚恢复的条目再次剔除（服务端侧 _apply_restore 已同步除名）。
  _forgetDeletedIds('phymathia_knowledge_deleted', Object.keys((data && data.knowledge) || {}));
  _forgetDeletedIds('phymathia_formulas_deleted', Object.keys((data && data.formulas) || {}));
}

// 逐项选择（manual）与服务端口径一致：未翻面的条目按「保留较新」，用户明确
// 选了 current/backup 的条目才偏离时间规则。本地缓存必须同口径回放——否则
// 下一页的 saveSessions/同步会把较新的本地版本再推回服务端，抹掉刚做的选择。
function _localConflictSide(conflict, decisions, kind, id, current, incoming) {
  if (conflict === 'backup') return 'backup';
  if (conflict === 'manual') {
    const map = (decisions && decisions[kind]) || {};
    if (map[id] === 'backup' || map[id] === 'current') return map[id];
  }
  if (current && _backupItemTs(current) > _backupItemTs(incoming)) return 'current';
  return 'backup';
}

function _messageIdentity(msg) {
  const ts = msg && msg.timestamp;
  if (typeof ts === 'number' && ts) return 'ts:' + ts;
  return 'raw:' + String((msg && msg.role) || '') + '|' + String((msg && msg.content) || '');
}

function _fillMessageFields(base, extra) {
  const out = { ...(base || {}) };
  for (const [field, value] of Object.entries(extra || {})) {
    const current = out[field];
    const empty = current === undefined || current === null || current === ''
      || (Array.isArray(current) && current.length === 0)
      || (current && typeof current === 'object' && !Array.isArray(current)
          && Object.keys(current).length === 0);
    if (empty && value !== null && value !== '') out[field] = value;
  }
  return out;
}

function _applyManualMessageDecisions(merged, existing, incoming, sid, overrides) {
  if (!overrides || typeof overrides !== 'object') return merged;
  const curById = new Map();
  (Array.isArray(existing) ? existing : []).forEach(msg => {
    if (msg && typeof msg === 'object') curById.set(_messageIdentity(msg), msg);
  });
  const incById = new Map();
  (Array.isArray(incoming) ? incoming : []).forEach(msg => {
    if (msg && typeof msg === 'object') incById.set(_messageIdentity(msg), msg);
  });
  return merged.map(msg => {
    const identity = _messageIdentity(msg);
    const side = overrides[sid + '|' + identity];
    if (side === 'backup' && incById.has(identity)) {
      return _fillMessageFields(incById.get(identity), curById.get(identity));
    }
    if (side === 'current' && curById.has(identity)) {
      return _fillMessageFields(curById.get(identity), incById.get(identity));
    }
    return msg;
  });
}

// 服务端导入失败后的兜底直推：把用户选了「当前」的备份条目剔掉，别让兜底
// 通道再把它们写回服务端。
function _filterBackupByDecisions(data, decisions) {
  if (!decisions || !Object.keys(decisions).length) return data;
  const keep = (kind, id) => !(decisions[kind] && decisions[kind][id] === 'current');
  const copy = { ...data };
  copy.sessions = Object.fromEntries(
    Object.entries(data.sessions || {}).filter(([id]) => keep('sessions', id)));
  copy.knowledge = Object.fromEntries(
    Object.entries(data.knowledge || {}).filter(([id]) => keep('knowledge', id)));
  copy.formulas = Object.fromEntries(
    Object.entries(data.formulas || {}).filter(([id]) => keep('formulas', id)));
  const graphs = {};
  Object.entries(data.graphs || {}).forEach(([sid, state]) => {
    if (keep('graphs', 'graph:' + sid)) graphs[sid] = state;
  });
  copy.graphs = graphs;
  const messages = {};
  Object.entries(data.messages || {}).forEach(([sid, list]) => {
    if (!Array.isArray(list)) { messages[sid] = list; return; }
    messages[sid] = list.filter(msg => {
      const side = (decisions.messages || {})[sid + '|' + _messageIdentity(msg)];
      return side !== 'current';
    });
  });
  copy.messages = messages;
  if (data.kv && typeof data.kv === 'object') {
    const kv = { ...data.kv };
    Object.keys(kv).forEach(key => {
      if ((decisions.graphs || {})[key] === 'current') delete kv[key];
    });
    copy.kv = kv;
  }
  return copy;
}

function _applyLocalBackup(data, replace, conflict, decisions) {
  conflict = conflict === 'backup' || conflict === 'manual' ? conflict : 'newer';
  decisions = decisions && typeof decisions === 'object' ? decisions : {};
  _importCacheMisses.length = 0; // 每次回放重算没写进的键，返回给 confirmImport 拼说明
  if (replace) _clearLocalDataForReplace();
  const sessions = _safeParseJSON(localStorage.getItem('phymathia_sessions'), {});
  for (const [sid, session] of Object.entries(data.sessions || {})) {
    if (!session || typeof session !== 'object') continue;
    const side = _localConflictSide(conflict, decisions, 'sessions', sid, sessions[sid], session);
    if (!replace && side === 'current' && sessions[sid]) continue;
    sessions[sid] = session;
  }
  _importCacheSet('phymathia_sessions', JSON.stringify(sessions));

  for (const [sid, msgs] of Object.entries(data.messages || {})) {
    if (!Array.isArray(msgs)) continue;
    const key = 'phymathia_msgs_' + sid;
    const existing = _safeParseJSON(localStorage.getItem(key), []);
    let merged;
    if (replace || conflict === 'backup') merged = _mergeMessageArrays([], msgs);
    else merged = _mergeMessageArrays(existing, msgs);
    if (conflict === 'manual') {
      merged = _applyManualMessageDecisions(merged, existing, msgs, sid, decisions.messages);
    }
    _importCacheSet(key, JSON.stringify(merged));
  }

  const knowledge = _safeParseJSON(localStorage.getItem('phymathia_knowledge'), {});
  for (const [id, item] of Object.entries(data.knowledge || {})) {
    if (!item || typeof item !== 'object') continue;
    const side = _localConflictSide(conflict, decisions, 'knowledge', id, knowledge[id], item);
    if (!replace && side === 'current' && knowledge[id]) continue;
    knowledge[id] = item;
  }
  _importCacheSet('phymathia_knowledge', JSON.stringify(knowledge));

  const formulas = _safeParseJSON(localStorage.getItem('phymathia_formulas'), {});
  for (const [id, item] of Object.entries(data.formulas || {})) {
    if (!item || typeof item !== 'object') continue;
    const side = _localConflictSide(conflict, decisions, 'formulas', id, formulas[id], item);
    if (!replace && side === 'current' && formulas[id]) continue;
    formulas[id] = item;
  }
  // setFormulaCache 内部 try/catch 吞掉写入失败——写前后比对原串，认出「没写进」
  const formulasRawBefore = localStorage.getItem('phymathia_formulas');
  if (typeof setFormulaCache === 'function') {
    setFormulaCache(formulas);
    if (Object.keys(formulas).length > 0 && localStorage.getItem('phymathia_formulas') === formulasRawBefore) {
      _importCacheMisses.push('phymathia_formulas');
    }
  } else {
    _importCacheSet('phymathia_formulas', JSON.stringify(formulas));
  }

  for (const [sid, state] of Object.entries(data.graphs || {})) {
    if (!(state && typeof state === 'object')) continue;
    if (sid.startsWith('history_')) {
      // 旧版备份把历史快照错并进 graphs（键 history_<sid>）——归位到历史键
      if (Array.isArray(state)) _importCacheSet('phymathia_graph_history_' + sid.slice('history_'.length), JSON.stringify(state));
      continue;
    }
    const graphKey = 'phymathia_graph_' + sid;
    const current = replace ? null : _safeParseJSON(localStorage.getItem(graphKey), null);
    const side = _localConflictSide(conflict, decisions, 'graphs', 'graph:' + sid, current, state);
    if (!replace && side === 'current' && current) continue;
    _importCacheSet(graphKey, JSON.stringify(state));
  }
  for (const [sid, arr] of Object.entries(data.graphHistories || {})) {
    // T365：历史键可以是旧裸数组，也可以是 v2 信封 {v:2,e,c,l}（游标随盘）——两者原样回放
    if (!(Array.isArray(arr) || (arr && Array.isArray(arr.e)))) continue;
    const historyKey = 'phymathia_graph_history_' + sid;
    if (!replace && conflict !== 'backup') {
      const current = _safeParseJSON(localStorage.getItem(historyKey), null);
      const currentTs = Number(current && current.t) || 0;
      const incomingTs = Number(arr && arr.t) || 0;
      if (currentTs > incomingTs) continue;
    }
    _importCacheSet(historyKey, JSON.stringify(arr));
  }
  _applyLocalSettings(data);
  return _importCacheMisses.splice(0);
}

async function _pushBackupToExistingApis(data) {
  try {
    if (data.sessions) await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data.sessions)
    });
    for (const [sid, msgs] of Object.entries(data.messages || {})) {
      if (typeof saveSessionMessages === 'function') await saveSessionMessages(sid, msgs);
    }
    if (data.knowledge) await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: data.knowledge })
    });
    if (data.formulas) await fetch('/api/formulas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: Object.values(data.formulas) })
    });
    const graphEntries = Object.entries(data.graphs || {});
    for (const [sid, state] of graphEntries) {
      if (sid.startsWith('history_')) continue; // 旧备份混入的历史快照走 graphHistories 通道
      await fetch('/api/kv/' + encodeURIComponent('graph:' + sid), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: state })
      });
    }
    for (const [sid, arr] of Object.entries(data.graphHistories || {})) {
      // T365：旧裸数组与 v2 信封两吃（信封带游标，服务端 kv 只存不透明 JSON 串）
      if (!Array.isArray(arr) && !(arr && Array.isArray(arr.e))) continue;
      await fetch('/api/kv/' + encodeURIComponent('graph_history:' + sid), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: arr })
      });
    }
    if (data.quizStats) await fetch('/api/kv/phymathia_quiz_stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: data.quizStats })
    });
    const quizBank = data.quizBank || (data.kv && data.kv['phymathia_quiz_bank']) || null;
    if (quizBank) await fetch('/api/kv/phymathia_quiz_bank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: quizBank })
    });
    for (const [key, value] of Object.entries(data.kv || {})) {
      if (key.startsWith('graph:') || key === 'phymathia_quiz_stats' || key === 'phymathia_quiz_bank') continue;
      await fetch('/api/kv/' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      });
    }
  } catch (e) {
    console.warn('[Import] Fallback server push failed:', e);
  }
}

// ===== 导入模式分段胶囊（T451，2026-11-14）=====
// 旧实现是原生 <select>：只有「合并/替换」两项，下拉把另一个选项藏起来，还自带
// 一层浏览器原生弹层（深色主题下是系统亮色列表）。改成两选一胶囊后与检测页
// chips / 难度卡片同语言；状态只活在内存里——导入是一次性动作，刷新回默认合并，
// 与旧 select 每次加载都回 merge 的语义一致（刻意不落 localStorage）。
let _importMode = 'merge';
let _importConflict = 'newer';
let _pendingImport = null;
let _importBusy = false;
let _importPreviewSeq = 0;
// 逐项选择（manual）：只记录与「保留较新」默认不同的翻面条目——预览里可能
// 有上千项，默认全按较新，用户改一项才多一条请求数据。
const _IMPORT_CONFLICT_KINDS = ['sessions', 'messages', 'knowledge', 'formulas', 'graphs'];
const _IMPORT_CONFLICT_KIND_LABELS = {
  sessions: '会话', messages: '消息', knowledge: '知识点', formulas: '公式', graphs: '画布'
};
let _importDecisions = _emptyImportDecisions();
let _importConflictRows = [];
let _importConflictGroups = [];

function _emptyImportDecisions() {
  const out = {};
  _IMPORT_CONFLICT_KINDS.forEach(kind => { out[kind] = {}; });
  return out;
}

function _importConflictDefaultSide(item) {
  // 与服务端「保留较新」同口径：会话/知识/公式/画布打平时取备份；消息走
  // merge_message_lists 的「现有在前」，同时间戳冲突时现有内容赢，故默认当前。
  if (item && item.kind === 'messages') return 'current';
  return (Number(item && item.backupTs) || 0) >= (Number(item && item.currentTs) || 0)
    ? 'backup' : 'current';
}

function _importConflictSide(kind, item) {
  const map = _importDecisions[kind] || {};
  return map[item.id] || _importConflictDefaultSide(item);
}

function _setImportConflictSide(kind, item, side) {
  const map = _importDecisions[kind] || (_importDecisions[kind] = {});
  if (side === _importConflictDefaultSide(item)) delete map[item.id];
  else map[item.id] = side;
}

function _importDecisionsPayload() {
  const out = {};
  _IMPORT_CONFLICT_KINDS.forEach(kind => {
    const map = _importDecisions[kind] || {};
    if (Object.keys(map).length) out[kind] = { ...map };
  });
  return out;
}

function _resetImportDecisions() {
  _importDecisions = _emptyImportDecisions();
  _importConflictRows = [];
  _importConflictGroups = [];
  const box = document.getElementById('importConflictItems');
  if (box) { box.hidden = true; box.textContent = ''; }
}

function _formatConflictTs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '无时间';
  const date = new Date(number);
  if (isNaN(date.getTime())) return '无时间';
  const pad = n => String(n).padStart(2, '0');
  // 跨年备份要能一眼看出年份，同年只留月日省宽度（面板 360px）。
  const year = date.getFullYear() === new Date().getFullYear()
    ? '' : (date.getFullYear() + '-');
  return year + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function _importModeGet() {
  return _importMode === 'replace' ? 'replace' : 'merge';
}

function _importModeHint(mode) {
  return mode === 'replace'
    ? '先清空当前账号的会话、知识、公式与画布，再写入备份；本机设置与设备编号保留'
    : '同名条目按时间取较新，备份里没有的保持不变';
}

function _setSegActive(id, value) {
  const seg = document.getElementById(id);
  if (!seg || !seg.querySelectorAll) return;
  Array.prototype.slice.call(seg.querySelectorAll('.pm-seg-btn')).forEach(btn => {
    const on = String((btn.dataset || {}).value) === String(value);
    if (btn.classList) btn.classList.toggle('active', on);
    if (btn.setAttribute) btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function pickImportMode(mode) {
  _importMode = mode === 'replace' ? 'replace' : 'merge';
  _setSegActive('importModeSeg', _importMode);
  const hint = document.getElementById('importModeHint');
  if (hint) hint.textContent = _importModeHint(_importMode);
  // 已选好文件但还没确认时，切换模式要重算预览（替换/合并的影响面不同）
  _refreshPendingImportPreview();
}

function pickImportConflict(value) {
  _importConflict = value === 'backup' ? 'backup'
    : (value === 'manual' ? 'manual' : 'newer');
  _setSegActive('importConflictSeg', _importConflict);
  if (_importConflict === 'manual') {
    const box = document.getElementById('importConflictItems');
    if (box) { box.hidden = false; box.textContent = '正在读取冲突条目…'; }
  }
  _refreshPendingImportPreview();
}

function _backupHasPayload(data) {
  const has = value => !!(value && typeof value === 'object' && Object.keys(value).length);
  return has(data && data.sessions) || has(data && data.messages) || has(data && data.knowledge) ||
    has(data && data.formulas) || has(data && data.kv) || has(data && data.graphs) ||
    has(data && data.quizStats) || !!(data && data.quizBank) || has(data && data.profiles) ||
    has(data && data.settings) || has(data && data.skills) || has(data && data.trash) ||
    has(data && data.uploads) || has(data && data.models) ||
    (Array.isArray(data && data.usage) && data.usage.length > 0);
}

function _slimBackupForPreview(data) {
  // 586：附件字节是备份里唯一的大块，预览不读它们；元数据保留供计数。
  if (!data || typeof data !== 'object') return data;
  const light = { ...data };
  if (light.uploads && typeof light.uploads === 'object') {
    light.uploads = { ...light.uploads, files: {}, fulltext: {} };
  }
  return light;
}

function _localImportPreview(data, mode, conflict) {
  return {
    ok: false,
    serverAvailable: false,
    mode: mode,
    conflict: conflict,
    incoming: _backupCounts(data),
    current: null,
    conflicts: null
  };
}

async function _requestImportPreview(data, mode, conflict) {
  try {
    const resp = await fetch('/api/backup/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 586：预览只要条数——附件字节（可能几十 MB）不进预览请求，避免选一次
      // 文件、切一次模式就把整包重发一遍；导入本身照旧带全量。
      body: JSON.stringify({ mode: mode, conflict: conflict, device_id: getDeviceId(),
        backup: _slimBackupForPreview(data) }),
      signal: AbortSignal.timeout(30000)
    });
    if (resp.ok) {
      const preview = await resp.json();
      if (preview && typeof preview === 'object') {
        preview.serverAvailable = true;
        return preview;
      }
    }
  } catch (e) {
    console.warn('[Import] Preview unavailable, use local counts:', e);
  }
  return _localImportPreview(data, mode, conflict);
}

function _refreshPendingImportPreview() {
  if (!_pendingImport || _importBusy) return;
  const seq = ++_importPreviewSeq;
  const mode = _importModeGet();
  const conflict = mode === 'replace' ? 'backup' : _importConflict;
  _pendingImport.mode = mode;
  _pendingImport.conflict = conflict;
  _requestImportPreview(_pendingImport.data, mode, conflict).then(preview => {
    if (seq !== _importPreviewSeq || !_pendingImport) return;
    _pendingImport.preview = preview;
    _renderImportPreview();
  });
}

function _renderImportPreview() {
  const box = document.getElementById('importPreview');
  if (!box || !_pendingImport) return;
  const preview = _pendingImport.preview || {};
  const incoming = preview.incoming || _backupCounts(_pendingImport.data);
  const current = preview.current || null;
  const conflicts = preview.conflicts || null;
  const mode = _importModeGet();

  const title = document.getElementById('importPreviewTitle');
  if (title) title.textContent = '准备导入「' + _pendingImport.fileName + '」';

  const stats = document.getElementById('importPreviewStats');
  if (stats) {
    const lines = [];
    lines.push('备份内容：' + incoming.sessions + ' 张画布 · ' + incoming.messages + ' 条消息 · ' +
      incoming.knowledge + ' 条知识点 · ' + incoming.formulas + ' 条公式 · ' + incoming.graphs + ' 个探索网');
    // 586：覆盖补齐的附带内容只在真有货时出现，不占常驻版面
    const extras = [];
    if (incoming.skills) extras.push('技能 ' + incoming.skills + ' 个');
    if (incoming.uploads) extras.push('素材 ' + incoming.uploads + ' 个');
    if (incoming.usage) extras.push('用量记录 ' + incoming.usage + ' 条');
    if (incoming.trash) extras.push('回收站 ' + incoming.trash + ' 项');
    if (incoming.models) extras.push('模型槽位');
    if (extras.length) lines.push('附带：' + extras.join(' · '));
    if (incoming.models) lines.push('模型槽位随备份恢复；密钥不在备份内，换机器后需重新填写。');
    if (current) {
      lines.push('当前账号：' + current.sessions + ' 张画布 · ' + current.messages + ' 条消息 · ' +
        current.knowledge + ' 条知识点 · ' + current.formulas + ' 条公式 · ' + current.graphs + ' 个探索网');
    }
    if (mode === 'replace') {
      lines.push('替换模式：会话、消息、知识、公式、画布与技能按备份替换；素材、用量与回收站只增不删，本机设置与设备编号保留。');
    } else if (conflicts) {
      const bits = [];
      if (conflicts.sessions) bits.push(conflicts.sessions + ' 个同名会话');
      if (conflicts.messages) bits.push(conflicts.messages + ' 条同时间消息');
      if (conflicts.knowledge) bits.push(conflicts.knowledge + ' 条同名知识点');
      if (conflicts.formulas) bits.push(conflicts.formulas + ' 条同 id 公式');
      if (conflicts.graphs) bits.push(conflicts.graphs + ' 张同名画布');
      lines.push(bits.length ? ('同名冲突：' + bits.join(' · ')) : '没有同名冲突，直接合并。');
      const older = conflicts.olderInBackup || {};
      const olderCount = (older.sessions || 0) + (older.knowledge || 0) + (older.formulas || 0) + (older.graphs || 0);
      if (olderCount) {
        if (_importConflict === 'backup') {
          lines.push('其中 ' + olderCount + ' 项备份版本比当前旧，将按你的选择以备份为准。');
        } else if (_importConflict === 'manual') {
          lines.push('其中 ' + olderCount + ' 项备份版本比当前旧，默认保留较新，可在下方逐项改选。');
        } else {
          lines.push('其中 ' + olderCount + ' 项备份版本比当前旧，将保留当前较新版本。');
        }
      } else if (_importConflict === 'manual') {
        lines.push('默认保留较新，可在下方逐项改选。');
      }
    }
    if (!preview.serverAvailable) {
      lines.push('服务端预览不可用：导入会先写本机缓存，联网后再补传；条数为文件内统计。');
    }
    stats.textContent = lines.join('\n');
  }

  const conflictBox = document.getElementById('importPreviewConflict');
  if (conflictBox) conflictBox.style.display = mode === 'merge' ? '' : 'none';
  _setSegActive('importConflictSeg', _importConflict);
  if (mode === 'merge' && _importConflict === 'manual') {
    _renderImportConflictItems(preview.items);
  } else {
    const itemsBox = document.getElementById('importConflictItems');
    if (itemsBox) { itemsBox.hidden = true; itemsBox.textContent = ''; }
    _importConflictRows = [];
    _importConflictGroups = [];
  }

  const note = document.getElementById('importPreviewNote');
  if (note) {
    note.textContent = '确认后才会写入。导入前会自动把当前账号数据备份到项目文件夹，可在下方「自动备份」里恢复。';
  }

  const result = document.getElementById('importPreviewResult');
  if (result) { result.textContent = ''; result.style.color = ''; }

  const confirmBtn = document.getElementById('importConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = mode === 'replace' ? '确认替换' : '确认合并';
  }
  box.hidden = false;
  if (box.scrollIntoView) { try { box.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
}

// ===== 逐项选择：冲突条目清单（2026-11-24）=====
// 只列内容确有差异的冲突（服务端已过滤相同条目）。默认按「保留较新」高亮，
// 用户改一项才记一条决定；全部/筛选都在本地完成，不重新请求预览。
function _syncImportConflictRow(row, item, kind) {
  const side = _importConflictSide(kind, item);
  Array.prototype.slice.call(row.querySelectorAll('button[data-side]')).forEach(btn => {
    const on = btn.dataset.side === side;
    btn.classList.toggle('active', on);
    if (btn.setAttribute) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function _updateImportConflictSummary() {
  const el = document.getElementById('importConflictSummary');
  if (!el) return;
  let changed = 0;
  _IMPORT_CONFLICT_KINDS.forEach(kind => {
    changed += Object.keys(_importDecisions[kind] || {}).length;
  });
  el.textContent = '共 ' + _importConflictRows.length + ' 项 · 已调整 ' + changed + ' 项';
}

function _onImportConflictClick(event) {
  const btn = event.target && event.target.closest ? event.target.closest('button[data-side]') : null;
  if (!btn) return;
  const row = btn.closest('.import-conflict-item');
  if (!row) return;
  const kind = row.dataset.kind;
  const id = row.dataset.id;
  const entry = _importConflictRows.find(item => item.kind === kind && item.item.id === id);
  if (!entry) return;
  _setImportConflictSide(kind, entry.item, btn.dataset.side);
  _syncImportConflictRow(row, entry.item, kind);
  _updateImportConflictSummary();
}

function bulkImportConflict(kind, side) {
  _importConflictRows.forEach(entry => {
    if (entry.kind !== kind) return;
    _setImportConflictSide(kind, entry.item, side);
    _syncImportConflictRow(entry.row, entry.item, kind);
  });
  _updateImportConflictSummary();
}

function filterImportConflictItems(value) {
  const query = String(value || '').trim().toLowerCase();
  _importConflictRows.forEach(entry => {
    entry.row.hidden = !!query && !(entry.row.dataset.text || '').includes(query);
  });
  _importConflictGroups.forEach(group => {
    group.group.hidden = !_importConflictRows.some(
      entry => entry.kind === group.kind && !entry.row.hidden);
  });
}

function _renderImportConflictItems(items) {
  const box = document.getElementById('importConflictItems');
  if (!box) return;
  box.hidden = false;
  box.textContent = '';
  _importConflictRows = [];
  _importConflictGroups = [];
  if (!Array.isArray(items)) {
    // 预览拿不到条目时不能沿用上一轮的翻面决定——提示说按「保留较新」，
    // 请求里却夹带旧决定会让导入结果与用户看到的说明不一致。
    _IMPORT_CONFLICT_KINDS.forEach(kind => { _importDecisions[kind] = {}; });
    box.textContent = '服务端预览不可用，逐项选择暂时不可用；将按「保留较新」合并。';
    return;
  }
  // 预览重算后只保留仍存在的条目决定，避免切模式/换文件时旧决定混进请求。
  const validIds = new Set(items.map(item => item.kind + '\u0000' + item.id));
  _IMPORT_CONFLICT_KINDS.forEach(kind => {
    Object.keys(_importDecisions[kind] || {}).forEach(id => {
      if (!validIds.has(kind + '\u0000' + id)) delete _importDecisions[kind][id];
    });
  });
  if (!items.length) {
    box.textContent = '没有需要手动判断的差异条目，将按「保留较新」合并。';
    return;
  }

  const tools = document.createElement('div');
  tools.className = 'import-conflict-tools';
  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'import-conflict-filter';
  filter.id = 'importConflictFilter';
  filter.placeholder = '筛选条目（标题或内容）';
  filter.addEventListener('input', () => filterImportConflictItems(filter.value));
  const summary = document.createElement('span');
  summary.className = 'import-conflict-summary';
  summary.id = 'importConflictSummary';
  tools.appendChild(filter);
  tools.appendChild(summary);
  box.appendChild(tools);

  const list = document.createElement('div');
  list.className = 'import-conflict-list';
  list.id = 'importConflictList';
  list.addEventListener('click', _onImportConflictClick);
  box.appendChild(list);

  const byKind = {};
  items.forEach(item => {
    if (!byKind[item.kind]) byKind[item.kind] = [];
    byKind[item.kind].push(item);
  });

  _IMPORT_CONFLICT_KINDS.forEach(kind => {
    const groupItems = byKind[kind] || [];
    if (!groupItems.length) return;
    const group = document.createElement('div');
    group.className = 'import-conflict-group';
    group.dataset.kind = kind;
    const head = document.createElement('div');
    head.className = 'import-conflict-group-head';
    const name = document.createElement('span');
    name.className = 'import-conflict-group-name';
    name.textContent = (_IMPORT_CONFLICT_KIND_LABELS[kind] || kind) + ' · ' + groupItems.length;
    const actions = document.createElement('span');
    actions.className = 'import-conflict-group-actions';
    [['current', '全部当前'], ['backup', '全部备份']].forEach(pair => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'import-conflict-bulk';
      btn.textContent = pair[1];
      btn.addEventListener('click', () => bulkImportConflict(kind, pair[0]));
      actions.appendChild(btn);
    });
    head.appendChild(name);
    head.appendChild(actions);
    group.appendChild(head);

    groupItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'import-conflict-item';
      row.dataset.kind = kind;
      row.dataset.id = item.id;
      row.dataset.text = [item.label, item.currentLabel, item.id].join(' ').toLowerCase();

      const main = document.createElement('div');
      main.className = 'import-conflict-main';
      const label = document.createElement('div');
      label.className = 'import-conflict-label';
      label.textContent = item.label || item.id;
      label.title = item.label || item.id;
      main.appendChild(label);
      if (item.currentLabel && item.currentLabel !== item.label) {
        const currentLabel = document.createElement('div');
        currentLabel.className = 'import-conflict-label import-conflict-label--current';
        currentLabel.textContent = '当前：' + item.currentLabel;
        main.appendChild(currentLabel);
      }
      const meta = document.createElement('div');
      meta.className = 'import-conflict-meta';
      meta.textContent = '当前 ' + _formatConflictTs(item.currentTs)
        + ' · 备份 ' + _formatConflictTs(item.backupTs);
      main.appendChild(meta);
      row.appendChild(main);

      const choice = document.createElement('div');
      choice.className = 'import-conflict-choice';
      [['current', '当前'], ['backup', '备份']].forEach(pair => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.side = pair[0];
        btn.textContent = pair[1];
        choice.appendChild(btn);
      });
      row.appendChild(choice);
      group.appendChild(row);
      _importConflictRows.push({ row, item, kind });
      _syncImportConflictRow(row, item, kind);
    });

    list.appendChild(group);
    _importConflictGroups.push({ group, kind });
  });

  _updateImportConflictSummary();
}

function _reloadAfterDataWrite(delay) {
  // 导入/恢复已把结果写进服务端与本机缓存；beforeunload 的卸载冲刷用的是导入前
  // 的内存副本，放它发出去会把刚导入的版本盖回（2026-11-24 真机踩到：逐项选择
  // 翻成备份后，刷新又被旧标题/旧消息顶回去）。一次性标志让卸载冲刷跳过网络回写。
  try {
    if (typeof window !== 'undefined') window.__phySkipUnloadFlush = true;
  } catch (e) {}
  setTimeout(() => location.reload(), delay);
}

function cancelImport() {
  _importPreviewSeq++;
  _pendingImport = null;
  _resetImportDecisions();
  const box = document.getElementById('importPreview');
  if (box) box.hidden = true;
  const input = document.getElementById('importFileInput');
  if (input) input.value = '';
}

async function importData(event) {
  if (phyIsReadonly()) { phyReadonlyBlock('导入备份'); return; }
  const input = event && event.target;
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (input) input.value = '';
  if (file.size > 50 * 1024 * 1024) {
    alert('导入失败：备份文件超过 50MB，请拆分后再试。');
    return;
  }
  const reader = new FileReader();
  reader.onerror = function() {
    alert('导入失败：读取文件失败，请重试。');
  };
  reader.onload = async function(e) {
    let raw = null;
    try {
      raw = JSON.parse(e.target.result);
    } catch (err) {
      alert('导入失败：文件不是有效 JSON - ' + err.message);
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      alert('导入失败：文件格式不正确，缺少有效数据');
      return;
    }
    if (raw.version != null && Number(raw.version) > 3) {
      alert('这份备份来自更新的版本（v' + raw.version + '），可能包含当前版本不认识的数据；仍可尝试导入。');
    }
    const data = _normalizeBackup(raw);
    if (!_backupHasPayload(data)) {
      alert('导入失败：文件格式不正确，缺少有效数据');
      return;
    }
    _resetImportDecisions();
    const mode = _importModeGet();
    const conflict = mode === 'replace' ? 'backup' : _importConflict;
    const preview = await _requestImportPreview(data, mode, conflict);
    _pendingImport = {
      data: data,
      fileName: file.name,
      fileSize: file.size,
      mode: mode,
      conflict: conflict,
      preview: preview
    };
    _renderImportPreview();
  };
  reader.readAsText(file);
}

async function confirmImport() {
  if (!_pendingImport || _importBusy) return;
  const pending = _pendingImport;
  const data = pending.data;
  const mode = _importModeGet();
  const conflict = mode === 'replace' ? 'backup' : _importConflict;
  const decisions = conflict === 'manual' ? _importDecisionsPayload() : {};
  _importBusy = true;
  const confirmBtn = document.getElementById('importConfirmBtn');
  const cancelBtn = document.getElementById('importCancelBtn');
  const resultEl = document.getElementById('importPreviewResult');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '导入中…'; }
  if (cancelBtn) cancelBtn.disabled = true;
  if (resultEl) { resultEl.textContent = ''; resultEl.style.color = ''; }

  let serverResp = null;
  try {
    serverResp = await fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // device_id 同导出：服务端据此圈定 replace 清除范围与本账号画像归属；
      // auto_backup 让服务端在写入前把当前账号存到 data/backups/
      body: JSON.stringify({ mode, conflict, decisions, auto_backup: true, device_id: getDeviceId(), backup: data }),
      signal: AbortSignal.timeout(120000)
    });
  } catch (serverErr) {
    console.warn('[Import] Server import unavailable, use local:', serverErr);
  }

  if (serverResp && !serverResp.ok) {
    let detail = 'HTTP ' + serverResp.status;
    try {
      const body = await serverResp.json();
      if (body && body.detail) detail = body.detail;
    } catch (e) {}
    _importBusy = false;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = mode === 'replace' ? '确认替换' : '确认合并'; }
    if (cancelBtn) cancelBtn.disabled = false;
    if (resultEl) { resultEl.textContent = '导入失败：' + detail; resultEl.style.color = 'var(--danger, #c0392b)'; }
    if (typeof showToast === 'function') showToast('导入失败：' + detail, 6000);
    return;
  }

  let result = null;
  if (serverResp && serverResp.ok) {
    try { result = await serverResp.json(); } catch (e) {}
  }
  // 导入结论只看服务端：/api/backup/import 收下＝数据已完整存进电脑存档（真相源），
  // 本机缓存只是加速副本，写满/写挂都不再把整次导入报成失败（2026-11-24 用户实测：
  // 配额满曾被误报成「导入失败：The quota has been exceeded.」，刷新后数据其实都在）。
  const serverImported = !!(serverResp && serverResp.ok);
  let applyError = null;
  let misses = [];
  try {
    misses = _applyLocalBackup(data, mode === 'replace', conflict, decisions) || [];
    _forgetImportedTombstones(data);
    if (!serverResp) {
      await _pushBackupToExistingApis(_filterBackupByDecisions(data, decisions));
    }
    if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
    if (typeof setFormulaCache === 'function') setFormulaCache(_safeParseJSON(localStorage.getItem('phymathia_formulas'), {}));
    updateDataStats();
    // T284：把导入后的模型配置先推到服务端再刷新（推送失败也无碍——乐观同步戳
    // 在 scheduleModelsSync 时已落地，刷新后按「本地较新→补传」收敛）
    if (typeof flushModelsSync === 'function') { try { await flushModelsSync(); } catch (e) {} }
  } catch (err) {
    console.error('[Import] Apply error:', err);
    applyError = err;
  }

  const counts = result && result.ok ? result : _backupCounts(data);
  let text = '导入完成：' + (counts.sessions || 0) + ' 张画布 · ' + (counts.messages || 0) + ' 条消息 · ' +
    (counts.knowledge || 0) + ' 条知识点 · ' + (counts.formulas || 0) + ' 条公式';
  if (result && result.autoBackup && result.autoBackup.id) text += ' · 已自动备份当前数据';
  if (serverImported) {
    // 服务端已收下：缓存没写全只附一句说明，刷新延时放长到 3.6s 给人读完
    if (applyError) {
      text += '\n本机缓存没有更新；数据已完整存入电脑存档，不影响使用。';
      if (typeof showToast === 'function') showToast('导入完成：数据已存入电脑存档（本机缓存没有更新，不影响使用）', 6000);
    } else if (misses.length) {
      text += '\n浏览器本地空间不足，部分内容没有缓存到本机；数据已完整存入电脑存档，不影响使用。';
      if (typeof showToast === 'function') showToast('导入完成：数据已存入电脑存档（浏览器本地空间不足，部分内容未缓存到本机，不影响使用）', 3600);
    } else if (typeof showToast === 'function') showToast(text, 6000);
    if (resultEl) { resultEl.textContent = text; resultEl.style.color = 'var(--text-secondary)'; }
    updateBackupSnapshots(true);
    _reloadAfterDataWrite((applyError || misses.length) ? 3600 : 1400);
    return;
  }
  // 服务端没收到（离线兜底路）：本机缓存是唯一落点，没存全就得照实说、让人重试
  if (applyError || misses.length) {
    _importBusy = false;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = mode === 'replace' ? '确认替换' : '确认合并'; }
    if (cancelBtn) cancelBtn.disabled = false;
    if (resultEl) {
      resultEl.textContent = '导入未完成：服务端暂时不可用，且浏览器本地空间已满，数据只存下了一部分。可在释放浏览器空间后重试导入。';
      resultEl.style.color = 'var(--danger, #c0392b)';
    }
    if (typeof showToast === 'function') showToast('导入未完成：数据只存下了一部分，可重试', 6000);
    return;
  }
  text += '（服务端不可用，仅写入本机缓存）';
  if (resultEl) { resultEl.textContent = text; resultEl.style.color = 'var(--text-secondary)'; }
  if (typeof showToast === 'function') showToast(text, 6000);
  updateBackupSnapshots(true);
  _reloadAfterDataWrite(1400);
}

// ====== 自动备份列表（583）======
let _snapshotFetchBusy = false;

function _snapshotReasonLabel(reason) {
  const map = { import: '导入前', restore: '恢复前' };
  return map[reason] || '自动备份';
}

function _renderSnapshotList(items) {
  const list = document.getElementById('backupSnapshotList');
  if (!list) return;
  list.textContent = '';
  if (!items.length) {
    list.textContent = '还没有自动备份（每次导入前会自动生成一份）';
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);';
    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.4;word-break:break-all;';
    const when = new Date(Number(item.createdAt) || Date.now());
    const timeText = isNaN(when.getTime()) ? String(item.id) : when.toLocaleString();
    info.textContent = timeText + ' · ' + _snapshotReasonLabel(item.reason) + ' · ' + _formatBackupBytes(item.size);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '恢复';
    btn.style.cssText = 'flex:none;padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-container);color:var(--text-primary);cursor:pointer;font-size:12px;';
    btn.addEventListener('click', () => restoreBackupSnapshot(item.id));
    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

async function updateBackupSnapshots() {
  const list = document.getElementById('backupSnapshotList');
  if (!list || _snapshotFetchBusy) return;
  _snapshotFetchBusy = true;
  try {
    const resp = await fetch('/api/backup/snapshots', {
      cache: 'no-cache',
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const body = await resp.json();
    _renderSnapshotList(Array.isArray(body && body.snapshots) ? body.snapshots : []);
  } catch (e) {
    list.textContent = '自动备份列表暂时不可用';
  } finally {
    _snapshotFetchBusy = false;
  }
}

async function restoreBackupSnapshot(id) {
  if (phyIsReadonly()) { phyReadonlyBlock('恢复备份'); return; }
  if (!id || !confirm('恢复这份自动备份？当前数据会先自动备份一份，然后被这份备份替换。')) return;
  try {
    const resp = await fetch('/api/backup/snapshots/' + encodeURIComponent(id) + '/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: getDeviceId() }),
      signal: AbortSignal.timeout(120000)
    });
    if (!resp.ok) {
      let detail = 'HTTP ' + resp.status;
      try {
        const body = await resp.json();
        if (body && body.detail) detail = body.detail;
      } catch (e) {}
      alert('恢复失败：' + detail);
      return;
    }
    // 本地缓存先清掉，刷新后以服务端恢复结果为准；设置与设备编号保留
    _clearLocalDataForReplace();
    if (typeof showToast === 'function') showToast('已恢复自动备份，页面即将刷新', 5000);
    _reloadAfterDataWrite(800);
  } catch (e) {
    alert('恢复失败：' + e.message);
  }
}
