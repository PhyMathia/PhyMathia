// ====== 难度等级管理 ======
let currentLevel = localStorage.getItem(STORAGE_KEY_LEVEL) || 'university';

function updateLevelUI() {
  document.getElementById('levelBtn').innerHTML = LEVEL_ICON_SVG[currentLevel] + ' ' + LEVEL_LABELS[currentLevel];
  document.querySelectorAll('.level-option').forEach(el => {
    el.classList.toggle('active', el.dataset.level === currentLevel);
  });
}
function setLevel(level) {
  currentLevel = level;
  localStorage.setItem(STORAGE_KEY_LEVEL, level);
  updateLevelUI();
  toggleLevelPanel();
}
function toggleLevelPanel(e) {
  e?.stopPropagation();
  const panel = document.getElementById('levelPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  if (willShow) {
    document.getElementById('modelPanel').classList.remove('show');
    document.getElementById('dataPanel').classList.remove('show');
    void panel.offsetHeight;
    const trigger = e?.currentTarget || document.getElementById('levelBtn');
    _positionPanel('levelPanel', trigger);
  }
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('levelPanel');
  const btn = document.getElementById('levelBtn');
  if (panel && !panel.contains(e.target) && !btn.contains(e.target)) panel.classList.remove('show');
});
updateLevelUI();

// ====== 模型设置管理（由 models.js 模块接管）=====

function showModelToast(msg, isError) {
  const toast = document.getElementById('modelToast');
  toast.textContent = msg;
  toast.style.borderColor = isError ? '#ef4444' : 'var(--accent)';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

function _positionPanel(panelId, triggerEl) {
  const panel = document.getElementById(panelId);
  if (!panel || !triggerEl) return;
  const rect = triggerEl.getBoundingClientRect();
  const panelW = panel.offsetWidth;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  // 水平：优先按钮左对齐，如果超出右边则右对齐
  let left = rect.left;
  if (left + panelW > viewW - 8) {
    left = viewW - panelW - 8;
  }
  if (left < 8) left = 8;
  // 垂直：面板顶部紧贴所在工具栏（顶栏 / 二级工具栏）的底部，避免遮挡工具栏
  const toolbar = triggerEl.closest('.chat-header, .header-secondary-bar');
  const top = Math.max(8, (toolbar ? toolbar.getBoundingClientRect().bottom : rect.bottom) + 6);
  // 高度不足时限制最大高度并内部滚动，避免面板翻到工具栏上方遮挡
  const maxH = Math.max(120, viewH - top - 8);
  panel.style.left = left + 'px';
  panel.style.right = 'auto';
  panel.style.top = top + 'px';
  panel.style.maxHeight = maxH + 'px';
  panel.style.overflowY = 'auto';
}

function toggleModelPanel(e) {
  e?.stopPropagation();
  const panel = document.getElementById('modelPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  // Close other panels
  document.getElementById('levelPanel').classList.remove('show');
  document.getElementById('dataPanel').classList.remove('show');
  if (willShow) {
    renderModelList();
    renderModelSelects();
    const trigger = e && e.currentTarget ? e.currentTarget : document.getElementById('modelBtn');
    void panel.offsetHeight;
    _positionPanel('modelPanel', trigger);
  }
}

function toggleDataPanel(e) {
  const panel = document.getElementById('dataPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  if (willShow && typeof window._positionPanelBelowBtn === 'function') window._positionPanelBelowBtn(panel, e?.currentTarget);
  // Close other panels
  document.getElementById('levelPanel').classList.remove('show');
  document.getElementById('modelPanel').classList.remove('show');
  // Show data stats
  updateDataStats();
  if (willShow) {
    const trigger = e && e.currentTarget ? e.currentTarget : document.getElementById('modelBtn');
    // Force reflow so offsetWidth/offsetHeight are available
    void panel.offsetHeight;
    _positionPanel('dataPanel', trigger);
  }
}

function updateDataStats() {
  const sessions = JSON.parse(localStorage.getItem('phymathia_sessions') || '{}');
  const knowledge = JSON.parse(localStorage.getItem('phymathia_knowledge') || '{}');
  const formulas = (typeof getFormulaCache === 'function' ? getFormulaCache() : {}) || {};
  const quizStats = JSON.parse(localStorage.getItem('phymathia_quiz_stats') || '{}');
  const sessionCount = Object.keys(sessions).length;
  let msgCount = 0;
  Object.keys(sessions).forEach(sid => {
    const msgs = JSON.parse(localStorage.getItem('phymathia_msgs_' + sid) || '[]');
    msgCount += msgs.length;
  });
  const knowledgeCount = Object.keys(knowledge).length;
  const formulaCount = Object.keys(formulas).length;
  const graphCount = Object.keys(localStorage).filter(k => k.startsWith('phymathia_graph_')).length;
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
  const sessions = _safeParseJSON(localStorage.getItem('phymathia_sessions'), {});
  const messages = {};
  Object.keys(sessions).forEach(sid => {
    messages[sid] = _safeParseJSON(localStorage.getItem('phymathia_msgs_' + sid), []);
  });
  const graphs = {};
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('phymathia_graph_')) {
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
  const local = _collectLocalBackup();
  let data = { ...local, version: 2, exportTime: new Date().toISOString() };
  try {
    const resp = await fetch('/api/backup/export', { cache: 'no-cache' });
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
  const keys = Object.keys(localStorage).filter(k => k.startsWith('phymathia_'));
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
    Object.keys(localStorage).filter(k => k.startsWith('phymathia_')).forEach(k => localStorage.removeItem(k));
  }
  const sessions = _safeParseJSON(localStorage.getItem('phymathia_sessions'), {});
  Object.assign(sessions, data.sessions || {});
  localStorage.setItem('phymathia_sessions', JSON.stringify(sessions));

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
    localStorage.setItem(key, JSON.stringify(merged));
  }

  const knowledge = _safeParseJSON(localStorage.getItem('phymathia_knowledge'), {});
  Object.assign(knowledge, data.knowledge || {});
  localStorage.setItem('phymathia_knowledge', JSON.stringify(knowledge));

  const formulas = _safeParseJSON(localStorage.getItem('phymathia_formulas'), {});
  Object.assign(formulas, data.formulas || {});
  if (typeof setFormulaCache === 'function') setFormulaCache(formulas); else localStorage.setItem('phymathia_formulas', JSON.stringify(formulas));

  for (const [sid, state] of Object.entries(data.graphs || {})) {
    if (state && typeof state === 'object') localStorage.setItem('phymathia_graph_' + sid, JSON.stringify(state));
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
      await fetch('/api/kv/' + encodeURIComponent('graph:' + sid), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: state })
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
          body: JSON.stringify({ mode, backup: data })
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

// Close model/data panel on outside click
document.addEventListener('click', (e) => {
  // 事件处理器里重建过 DOM 时，e.target 可能已脱离文档（detached）——此时
  // contains 恒为 false，会把面板内点击误判为“点外部”而关闭；跳过这类事件
  if (e.target && !e.target.isConnected) return;
  const panels = [
    { el: document.getElementById('modelPanel'), btns: document.querySelectorAll('[onclick*="toggleModelPanel"]') },
    { el: document.getElementById('dataPanel'), btns: document.querySelectorAll('[onclick*="toggleDataPanel"]') }
  ];
  panels.forEach(({ el, btns }) => {
    if (!el) return;
    const clickedBtn = Array.from(btns).some(btn => btn.contains(e.target));
    if (!el.contains(e.target) && !clickedBtn) {
      el.classList.remove('show');
    }
  });
});

// models.js is loaded before the model panel markup in index.html.
// The initial render is performed from the window load handler below.


/* ====================================================
 * 漂浮数学物理符号（海面漂浮效果 + 鼠标交互）
 * ==================================================== */
(function initFloatingSymbols() {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // 符号池：匹配背景图上的公式和符号
  const symbolPool = [
    'e^{iπ}+1=0', '∫', '∂', '∇', 'Σ', 'Δ', 'λ', 'ω', 'φ', 'π',
    'ε₀', 'F=ma', 'E=mc²', '∇·E=ρ/ε₀', '∂²u/∂t²=c²∇²u',
    '∑1/n²=π²/6', 'd²x/dt²=-kx/m', '∮', 'ℏ', 'α', 'β', 'γ',
    'θ', 'μ', 'σ', 'τ', 'ψ', 'Ω'
  ];

  const SYMBOL_COUNT = isMobile ? 18 : 33;
  const REPEL_RADIUS = 120;
  const REPEL_STRENGTH = 0.6;

  let mouseX = -1000, mouseY = -1000;
  let smoothMouseX = -1000, smoothMouseY = -1000;

  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });
  document.addEventListener('mouseleave', () => {
    mouseX = -1000;
    mouseY = -1000;
  });
  // 移动端触摸交互
  if (isMobile) {
    document.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        mouseX = e.touches[0].clientX;
        mouseY = e.touches[0].clientY;
      }
    }, { passive: true });
    document.addEventListener('touchend', () => {
      mouseX = -1000;
      mouseY = -1000;
    }, { passive: true });
  }

  const container = document.createElement('div');
  container.id = 'floating-symbols';
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;';
  document.body.appendChild(container);

  class FloatingSymbol {
    constructor(index) {
      this.el = document.createElement('span');
      this.text = symbolPool[index % symbolPool.length];
      this.el.textContent = this.text;

      const isFormula = this.text.length > 3;
      this.size = isFormula ? 14 + Math.random() * 8 : 18 + Math.random() * 16;
      this.el.style.fontSize = this.size + 'px';

      this.x = Math.random() * window.innerWidth;
      this.y = Math.random() * window.innerHeight;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.vy = (Math.random() - 0.5) * 0.15;

      this.bobPhase = Math.random() * Math.PI * 2;
      this.bobSpeed = 0.008 + Math.random() * 0.012;
      this.bobAmp = 1.5 + Math.random() * 3;

      this.rotation = (Math.random() - 0.5) * 20;
      this.rotSpeed = (Math.random() - 0.5) * 0.15;

      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      this.baseOpacity = dark
        ? (isFormula ? 0.12 + Math.random() * 0.12 : 0.15 + Math.random() * 0.2)
        : (isFormula ? 0.05 + Math.random() * 0.06 : 0.06 + Math.random() * 0.10);
      this.repelVx = 0;
      this.repelVy = 0;

      this.applyTheme();
      container.appendChild(this.el);
    }

    applyTheme() {
      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      const isFormula = this.text.length > 3;
      this.baseOpacity = dark
        ? (isFormula ? 0.12 + Math.random() * 0.12 : 0.15 + Math.random() * 0.2)
        : (isFormula ? 0.08 + Math.random() * 0.08 : 0.10 + Math.random() * 0.12);
      this.el.style.cssText = `
        position:absolute; left:0; top:0;
        font-family: 'Cambria Math','Latin Modern Math','STIX Two Math','Times New Roman',serif;
        font-size:${this.size}px;
        color:${dark ? 'rgba(140,180,255,1)' : 'rgba(160,120,70,1)'};
        text-shadow:${dark ? '0 0 8px rgba(100,150,255,0.3)' : '0 0 6px rgba(180,140,80,0.2)'};
        user-select:none; will-change:transform,opacity; pointer-events:none;
      `;
    }

    update() {
      this.bobPhase += this.bobSpeed;
      const bobY = Math.sin(this.bobPhase) * this.bobAmp;
      const bobX = Math.cos(this.bobPhase * 0.7) * this.bobAmp * 0.5;

      this.x += this.vx;
      this.y += this.vy;
      this.rotation += this.rotSpeed;

      const dx = this.x - smoothMouseX;
      const dy = this.y - smoothMouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < REPEL_RADIUS && dist > 0) {
        const force = (1 - dist / REPEL_RADIUS) * REPEL_STRENGTH;
        this.repelVx += (dx / dist) * force;
        this.repelVy += (dy / dist) * force;
      }
      this.repelVx *= 0.94;
      this.repelVy *= 0.94;

      const margin = 60;
      if (this.x < -margin) this.x = window.innerWidth + margin;
      if (this.x > window.innerWidth + margin) this.x = -margin;
      if (this.y < -margin) this.y = window.innerHeight + margin;
      if (this.y > window.innerHeight + margin) this.y = -margin;

      const finalX = this.x + bobX + this.repelVx;
      const finalY = this.y + bobY + this.repelVy;
      this.el.style.transform = `translate(${finalX}px,${finalY}px) rotate(${this.rotation}deg)`;

      const highlight = dist < REPEL_RADIUS ? 1 + (1 - dist / REPEL_RADIUS) * 0.4 : 1;
      this.el.style.opacity = this.baseOpacity * highlight;
    }
  }

  const symbols = [];
  for (let i = 0; i < SYMBOL_COUNT; i++) symbols.push(new FloatingSymbol(i));

  function animate() {
    smoothMouseX += (mouseX - smoothMouseX) * 0.1;
    smoothMouseY += (mouseY - smoothMouseY) * 0.1;
    for (const sym of symbols) sym.update();
    requestAnimationFrame(animate);
  }
  animate();

  const origToggle = window.toggleTheme;
  window.toggleTheme = function() {
    if (origToggle) origToggle();
    for (const sym of symbols) sym.applyTheme();
  };
})();

