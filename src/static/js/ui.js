// ====== 难度等级管理 ======
let currentLevel = localStorage.getItem(STORAGE_KEY_LEVEL) || 'university';

function updateLevelUI() {
  document.getElementById('levelBtn').textContent = LEVEL_LABELS[currentLevel];
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
function toggleLevelPanel() { document.getElementById('levelPanel').classList.toggle('show'); }
document.addEventListener('click', (e) => {
  const panel = document.getElementById('levelPanel');
  const btn = document.getElementById('levelBtn');
  if (panel && !panel.contains(e.target) && !btn.contains(e.target)) panel.classList.remove('show');
});
updateLevelUI();

// ====== 模型设置管理 ======
let availableModels = [];
let currentModels = { agent_model: '', html_model: '' };

async function fetchModels() {
  try {
    const resp = await fetch('/api/models', { cache: 'no-cache' });
    if (!resp.ok) return;
    const data = await resp.json();
    availableModels = data.available_models || [];
    currentModels = data.current || {};
    renderModelSelects();
  } catch(e) {
    console.warn('Failed to fetch models:', e);
  }
}

function renderModelSelects() {
  const agentSelect = document.getElementById('agentModelSelect');
  const htmlSelect = document.getElementById('htmlModelSelect');

  // Build options
  const optionsHtml = availableModels.map(m =>
    `<option value="${m.id}" ${m.id === currentModels.agent_model || m.id === currentModels.html_model ? '' : ''}>${m.name} — ${m.desc}</option>`
  ).join('');

  agentSelect.innerHTML = availableModels.map(m =>
    `<option value="${m.id}">${m.name} — ${m.desc}</option>`
  ).join('');
  htmlSelect.innerHTML = availableModels.map(m =>
    `<option value="${m.id}">${m.name} — ${m.desc}</option>`
  ).join('');

  // Set current values
  agentSelect.value = currentModels.agent_model || availableModels[0]?.id || '';
  htmlSelect.value = currentModels.html_model || availableModels[0]?.id || '';

  updateModelMeta('agent');
  updateModelMeta('html');
}

function updateModelMeta(type) {
  const select = document.getElementById(type === 'agent' ? 'agentModelSelect' : 'htmlModelSelect');
  const descEl = document.getElementById(type === 'agent' ? 'agentModelDesc' : 'htmlModelDesc');
  const tagsEl = document.getElementById(type === 'agent' ? 'agentModelTags' : 'htmlModelTags');
  const model = availableModels.find(m => m.id === select.value);
  if (model) {
    descEl.textContent = model.desc || '';
    tagsEl.innerHTML = (model.tags || []).map(t => `<span class="model-tag">${t}</span>`).join('');
  } else {
    descEl.textContent = '';
    tagsEl.innerHTML = '';
  }
}

async function onModelChange(type) {
  const select = document.getElementById(type === 'agent' ? 'agentModelSelect' : 'htmlModelSelect');
  updateModelMeta(type);

  const payload = {};
  if (type === 'agent') payload.agent_model = select.value;
  else payload.html_model = select.value;

  try {
    const resp = await fetch('/api/models/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-cache'
    });
    if (!resp.ok) {
      let detail = '未知错误';
      try { const err = await resp.json(); detail = err.detail || detail; } catch(_){}
      showModelToast('切换失败: ' + detail, true);
      fetchModels(); // Revert
      return;
    }
    const data = await resp.json();
    currentModels = data.current || {};
    const model = availableModels.find(m => m.id === select.value);
    const label = type === 'agent' ? 'Agent 推理' : 'HTML 生成';
    showModelToast(`${label}模型已切换为 ${model ? model.name : select.value}`);
  } catch(e) {
    console.error('[Model] Switch failed:', e);
    showModelToast('切换失败: ' + (e.message || '网络错误'), true);
    fetchModels();
  }
}

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
  const panel = document.getElementById('modelPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  // Close other panels
  document.getElementById('levelPanel').classList.remove('show');
  document.getElementById('dataPanel').classList.remove('show');
  if (willShow) {
    const trigger = e && e.currentTarget ? e.currentTarget : document.getElementById('modelBtn');
    // Force reflow so offsetWidth/offsetHeight are available
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
  const sessionCount = Object.keys(sessions).length;
  let msgCount = 0;
  Object.keys(sessions).forEach(sid => {
    const msgs = JSON.parse(localStorage.getItem('phymathia_msgs_' + sid) || '[]');
    msgCount += msgs.length;
  });
  const knowledgeCount = Object.keys(knowledge).length;
  const el = document.getElementById('dataStats');
  if (el) {
    el.innerHTML = `当前存储：${sessionCount} 个会话 · ${msgCount} 条消息 · ${knowledgeCount} 条知识点`;
  }
  updateStorageDebug();
}

function exportData() {
  const data = {};
  // Export sessions
  data.sessions = JSON.parse(localStorage.getItem('phymathia_sessions') || '{}');
  // Export messages for each session
  data.messages = {};
  Object.keys(data.sessions).forEach(sid => {
    data.messages[sid] = JSON.parse(localStorage.getItem('phymathia_msgs_' + sid) || '[]');
  });
  // Export knowledge
  data.knowledge = JSON.parse(localStorage.getItem('phymathia_knowledge') || '{}');
  // Export settings
  data.currentSession = localStorage.getItem('phymathia_current_session') || '';
  data.level = localStorage.getItem('phymathia_level') || 'university';
  data.theme = localStorage.getItem('phymathia_theme') || 'dark';
  // Version for forward compatibility
  data.version = 1;
  data.exportTime = new Date().toISOString();

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'phymathia_backup_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
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

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const data = JSON.parse(e.target.result);
      // Validate format
      if (!data.sessions && !data.messages && !data.knowledge) {
        alert('导入失败：文件格式不正确，缺少有效数据');
        return;
      }
      // Import sessions (merge with existing)
      if (data.sessions) {
        const existing = JSON.parse(localStorage.getItem('phymathia_sessions') || '{}');
        Object.assign(existing, data.sessions);
        localStorage.setItem('phymathia_sessions', JSON.stringify(existing));
      }
      // Import messages (merge, skip duplicates by timestamp)
      if (data.messages) {
        Object.entries(data.messages).forEach(([sid, msgs]) => {
          if (!Array.isArray(msgs)) return;
          const key = 'phymathia_msgs_' + sid;
          const existing = JSON.parse(localStorage.getItem(key) || '[]');
          // Deduplicate by timestamp (field is 'timestamp', not 'time')
          const existingTimes = new Set(existing.map(m => m.timestamp));
          msgs.forEach(m => { if (!existingTimes.has(m.timestamp)) existing.push(m); });
          localStorage.setItem(key, JSON.stringify(existing));
        });
      }
      // Import knowledge
      if (data.knowledge) {
        const existing = JSON.parse(localStorage.getItem('phymathia_knowledge') || '{}');
        Object.assign(existing, data.knowledge);
        localStorage.setItem('phymathia_knowledge', JSON.stringify(existing));
      }
      // Import settings
      if (data.currentSession) localStorage.setItem('phymathia_current_session', data.currentSession);
      if (data.level) localStorage.setItem('phymathia_level', data.level);
      if (data.theme) localStorage.setItem('phymathia_theme', data.theme);

      // Sync all imported data to server
      await _flushToServer();
      // Also sync individual session messages
      if (data.sessions) {
        for (const sid of Object.keys(data.sessions)) {
          const msgs = JSON.parse(localStorage.getItem('phymathia_msgs_' + sid) || '[]');
          await saveSessionMessages(sid, msgs);
        }
      }

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

// Init: fetch models on load
fetchModels();

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

// ====== 进度指示器 ======
let progressTimer = null;
let waitingTipTimer = null;
let progressStartTime = 0;
let lastChunkTime = 0;
let currentStage = '';

function showProgress(stage) {
  currentStage = stage;
  const bar = document.getElementById('progressBar');
  const statusEl = document.getElementById('progressStatus');
  if (bar) bar.classList.add('active');
  if (statusEl) { statusEl.classList.add('active'); updateProgressText(stage); }
  if (!progressTimer) {
    progressStartTime = Date.now();
    lastChunkTime = Date.now();
    progressTimer = setInterval(() => {
      updateElapsedTime();
      if (Date.now() - lastChunkTime > 5000 && currentStage !== 'waiting') {
        updateProgressText('waiting');
        currentStage = 'waiting';
        waitingTipTimer = setInterval(() => updateProgressText('waiting'), 8000);
      }
    }, 500);
  }
}
function updateProgressText(stage) {
  const textEl = document.querySelector('#progressStatus .status-text');
  if (!textEl) return;
  const msgs = { 'thinking':'PhyMathia 正在深度思考，可能需要一点时间...', 'tool':'正在调用工具进行计算和可视化生成，请耐心等待...', 'generating':'正在精心组织回复...', 'waiting':'', 'done':'回复完成' };
  if (stage === 'waiting') {
    waitingTipIndex = (waitingTipIndex + 1) % waitingTips.length;
    textEl.textContent = waitingTips[waitingTipIndex];
  } else {
    textEl.textContent = msgs[stage] || msgs['thinking'];
  }
}
var waitingTipIndex = -1;
function updateElapsedTime() {
  const timeEl = document.querySelector('#progressStatus .elapsed-time');
  if (!timeEl) return;
  const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  timeEl.textContent = min > 0 ? `${min}m${sec.toString().padStart(2,'0')}s` : `${sec}s`;
}
function hideProgress() {
  const bar = document.getElementById('progressBar');
  const statusEl = document.getElementById('progressStatus');
  if (bar) bar.classList.remove('active');
  if (statusEl && statusEl.classList.contains('active')) {
    updateProgressText('done');
    setTimeout(() => { statusEl.classList.remove('active'); }, 1500);
  }
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  if (waitingTipTimer) { clearInterval(waitingTipTimer); waitingTipTimer = null; }
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}
function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}
document.getElementById('userInput').addEventListener('input', function() { autoResize(this); });

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return min + 'm' + (remSec < 10 ? '0' : '') + remSec + 's';
}

