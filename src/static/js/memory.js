// ====== 用户画像（记忆）客户端封装 ======
// 后端 data/profiles/{device_id}.json；开关关闭时后端不注入不写入。
// 隐私：所有画像数据仅存本机 + 随请求发给模型服务商（与对话内容一致）。

const MEMORY_PANEL_KEY = 'phymathia_memory_panel_open';

// ---------- 基础读写 ----------
async function memoryGetProfile() {
  const res = await fetch('/api/profile?device_id=' + encodeURIComponent(getDeviceId()));
  if (!res.ok) throw new Error('profile get failed: ' + res.status);
  return res.json();
}

async function memorySaveProfile(updates) {
  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: getDeviceId(), updates: updates || {} })
  });
  if (!res.ok) throw new Error('profile save failed: ' + res.status);
  return res.json();
}

async function memoryClearProfile() {
  const res = await fetch('/api/profile?device_id=' + encodeURIComponent(getDeviceId()), { method: 'DELETE' });
  if (!res.ok) throw new Error('profile clear failed: ' + res.status);
  return res.json();
}

// 记忆开关（服务端为准；enabled 状态随 profile 持久化）
async function memorySetEnabled(enabled) {
  return memorySaveProfile({ enabled: !!enabled });
}

// ---------- 请求注入 ----------
// 给需要携带设备标识的请求 payload 追加 device_id
function memoryWithDevice(payload) {
  return Object.assign({}, payload || {}, { device_id: getDeviceId() });
}

// ---------- 影响面说明（透明性）----------
function memoryImpactAreas() {
  return [
    { key: 'chat', label: '对话回答风格', desc: '按画像调整详略、术语与可视化偏好' },
    { key: 'quiz', label: '知识检测出题', desc: '优先考察薄弱章节' },
    { key: 'extend', label: '延伸思考', desc: '进阶学习方向结合画像目标' }
  ];
}

// ---------- 同步画像缓存（供非 async 调用点使用，如 _modulePrompt）----------
let _cachedProfile = null;

async function memoryRefreshCache() {
  try {
    _cachedProfile = await memoryGetProfile();
  } catch (e) {
    _cachedProfile = null;
  }
}

function memoryCachedContext() {
  if (!_cachedProfile || !_cachedProfile.enabled) return '';
  const exp = _cachedProfile.explicit || {};
  const parts = [];
  if (String(exp.goal || '').trim()) parts.push('学习目标：' + exp.goal.trim());
  if (String(exp.interests || '').trim()) parts.push('兴趣方向：' + exp.interests.trim());
  if (String(exp.weakAreas || '').trim()) parts.push('薄弱章节：' + exp.weakAreas.trim());
  const facts = (_cachedProfile.facts || [])
    .filter(f => ['goal', 'interest', 'weakness'].includes(f.category) && String(f.fact || '').trim())
    .map(f => f.fact);
  if (facts.length) parts.push('已了解：' + facts.slice(0, 3).join('；'));
  return parts.join('；');
}

memoryRefreshCache();

// 全局暴露（与项目 window.* 惯例一致）
window.memoryGetProfile = memoryGetProfile;
window.memorySaveProfile = memorySaveProfile;
window.memoryClearProfile = memoryClearProfile;
window.memorySetEnabled = memorySetEnabled;
window.memoryWithDevice = memoryWithDevice;
window.memoryImpactAreas = memoryImpactAreas;
window.memoryRefreshCache = memoryRefreshCache;
window.memoryCachedContext = memoryCachedContext;

// ---------- 记忆面板 UI ----------
const MEMORY_CATEGORY_LABELS = { stage: '学段', goal: '目标', interest: '兴趣', weakness: '薄弱', style: '偏好', other: '其他' };
const MEMORY_STYLE_OPTIONS = {
  detail: [['简洁', '简洁'], ['标准', '标准'], ['详细', '详细']],
  jargon: [['通俗', '通俗'], ['标准', '标准'], ['专业', '专业']],
  visuals: [['否', '否'], ['公式', '公式'], ['公式+可视化', '公式+可视化']],
};

function openMemoryPanel() {
  const panel = document.getElementById('memoryPanel');
  const kp = document.getElementById('knowledgePanel');
  if (kp) kp.classList.remove('active');
  panel?.classList.add('active');
  memoryRenderPanel();
}