// ====== 简易 Toast ======
function showToast(msg, duration = 2500) {
  let toast = document.getElementById('phymathia_toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'phymathia_toast';
    // 第 5 轮磨砂化：全局 toast 统一极光磨砂（--compact 胶囊档）——
    // 底色/阴影归玻璃类，内联样式里不能再写 background（会整块盖掉极光层）
    toast.className = 'aurora-glass aurora-glass--compact';
    toast.style.cssText = 'position:fixed;bottom:120px;left:50%;transform:translateX(-50%) translateY(10px);color:var(--text-primary);border:1px solid var(--border-color);border-radius:10px;padding:10px 20px;font-size:13px;z-index:9999;opacity:0;transition:opacity 0.3s,transform 0.3s;pointer-events:none;white-space:nowrap;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(10px)';
  }, duration);
}

function showCompletionCard(title, subtitle, duration = 4000) {
  let card = document.getElementById('phymathia_completion_card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'phymathia_completion_card';
    // 第 5 轮磨砂化：完成通知卡统一极光磨砂（基础档小浮层）；styles.css 里本载体的
    // background/box-shadow 已拔掉
    card.className = 'completion-card aurora-glass';
    card.innerHTML =
      '<div class="completion-card-icon">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
      '</div>' +
      '<div class="completion-card-content">' +
      '<div class="completion-card-title"></div>' +
      '<div class="completion-card-subtitle"></div>' +
      '</div>' +
      '<button class="completion-card-close" title="关闭" aria-label="关闭">×</button>';
    card.querySelector('.completion-card-close').addEventListener('click', function () {
      hideCompletionCard(card);
    });
    document.body.appendChild(card);
  }
  card.querySelector('.completion-card-title').textContent = title;
  card.querySelector('.completion-card-subtitle').textContent = subtitle || '';
  requestAnimationFrame(function () {
    card.classList.add('show');
  });
  clearTimeout(card._timer);
  card._timer = setTimeout(function () {
    hideCompletionCard(card);
  }, duration);
}

function hideCompletionCard(card) {
  if (!card) card = document.getElementById('phymathia_completion_card');
  if (!card) return;
  card.classList.remove('show');
}

let _completionAudioContext = null;

function playCompletionSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!_completionAudioContext) _completionAudioContext = new AudioContextClass();
    const ctx = _completionAudioContext;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const tones = [
      { at: 0, frequency: 880, duration: 0.18 },
      { at: 0.16, frequency: 1174.66, duration: 0.22 }
    ];
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.frequency;
      gain.gain.setValueAtTime(0.0001, now + tone.at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + tone.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.at);
      osc.stop(now + tone.at + tone.duration + 0.02);
    }
  } catch (e) {
    // 浏览器限制或音频设备不可用时静默跳过提示音
  }
}

function notifyTaskCompleted(durationMs, label = '任务完成') {
  const ms = Math.max(0, Number(durationMs) || 0);
  const durationText = typeof formatDuration === 'function' ? formatDuration(ms) : Math.ceil(ms / 1000) + 's';
  const labelText = String(label || '任务完成');
  let title = labelText;
  let rest = '';
  if (labelText.indexOf('工作流完成') === 0) {
    title = '工作流完成';
    rest = labelText.slice('工作流完成'.length).replace(/^[·\s]+/, '');
  }
  const subtitle = [rest, '用时 ' + durationText].filter(Boolean).join(' · ');
  showCompletionCard(title, subtitle);
  playCompletionSound();
}

document.addEventListener('pointerdown', () => {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || _completionAudioContext) return;
    _completionAudioContext = new AudioContextClass();
    if (_completionAudioContext.state === 'suspended') _completionAudioContext.resume().catch(() => {});
  } catch (e) {
    // 音频上下文预热失败不影响任务本身
  }
}, { passive: true });