function sendQuick(text) {
  document.getElementById('userInput').value = text;
  autoResize(document.getElementById('userInput'));
  sendMessage();
}

// URL 参数自动提问
(function() {
  const params = new URLSearchParams(window.location.search);
  const question = params.get('question');
  if (question) {
    window.history.replaceState({}, '', window.location.pathname);
    setTimeout(() => sendQuick(decodeURIComponent(question)), 500);
  }
})();

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

// ====== 语音输入（长按模式）======
let recognition = null;
let isRecording = false;
let voiceCancelled = false;     // 上滑取消标记
let voiceStartY = 0;           // 按下时 Y 坐标
let voiceCancelZone = null;     // 取消提示区域

// 创建取消提示区域
(function initVoiceCancelZone() {
  voiceCancelZone = document.createElement('div');
  voiceCancelZone.className = 'voice-cancel-zone';
  voiceCancelZone.innerHTML = '<span>↑ 上滑取消录音</span>';
  document.body.appendChild(voiceCancelZone);
})();

// 长按开始
function voicePressStart(e) {
  e.preventDefault();
  if (isRecording) return;
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    // 不支持语音时 fallback 为点击提示
    showToast('您的浏览器不支持语音输入，请使用 Chrome 浏览器');
    return;
  }
  voiceCancelled = false;
  voiceStartY = e.touches ? e.touches[0].clientY : e.clientY;
  startVoice();
}

