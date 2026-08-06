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
  const panelH = panel.offsetHeight;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  // 水平：优先按钮左对齐，如果超出右边则右对齐
  let left = rect.left;
  if (left + panelW > viewW - 8) {
    left = viewW - panelW - 8;
  }
  if (left < 8) left = 8;
  // 垂直：按钮下方，如果超出底部则按钮上方
  let top = rect.bottom + 6;
  if (top + panelH > viewH - 8) {
    top = rect.top - panelH - 6;
  }
  if (top < 8) top = 8;
  panel.style.left = left + 'px';
  panel.style.right = 'auto';
  panel.style.top = top + 'px';
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
    el.innerHTML = `当前存储：${sessionCount} 个会话 · ${msgCount} 条消息 · ${knowledgeCount} 条知识点 · ${formulaCount} 条公式 · ${graphCount} 个探索网 · ${quizCount} 个检测主题`;
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

async function exportData() {
  const local = _collectLocalBackup();
  let data = { ...local, version: 2, exportTime: new Date().toISOString() };
  try {
    const resp = await fetch('/api/backup/export', { cache: 'no-cache' });
    if (resp.ok) {
      const server = await resp.json();
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
        kv,
        graphs: _mergeMaps(serverGraphs, local.graphs),
        quizStats: _mergeMaps(kv['phymathia_quiz_stats'] || {}, local.quizStats),
        userModels: local.userModels,
        activeModels: local.activeModels,
        currentSession: local.currentSession,
        level: local.level,
        theme: local.theme,
        onboarding: local.onboarding
      };
    }
  } catch (e) {
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
  if (Array.isArray(data.userModels)) localStorage.setItem('phymathia_user_models', JSON.stringify(data.userModels));
  if (data.activeModels && typeof data.activeModels === 'object') localStorage.setItem('phymathia_active_models', JSON.stringify(data.activeModels));
  const quizStats = data.quizStats && typeof data.quizStats === 'object'
    ? data.quizStats
    : (data.kv && data.kv['phymathia_quiz_stats']) || {};
  if (quizStats && typeof quizStats === 'object') localStorage.setItem('phymathia_quiz_stats', JSON.stringify(quizStats));
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
    for (const [key, value] of Object.entries(data.kv || {})) {
      if (key.startsWith('graph:') || key === 'phymathia_quiz_stats') continue;
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
      if (!data.sessions && !data.messages && !data.knowledge && !data.formulas && !data.kv && !data.quizStats) {
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

// ====== 相对时间 ======
function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + '分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + '小时前';
  const day = Math.floor(hr / 24);
  if (day < 7) return day + '天前';
  return formatTime(ts);
}

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
    toast.style.cssText = 'position:fixed;bottom:120px;left:50%;transform:translateX(-50%) translateY(10px);background:var(--card-bg);color:var(--text-primary);border:1px solid var(--border-color);border-radius:10px;padding:10px 20px;font-size:13px;z-index:9999;opacity:0;transition:opacity 0.3s,transform 0.3s;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.15);white-space:nowrap;';
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
const _obSteps = [
  {
    type: 'welcome',
    icon: '<img src="/logo.png" style="width:48px;height:48px;border-radius:12px;" />',
    title: '欢迎来到 PhyMathia',
    features: [
      { icon: UI_ICON_SVG.formula, text: '<strong>双域解释</strong> — 每个问题同时从物理直觉和数学本质给出答案' },
      { icon: UI_ICON_SVG.monitor, text: '<strong>交互可视化</strong> — 生成可动手操作的 HTML 可视化页面' },
      { icon: UI_ICON_SVG.formula, text: '<strong>网络图探索</strong> — 新会话从中心节点开始，答案与模块向外铺展' },
      { icon: UI_ICON_SVG.book, text: '<strong>知识积累</strong> — 自动提取知识点，构建你的专属知识库' },
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
        : '在探索网中点击气泡上的<strong>追问</strong>、<strong>没看懂</strong>或<strong>删除</strong>，管理当前对话分支。';
    }
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.header-secondary-bar' : '.header-actions'; },
    icon: UI_ICON_SVG.sliders,
    title: '个性化设置',
    get desc() {
      return _isMobile()
        ? '顶栏可切换<strong>深色/浅色主题</strong>和<strong>难度等级</strong>；这里可设置<strong>AI 模型</strong>、打开<strong>知识总览</strong>、管理数据和清空对话。'
        : '在这里切换<strong>深色/浅色主题</strong>、选择<strong>AI 模型</strong>和<strong>难度等级</strong>（中学 / 大学 / 科研），点击书本图标打开<strong>知识总览</strong>面板，查看 AI 自动提取的知识点和你收藏的内容。';
    }
  },
  {
    type: 'click',
    target: '.menu-btn',
    icon: UI_ICON_SVG.book,
    title: '试试点击菜单按钮',
    desc: '点击左上角的菜单按钮，打开侧边栏管理<strong>多个对话</strong>，随时切换不同话题。',
    onClick() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.sidebar-sessions' : '.session-item'; },
    icon: UI_ICON_SVG.pencil,
    title: '个性化对话',
    get desc() {
      return '点击对话图标可以<strong>切换力学、电磁、光学等图标</strong>，点击重命名按钮可以<strong>重命名对话</strong>，让你的对话列表更清晰有序。';
    },
    beforeShow() { document.getElementById('sidebar').classList.add('open'); }
  }
];

function startOnboarding(force) {
  if (!force && localStorage.getItem(ONBOARDING_KEY)) return;
  _obStep = 0;
  const overlay = document.getElementById('onboardingOverlay');
  overlay.classList.add('active');
  _renderObStep();
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
      card.className = 'onboarding-card ob-welcome';
      card.innerHTML = `
        <span class="ob-icon">${step.icon}</span>
        <div class="ob-title">${step.title}</div>
        <div class="ob-features">
          ${step.features.map(f => `
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
            <button class="ob-btn ob-btn-next" onclick="nextObStep()">开始了解 ${UI_ICON_SVG.arrowRight}</button>
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

      card.className = 'onboarding-card';
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
  // Close floating panels on resize to avoid mispositioning
  document.getElementById('modelPanel')?.classList.remove('show');
  document.getElementById('dataPanel')?.classList.remove('show');
  document.getElementById('levelPanel')?.classList.remove('show');
});

// ESC 关闭可视化全屏
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
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
  document.getElementById('chatMessages').addEventListener('click', function(e) {
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

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY_THEME, theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = theme === 'dark' ? UI_ICON_SVG.moon : UI_ICON_SVG.sun;
  updateBgImage();
  // 同步所有可视化 iframe 的主题（含全屏）
  if (typeof syncVizThemes === 'function') syncVizThemes(theme);
  // CSS 变量过渡驱动现有 Mermaid 图表颜色平滑变化
  // 等 CSS 过渡完成后再更新 mermaid.initialize 配置，确保未来新图表使用正确主题
  if (typeof mermaid !== 'undefined') {
    if (_mermaidThemeTimer) clearTimeout(_mermaidThemeTimer);
    _mermaidThemeTimer = setTimeout(() => {
      const isDark = theme === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'strict',
        themeVariables: isDark ? {
          primaryColor: '#0c2d3e', primaryTextColor: '#a5f3fc',
          primaryBorderColor: '#0891b2', lineColor: '#22d3ee',
          secondaryColor: '#0f3649', tertiaryColor: '#0a2533',
          mainBkg: '#0c2d3e', nodeBorder: '#0891b2',
          clusterBkg: '#0a2533', clusterBorder: '#0891b2',
          titleColor: '#a5f3fc', edgeLabelBackground: '#0c2d3e',
          fontFamily: 'inherit'
        } : {
          primaryColor: '#f0fdfa', primaryTextColor: '#134e4a',
          primaryBorderColor: '#0891b2', lineColor: '#0891b2',
          secondaryColor: '#f0fdfa', tertiaryColor: '#ecfdf5',
          mainBkg: '#f0fdfa', nodeBorder: '#0891b2',
          clusterBkg: '#ecfdf5', clusterBorder: '#0891b2',
          titleColor: '#134e4a', edgeLabelBackground: '#f0fdfa',
          fontFamily: 'inherit'
        }
      });
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