// ====== 移动端键盘适配 ======
function handleVisualViewport() {
  if (!window.visualViewport) return;
  const viewport = window.visualViewport;
  const inputArea = document.querySelector('.input-area');
  const chatMessages = document.getElementById('chatMessages');
  if (inputArea) {
    const offset = window.innerHeight - viewport.height;
    if (offset > 50) {
      // 键盘弹起：将输入区固定到可视区域底部
      inputArea.style.position = 'fixed';
      inputArea.style.bottom = '0';
      inputArea.style.left = '0';
      inputArea.style.right = '0';
      inputArea.style.zIndex = '100';
      inputArea.style.transform = '';
      inputArea.style.marginBottom = '';
      // 给聊天区域留出输入框的空间
      if (chatMessages) chatMessages.style.paddingBottom = '70px';
    } else {
      inputArea.style.position = '';
      inputArea.style.bottom = '';
      inputArea.style.left = '';
      inputArea.style.right = '';
      inputArea.style.zIndex = '';
      inputArea.style.transform = '';
      inputArea.style.marginBottom = '';
      if (chatMessages) chatMessages.style.paddingBottom = '';
    }
  }
  scrollToBottom();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleVisualViewport);
  window.visualViewport.addEventListener('scroll', handleVisualViewport);
}

// ====== 首次使用引导 ======
let _obStep = -1;
const _isMobile = () => window.innerWidth <= 768;
const ONBOARDING_EXAMPLE_QUESTION = '请解释简谐运动的物理和数学本质，并生成交互式可视化';
const _obSteps = [
  {
    type: 'welcome',
    icon: '<img src="/logo.png" style="width:48px;height:48px;border-radius:12px;" />',
    title: '欢迎来到 PhyMathia',
    features: [
      { icon: UI_ICON_SVG.formula, text: '<strong>双域解释</strong> — 每个问题同时从物理直觉和数学本质给出答案' },
      { icon: UI_ICON_SVG.monitor, text: '<strong>交互可视化</strong> — 生成可动手操作的 HTML 可视化页面' },
      { icon: UI_ICON_SVG.formula, text: '<strong>网络图探索</strong> — 新画布从中心节点开始，答案与模块向外铺展' },
      { icon: UI_ICON_SVG.book, text: '<strong>知识积累</strong> — 自动提取知识点，构建你的专属知识库' },
    ]
  },
  {
    type: 'welcome',
    example: true,
    icon: UI_ICON_SVG.sparkles,
    title: '内置示例图讲解',
    desc: '打开一张内置的「简谐运动」示例探索网，在<strong>真实画布</strong>上逐步讲解：双击添加节点、端口拖线、节点类型、工具栏、选择编辑和状态显示。',
    exampleQuestion: ONBOARDING_EXAMPLE_QUESTION,
    exampleNote: '演示图不会调用模型，关闭后会恢复你原来的画布。',
    features: [
      { icon: UI_ICON_SVG.pencil, text: '<strong>边点边学</strong> — 聚光灯指到哪，右侧就讲解到哪' },
      { icon: UI_ICON_SVG.monitor, text: '<strong>真实画布</strong> — 可直接拖动、缩放、双击和拉线体验' },
      { icon: UI_ICON_SVG.book, text: '<strong>不产生数据</strong> — 演示改动不会写入当前会话或知识库' },
    ]
  },
  {
    type: 'spotlight',
    get target() { return document.querySelector('.graph-new-session-node') ? '.graph-new-session-node' : '.graph-canvas'; },
    icon: UI_ICON_SVG.pencil,
    get title() { return document.querySelector('.graph-new-session-node') ? '在中心节点提问' : '继续探索'; },
    get desc() {
      return document.querySelector('.graph-new-session-node')
        ? '在画布中央的<strong>中心节点</strong>输入物理或数学问题，答案会从中心向外展开成探索网。'
        : '在探索网中点击气泡上的<strong>追问</strong>、<strong>没看懂</strong>或<strong>删除</strong>，管理当前画布分支。';
    }
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.header-secondary-bar' : '.header-actions'; },
    icon: UI_ICON_SVG.sliders,
    title: '个性化设置',
    get desc() {
      return _isMobile()
        ? '顶栏可切换<strong>深色/浅色主题</strong>和<strong>难度等级</strong>；这里可设置<strong>AI 模型</strong>、打开<strong>知识总览</strong>、管理数据和清空画布。'
        : '在这里切换<strong>深色/浅色主题</strong>、选择<strong>AI 模型</strong>和<strong>难度等级</strong>（中学 / 大学 / 科研），点击书本图标打开<strong>知识总览</strong>面板，查看 AI 自动提取的知识点和你收藏的内容。';
    }
  },
  {
    type: 'click',
    target: '.menu-btn',
    icon: UI_ICON_SVG.book,
    title: '试试点击菜单按钮',
    desc: '点击左上角的菜单按钮，打开侧边栏管理<strong>多张画布</strong>，随时切换不同话题。',
    onClick() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.sidebar-sessions' : '.session-item'; },
    icon: UI_ICON_SVG.pencil,
    title: '个性化画布',
    get desc() {
      return '点击画布图标可以<strong>切换力学、电磁、光学等图标</strong>，点击重命名按钮可以<strong>重命名画布</strong>，让你的画布列表更清晰有序。';
    },
    beforeShow() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'welcome',
    icon: UI_ICON_SVG.sparkles,
    title: '记忆功能（默认开启）',
    desc: 'PhyMathia 会记住你的<strong>学习画像</strong>（学段、目标、兴趣、薄弱点、回答偏好），让回答风格、出题方向更贴合你。画像仅存本机，可随时关闭或清除。',
    features: [
      { icon: UI_ICON_SVG.check, text: '<strong>个性化</strong> — 回答详略、术语密度、检测出题按你的画像调整' },
      { icon: UI_ICON_SVG.book, text: '<strong>本地存储</strong> — 画像保存在本机；对话内容仍会发送给模型服务商' },
      { icon: UI_ICON_SVG.sliders, text: '<strong>完全可控</strong> — 侧边栏「记忆」中可查看、编辑、删除，也可一键关闭或清除' },
    ]
  }
];

function startOnboarding(force) {
  if (!force && localStorage.getItem(ONBOARDING_KEY)) return;
  _obStep = 0;
  const overlay = document.getElementById('onboardingOverlay');
  overlay.classList.add('active');
  _renderObStep();
}

function startOnboardingExample() {
  openExampleGuide();
}

// ====== 内置示例图讲解：载入演示图，在真实画布上边点边讲 ======
let _exampleGuideStep = 0;
let _exampleGuideOriginal = null;
let _exampleGuideDemoState = null;
let _exampleGuideSuspendedOnboarding = false;
let _exampleGuideLastPanelSide = null;
let _exampleGuideSpotlightRaf = 0;

const EXAMPLE_GUIDE_VIZ_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head><meta charset="UTF-8"><style>',
  ':root{color-scheme:dark}',
  'html,body{margin:0;padding:0;background:transparent;color:#e8eefc;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
  'body{padding:12px}',
  'h3{margin:0 0 6px;font-size:14px}',
  'p{margin:6px 0;font-size:11px;line-height:1.6;color:#b9c7dd}',
  '.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}',
  'label{font-size:11px;color:#dbe6f6}',
  'input{width:120px;accent-color:#38bdf8}',
  '.note{margin-top:6px;font-size:11px;color:#7dd3a7}',
  '</style></head>',
  '<body>',
  '<h3>简谐运动位移曲线</h3>',
  '<p>回复力 F=-kx 把物体拉回平衡位置。</p>',
  '<div class="row"><label>振幅 A <input id="a" type="range" min="0.5" max="2" step="0.1" value="1"></label><label>角频率 ω <input id="w" type="range" min="0.5" max="3" step="0.1" value="1.5"></label></div>',
  '<canvas id="c" width="500" height="170"></canvas>',
  '<div class="note" id="t"></div>',
  '<script>',
  '(function(){var cv=document.getElementById("c"),ctx=cv.getContext("2d");var A=1,w=1.5;',
  'function draw(){ctx.clearRect(0,0,cv.width,cv.height);ctx.strokeStyle="#38bdf8";ctx.lineWidth=2;ctx.beginPath();',
  'for(var x=0;x<=cv.width;x++){var t=x/cv.width*12;var y=85-A*40*Math.sin(w*t);if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}',
  'ctx.stroke();ctx.strokeStyle="rgba(148,163,184,.5)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,85);ctx.lineTo(cv.width,85);ctx.stroke();',
  'document.getElementById("t").textContent="x(t)="+A.toFixed(1)+"·cos("+w.toFixed(1)+"t)。拖动滑块观察振幅和角频率的影响。";}',
  'document.getElementById("a").oninput=function(){A=parseFloat(this.value);draw();};',
  'document.getElementById("w").oninput=function(){w=parseFloat(this.value);draw();};draw();',
  '})();',
  '<\/script>',
  '</body></html>'
].join('\n');

