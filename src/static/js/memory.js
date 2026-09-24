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

// ---------- 候选提交与固化提醒 ----------
// 确定性信号（检测错题/苏格拉底答错/高频提问）走这个入口，与对话采集同一套合并语义。
// ok 仅代表 HTTP/JSON 成功；防重必须使用 accepted + 原请求位置 acceptedIndices。
async function memoryPostCandidates(candidates, source) {
  const rejected = (status, ok = false) => ({ changed: 0, promoted: [], ok, accepted: false, acceptedIndices: [], status });
  if (!Array.isArray(candidates) || !candidates.length) return rejected('invalid');
  try {
    const res = await fetch('/api/profile/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: getDeviceId(), candidates: candidates, source: source || 'signal' })
    });
    if (!res.ok) return rejected('http-failure');
    const data = await res.json();
    const indices = data && data.acceptedIndices;
    if (!data || typeof data.accepted !== 'boolean' || !Array.isArray(indices)
      || indices.some(i => !Number.isInteger(i) || i < 0 || i >= candidates.length)
      || new Set(indices).size !== indices.length
      || data.accepted !== (indices.length > 0)) return rejected('invalid-response', true);
    const status = data.accepted ? 'accepted' : data.ignored === 'disabled' ? 'disabled' : 'rejected';
    if (data.accepted && Array.isArray(data.promoted) && data.promoted.length) {
      memoryNotifyPromoted(data.promoted);
    }
    memoryRefreshCache();
    return Object.assign({ changed: 0, promoted: [] }, data, { ok: true, status, acceptedIndices: indices.slice() });
  } catch (e) {
    return rejected('network');
  }
}

