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
}

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
    currentSession: localStorage.getItem('phymathia_current_session') || '',
    level: localStorage.getItem('phymathia_level') || 'university',
    theme: _getInitialTheme(),
    onboarding: localStorage.getItem('phymathia_onboarding_done') || ''
  };
}

function _downloadBackup(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'phymathia_backup_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function _pickNewerQuizBank(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return (Number(a.updatedAt || 0) >= Number(b.updatedAt || 0)) ? a : b;
}

async function exportData(options = {}) {
  // 查阅态拦下（T187 2026-10-07 拍板）：allowBrowse 的礼节是「只读查阅会话与
  // 知识」，整包导出是把对方全部内容一次带走，超出浏览语义（服务端同步 403）。
  // PNG 海报与单画布 .pmu 是纯前端产物，不受影响。
  if (phyIsReadonly()) { phyReadonlyBlock('导出数据'); return; }
  const local = _collectLocalBackup();
  let data = { ...local, version: 2, exportTime: new Date().toISOString() };
  try {
    // device_id 恒传：服务端按账号圈定备份里的画像（只带走本账号归属的设备），
    // 顺手把当前设备登记进账号绑定——画像按账号隔离的圈定键
    const resp = await fetch('/api/backup/export?device_id=' + encodeURIComponent(getDeviceId()), { cache: 'no-cache' });
    if (!resp.ok && options.requireServer) throw new Error('备份请求失败：' + resp.status);
    if (resp.ok) {
      const server = await resp.json();
      if (options.requireServer && (!server || !server.profiles || typeof server.profiles !== 'object' || Array.isArray(server.profiles))) {
        throw new Error('服务端备份缺少画像数据');
      }
      const serverGraphs = {};
      const kv = server.kv || {};
      for (const [key, value] of Object.entries(kv)) {
        if (key.startsWith('graph:')) serverGraphs[key.slice(6)] = value;
      }
      data = {
        version: 2,
        exportTime: new Date().toISOString(),
        sessions: _mergeMaps(server.sessions, local.sessions),
        messages: { ...(server.messages || {}), ...local.messages },
        knowledge: _mergeMaps(server.knowledge, local.knowledge),
        formulas: _mergeMaps(server.formulas, local.formulas),
        profiles: server.profiles || {},
        kv,
        graphs: _mergeMaps(serverGraphs, local.graphs),
        quizStats: _mergeMaps(kv['phymathia_quiz_stats'] || {}, local.quizStats),
        quizBank: _pickNewerQuizBank(kv['phymathia_quiz_bank'] || null, local.quizBank),
        userModels: local.userModels,
        activeModels: local.activeModels,
        currentSession: local.currentSession,
        level: local.level,
        theme: local.theme,
        onboarding: local.onboarding
      };
    }
  } catch (e) {
    if (options.requireServer) throw e;
    console.warn('[Export] Server backup unavailable, use local snapshot:', e);
  }
  _downloadBackup(data);
}

function _normalizeBackup(data) {
  const result = { ...data };
  result.sessions = result.sessions && typeof result.sessions === 'object' && !Array.isArray(result.sessions)
    ? result.sessions
    : Array.isArray(result.sessions)
      ? Object.fromEntries(result.sessions.map(item => [item.id, item]).filter(([id]) => id))
      : {};
  result.messages = result.messages && typeof result.messages === 'object' ? result.messages : {};
  result.knowledge = result.knowledge && typeof result.knowledge === 'object' ? result.knowledge : {};
  if (result.formulas && typeof result.formulas === 'object' && !Array.isArray(result.formulas) && result.formulas.items) {
    result.formulas = Array.isArray(result.formulas.items)
      ? Object.fromEntries(result.formulas.items.map(item => [item.id, item]).filter(([id]) => id))
      : result.formulas.items;
  }
  result.formulas = result.formulas && typeof result.formulas === 'object' ? result.formulas : {};
  result.graphs = result.graphs && typeof result.graphs === 'object' ? result.graphs : {};
  result.quizStats = result.quizStats && typeof result.quizStats === 'object' ? result.quizStats : {};
  result.quizBank = result.quizBank && typeof result.quizBank === 'object' ? result.quizBank : null;
  return result;
}

function updateStorageDebug() {
  const el = document.getElementById('storageDebug');
  if (!el) return;
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
}