function _demoNode(id, kind, x, y, options) {
  const opt = options || {};
  const now = Date.now();
  return {
    id,
    kind,
    moduleKey: opt.moduleKey || '',
    manual: !!opt.manual,
    label: opt.label || '',
    content: opt.content || '',
    status: opt.status || ((opt.content || opt.analysis || kind === 'hub') ? 'done' : 'waiting'),
    summary: opt.summary || '',
    analysis: opt.analysis || '',
    analysisHash: '',
    inputHash: '',
    generatedAt: now,
    requirements: opt.requirements || '',
    busy: false,
    generated: false,
    maxItems: kind === 'source' ? 3 : 0,
    items: opt.items || [],
    edges: [],
    fileId: '',
    fileName: '',
    generatedNodeIds: [],
    category: opt.category || '',
    formulas: opt.formulas || [],
    knowledgeKey: '',
    x,
    y,
    depth: kind === 'user' ? 1 : kind === 'answer' ? 2 : 3,
    targetAngle: 0,
    isRoot: false,
    timestamp: now,
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: opt.width || null,
    customHeight: opt.height || null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  };
}

function _buildExampleGraphDemoState() {
  const nodes = [
    _demoNode('demo-question', 'user', -700, -260, { manual: true, content: '请解释简谐运动的物理和数学本质，并生成交互式可视化' }),
    _demoNode('demo-answer', 'answer', -220, -260, { analysis: '核心概念：回复力 F=-kx；数学结构：二阶线性微分方程；建议模块：物理视角、数学视角、知识图谱、交互可视化、进阶学习、苏格拉底追问。' }),
    _demoNode('demo-physics', 'module', 340, -540, { moduleKey: 'physics', content: '物体偏离平衡位置越远，回复力越大。回复力 <formula>F=-kx</formula> 总指向平衡位置，动能和弹性势能不断转换。' }),
    _demoNode('demo-math', 'module', 350, -180, { moduleKey: 'math', content: '由牛顿第二定律得到 <formula>m\\frac{d^2x}{dt^2}=-kx</formula>，通解为 <formula>x(t)=A\\cos(\\omega t+\\phi)</formula>。' }),
    _demoNode('demo-graph', 'module', 350, 180, { moduleKey: 'graph', content: '知识图谱：回复力 → 位移 → 速度 → 加速度 → 能量守恒。' }),
    _demoNode('demo-viz', 'module', 350, 540, { moduleKey: 'viz', content: '```html\n' + EXAMPLE_GUIDE_VIZ_HTML + '\n```' }),
    _demoNode('demo-learn', 'module', 900, 0, { moduleKey: 'learn', content: '### 进阶学习方向\n1. 阻尼振动与受迫振动\n2. 共振现象\n3. 耦合振子与简正模式' }),
    _demoNode('demo-socratic', 'module', 900, 360, { moduleKey: 'socratic', content: '### 苏格拉底追问\n1. [基础] 弹簧变硬后振动会怎样？\n2. [进阶] 能量为什么与振幅平方成正比？\n3. [拓展] 加入阻尼后方程如何变化？' }),
    _demoNode('demo-blank', 'blank', -720, 260, { requirements: '用动画解释共振现象', status: 'waiting' }),
    _demoNode('demo-source', 'source', -260, 560, { manual: true, items: [{ title: '简谐运动' }, { title: '回复力' }, { title: '角频率' }] }),
    _demoNode('demo-knowledge', 'knowledge', 320, 820, { manual: true, content: '简谐运动：回复力与位移成正比且反向，系统围绕平衡位置做周期性运动。', formulas: ['F=-kx'] }),
    _demoNode('demo-human', 'human_note', -720, 640, { manual: true, label: '我的理解', content: '回复力像“拉回平衡位置的橡皮筋”，偏离越多拉得越强。' }),
    _demoNode('demo-hub', 'hub', 900, -420, {}),
    _demoNode('demo-note', 'note', 900, 720, { manual: true, content: '我的总结：简谐运动的核心是线性回复力，它同时决定了运动方程与能量关系。' }),
  ];
  const positions = {};
  nodes.forEach(node => { positions[node.id] = { x: node.x, y: node.y }; });
  return {
    collapsed: {},
    hidden: {},
    positions,
    pinned: {},
    sizes: {},
    pan: { x: 140, y: 60 },
    zoom: 0.62,
    focus: null,
    layoutVersion: 4,
    connections: [
      { from: 'demo-question', fromPort: 'out-0', to: 'demo-answer', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-0', to: 'demo-physics', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-1', to: 'demo-math', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-2', to: 'demo-graph', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-3', to: 'demo-viz', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-4', to: 'demo-learn', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-5', to: 'demo-socratic', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-physics', fromPort: 'out-0', to: 'demo-hub', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-math', fromPort: 'out-0', to: 'demo-hub', toPort: 'in-1', type: 'custom', custom: true },
      { from: 'demo-graph', fromPort: 'out-0', to: 'demo-human', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-learn', fromPort: 'out-0', to: 'demo-blank', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-source', fromPort: 'out-0', to: 'demo-knowledge', toPort: 'in-0', type: 'custom', custom: true },
    ],
    removedEdges: [],
    portCounts: {},
    inputPortCounts: { 'demo-hub': 1 },
    groups: [],
    customNodes: nodes,
    harnessDeleted: {},
    harnessCheckpoint: null,
    updatedAt: Date.now(),
  };
}