// 事实固化（候选转正）时给一句可感知的反馈——记忆功能「看得见」的一半靠它
function memoryNotifyPromoted(promoted) {
  if (!Array.isArray(promoted) || !promoted.length) return;
  const toast = document.getElementById('modelToast');
  if (!toast) return;
  const label = promoted.slice(0, 2).join('；') + (promoted.length > 2 ? ' 等 ' + promoted.length + ' 条' : '');
  toast.textContent = '已记住：' + label + '（记忆面板可查看或删除）';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
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

// 模块与角标共用激活过滤；旧数据缺省 status 视为 active。
function _memoryActiveFacts() {
  const facts = _cachedProfile && _cachedProfile.facts;
  return (Array.isArray(facts) ? facts : [])
    .filter(f => f && (f.status === undefined || f.status === 'active') && String(f.fact || '').trim());
}

async function memoryRefreshCache() {
  try {
    _cachedProfile = await memoryGetProfile();
  } catch (e) {
    _cachedProfile = null;
  }
  memoryUpdateSidebarDot();
}

// pending 有新候选时侧边栏「记忆」入口亮红点
function memoryUpdateSidebarDot() {
  const dot = document.getElementById('memoryDot');
  if (!dot) return;
  const pendingCount = (_cachedProfile && Array.isArray(_cachedProfile.pending)) ? _cachedProfile.pending.length : 0;
  dot.hidden = !(pendingCount > 0);
}

// ---------- 画像角标（回答卡上的「已结合你的画像」） ----------
// 分节优先用后端随回答下发的注入快照（usage），它与真正进 prompt 的内容同源；
// 只有拿不到快照时（本地寒暄回答、旧服务端）才退回按缓存计算。
// 退回路径与后端 profile._profile_section_texts 同构的分节口径，是「逐步退场」的兼容层：
// 主路径有了快照后，两侧规则不再需要同步维护。
function memoryBadgeSections(usage) {
  if (usage && Array.isArray(usage.sections)) {
    // 服务端明确说了本次注入内容（可能为空 = 本次没注入）：以它为准
    return usage.sections
      .filter(s => s && s.label && String(s.text || '').trim())
      .map(s => ({ label: String(s.label), text: String(s.text) }));
  }
  return memoryBadgeSectionsFromCache();
}

function _memoryNormFact(t) {
  return String(t || '').trim().toLowerCase()
    .replace(/^(用户|我)+(是|的)?/, '')
    .replace(/(的|了)$/, '')
    .replace(/[\s，。；、：:()（）[\]【】"'‘’“”，.!?！？]+/g, '');
}

// 退回路径：按当前缓存里的活跃事实重算分节（与后端同构，仅在无快照时使用）
function memoryBadgeSectionsFromCache() {
  if (!_cachedProfile || !_cachedProfile.enabled) return [];
  const exp = _cachedProfile.explicit || {};
  const facts = _memoryActiveFacts()
    .sort((a, b) => ((b.occurrences || 1) - (a.occurrences || 1)) || ((b.updatedAt || 0) - (a.updatedAt || 0)))
    .slice(0, 12);
  const byCategory = (cat) => {
    const texts = [];
    const seen = new Set();
    const add = (t) => {
      t = String(t || '').trim();
      const k = _memoryNormFact(t);
      if (t && k && !seen.has(k)) { seen.add(k); texts.push(Array.from(t).slice(0, 60).join('')); }
    };
    if (cat === 'stage') add(exp.stage);
    if (cat === 'goal') add(exp.goal);
    if (cat === 'weakness') add(exp.weakAreas);
    if (cat === 'interest') add(exp.interests);
    facts.filter(f => f.category === cat).forEach(f => add(f.fact));
    return texts;
  };
  const sections = [];
  const rows = [['学段', 'stage'], ['目标', 'goal'], ['薄弱', 'weakness'], ['兴趣', 'interest']];
  for (const [label, cat] of rows) {
    const texts = byCategory(cat);
    if (texts.length) sections.push({ label: label, text: texts.slice(0, 5).join('；') });
  }
  const style = exp.style || {};
  const styleParts = [];
  if (style.detail && style.detail !== '标准') styleParts.push('详略=' + style.detail);
  if (style.jargon && style.jargon !== '标准') styleParts.push('术语=' + style.jargon);
  if (style.visuals && style.visuals !== '否') styleParts.push('可视化=' + style.visuals);
  // style 类别的自动事实与显式偏好同段（后端口径一致，否则该类事实被记录却永不展示）
  const styleSeen = new Set();
  facts.filter(f => f.category === 'style').forEach(f => {
    const t = String(f.fact || '').slice(0, 60);
    const k = _memoryNormFact(t);
    if (t && k && !styleSeen.has(k)) { styleSeen.add(k); styleParts.push(t); }
  });
  if (styleParts.length) sections.push({ label: '偏好', text: styleParts.join('；') });
  const otherSeen = new Set();
  const others = facts.filter(f => f.category === 'other').map(f => Array.from(String(f.fact)).slice(0, 60).join(''))
    .filter(t => { const key = _memoryNormFact(t); if (!key || otherSeen.has(key)) return false; otherSeen.add(key); return true; });
  if (others.length) sections.push({ label: '其他', text: others.slice(0, 5).join('；') });
  return sections;
}

// 往 message-meta 里插一枚可展开的画像角标；画像为空/停用时不插
function memoryAppendProfileBadge(metaEl, usage) {
  if (!metaEl || !metaEl.isConnected) return;
  if (metaEl.querySelector('.memory-badge')) return;
  const sections = memoryBadgeSections(usage);
  if (!sections.length) return;
  const wrap = document.createElement('span');
  wrap.className = 'memory-badge';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'memory-badge-btn';
  btn.textContent = '已结合你的画像（' + sections.map(s => s.label).join('·') + '）';
  btn.title = '点击查看本次回答参考了哪些记忆';
  const detail = document.createElement('span');
  detail.className = 'memory-badge-detail';
  detail.hidden = true;
  detail.innerHTML = sections.map(s =>
    '<div class="memory-badge-row"><span class="memory-badge-label">【' + s.label + '】</span>' + escapeHtml(s.text) + '</div>'
  ).join('') +
    '<div class="memory-badge-row memory-badge-manage"><button type="button" class="memory-badge-manage-btn" onclick="openMemoryPanel()">管理记忆</button></div>';
  btn.addEventListener('click', () => { detail.hidden = !detail.hidden; });
  wrap.appendChild(btn);
  wrap.appendChild(detail);
  metaEl.insertBefore(wrap, metaEl.firstChild);
}

function memoryCachedContext() {
  if (!_cachedProfile || !_cachedProfile.enabled) return '';
  const exp = _cachedProfile.explicit || {};
  const parts = [];
  if (String(exp.goal || '').trim()) parts.push('学习目标：' + exp.goal.trim());
  if (String(exp.interests || '').trim()) parts.push('兴趣方向：' + exp.interests.trim());
  if (String(exp.weakAreas || '').trim()) parts.push('薄弱章节：' + exp.weakAreas.trim());
  const facts = _memoryActiveFacts()
    .filter(f => ['goal', 'interest', 'weakness'].includes(f.category))
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
window.memoryPostCandidates = memoryPostCandidates;
window.memoryNotifyPromoted = memoryNotifyPromoted;
window.memoryImpactAreas = memoryImpactAreas;
window.memoryRefreshCache = memoryRefreshCache;
window.memoryCachedContext = memoryCachedContext;
window.memoryBadgeSections = memoryBadgeSections;
window.memoryAppendProfileBadge = memoryAppendProfileBadge;

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

  // 自动记忆（时间线：类别 + 原文 + 次数 + 相对时间）
  const facts = (profile && profile.facts || []).filter(f => f && f.status !== 'idle');
  document.getElementById('memoryFactCount').textContent = facts.length ? '(' + facts.length + ')' : '';
  const factEl = document.getElementById('memoryFactList');
  if (factEl) {
    factEl.innerHTML = facts.length
      ? facts.map(f =>
          '<div class="memory-item"><span class="memory-item-tag">' + (MEMORY_CATEGORY_LABELS[f.category] || f.category || '其他') + '</span>' +
          '<span class="memory-item-fact">' + escapeHtml(String(f.fact || '')) + '</span>' +
          '<span class="memory-item-time" title="确认 ' + (f.occurrences || 1) + ' 次">' + memoryRelTime(f.updatedAt) + ' · ×' + (f.occurrences || 1) + '</span>' +
          '<button class="memory-item-btn memory-item-btn-danger" onclick="memoryDeleteFact(\'' + String(f.id || '').replace(/'/g, '') + '\')">删除</button></div>'
        ).join('')
      : '<div class="memory-empty">暂无自动记忆。对话中提到的个人信息（学段、目标、薄弱点等）与检测错题、常问主题会出现在这里。</div>';
  }

  // 休眠记忆：长期没被用到的自动事实，不参与回答，可一键恢复
  const idleFacts = (profile && profile.facts || []).filter(f => f && f.status === 'idle');
  const idleCount = document.getElementById('memoryIdleCount');
  const idleEl = document.getElementById('memoryIdleList');
  if (idleCount) idleCount.textContent = idleFacts.length ? '(' + idleFacts.length + ')' : '';
  if (idleEl) {
    idleEl.innerHTML = idleFacts.length
      ? idleFacts.map(f =>
          '<div class="memory-item memory-item-idle"><span class="memory-item-tag">' + (MEMORY_CATEGORY_LABELS[f.category] || f.category || '其他') + '</span>' +
          '<span class="memory-item-fact">' + escapeHtml(String(f.fact || '')) + '</span>' +
          '<span class="memory-item-time">休眠 · 上次使用 ' + memoryRelTime(f.lastUsedAt || f.updatedAt) + '</span>' +
          '<button class="memory-item-btn" onclick="memoryRestoreFact(\'' + String(f.id || '').replace(/'/g, '') + '\')">恢复</button>' +
          '<button class="memory-item-btn memory-item-btn-danger" onclick="memoryDeleteFact(\'' + String(f.id || '').replace(/'/g, '') + '\')">删除</button></div>'
        ).join('')
      : '<div class="memory-empty">超过 30 天没被回答用到的记忆会休眠（不再注入），可随时恢复。</div>';
  }

  // 已更正或移除：AI 更正/否认事实时旧值进归档，可恢复（回到建议区再确认）或彻底删除
  const archive = (profile && profile.archive) || [];
  const archiveCount = document.getElementById('memoryArchiveCount');
  const archiveEl = document.getElementById('memoryArchiveList');
  if (archiveCount) archiveCount.textContent = archive.length ? '(' + archive.length + ')' : '';
  if (archiveEl) {
    archiveEl.innerHTML = archive.length
      ? archive.map(f =>
          '<div class="memory-item memory-item-archived"><span class="memory-item-tag">' + (MEMORY_CATEGORY_LABELS[f.category] || f.category || '其他') + '</span>' +
          '<span class="memory-item-fact">' + escapeHtml(String(f.fact || '')) + '</span>' +
          '<span class="memory-item-time">' + (f.source === 'superseded' ? '已更正' : '已移除') + ' · ' + memoryRelTime(f.removedAt) + '</span>' +
          '<button class="memory-item-btn" onclick="memoryRestoreArchive(\'' + String(f.id || '').replace(/'/g, '') + '\')">恢复</button>' +
          '<button class="memory-item-btn memory-item-btn-danger" onclick="memoryDeleteArchive(\'' + String(f.id || '').replace(/'/g, '') + '\')">删除</button></div>'
        ).join('')
      : '<div class="memory-empty">AI 更正或你否认旧记忆时，原内容会留档在这里，可恢复或删除。</div>';
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

async function _memoryMutateFacts(action, id) {
  try {
    const res = await fetch('/api/profile/manage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: getDeviceId(), action, fact_id: id })
    });
    if (!res.ok) throw new Error('profile manage failed: ' + res.status);
    const result = await res.json();
    if (result.accepted !== true) throw new Error('条目已变化或记忆容量已满，请刷新后重试');
    await memoryRefreshCache();
    await memoryRenderPanel();
  } catch (e) {
    console.warn('Memory mutate failed:', e);
    const toast = document.getElementById('modelToast');
    if (toast) {
      toast.textContent = '记忆操作未完成：' + e.message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 5000);
    }
  }
}

async function memoryDeleteFact(id) {
  await _memoryMutateFacts('delete_fact', id);
}

// 相对时间（面板时间线用）：刚刚 / n 分钟前 / n 小时前 / n 天前 / 具体日期
// 服务端时间戳是秒（time.time()），低于毫秒纪元阈值按秒换算；兼容历史混入的毫秒脏数据
function memoryRelTime(ts) {
  let t = Number(ts || 0);
  if (!t) return '—';
  if (t < 1e12) t *= 1000;
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前';
  if (diff < 30 * 86400000) return Math.round(diff / 86400000) + ' 天前';
  const d = new Date(t);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

// 休眠事实恢复：回 active 并刷新 lastUsedAt（否则会被再次判休眠）。
// 时间戳单位与服务端一致用秒（time.time()），毫秒值会污染休眠判定与排序
async function memoryRestoreFact(id) {
  await _memoryMutateFacts('restore_fact', id);
}

// 归档恢复回建议区，必须再次确认才生效。
async function memoryRestoreArchive(id) {
  await _memoryMutateFacts('restore_archive', id);
}

async function memoryDeleteArchive(id) {
  await _memoryMutateFacts('delete_archive', id);
}

async function memoryConfirmPending(id) {
  await _memoryMutateFacts('confirm_pending', id);
}

async function memoryDeletePending(id) {
  await _memoryMutateFacts('delete_pending', id);
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
  const results = { backup: false, profile: false, learning: includeLearning ? false : null };
  // 1. 自动备份（复用现有导出链路，产出与导入对称）。
  // 必须 await：否则下载尚未完成就执行后面的 DELETE，备份与服务端清空竞态；
  // 且 async rejection 不会被同步调用处的 try/catch 捕获。
  // requireServer：清除前必须拿到含服务端数据（含画像）的完整备份，
  // 服务端备份失败时退回「纯本地快照」会漏掉服务端会话/画像，删了就找不回——中止
  try {
    if (typeof exportData === 'function') { await exportData({ requireServer: true }); results.backup = true; }
    else throw new Error('exportData unavailable');
  } catch (e) { console.warn('Backup before clear failed:', e); }
  if (!results.backup) {
    memoryShowClearResult('备份失败，已中止清除：未删除任何数据。请重试或手动导出后再清除。', results);
    return;
  }
  // 2. 清除画像
  try { await memoryClearProfile(); results.profile = true; }
  catch (e) { console.warn('Profile clear failed:', e); }
  // 画像删除失败时不继续删学习数据：部分删除比全保留更难向用户解释
  if (results.profile && includeLearning) {
    try {
      const res = await fetch('/api/sessions', { method: 'DELETE' });
      if (res.ok) {
        const keys = ['phymathia_knowledge', 'phymathia_formulas', 'phymathia_quiz_stats', 'phymathia_quiz_bank', 'phymathia_quiz_source'];
        keys.forEach(k => localStorage.removeItem(k));
        if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
        results.learning = true;
      }
    } catch (e) { console.warn('Learning data clear failed:', e); }
  }
  await memoryRefreshCache();
  memoryRenderPanel();
  memoryShowClearResult('', results);
}

// 按步骤真实结果提示：不把失败说成成功；部分失败时说明完成了什么、什么没动
function memoryShowClearResult(prefix, results) {
  const parts = [];
  if (prefix) parts.push(prefix);
  else if (results.profile && results.learning !== false) {
    parts.push('记忆已清除' + (results.learning ? '，学习数据已一并清除' : '') + '。');
  } else if (results.profile && results.learning === false) {
    parts.push('记忆已清除，但学习数据清除失败，可稍后重试。');
  } else if (results.profile) {
    parts.push('记忆已清除。');
  } else {
    parts.push('画像清除失败，记忆数据保留未删。');
  }
  if (results.backup) parts.push('备份文件已生成，可从「数据管理-导入数据」恢复。');
  const toast = document.getElementById('modelToast');
  if (toast) { toast.textContent = parts.join(''); toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 5000); }
}

window.openMemoryPanel = openMemoryPanel;
window.closeMemoryPanel = closeMemoryPanel;
window.memoryRenderPanel = memoryRenderPanel;
window.memoryToggleChanged = memoryToggleChanged;
window.memorySaveExplicitField = memorySaveExplicitField;
window.memoryDeleteFact = memoryDeleteFact;
window.memoryConfirmPending = memoryConfirmPending;
window.memoryDeletePending = memoryDeletePending;
window.memoryRestoreFact = memoryRestoreFact;
window.memoryRestoreArchive = memoryRestoreArchive;
window.memoryDeleteArchive = memoryDeleteArchive;
window.memoryRelTime = memoryRelTime;
window.memoryOpenClearDialog = memoryOpenClearDialog;
window.closeMemoryClearDialog = closeMemoryClearDialog;
window.memoryConfirmClear = memoryConfirmClear;