function _applyLocalSettings(data) {
  if (data.theme) localStorage.setItem('phymathia_theme', data.theme);
  if (data.level) localStorage.setItem('phymathia_level', data.level);
  if (data.currentSession) localStorage.setItem('phymathia_current_session', data.currentSession);
  if (data.onboarding) localStorage.setItem('phymathia_onboarding_done', data.onboarding);
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
    localStorage.setItem('phymathia_user_models', JSON.stringify(merged));
  }
  if (data.activeModels && typeof data.activeModels === 'object') localStorage.setItem('phymathia_active_models', JSON.stringify(data.activeModels));
  const quizStats = data.quizStats && typeof data.quizStats === 'object'
    ? data.quizStats
    : (data.kv && data.kv['phymathia_quiz_stats']) || {};
  if (quizStats && typeof quizStats === 'object') localStorage.setItem('phymathia_quiz_stats', JSON.stringify(quizStats));
  const quizBank = data.quizBank || (data.kv && data.kv['phymathia_quiz_bank']) || null;
  if (quizBank && typeof quizBank === 'object') localStorage.setItem('phymathia_quiz_bank', JSON.stringify(quizBank));
}

function _applyLocalBackup(data, replace) {
  if (replace) {
    lsKeys().filter(k => k.startsWith('phymathia_')).forEach(k => localStorage.removeItem(k));
  }
  const sessions = _safeParseJSON(localStorage.getItem('phymathia_sessions'), {});
  Object.assign(sessions, data.sessions || {});
  safeLocalStorageSet('phymathia_sessions', JSON.stringify(sessions));

  for (const [sid, msgs] of Object.entries(data.messages || {})) {
    if (!Array.isArray(msgs)) continue;
    const key = 'phymathia_msgs_' + sid;
    const existing = _safeParseJSON(localStorage.getItem(key), []);
    const existingKeys = new Set(existing.map(m => m.timestamp || JSON.stringify(m)));
    const merged = [...existing];
    for (const msg of msgs) {
      const msgKey = msg.timestamp || JSON.stringify(msg);
      if (!existingKeys.has(msgKey)) {
        existingKeys.add(msgKey);
        merged.push(msg);
      }
    }
    safeLocalStorageSet(key, JSON.stringify(merged));
  }

  const knowledge = _safeParseJSON(localStorage.getItem('phymathia_knowledge'), {});
  Object.assign(knowledge, data.knowledge || {});
  safeLocalStorageSet('phymathia_knowledge', JSON.stringify(knowledge));

  const formulas = _safeParseJSON(localStorage.getItem('phymathia_formulas'), {});
  Object.assign(formulas, data.formulas || {});
  if (typeof setFormulaCache === 'function') setFormulaCache(formulas); else safeLocalStorageSet('phymathia_formulas', JSON.stringify(formulas));

  for (const [sid, state] of Object.entries(data.graphs || {})) {
    if (!(state && typeof state === 'object')) continue;
    if (sid.startsWith('history_')) {
      // 旧版备份把历史快照错并进 graphs（键 history_<sid>）——归位到历史键
      if (Array.isArray(state)) safeLocalStorageSet('phymathia_graph_history_' + sid.slice('history_'.length), JSON.stringify(state));
      continue;
    }
    safeLocalStorageSet('phymathia_graph_' + sid, JSON.stringify(state));
  }
  for (const [sid, arr] of Object.entries(data.graphHistories || {})) {
    if (Array.isArray(arr)) safeLocalStorageSet('phymathia_graph_history_' + sid, JSON.stringify(arr));
  }
  _applyLocalSettings(data);
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
      if (!Array.isArray(arr)) continue;
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

async function importData(event) {
  if (phyIsReadonly()) { phyReadonlyBlock('导入备份'); return; }
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const data = _normalizeBackup(JSON.parse(e.target.result));
      if (!data.sessions && !data.messages && !data.knowledge && !data.formulas && !data.kv && !data.quizStats && !data.quizBank) {
        alert('导入失败：文件格式不正确，缺少有效数据');
        return;
      }
      const modeSelect = document.getElementById('importModeSelect');
      const mode = modeSelect && modeSelect.value ? modeSelect.value : 'merge';
      let serverResp = null;
      try {
        serverResp = await fetch('/api/backup/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // device_id 同导出：服务端据此圈定 replace 清除范围与本账号画像归属
          body: JSON.stringify({ mode, device_id: getDeviceId(), backup: data })
        });
      } catch (serverErr) {
        console.warn('[Import] Server import unavailable, use local:', serverErr);
      }
      if (!serverResp || !serverResp.ok) {
        _applyLocalBackup(data, mode === 'replace');
        await _pushBackupToExistingApis(data);
      } else {
        _applyLocalBackup(data, mode === 'replace');
      }
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
      if (typeof setFormulaCache === 'function') setFormulaCache(_safeParseJSON(localStorage.getItem('phymathia_formulas'), {}));
      updateDataStats();
      alert('数据导入成功！页面即将刷新。');
      location.reload();
    } catch (err) {
      console.error('[Import] Error:', err);
      alert('导入失败：文件格式不正确 - ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}