const EXAMPLE_GUIDE_STEPS = [
  {
    title: '这是内置演示图',
    icon: UI_ICON_SVG.sparkles,
    desc: '已经载入一张以「简谐运动」为主题的示例探索网，并已使用画布自带的<strong>自动整理</strong>重新排布：问题 → AI 回答 → 各模块 → 延伸与结构节点，层级更清晰。',
    points: ['演示期间不会调用模型，也不会写入你的会话。', '你也可以随时点击右下角工具栏的“自动整理”再次重排。', '关闭示例后，画布会恢复成你原来的图。'],
    target: '[data-node-id="demo-answer"]',
  },
  {
    title: '双击空白处添加节点',
    icon: UI_ICON_SVG.plus,
    desc: '在画布空白处<strong>双击</strong>，会弹出“添加节点”菜单，可选择 AI 生成、视角模块、基础素材、人工内容和结构节点。',
    points: ['可以现在就双击右侧空白区域试一试。', '选择节点后，它会出现在你双击的位置。'],
    spot: 'blank',
  },
  {
    title: '问题节点：探索的起点',
    icon: UI_ICON_SVG.pencil,
    desc: '问题节点保存原始问题，右侧有两个输出端口：<strong>AI 回答</strong>和<strong>我的回答</strong>，分别连接自动回答或手写回答。',
    points: ['把输出端口拖到空白处可快速创建下一级节点。', '问题文本可以直接在节点中编辑。'],
    target: '[data-node-id="demo-question"]',
  },
  {
    title: 'AI 回答节点：模块分发器',
    icon: UI_ICON_SVG.sparkles,
    desc: 'AI 回答节点根据问题分析结果，把回答拆成物理视角、数学视角、知识图谱、交互可视化、进阶学习和苏格拉底追问等模块。',
    points: ['每个输出端口对应一个模块。', '状态徽标会显示“分析中 / 完成 / 失败”。'],
    target: '[data-node-id="demo-answer"]',
  },
  {
    title: '模块节点：独立可追问',
    icon: UI_ICON_SVG.book,
    desc: '物理、数学、图谱、可视化等模块都是独立节点，可以单独<strong>追问</strong>、<strong>没看懂</strong>、<strong>编辑</strong>、<strong>最小化</strong>或删除。',
    points: ['节点右下角按钮可重新生成或追问。', '双击节点标题/内容区不会误触添加节点。'],
    target: '[data-node-id="demo-physics"]',
  },
  {
    title: '拖动输出端口生成节点',
    icon: UI_ICON_SVG.external,
    desc: '按住任意节点的<strong>右侧输出端口</strong>，拖到空白处松手，会按端口类型创建追问、进阶学习、苏格拉底回答等新节点。',
    points: ['试试拖动“物理视角”右侧的端口到空白处。', '新节点会自动连接到来源节点。'],
    target: '[data-node-id="demo-physics"] .graph-output-port',
  },
  {
    title: '输入端口：重连或断开',
    icon: UI_ICON_SVG.monitor,
    desc: '按住<strong>左侧输入端口</strong>拖动：拖到其他节点的输出端口可以重连来源；拖到空白处松手则断开当前输入。',
    points: ['模块节点默认有一个输入端口。', '问题、汇聚、空白节点可点击 + 增加输入端口。'],
    target: '[data-node-id="demo-math"] .graph-input-port',
  },
  {
    title: '交互可视化节点',
    icon: UI_ICON_SVG.monitor,
    desc: '可视化模块内嵌可交互 HTML：可以拖动滑块、全屏、复制源码或新窗口打开。真实生成失败时会显示红色“失败”。',
    points: ['在示例图中直接拖动滑块试试。', '“没看懂”会只要求重讲这个可视化。'],
    target: '[data-node-id="demo-viz"]',
  },
  {
    title: '基础素材：输入、知识点、我的理解',
    icon: UI_ICON_SVG.database,
    desc: '画布还支持<strong>输入节点</strong>（文件/文本解析为知识点）、<strong>知识点节点</strong>和<strong>我的理解</strong>批注。',
    points: ['输入节点把内容分发为多个知识点。', '双击“我的理解”节点可直接编辑标题、正文和公式。'],
    target: '[data-node-id="demo-source"]',
  },
  {
    title: '结构节点：汇聚与总结',
    icon: UI_ICON_SVG.book,
    desc: '<strong>汇聚节点</strong>收集多条上游输入，再分发到 AI 总结、我的总结或追问。<strong>我的总结</strong>用于人工收束一条探索路径；本示例中它被收拢在右侧素材区。',
    points: ['汇聚节点可以点击 + 增加输入端口。', '总结节点没有输出端口，表示路径暂告一段落。'],
    target: '[data-node-id="demo-hub"]',
  },
  {
    title: '空白节点：自由生成',
    icon: UI_ICON_SVG.plus,
    desc: '通过双击添加的<strong>AI 生成空白</strong>节点，可以写任意要求（如“用动画解释共振”），点生成后由 AI 生成任意内容。',
    points: ['演示模式不会真的调用模型。', '真实使用时，生成失败会变红并可单独重试。'],
    target: '[data-node-id="demo-blank"]',
  },
  {
    title: '画布工具栏',
    icon: UI_ICON_SVG.sliders,
    desc: '右下角工具栏提供搜索、图体检、缩放/适配、修改历史、文字选择、联系模式、分组、Φ 助手和自动整理。讲解本步时面板已临时移到左侧，不会再遮挡工具栏。',
    points: ['联系模式：依次点两个节点即可添加联系箭头。', '选中多个节点后可创建分组或批量删除。', '自动整理会按节点层级重新排布并适配画布。'],
    target: '.graph-canvas-toolbar',
    panelSide: 'left',
  },
  {
    title: '选择、编辑、删除与撤销',
    icon: UI_ICON_SVG.pencil,
    desc: '单击选中节点，按住 Ctrl/Cmd 多选，空白处拖拽可框选；拖动节点、右下角缩放尺寸，Delete 删除，顶部历史按钮可撤销/重做。',
    points: ['节点右上角按钮：最小化、编辑、删除。', '拖拽分组框可整体移动组内节点。'],
    target: '[data-node-id="demo-blank"]',
  },
  {
    title: '结束演示',
    icon: UI_ICON_SVG.check,
    desc: '你已经看完探索网的核心操作。关闭本示例后，画布会恢复为你原来的会话图，演示中产生的任何改动都不会保留。',
    points: ['在真实画布中双击空白处即可开始搭建自己的网络。', '随时可从侧边栏“示例讲解”重新打开本演示。'],
    spot: 'none',
  },
];