// 长按中移动（检测上滑取消）
function voicePressMove(e) {
  if (!isRecording) return;
  const currentY = e.touches ? e.touches[0].clientY : e.clientY;
  const deltaY = voiceStartY - currentY;
  if (deltaY > VOICE_CANCEL_THRESHOLD) {
    if (!voiceCancelled) {
      voiceCancelled = true;
      voiceCancelZone.classList.add('active', 'cancelled');
      voiceCancelZone.querySelector('span').textContent = '✕ 松开取消录音';
      document.getElementById('voiceBtn').style.opacity = '0.4';
    }
  } else {
    if (voiceCancelled) {
      voiceCancelled = false;
      voiceCancelZone.classList.remove('cancelled');
      voiceCancelZone.querySelector('span').textContent = '↑ 上滑取消录音';
      document.getElementById('voiceBtn').style.opacity = '1';
    }
    if (deltaY > 20) {
      voiceCancelZone.classList.add('active');
    } else {
      voiceCancelZone.classList.remove('active');
    }
  }
}

// 长按结束
function voicePressEnd(e) {
  if (!isRecording) return;
  stopVoice();
  voiceCancelZone.classList.remove('active', 'cancelled');
  document.getElementById('voiceBtn').style.opacity = '1';

  if (voiceCancelled) {
    // 上滑取消：清空输入，不发送
    document.getElementById('userInput').value = '';
    autoResize(document.getElementById('userInput'));
    voiceCancelled = false;
    return;
  }

  // 正常松开：自动发送
  if (document.getElementById('userInput').value.trim()) {
    setTimeout(() => sendMessage(), 300);
  }
}