function closeMemoryPanel() {
  document.getElementById('memoryPanel')?.classList.remove('active');
}

async function memoryRenderPanel() {
  let profile;
  try { profile = await memoryGetProfile(); } catch (e) { profile = null; }
  const enabled = !!(profile && profile.enabled);
  const toggle = document.getElementById('memoryEnabledToggle');
  const banner = document.getElementById('memoryDisabledBanner');
  if (toggle) toggle.checked = enabled;
  if (banner) banner.hidden = enabled;

  // 影响面
  const impactEl = document.getElementById('memoryImpactList');
  if (impactEl) {
    impactEl.innerHTML = memoryImpactAreas().map(a =>
      '<span class="memory-impact-chip">' + a.label + ' — ' + a.desc + '</span>'
    ).join('');
  }

  // 我的画像表单
  const formEl = document.getElementById('memoryExplicitForm');
  if (formEl) {
    const exp = (profile && profile.explicit) || { style: { detail: '标准', jargon: '标准', visuals: '否' } };
    const style = exp.style || {};
    const field = (key, label, ph) =>
      '<div class="memory-form-field"><label>' + label + '</label>' +
      '<input type="text" value="' + escapeHtml(String(exp[key] || '')) + '" placeholder="' + ph + '" ' +
      'onchange="memorySaveExplicitField(\'' + key + '\', this.value)"></div>';
    const styleField = (key, label) =>
      '<div class="memory-form-field"><label>' + label + '</label><select onchange="memorySaveExplicitField(\'style\', this.value, \'' + key + '\')">' +
      (MEMORY_STYLE_OPTIONS[key] || []).map(([v, l]) =>
        '<option value="' + v + '"' + (String(style[key] || '') === v ? ' selected' : '') + '>' + l + '</option>'
      ).join('') + '</select></div>';
    formEl.innerHTML =
      field('stage', '学段 / 年级', '如：高二、大一、考研备考…') +
      field('goal', '学习目标', '如：高考物理 90 分、掌握电磁学…') +
      field('interests', '兴趣方向', '如：天体物理、微积分…') +
      field('weakAreas', '薄弱章节', '如：电磁感应、微分方程…') +
      '<div class="memory-form-style-row">' +
      styleField('detail', '详略') + styleField('jargon', '术语') + styleField('visuals', '可视化') +
      '</div>';
  }

  // 自动记忆
  const facts = (profile && profile.facts) || [];
  document.getElementById('memoryFactCount').textContent = facts.length ? '(' + facts.length + ')' : '';
  const factEl = document.getElementById('memoryFactList');
  if (factEl) {
    factEl.innerHTML = facts.length
      ? facts.map(f =>
          '<div class="memory-item"><span class="memory-item-tag">' + (MEMORY_CATEGORY_LABELS[f.category] || f.category || '其他') + '</span>' +
          '<span class="memory-item-fact">' + escapeHtml(String(f.fact || '')) + '</span>' +
          '<button class="memory-item-btn memory-item-btn-danger" onclick="memoryDeleteFact(\'' + String(f.id || '').replace(/'/g, '') + '\')">删除</button></div>'
        ).join('')
      : '<div class="memory-empty">暂无自动记忆。对话中重复提到的个人信息（学段、目标、薄弱点等）会出现在这里。</div>';
  }

  // 建议区
  const pending = (profile && profile.pending) || [];
  document.getElementById('memoryPendingCount').textContent = pending.length ? '(' + pending.length + ')' : '';
  const pendEl = document.getElementById('memoryPendingList');
  if (pendEl) {
    pendEl.innerHTML = pending.length
      ? pending.map(p =>
          '<div class="memory-item"><span class="memory-item-tag">候选</span>' +
          '<span class="memory-item-fact">' + escapeHtml(String(p.fact || '')) + '</span>' +
          '<button class="memory-item-btn" onclick="memoryConfirmPending(\'' + String(p.id || '').replace(/'/g, '') + '\')">确认</button>' +
          '<button class="memory-item-btn memory-item-btn-danger" onclick="memoryDeletePending(\'' + String(p.id || '').replace(/'/g, '') + '\')">忽略</button></div>'
        ).join('')
      : '<div class="memory-empty">这里会出现对话中只提到过一次的信息，出现两次后自动生效。</div>';
  }
}

async function memoryToggleChanged(checked) {
  try {
    await memorySetEnabled(checked);
    await memoryRefreshCache();
    const banner = document.getElementById('memoryDisabledBanner');
    if (banner) banner.hidden = checked;
  } catch (e) {
    console.warn('Memory toggle failed:', e);
  }
}

async function memorySaveExplicitField(key, value, styleKey) {
  const updates = { explicit: {} };
  if (styleKey) {
    updates.explicit.style = {};
    updates.explicit.style[styleKey] = value;
  } else {
    updates.explicit[key] = value;
  }
  try {
    await memorySaveProfile(updates);
    await memoryRefreshCache();
  } catch (e) {
    console.warn('Memory save failed:', e);
  }
}

async function _memoryMutateFacts(fn) {
  try {
    const profile = await memoryGetProfile();
    const next = fn(profile);
    await memorySaveProfile(next);
    await memoryRefreshCache();
    memoryRenderPanel();
  } catch (e) {
    console.warn('Memory mutate failed:', e);
  }
}

async function memoryDeleteFact(id) {
  await _memoryMutateFacts(p => { p.facts = (p.facts || []).filter(f => f.id !== id); return p; });
}

async function memoryConfirmPending(id) {
  await _memoryMutateFacts(p => {
    const item = (p.pending || []).find(x => x.id === id);
    if (item) {
      p.pending = p.pending.filter(x => x.id !== id);
      p.facts = p.facts || [];
      if (!p.facts.some(f => String(f.fact || '') === String(item.fact || ''))) {
        item.occurrences = 2;
        p.facts.push(item);
      }
    }
    return p;
  });
}

async function memoryDeletePending(id) {
  await _memoryMutateFacts(p => { p.pending = (p.pending || []).filter(x => x.id !== id); return p; });
}

// ---------- 清除记忆 ----------
function memoryOpenClearDialog() {
  document.getElementById('memoryClearIncludeLearning').checked = false;
  document.getElementById('memoryClearDialog').classList.add('show');
}

function closeMemoryClearDialog() {
  document.getElementById('memoryClearDialog').classList.remove('show');
}

async function memoryConfirmClear() {
  const includeLearning = document.getElementById('memoryClearIncludeLearning').checked;
  closeMemoryClearDialog();
  // 1. 自动备份（复用现有导出链路，产出与导入对称）。
  // 必须 await：否则下载尚未完成就执行后面的 DELETE，备份与服务端清空竞态；
  // 且 async rejection 不会被同步调用处的 try/catch 捕获
  try {
    if (typeof exportData === 'function') await exportData();
  } catch (e) { console.warn('Backup before clear failed:', e); }
  // 2. 清除画像
  try { await memoryClearProfile(); } catch (e) { console.warn('Profile clear failed:', e); }
  // 3. 可选：清除学习数据（知识/公式/错题统计）
  if (includeLearning) {
    try {
      await fetch('/api/sessions', { method: 'DELETE' });
      const keys = ['phymathia_knowledge', 'phymathia_formulas', 'phymathia_quiz_stats', 'phymathia_quiz_bank', 'phymathia_quiz_source'];
      keys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
    } catch (e) { console.warn('Learning data clear failed:', e); }
  }
  await memoryRefreshCache();
  memoryRenderPanel();
  const tip = '记忆已清除' + (includeLearning ? '，学习数据已一并清除' : '') + '。备份文件已生成，可从「数据管理-导入数据」恢复。';
  const toast = document.getElementById('modelToast');
  if (toast) { toast.textContent = tip; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 4000); }
}

window.openMemoryPanel = openMemoryPanel;
window.closeMemoryPanel = closeMemoryPanel;
window.memoryRenderPanel = memoryRenderPanel;
window.memoryToggleChanged = memoryToggleChanged;
window.memorySaveExplicitField = memorySaveExplicitField;
window.memoryDeleteFact = memoryDeleteFact;
window.memoryConfirmPending = memoryConfirmPending;
window.memoryDeletePending = memoryDeletePending;
window.memoryOpenClearDialog = memoryOpenClearDialog;
window.closeMemoryClearDialog = closeMemoryClearDialog;
window.memoryConfirmClear = memoryConfirmClear;