function _exampleGuideSpotRect(step) {
  const canvas = document.getElementById('graphCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (step.spot === 'blank') {
    const left = rect.left + rect.width * 0.36;
    const top = rect.top + rect.height * 0.30;
    const width = Math.min(360, rect.width * 0.30);
    const height = Math.min(240, rect.height * 0.30);
    return { left, top, width, height };
  }
  if (step.spot === 'none') return null;
  if (step.spot === 'canvas') {
    return { left: rect.left + 12, top: rect.top + 12, width: rect.width - 24, height: rect.height - 24 };
  }
  const el = step.target ? document.querySelector(step.target) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const pad = step.spot === 'port' ? 10 : 8;
  return { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

function _compactDemoMaterialNodes() {
  const state = typeof window.getGraphState === 'function' ? window.getGraphState() : null;
  if (!state || !state.positions) return;
  const treeIds = ['demo-question', 'demo-answer', 'demo-physics', 'demo-math', 'demo-graph', 'demo-viz', 'demo-learn', 'demo-socratic', 'demo-hub', 'demo-human', 'demo-blank'];
  let maxX = -Infinity;
  treeIds.forEach(id => {
    const pos = state.positions[id];
    if (pos && typeof pos.x === 'number') maxX = Math.max(maxX, pos.x);
  });
  if (!Number.isFinite(maxX)) return;
  const materialX = maxX + 560;
  ['demo-source', 'demo-knowledge', 'demo-note'].forEach((id, index) => {
    state.positions[id] = { x: materialX, y: (index - 1) * 300 };
    if (typeof graphView !== 'undefined' && graphView.nodeById && graphView.nodeById[id]) {
      graphView.nodeById[id].x = materialX;
      graphView.nodeById[id].y = (index - 1) * 300;
    }
  });
  if (typeof window.saveGraphState === 'function') window.saveGraphState('', state);
  if (typeof _updateNodeTransforms === 'function') _updateNodeTransforms();
  if (typeof _redrawEdges === 'function') _redrawEdges();
}

function _fitDemoGraphForPanel(panelLeft) {
  if (typeof window.getGraphState !== 'function') return;
  const dialog = document.querySelector('.example-guide-dialog');
  if (!dialog) return;
  const state = window.getGraphState();
  if (!state || !state.pan) return;
  if (window.innerWidth <= 760) {
    _exampleGuideLastPanelSide = panelLeft;
    return;
  }
  const panelWidth = Math.max(280, dialog.getBoundingClientRect().width || 360);
  const shift = Math.min(170, panelWidth * 0.34);
  if (_exampleGuideLastPanelSide === null) {
    state.pan.x -= shift;
  } else if (panelLeft !== _exampleGuideLastPanelSide) {
    state.pan.x += (panelLeft ? 1 : -1) * shift * 2;
  }
  _exampleGuideLastPanelSide = panelLeft;
  if (typeof window.saveGraphState === 'function') window.saveGraphState('', state);
  if (typeof _applyGraphTransform === 'function') _applyGraphTransform();
}

function _renderExampleGuideStep() {
  const step = EXAMPLE_GUIDE_STEPS[_exampleGuideStep] || EXAMPLE_GUIDE_STEPS[0];
  const iconEl = document.getElementById('exampleGuideStepIcon');
  const titleEl = document.getElementById('exampleGuideStepTitle');
  const descEl = document.getElementById('exampleGuideStepDesc');
  const pointsEl = document.getElementById('exampleGuidePoints');
  const dotsEl = document.getElementById('exampleGuideDots');
  const prevBtn = document.getElementById('exampleGuidePrevBtn');
  const nextBtn = document.getElementById('exampleGuideNextBtn');
  if (iconEl) iconEl.innerHTML = step.icon || '';
  if (titleEl) titleEl.textContent = step.title;
  if (descEl) descEl.innerHTML = step.desc;
  if (pointsEl) pointsEl.innerHTML = (step.points || []).map(point => '<li>' + point + '</li>').join('');
  if (dotsEl) dotsEl.innerHTML = EXAMPLE_GUIDE_STEPS.map((item, index) =>
    '<button class="example-guide-dot' + (index === _exampleGuideStep ? ' active' : '') + '" onclick="jumpExampleGuideStep(' + index + ')" title="' + item.title + '"></button>'
  ).join('');
  if (prevBtn) prevBtn.disabled = _exampleGuideStep === 0;
  if (nextBtn) {
    const isLast = _exampleGuideStep === EXAMPLE_GUIDE_STEPS.length - 1;
    nextBtn.innerHTML = isLast ? '完成' : '下一步 <span class="example-guide-next-icon">→</span>';
  }
  const dialog = document.querySelector('.example-guide-dialog');
  const useLeftPanel = step.panelSide === 'left' || (_exampleGuideStep >= 5 && _exampleGuideStep <= 13);
  if (dialog) dialog.classList.toggle('example-guide-panel-left', useLeftPanel);
  _fitDemoGraphForPanel(useLeftPanel);
  _updateExampleGuideSpotlight(step);
}

function _updateExampleGuideSpotlight(step) {
  const spotlight = document.getElementById('exampleGuideSpotlight');
  if (!spotlight) return;
  const currentStep = step || EXAMPLE_GUIDE_STEPS[_exampleGuideStep] || EXAMPLE_GUIDE_STEPS[0];
  const rect = _exampleGuideSpotRect(currentStep);
  if (rect && rect.left >= -20 && rect.top >= -20 && rect.width > 10 && rect.height > 10) {
    spotlight.style.left = rect.left + 'px';
    spotlight.style.top = rect.top + 'px';
    spotlight.style.width = rect.width + 'px';
    spotlight.style.height = rect.height + 'px';
    spotlight.classList.add('show');
  } else {
    spotlight.classList.remove('show');
  }
}

function _startExampleGuideSpotlightLoop() {
  if (_exampleGuideSpotlightRaf) return;
  const tick = () => {
    const overlay = document.getElementById('exampleGuideOverlay');
    if (!overlay || !overlay.classList.contains('active')) {
      _exampleGuideSpotlightRaf = 0;
      return;
    }
    _updateExampleGuideSpotlight();
    _exampleGuideSpotlightRaf = requestAnimationFrame(tick);
  };
  _exampleGuideSpotlightRaf = requestAnimationFrame(tick);
}

function _stopExampleGuideSpotlightLoop() {
  if (_exampleGuideSpotlightRaf) {
    cancelAnimationFrame(_exampleGuideSpotlightRaf);
    _exampleGuideSpotlightRaf = 0;
  }
}

function _restoreExampleGraphBindings() {
  if (!_exampleGuideOriginal) return;
  const original = _exampleGuideOriginal;
  const restore = (name, value) => {
    try { window[name] = value; } catch (e) {}
  };
  restore('getGraphState', original.getGraphState);
  restore('saveGraphState', original.saveGraphState);
  restore('flushGraphStateServerSave', original.flushGraphStateServerSave);
  restore('getChatHistory', original.getChatHistory);
  restore('getStreamingAssistant', original.getStreamingAssistant);
  restore('getCurrentSessionId', original.getCurrentSessionId);
  restore('getActiveModelForRole', original.getActiveModelForRole);
  restore('proxyChatWithModel', original.proxyChatWithModel);
  restore('proxyChat', original.proxyChat);
  restore('runWorkflowNode', original.runWorkflowNode);
  restore('runWorkflowNodes', original.runWorkflowNodes);
  restore('runAllWorkflowNodes', original.runAllWorkflowNodes);
  restore('startQuestionWorkflow', original.startQuestionWorkflow);
  restore('generateBlankNode', original.generateBlankNode);
  restore('generateKnowledgeNode', original.generateKnowledgeNode);
  restore('generateRelationNode', original.generateRelationNode);
  restore('submitRegenerateNode', original.submitRegenerateNode);
  restore('generateVizNode', original.generateVizNode);
  restore('draftAskAi', original.draftAskAi);
  restore('toggleGraphPet', original.toggleGraphPet);
  restore('submitDraftQuestion', original.submitDraftQuestion);
  restore('draftSocraticAnswer', original.draftSocraticAnswer);
  restore('sendGraphNewSession', original.sendGraphNewSession);
  _exampleGuideOriginal = null;
  _exampleGuideDemoState = null;
  try { localStorage.removeItem('phymathia_graph_history___example_graph_demo__'); } catch (e) {}
}

function _enterExampleGraphDemo() {
  if (_exampleGuideOriginal) return;
  const state = _buildExampleGraphDemoState();
  const original = {
    getGraphState: window.getGraphState,
    saveGraphState: window.saveGraphState,
    flushGraphStateServerSave: window.flushGraphStateServerSave,
    getChatHistory: window.getChatHistory,
    getStreamingAssistant: window.getStreamingAssistant,
    getCurrentSessionId: window.getCurrentSessionId,
    getActiveModelForRole: window.getActiveModelForRole,
    proxyChatWithModel: window.proxyChatWithModel,
    proxyChat: window.proxyChat,
    runWorkflowNode: window.runWorkflowNode,
    runWorkflowNodes: window.runWorkflowNodes,
    runAllWorkflowNodes: window.runAllWorkflowNodes,
    startQuestionWorkflow: window.startQuestionWorkflow,
    generateBlankNode: window.generateBlankNode,
    generateKnowledgeNode: window.generateKnowledgeNode,
    generateRelationNode: window.generateRelationNode,
    submitRegenerateNode: window.submitRegenerateNode,
    generateVizNode: window.generateVizNode,
    draftAskAi: window.draftAskAi,
    toggleGraphPet: window.toggleGraphPet,
    submitDraftQuestion: window.submitDraftQuestion,
    draftSocraticAnswer: window.draftSocraticAnswer,
    sendGraphNewSession: window.sendGraphNewSession,
  };
  _exampleGuideOriginal = original;
  _exampleGuideDemoState = state;
  window.getGraphState = () => _exampleGuideDemoState;
  window.flushGraphStateServerSave = () => Promise.resolve();
  window.saveGraphState = (sid, nextState) => {
    if (nextState && typeof nextState === 'object') _exampleGuideDemoState = nextState;
  };
  window.getChatHistory = () => [];
  window.getStreamingAssistant = () => null;
  window.getCurrentSessionId = () => '__example_graph_demo__';
  window.getActiveModelForRole = () => null;
  window.proxyChatWithModel = () => Promise.reject(new Error('演示模式不调用模型'));
  window.proxyChat = () => Promise.resolve(null);
  const blockAi = () => {
    if (typeof showToast === 'function') showToast('演示模式：这里不会调用模型，退出示例后可在真实画布使用');
  };
  ['runWorkflowNode', 'runWorkflowNodes', 'runAllWorkflowNodes', 'startQuestionWorkflow', 'generateBlankNode', 'generateKnowledgeNode', 'generateRelationNode', 'submitRegenerateNode', 'generateVizNode', 'draftAskAi', 'toggleGraphPet', 'submitDraftQuestion', 'draftSocraticAnswer', 'sendGraphNewSession'].forEach(name => {
    try { window[name] = blockAi; } catch (e) {}
  });
  document.body.classList.add('example-graph-demo-active');
  if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
}

function _exitExampleGraphDemo() {
  document.body.classList.remove('example-graph-demo-active');
  if (typeof closeAddBlankNodeModal === 'function') closeAddBlankNodeModal();
  if (typeof closeModuleNodeModal === 'function') closeModuleNodeModal();
  if (typeof closeHumanNoteNodeModal === 'function') closeHumanNoteNodeModal();
  if (typeof closeGraphSearchPanel === 'function') closeGraphSearchPanel();
  _restoreExampleGraphBindings();
  if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
}

function openExampleGuide() {
  const overlay = document.getElementById('exampleGuideOverlay');
  if (!overlay) return;
  if (typeof isStreaming !== 'undefined' && isStreaming) {
    if (typeof showToast === 'function') showToast('请先等待当前回答完成，再打开示例讲解');
    return;
  }
  if (typeof workflowRunActive !== 'undefined' && workflowRunActive) {
    if (typeof showToast === 'function') showToast('请先停止或等待当前工作流结束，再打开示例讲解');
    return;
  }
  if (typeof closeSidebar === 'function') closeSidebar();
  const onboarding = document.getElementById('onboardingOverlay');
  if (onboarding && onboarding.classList.contains('active')) {
    _exampleGuideSuspendedOnboarding = true;
    onboarding.classList.remove('active');
  }
  _enterExampleGraphDemo();
  _exampleGuideStep = 0;
  overlay.classList.add('active');
  setTimeout(() => {
    // 直接使用项目自带的“自动整理”：按问题根节点、层级和端口顺序重新排布示例图。
    if (typeof autoArrangeGraph === 'function') autoArrangeGraph();
    // 自动整理后，再把“素材/总结”类节点收拢到主树右侧，避免分散节点把整张图拉得过宽。
    _compactDemoMaterialNodes();
    if (typeof fitGraph === 'function') fitGraph();
    _exampleGuideLastPanelSide = null;
    _renderExampleGuideStep();
    _startExampleGuideSpotlightLoop();
  }, 120);
}

function closeExampleGuide() {
  const overlay = document.getElementById('exampleGuideOverlay');
  overlay?.classList.remove('active');
  const spotlight = document.getElementById('exampleGuideSpotlight');
  spotlight?.classList.remove('show');
  _exampleGuideLastPanelSide = null;
  _stopExampleGuideSpotlightLoop();
  _exitExampleGraphDemo();
  if (_exampleGuideSuspendedOnboarding) {
    _exampleGuideSuspendedOnboarding = false;
    const onboarding = document.getElementById('onboardingOverlay');
    const exampleInviteIndex = _obSteps.findIndex(step => step.example);
    const atExampleInvite = exampleInviteIndex !== -1 && _obStep === exampleInviteIndex;
    if (onboarding && _obStep >= 0 && _obStep < _obSteps.length) {
      onboarding.classList.add('active');
      if (atExampleInvite) nextObStep();
      else _renderObStep();
    }
  }
}

function prevExampleGuideStep() {
  if (_exampleGuideStep <= 0) return;
  _exampleGuideStep--;
  _renderExampleGuideStep();
}

function nextExampleGuideStep() {
  if (_exampleGuideStep >= EXAMPLE_GUIDE_STEPS.length - 1) {
    closeExampleGuide();
    return;
  }
  _exampleGuideStep++;
  _renderExampleGuideStep();
}

function jumpExampleGuideStep(index) {
  _exampleGuideStep = Math.max(0, Math.min(EXAMPLE_GUIDE_STEPS.length - 1, Number(index) || 0));
  _renderExampleGuideStep();
}

function _renderObStep() {
  if (_obStep < 0 || _obStep >= _obSteps.length) { endOnboarding(); return; }
  const step = _obSteps[_obStep];
  const card = document.getElementById('onboardingCard');
  const spotlight = document.getElementById('onboardingSpotlight');
  const overlay = document.getElementById('onboardingOverlay');

  // For click-type steps, allow clicks to pass through overlay to reach target element
  if (step.type === 'click') {
    overlay.style.pointerEvents = 'none';
    // Keep card clickable
    card.style.pointerEvents = 'auto';
  } else {
    overlay.style.pointerEvents = '';
    card.style.pointerEvents = '';
  }

  // Hide card briefly for transition
  card.classList.remove('visible');

  setTimeout(() => {
    if (step.type === 'welcome') {
      spotlight.style.display = 'none';
      card.className = 'onboarding-card ob-welcome aurora-glass aurora-glass--dialog';
      const isLast = _obStep === _obSteps.length - 1;
      const primaryAction = step.example
        ? '<button class="ob-btn ob-btn-ghost" onclick="nextObStep()">稍后再说</button>'
          + '<button class="ob-btn ob-btn-next" onclick="openExampleGuide()">进入示例图 ' + UI_ICON_SVG.arrowRight + '</button>'
        : '<button class="ob-btn ' + (isLast ? 'ob-btn-finish' : 'ob-btn-next') + '" onclick="' + (isLast ? 'endOnboarding()' : 'nextObStep()') + '">' + (isLast ? '开始使用 ' + UI_ICON_SVG.sparkles : '开始了解 ' + UI_ICON_SVG.arrowRight) + '</button>';
      card.innerHTML = `
        <span class="ob-icon">${step.icon}</span>
        <div class="ob-title">${step.title}</div>
        ${step.desc ? `<div class="ob-desc">${step.desc}</div>` : ''}
        ${step.exampleQuestion ? `
          <div class="ob-example-box">
            <div class="ob-example-label">${UI_ICON_SVG.pencil} 示例问题</div>
            <div class="ob-example-question">${step.exampleQuestion}</div>
            <div class="ob-example-note">${step.exampleNote || ''}</div>
            ${step.exampleLink ? `<a class="ob-example-link" href="${step.exampleLink}" target="_blank" rel="noopener noreferrer">${UI_ICON_SVG.external} 打开内置演示页</a>` : ''}
          </div>` : ''}
        <div class="ob-features">
          ${(step.features || []).map(f => `
            <div class="ob-feature">
              <span class="ob-feature-icon">${f.icon}</span>
              <span class="ob-feature-text">${f.text}</span>
            </div>
          `).join('')}
        </div>
        <div class="onboarding-footer">
          <div class="onboarding-dots">
            ${_obSteps.map((_, i) => `<div class="onboarding-dot ${i === _obStep ? 'active' : ''}"></div>`).join('')}
          </div>
          <div class="onboarding-actions">
            <button class="ob-btn ob-btn-skip" onclick="endOnboarding()">跳过</button>
            ${primaryAction}
          </div>
        </div>
      `;
    } else {
      // Spotlight mode
      if (step.beforeShow) step.beforeShow();
      const needsDelay = !!step.beforeShow;
      const renderSpotlight = () => {
      const target = document.querySelector(step.target);
      if (target) {
        const rect = target.getBoundingClientRect();
        const pad = 8;
        spotlight.style.display = 'block';
        spotlight.style.pointerEvents = step.type === 'click' ? 'none' : 'auto';
        spotlight.style.left = (rect.left - pad) + 'px';
        spotlight.style.top = (rect.top - pad) + 'px';
        spotlight.style.width = (rect.width + pad * 2) + 'px';
        spotlight.style.height = (rect.height + pad * 2) + 'px';
      } else {
        spotlight.style.display = 'none';
      }

      card.className = 'onboarding-card aurora-glass aurora-glass--dialog';
      const isLast = _obStep === _obSteps.length - 1;

      // Position card near the target
      if (target) {
        const rect = target.getBoundingClientRect();
        const cardW = 380;
        const cardH = 220;
        // Try below the target first, then above
        let top = rect.bottom + 16;
        let left = rect.left + rect.width / 2 - cardW / 2;
        // Clamp to viewport
        left = Math.max(16, Math.min(left, window.innerWidth - cardW - 16));
        if (top + cardH > window.innerHeight - 16) {
          top = rect.top - cardH - 16;
        }
        if (top < 16) top = 16;
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }

      card.innerHTML = `
        <span class="ob-icon">${step.icon}</span>
        <div class="ob-title">${step.title}</div>
        <div class="ob-desc">${step.desc}</div>
        <div class="onboarding-footer">
          <div class="onboarding-dots">
            ${_obSteps.map((_, i) => `<div class="onboarding-dot ${i === _obStep ? 'active' : ''}"></div>`).join('')}
          </div>
          <div class="onboarding-actions">
            <button class="ob-btn ob-btn-skip" onclick="endOnboarding()">跳过</button>
            ${isLast
              ? '<button class="ob-btn ob-btn-finish" onclick="endOnboarding()">开始使用 ' + UI_ICON_SVG.sparkles + '</button>'
              : step.type === 'click'
                ? '<span class="ob-hint">' + UI_ICON_SVG.pointer + ' 点击高亮区域继续</span>'
                : '<button class="ob-btn ob-btn-next" onclick="nextObStep()">下一步 ' + UI_ICON_SVG.arrowRight + '</button>'
            }
          </div>
        </div>
      `;
      }; // end renderSpotlight

      // Bind click handler for type:'click' steps
      const bindClickHandler = () => {
        if (step.type === 'click' && step.onClick) {
          // Allow clicks to pass through overlay to the target element
          spotlight.style.pointerEvents = 'none';
          const targetEl = document.querySelector(step.target);
          if (targetEl) {
            const handler = (e) => {
              e.stopPropagation();
              targetEl.removeEventListener('click', handler);
              step.onClick();
              nextObStep();
            };
            targetEl.addEventListener('click', handler);
          }
        }
      };
      if (needsDelay) {
        setTimeout(() => { renderSpotlight(); if(step.afterShow) step.afterShow(); bindClickHandler(); requestAnimationFrame(() => { card.classList.add('visible'); }); }, 350);
      } else {
        renderSpotlight();
        if(step.afterShow) step.afterShow();
        bindClickHandler();
        // Animate card in
        requestAnimationFrame(() => {
          card.classList.add('visible');
        });
      }
      return;
    }

    // Animate card in
    requestAnimationFrame(() => {
      card.classList.add('visible');
    });
  }, 150);
}

function nextObStep() {
  _obStep++;
  _renderObStep();
}

function endOnboarding() {
  localStorage.setItem(ONBOARDING_KEY, '1');
  _obStep = -1;
  const overlay = document.getElementById('onboardingOverlay');
  const card = document.getElementById('onboardingCard');
  const spotlight = document.getElementById('onboardingSpotlight');
  card.classList.remove('visible');
  overlay.classList.remove('active');
  setTimeout(() => {
    spotlight.style.display = 'none';
    card.style.left = '';
    card.style.top = '';
  }, 400);
}

// Handle resize during onboarding
window.addEventListener('resize', () => {
  if (_obStep >= 0) _renderObStep();
  const exampleOverlay = document.getElementById('exampleGuideOverlay');
  if (exampleOverlay && exampleOverlay.classList.contains('active')) _renderExampleGuideStep();
  // Close floating panels on resize to avoid mispositioning
  document.getElementById('modelPanel')?.classList.remove('show');
  document.getElementById('dataPanel')?.classList.remove('show');
  document.getElementById('levelPanel')?.classList.remove('show');
});

// ESC 关闭可视化全屏
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const exampleGuide = document.getElementById('exampleGuideOverlay');
    if (exampleGuide && exampleGuide.classList.contains('active')) {
      closeExampleGuide();
      return;
    }
    const overlay = document.getElementById('vizFullscreenOverlay');
    if (overlay && overlay.classList.contains('active')) {
      closeVizFullscreen();
    }
  }
});