// 绑定事件
(function bindVoiceEvents() {
  const btn = document.getElementById('voiceBtn');
  // 鼠标事件（桌面端）
  btn.addEventListener('mousedown', voicePressStart);
  btn.addEventListener('mousemove', voicePressMove);
  document.addEventListener('mouseup', voicePressEnd);
  // 触摸事件（移动端）
  btn.addEventListener('touchstart', voicePressStart, { passive: false });
  btn.addEventListener('touchmove', voicePressMove, { passive: false });
  document.addEventListener('touchend', voicePressEnd);
  // 防止长按菜单
  btn.addEventListener('contextmenu', e => e.preventDefault());
})();

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onstart = () => { isRecording = true; document.getElementById('voiceBtn').classList.add('recording'); };
  recognition.onresult = (event) => {
    let t = '';
    for (let i = event.resultIndex; i < event.results.length; i++) t += event.results[i][0].transcript;
    document.getElementById('userInput').value = t;
    autoResize(document.getElementById('userInput'));
  };
  recognition.onend = () => { isRecording = false; document.getElementById('voiceBtn').classList.remove('recording'); if (recognition) { recognition = null; } };
  recognition.onerror = (event) => { isRecording = false; document.getElementById('voiceBtn').classList.remove('recording'); if (event.error === 'not-allowed') showToast('请允许麦克风权限'); };
  recognition.start();
}
function stopVoice() {
  isRecording = false;
  document.getElementById('voiceBtn').classList.remove('recording');
  if (recognition) { recognition.stop(); recognition = null; }
}

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
      { icon: '🔬', text: '<strong>双域解释</strong> — 每个问题同时从物理直觉和数学本质给出答案' },
      { icon: '🎨', text: '<strong>交互可视化</strong> — 生成可动手操作的 HTML 可视化页面' },
      { icon: '📐', text: '<strong>公式渲染</strong> — LaTeX 公式实时渲染，支持知识图谱' },
      { icon: '🧠', text: '<strong>知识积累</strong> — 自动提取知识点，构建你的专属知识库' },
    ]
  },
  {
    type: 'spotlight',
    target: '#userInput',
    icon: '✍️',
    title: '输入你的问题',
    desc: '在输入框中输入任何<strong>物理或数学</strong>问题，也可以点击快捷按钮直接开始。支持<strong>长按语音输入</strong>和<strong>Enter 发送</strong>。'
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.header-secondary-bar' : '.header-actions'; },
    icon: '⚙️',
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
    icon: '👆',
    title: '试试点击菜单按钮',
    desc: '点击左上角的菜单按钮，打开侧边栏管理<strong>多个对话</strong>，随时切换不同话题。',
    onClick() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.sidebar-sessions' : '.session-item'; },
    icon: '✏️',
    title: '个性化对话',
    get desc() {
      return '点击对话图标可以<strong>切换图标</strong>（📐⚛️🧲等），点击 ✏️ 按钮可以<strong>重命名对话</strong>，让你的对话列表更清晰有序。';
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
            <button class="ob-btn ob-btn-next" onclick="nextObStep()">开始了解 →</button>
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
              ? '<button class="ob-btn ob-btn-finish" onclick="endOnboarding()">开始使用 ✨</button>'
              : step.type === 'click'
                ? '<span class="ob-hint" style="color:var(--text-secondary);font-size:12px;">👆 点击高亮区域继续</span>'
                : '<button class="ob-btn ob-btn-next" onclick="nextObStep()">下一步 →</button>'
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
window.addEventListener('load', () => {
  renderCurrentChat();
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

let currentTheme = localStorage.getItem(STORAGE_KEY_THEME) || 'dark';

// 延迟更新 mermaid 配置的定时器
let _mermaidThemeTimer = null;

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY_THEME, theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
  updateBgImage();
  // CSS 变量过渡驱动现有 Mermaid 图表颜色平滑变化
  // 等 CSS 过渡完成后再更新 mermaid.initialize 配置，确保未来新图表使用正确主题
  if (typeof mermaid !== 'undefined') {
    if (_mermaidThemeTimer) clearTimeout(_mermaidThemeTimer);
    _mermaidThemeTimer = setTimeout(() => {
      const isDark = theme === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'loose',
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