// ====== 页面加载 ======
window.addEventListener('load', async () => {
  await fetchModels();
  // 必须先初始化应用（加载 session、恢复聊天状态）
  await initApp();
  scrollToBottom();
  // 移动端提示
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const mobileHint = document.getElementById('mobileHint');
  if (isMobile && mobileHint) mobileHint.style.display = 'block';

  // 首次使用引导
  setTimeout(() => startOnboarding(), 600);

  // 消息内容中的链接委托处理（移动端友好）
  document.getElementById('chatMessages')?.addEventListener('click', function(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href) return;
    // .html 可视化链接：在新标签页打开
    if (href.endsWith('.html') || href.includes('.html?')) {
      e.preventDefault();
      e.stopPropagation();
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });
});

// ====== 深色/浅色模式 ======

// Preload all background images for instant theme switch
[DARK_LAND_URL, DARK_PORT_URL, LIGHT_LAND_URL, LIGHT_PORT_URL, '/logo.png'].forEach(src => {
  const img = new Image();
  img.src = src;
});

// 首次访问（localStorage 无值）跟随系统偏好，手动切换后以手动选择为准
function _getInitialTheme() {
  let t = null;
  try { t = localStorage.getItem(STORAGE_KEY_THEME); } catch (e) {}
  if (t === 'light' || t === 'dark') return t;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
}

let currentTheme = _getInitialTheme();

// 延迟更新 mermaid 配置的定时器
let _mermaidThemeTimer = null;

// 主题切换过渡抑制：styles.css 在 :root 上为 200+ 个 @property 注册变量挂了 0.35s 过渡，
// 翻转主题时每个插值帧都要全文档重算样式，节点多的画布会出现明显卡顿。
// 切换瞬间给 <html> 挂 theme-switching 全局禁用过渡（CSS 端对 .bg-layer 豁免，
// 背景图交叉淡入保留），450ms 后摘除，颜色即切即稳。
let _themeSwitchTimer = null;

function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  if (_themeSwitchTimer) clearTimeout(_themeSwitchTimer);
  _themeSwitchTimer = setTimeout(() => root.classList.remove('theme-switching'), 450);
  currentTheme = theme;
  root.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY_THEME, theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = theme === 'dark' ? UI_ICON_SVG.moon : UI_ICON_SVG.sun;
  updateBgImage();
  // 同步所有可视化 iframe 的主题（含全屏）
  if (typeof syncVizThemes === 'function') syncVizThemes(theme);
  // CSS 变量过渡驱动现有 Mermaid 图表颜色平滑变化
  // 等 CSS 过渡完成后再更新 Mermaid 配置，确保未来新图表使用正确主题
  if (typeof configureMermaid === 'function' && typeof getMermaidConfig === 'function') {
    if (_mermaidThemeTimer) clearTimeout(_mermaidThemeTimer);
    _mermaidThemeTimer = setTimeout(() => {
      configureMermaid(getMermaidConfig(theme === 'dark'));
    }, 400);
  }
}

function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// 双层背景交叉淡入：activeLayer(1或2)表示当前显示的层
let _activeBgLayer = 1;
let _bgInitialized = false;
function updateBgImage() {
  const isLandscape = window.innerWidth > window.innerHeight;
  const newUrl = currentTheme === 'dark'
    ? (isLandscape ? DARK_LAND_URL : DARK_PORT_URL)
    : (isLandscape ? LIGHT_LAND_URL : LIGHT_PORT_URL);

  // 首次加载：直接设置到bgLayer1，无需淡入淡出
  if (!_bgInitialized) {
    const el1 = document.getElementById('bgLayer1');
    if (el1) {
      el1.style.backgroundImage = `url('${newUrl}')`;
      el1.style.opacity = '1';
    }
    _bgInitialized = true;
    return;
  }

  // 预加载新背景图
  const img = new Image();
  img.onload = function() {
    const currentEl = document.getElementById('bgLayer' + _activeBgLayer);
    const nextLayer = _activeBgLayer === 1 ? 2 : 1;
    const nextEl = document.getElementById('bgLayer' + nextLayer);
    if (!currentEl || !nextEl) return;

    // 设置新背景到隐藏层
    nextEl.style.backgroundImage = `url('${newUrl}')`;
    // 淡入新层，淡出旧层
    nextEl.style.opacity = '1';
    currentEl.style.opacity = '0';
    _activeBgLayer = nextLayer;
  };
  img.src = newUrl;
}

// Apply saved theme on load
applyTheme(currentTheme);
let _resizeTimer;
function updateBgImageDebounced() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(updateBgImage, 200);
}
window.addEventListener('resize', updateBgImageDebounced);
window.addEventListener('orientationchange', () => setTimeout(updateBgImage, 300));

/* ====================================================
 * 鼠标特效系统
 * 点击溅射（桌面+移动端）
 * ==================================================== */
(function initMouseEffects() {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  let mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
  let lastMX = mouseX, lastMY = mouseY;

  // ── 点击溅射 ──
  const canvas = document.getElementById('particleCanvas');
  const ctx = canvas.getContext('2d');
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const particles = [];
  const MAX_PARTICLES = isMobile ? 80 : 150;

  class Particle {
    constructor(x, y, vx, vy, gravity = 0.02) {
      this.x = x; this.y = y;
      this.vx = vx; this.vy = vy;
      this.gravity = gravity;
      this.life = 1.0;
      this.decay = isMobile ? 0.015 + Math.random() * 0.018 : 0.010 + Math.random() * 0.012;
      this.size = isMobile ? 0.8 + Math.random() * 1.2 : 1.0 + Math.random() * 1.5;
      const dark = currentTheme !== 'light';
      if (dark) {
        const hue = 220 + Math.random() * 60;
        this.color = `hsla(${hue}, 80%, 75%,`;
      } else {
        const hue = 25 + Math.random() * 25;
        this.color = `hsla(${hue}, 65%, 60%,`;
      }
    }
    update() {
      this.vy += this.gravity;
      this.x += this.vx;
      this.y += this.vy;
      this.vx *= 0.985;
      this.life -= this.decay;
    }
    draw(ctx) {
      if (this.life <= 0) return;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
      ctx.fillStyle = this.color + (this.life * 0.6) + ')';
      ctx.fill();
    }
  }

  function animateParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = particles.length - 1; i >= 0; i--) {
      particles[i].update();
      particles[i].draw(ctx);
      if (particles[i].life <= 0) particles.splice(i, 1);
    }
    requestAnimationFrame(animateParticles);
  }
  animateParticles();

  // 点击/触摸爆发溅射
  const burstCount = isMobile ? 8 : 14;
  function burstAt(x, y) {
    for (let i = 0; i < burstCount; i++) {
      if (particles.length >= MAX_PARTICLES) {
        const oldest = particles.findIndex(p => p.life <= 0);
        if (oldest >= 0) particles.splice(oldest, 1);
        else particles.shift();
      }
      const angle = (Math.PI * 2 / burstCount) * i + (Math.random() - 0.5) * 0.5;
      const v = 0.5 + Math.random() * 1.5;
      particles.push(new Particle(
        x + (Math.random() - 0.5) * 4,
        y + (Math.random() - 0.5) * 4,
        Math.cos(angle) * v,
        Math.sin(angle) * v - 0.5,
        0.03
      ));
    }
  }
  document.addEventListener('click', (e) => burstAt(e.clientX, e.clientY));
  if (isMobile) {
    document.addEventListener('touchend', (e) => {
      if (e.changedTouches && e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        burstAt(t.clientX, t.clientY);
      }
    }, { passive: true });
  }

  // ── 鼠标移动统一监听（仅桌面） ──
  if (!isMobile) {
    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      lastMX = mouseX;
      lastMY = mouseY;
    });
  }
})();
