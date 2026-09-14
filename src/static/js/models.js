const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
const OPENCODE_DEFAULT_KEY = '';
// OpenCode Go 预设（2026-09-14 自 https://opencode.ai/zen/go/v1/models 实时拉取；
// 官方列表会滚动更新，过期时以该端点为准增删）。
// 注意：网关要求请求带 x-opencode-session 头（后端代理已按会话 id 注入，见 main.py）。
const OPENCODE_GO_MODEL_LABELS = {
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5': 'GLM-5',
  'kimi-k3': 'Kimi K3',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.5': 'Kimi K2.5',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision（实验）',
  'qwen3.8-max': 'Qwen3.8 Max',
  'qwen3.8-flash': 'Qwen3.8 Flash',
  'qwen3.7-max': 'Qwen3.7 Max',
  'qwen3.7-plus': 'Qwen3.7 Plus',
  'qwen3.6-plus': 'Qwen3.6 Plus',
  'qwen3.5-plus': 'Qwen3.5 Plus',
  'minimax-m3': 'MiniMax M3',
  'minimax-m2.7': 'MiniMax M2.7',
  'minimax-m2.5': 'MiniMax M2.5',
  'mimo-v2.5-pro': 'MiMo V2.5 Pro',
  'mimo-v2.5': 'MiMo V2.5',
  'mimo-v2-pro': 'MiMo V2 Pro',
  'mimo-v2-omni': 'MiMo V2 Omni',
  'longcat-2.0': 'LongCat 2.0',
  'hy3': '混元 Hy3',
  'hy3-preview': '混元 Hy3 Preview',
  'hy4-preview': '混元 Hy4 Preview',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'grok-4.6': 'Grok 4.6',
  'grok-4.5': 'Grok 4.5',
  'muse-spark-1.3-contributor': 'Muse Spark 1.3 Contributor',
  'muse-spark-1.2-contributor': 'Muse Spark 1.2 Contributor',
  'omen-alpha': 'Omen Alpha',
};
const OPENCODE_GO_MODELS = Object.keys(OPENCODE_GO_MODEL_LABELS);
// DeepSeek 官方预置（模型 id 见 https://api-docs.deepseek.com/），
// 密钥在模型面板 DeepSeek 组头统一填一次（platform.deepseek.com 申请）
const DEEPSEEK_PRESET_MODEL_LABELS = {
  'deepseek-chat': 'DeepSeek Chat（V4 通用）',
  'deepseek-reasoner': 'DeepSeek Reasoner（推理）',
};
const OPENCODE_FREE_MODEL_LABELS = {
  'big-pickle': 'Big Pickle',
  'mimo-v2.5-free': 'MiMo V2.5 Free',
  'laguna-s-2.1-free': 'Laguna S 2.1 Free',
  'ling-3.0-flash-free': 'Ling-3.0-flash Free',
  'longcat-2.0-free': 'LongCat-2.0 Free',
  'north-mini-code-free': 'North Mini Code Free',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra Free',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash Free',
};
const OPENCODE_FREE_MODELS = [
  'big-pickle',
  'mimo-v2.5-free',
  'laguna-s-2.1-free',
  'ling-3.0-flash-free',
  'longcat-2.0-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
  'deepseek-v4-flash-free',
];

const MODEL_PRESETS = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'], apiKeyHint: 'sk-' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], apiKeyHint: 'sk-' },
  llama: { name: 'llama.ccp (本地)', baseUrl: 'http://localhost:8080/v1', models: [], apiKeyHint: '可选，留空' },
  opencode: { name: 'OpenCode', baseUrl: OPENCODE_BASE_URL, models: OPENCODE_FREE_MODELS, apiKeyHint: '可填任意内容' },
  'opencode-go': { name: 'OpenCode Go', baseUrl: OPENCODE_GO_BASE_URL, models: OPENCODE_GO_MODELS, apiKeyHint: '需要密钥' },
};

const MODELS_STORAGE_KEY = 'phymathia_user_models';
// 模型分组密钥：按 provider 分组，一组共用一个密钥（如 OpenCode Go 订阅 key 组内 37 个模型共用）。
// 写入时同步落到组内每个条目的 apiKey 上——下游 8 处直读 model.apiKey 的调用点、
// 「密钥已配置」徽标、hasKey 全部零改动；组内单个条目仍可用模型配置弹窗覆盖自己的密钥。
const MODEL_GROUP_KEYS_STORAGE = 'phymathia_model_group_keys';
let modelGroupKeys = {};
const _modelGroupCollapsed = {};

function loadGroupKeys() {
  try { modelGroupKeys = JSON.parse(localStorage.getItem(MODEL_GROUP_KEYS_STORAGE) || '{}'); }
  catch { modelGroupKeys = {}; }
}

function getGroupKey(provider) {
  return modelGroupKeys[provider] || '';
}

function saveGroupKey(provider, key) {
  modelGroupKeys[provider] = String(key || '');
  try { localStorage.setItem(MODEL_GROUP_KEYS_STORAGE, JSON.stringify(modelGroupKeys)); } catch {}
  let changed = false;
  for (const cfg of userModelConfigs) {
    if (cfg.provider === provider && cfg.apiKey !== modelGroupKeys[provider]) {
      cfg.apiKey = modelGroupKeys[provider];
      changed = true;
    }
  }
  if (changed) saveUserModels();
  _refreshGroupKeyBadges(provider);
}

// 输入过程中就地刷新组内条目的密钥徽标——不重建 DOM（会丢输入框焦点），
// 完整的重渲染留给 onchange（失焦）触发
function _refreshGroupKeyBadges(provider) {
  try {
    document.querySelectorAll('#modelList .model-group').forEach(g => {
      if (g.getAttribute('data-provider') !== provider) return;
      const has = !!getGroupKey(provider);
      const html = has ? UI_ICON_SVG.check + ' 密钥已配置' : UI_ICON_SVG.key + ' 密钥可留空（后端环境变量）';
      g.querySelectorAll('.model-item-key').forEach(el => { el.innerHTML = html; });
    });
  } catch (e) {}
}

function toggleModelGroup(provider) {
  _modelGroupCollapsed[provider] = !_modelGroupCollapsed[provider];
  // 就地切换可见性，不重建列表——重建会让本次点击的按钮脱离 DOM，
  // 冒泡到 document 的“点外关闭”监听时 contains=false，面板被误关
  document.querySelectorAll('#modelList .model-group').forEach(g => {
    if (g.getAttribute('data-provider') !== provider) return;
    const body = g.querySelector('.model-group-body');
    const btn = g.querySelector('.model-group-toggle');
    if (body) body.style.display = _modelGroupCollapsed[provider] ? 'none' : '';
    if (btn) {
      btn.textContent = _modelGroupCollapsed[provider] ? '▶' : '▼';
      btn.title = _modelGroupCollapsed[provider] ? '展开' : '折叠';
    }
  });
}

// 分组密钥失焦提交：全量重渲染（刷新组内徽标）+ 输入框闪绿提示保存成功
function saveGroupKeyCommitted(provider, inputEl) {
  saveGroupKey(provider, inputEl.value);
  renderModelList();
  renderModelSelects();
  try {
    const fresh = document.querySelector('#modelList .model-group[data-provider="' + CSS.escape(provider) + '"] .model-group-key');
    if (fresh) {
      fresh.classList.add('saved-flash');
      setTimeout(() => fresh.classList.remove('saved-flash'), 1200);
    }
  } catch (e) {}
}

let userModelConfigs = [];
let activeModels = { agent_model: '', html_model: '', descriptor_model: '', quiz_model: '', graph_model: '', branch_model: '' };

function loadUserModels() {
  try {
    const raw = localStorage.getItem(MODELS_STORAGE_KEY);
    userModelConfigs = raw ? JSON.parse(raw) : [];
  } catch { userModelConfigs = []; }
  loadGroupKeys();
  _ensureOpencodeFreeModels();
  _ensureOpencodeGoModels();
  _ensureDeepseekModels();
}

function _ensureDeepseekModels() {
  let changed = false;
  for (const modelId of Object.keys(DEEPSEEK_PRESET_MODEL_LABELS)) {
    const label = DEEPSEEK_PRESET_MODEL_LABELS[modelId];
    let cfg = userModelConfigs.find(c => c.provider === 'deepseek' && c.model === modelId);
    if (!cfg) {
      addUserModel({ provider: 'deepseek', apiKey: getGroupKey('deepseek'), model: modelId, label, baseUrl: MODEL_PRESETS.deepseek.baseUrl });
      changed = true;
    } else if (cfg.label !== label || cfg.baseUrl !== MODEL_PRESETS.deepseek.baseUrl) {
      // 仅规范化 label/baseUrl（预设所有物）；apiKey 属于用户数据，绝不能覆盖
      Object.assign(cfg, { label, baseUrl: MODEL_PRESETS.deepseek.baseUrl });
      changed = true;
    }
  }
  if (changed) saveUserModels();
}

function _ensureOpencodeGoModels() {
  let changed = false;
  let firstId = '';
  for (const modelId of OPENCODE_GO_MODELS) {
    const label = OPENCODE_GO_MODEL_LABELS[modelId] || modelId;
    let cfg = userModelConfigs.find(c =>
      c.provider === 'opencode-go' && c.model === modelId
    );
    if (!cfg) {
      cfg = { provider: 'opencode-go', apiKey: getGroupKey('opencode-go'), model: modelId, label, baseUrl: OPENCODE_GO_BASE_URL };
      addUserModel(cfg);
      changed = true;
    } else if (cfg.label !== label || cfg.baseUrl !== OPENCODE_GO_BASE_URL) {
      // 仅规范化 label/baseUrl（预设所有物）；apiKey 属于用户数据，绝不能覆盖
      Object.assign(cfg, { label: label, baseUrl: OPENCODE_GO_BASE_URL });
      changed = true;
    }
    if (!firstId && cfg.id) firstId = cfg.id;
  }
  if (changed) saveUserModels();
  return firstId;
}

function _ensureOpencodeFreeModels() {
  const aliasToId = Object.fromEntries(
    Object.entries(OPENCODE_FREE_MODEL_LABELS).map(([id, label]) => [label, id])
  );
  let firstId = '';
  let changed = false;
  const legacyCount = userModelConfigs.length;
  userModelConfigs = userModelConfigs.filter(cfg =>
    !(cfg.provider === 'opencode' && String(cfg.baseUrl || '').includes('opencode.ai/zen/go'))
  );
  if (userModelConfigs.length !== legacyCount) changed = true;
  for (const modelId of OPENCODE_FREE_MODELS) {
    const label = OPENCODE_FREE_MODEL_LABELS[modelId];
    let cfg = userModelConfigs.find(c =>
      c.provider === 'opencode'
      && (c.model === modelId || aliasToId[c.model] === modelId)
    );
    if (!cfg) {
      cfg = { provider: 'opencode', apiKey: getGroupKey('opencode'), model: modelId, label, baseUrl: OPENCODE_BASE_URL };
      addUserModel(cfg);
    } else {
      // 仅规范化 model/label/baseUrl（迁移旧条目）；apiKey 属于用户数据，绝不能覆盖
      // （否则每次页面加载 loadUserModels() 都会把用户填的密钥重置为空 → “密钥存不住”）
      const next = { ...cfg, model: modelId, label, baseUrl: OPENCODE_BASE_URL };
      if (cfg.model !== next.model || cfg.label !== next.label || cfg.baseUrl !== next.baseUrl) {
        Object.assign(cfg, next);
        changed = true;
      }
    }
    if (!firstId && cfg.id) firstId = cfg.id;
  }
  if (changed) saveUserModels();
  return firstId;
}

function saveUserModels() {
  localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify(userModelConfigs));
}

function addUserModel(config) {
  config.id = 'model_' + crypto.randomUUID().replace(/-/g, '').substring(0, 12);
  config.createdAt = Date.now();
  userModelConfigs.push(config);
  saveUserModels();
  return config.id;
}

function updateUserModel(id, updates) {
  const idx = userModelConfigs.findIndex(m => m.id === id);
  if (idx === -1) return false;
  userModelConfigs[idx] = { ...userModelConfigs[idx], ...updates };
  saveUserModels();
  return true;
}

function deleteUserModel(id) {
  userModelConfigs = userModelConfigs.filter(m => m.id !== id);
  if (activeModels.agent_model === id) activeModels.agent_model = '';
  if (activeModels.html_model === id) activeModels.html_model = '';
  if (activeModels.descriptor_model === id) activeModels.descriptor_model = '';
  if (activeModels.quiz_model === id) activeModels.quiz_model = '';
  if (activeModels.graph_model === id) activeModels.graph_model = '';
  if (activeModels.branch_model === id) activeModels.branch_model = '';
  saveUserModels();
  localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels));
}

function getAllModels() {
  const result = [];
  for (const cfg of userModelConfigs) {
    const preset = MODEL_PRESETS[cfg.provider];
    const display = cfg.label || cfg.model;
    result.push({ id: cfg.id, name: (preset?.name || cfg.provider) + ' · ' + display, desc: preset?.name || cfg.provider, tags: [display], provider: cfg.provider, hasKey: !!cfg.apiKey });
  }
  return result;
}

function getModelById(id) {
  return userModelConfigs.find(m => m.id === id) || null;
}

function getActiveModelForRole(role) {
  const key = role === 'agent' ? 'agent_model' : role === 'html' ? 'html_model' : role === 'graph' ? 'graph_model' : role === 'quiz' ? 'quiz_model' : role === 'branch' ? 'branch_model' : 'descriptor_model';
  const id = activeModels[key];
  if (!id) return null;
  return getModelById(id);
}

async function fetchModels() {
  loadUserModels();
  try { const raw = localStorage.getItem('phymathia_active_models'); if (raw) activeModels = JSON.parse(raw); } catch {}
  const fallbackOpencode = userModelConfigs.find(m => m.provider === 'opencode') || null;
  const fallbackOpencodeGo = userModelConfigs.find(m => m.provider === 'opencode-go' && m.model === 'hy3')
    || userModelConfigs.find(m => m.provider === 'opencode-go') || null;
  for (const key of ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model']) {
    const model = getModelById(activeModels[key]);
    if (model && model.provider === 'opencode' && !OPENCODE_FREE_MODELS.includes(model.model)) {
      activeModels[key] = fallbackOpencode ? fallbackOpencode.id : '';
    }
  }
  if (!activeModels.agent_model) activeModels.agent_model = (fallbackOpencodeGo || fallbackOpencode)?.id || '';
  localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels));
  renderModelSelects();
}

function renderModelSelects() {
  const allModels = getAllModels();
  const agentSelect = document.getElementById('agentModelSelect');
  const htmlSelect = document.getElementById('htmlModelSelect');
  const descriptorSelect = document.getElementById('descriptorModelSelect');
  const quizSelect = document.getElementById('quizModelSelect');
  const graphSelect = document.getElementById('graphModelSelect');
  const branchSelect = document.getElementById('branchModelSelect');
  if (!agentSelect || !htmlSelect || !quizSelect || !graphSelect) return;

  const emptyOpt = '<option value="">— 请选择模型 —</option>';
  // 非主模型角色留空 = 跟随主模型（各调用点均为 getActiveModelForRole(角色) || 主模型），
  // 统一用同一份选项文案，避免五种角色各写一套描述漂移
  const sameAsMainOpt = '<option value="">— 与主模型相同（默认）—</option>';
  // 槽位下拉按 provider 分组（<optgroup>）：与模型面板的分组一致，组内模型按序可选
  const groupOrder = [];
  const byProvider = {};
  for (const m of allModels) {
    if (!byProvider[m.provider]) {
      byProvider[m.provider] = [];
      groupOrder.push(m.provider);
    }
    byProvider[m.provider].push(m);
  }
  const opts = groupOrder.map(provider => {
    const preset = MODEL_PRESETS[provider];
    const groupLabel = (preset && preset.name) || provider;
    const items = byProvider[provider].map(m =>
      `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`
    ).join('');
    return `<optgroup label="${escapeHtml(groupLabel)}">${items}</optgroup>`;
  }).join('');

  agentSelect.innerHTML = emptyOpt + opts;
  htmlSelect.innerHTML = sameAsMainOpt + opts;
  if (descriptorSelect) descriptorSelect.innerHTML = sameAsMainOpt + opts;
  quizSelect.innerHTML = sameAsMainOpt + opts;
  graphSelect.innerHTML = sameAsMainOpt + opts;
  agentSelect.value = activeModels.agent_model || '';
  htmlSelect.value = activeModels.html_model || '';
  if (descriptorSelect) descriptorSelect.value = activeModels.descriptor_model || '';
  quizSelect.value = activeModels.quiz_model || '';
  graphSelect.value = activeModels.graph_model || '';
  if (branchSelect) {
    branchSelect.innerHTML = sameAsMainOpt + opts;
    branchSelect.value = activeModels.branch_model || '';
  }
  updateModelMeta('agent');
  updateModelMeta('html');
  updateModelMeta('descriptor');
  updateModelMeta('quiz');
  updateModelMeta('graph');
  updateModelMeta('branch');
}

function updateModelMeta(type) {
  const selectMap = { agent: 'agentModelSelect', html: 'htmlModelSelect', descriptor: 'descriptorModelSelect', quiz: 'quizModelSelect', graph: 'graphModelSelect', branch: 'branchModelSelect' };
  const descMap = { agent: 'agentModelDesc', html: 'htmlModelDesc', descriptor: 'descriptorModelDesc', quiz: 'quizModelDesc', graph: 'graphModelDesc', branch: 'branchModelDesc' };
  const tagsMap = { agent: 'agentModelTags', html: 'htmlModelTags', descriptor: 'descriptorModelTags', quiz: 'quizModelTags', graph: 'graphModelTags', branch: 'branchModelTags' };
  const select = document.getElementById(selectMap[type]);
  const descEl = document.getElementById(descMap[type]);
  const tagsEl = document.getElementById(tagsMap[type]);
  if (!select || !descEl || !tagsEl) return;
  const model = getModelById(select.value);
  if (model) {
    const preset = MODEL_PRESETS[model.provider];
    descEl.textContent = (preset?.name || model.provider) + ' · ' + (model.label || model.model);
      tagsEl.innerHTML = `<span class="model-tag">${model.provider}</span><span class="model-tag">${model.apiKey ? UI_ICON_SVG.check + ' 已配置密钥' : UI_ICON_SVG.key + ' 密钥可留空'}</span>`;
  } else {
    if (type === 'agent') {
      descEl.textContent = select.value ? '' : '未配置模型。请选择模型（可直接使用免费模型）';
      tagsEl.innerHTML = select.value ? '' : '<span class="model-tag">未配置</span>';
    } else {
      // 其余角色统一口径：留空即与主模型相同，仅描述回退行为，不再各写一份角色说明
      descEl.textContent = select.value ? '' : '默认与主模型相同，无需单独配置';
      tagsEl.innerHTML = select.value ? '' : '<span class="model-tag">可选</span>';
    }
  }
}

async function onModelChange(type) {
  const selectMap = { agent: 'agentModelSelect', html: 'htmlModelSelect', descriptor: 'descriptorModelSelect', quiz: 'quizModelSelect', graph: 'graphModelSelect', branch: 'branchModelSelect' };
  const select = document.getElementById(selectMap[type]);
  updateModelMeta(type);
  if (type === 'agent') activeModels.agent_model = select.value;
  else if (type === 'html') activeModels.html_model = select.value;
  else if (type === 'quiz') activeModels.quiz_model = select.value;
  else if (type === 'graph') activeModels.graph_model = select.value;
  else if (type === 'branch') activeModels.branch_model = select.value;
  else activeModels.descriptor_model = select.value;
  localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels));
}

function _positionPanelBelowBtn(panel, btn) {
  if (!panel || !btn) return;
  const r = btn.getBoundingClientRect();
  const pw = panel.offsetWidth || 320;
  const toolbar = btn.closest('.chat-header, .header-secondary-bar');
  const top = Math.max(8, (toolbar ? toolbar.getBoundingClientRect().bottom : r.bottom) + 6);
  const maxH = Math.max(120, window.innerHeight - top - 8);
  panel.style.top = top + 'px';
  panel.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)) + 'px';
  panel.style.maxHeight = maxH + 'px';
  panel.style.overflowY = 'auto';
}
window._positionPanelBelowBtn = _positionPanelBelowBtn;

// toggleModelPanel 统一定义在 ui.js（打包顺序在后、实现更完整：联动关闭
// level/data 面板 + renderModelSelects）；此处不再重复定义，避免两份实现漂移

function renderModelList() {
  const container = document.getElementById('modelList');
  if (!container) return;
  if (userModelConfigs.length === 0) {
    container.innerHTML = '<div class="model-empty">暂无自定义模型，点击下方按钮添加</div>';
    return;
  }
  // 按 provider 分组渲染（保持首次出现顺序）：组头统一配置密钥，组内模型可折叠
  const groupOrder = [];
  const byProvider = {};
  for (const m of userModelConfigs) {
    if (!byProvider[m.provider]) {
      byProvider[m.provider] = [];
      groupOrder.push(m.provider);
    }
    byProvider[m.provider].push(m);
  }
  container.innerHTML = groupOrder.map(provider => {
    const models = byProvider[provider];
    const preset = MODEL_PRESETS[provider];
    const groupName = (preset && preset.name) || provider;
    // provider 进 onclick/oninput 单引号串需做 JS 转义（自定义 provider 是用户自由输入）
    const jsProvider = String(provider).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const collapsed = !!_modelGroupCollapsed[provider];
    const hint = (preset && preset.apiKeyHint) || 'sk-...';
    const items = models.map(m => {
      // label/model 是用户自由输入，必须转义；id 进 onclick 单引号串需做 JS 转义
      const jsId = String(m.id || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const hasKey = !!(m.apiKey || getGroupKey(provider));
      return `<div class="model-item">
        <div class="model-item-info">
          <div class="model-item-name">${escapeHtml(m.label || m.model)}</div>
          <div class="model-item-key">${hasKey ? UI_ICON_SVG.check + ' 密钥已配置' : UI_ICON_SVG.key + ' 密钥可留空（后端环境变量）'}</div>
        </div>
        <div class="model-item-actions">
          <button class="model-item-btn" onclick="openModelConfig('${jsId}')" title="配置">${UI_ICON_SVG.sliders}</button>
          <button class="model-item-btn model-item-btn-del" onclick="confirmDeleteModel('${jsId}')" title="删除">${UI_ICON_SVG.trash}</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="model-group" data-provider="${escapeHtml(provider)}">
      <div class="model-group-header">
        <button class="model-group-toggle" onclick="toggleModelGroup('${jsProvider}')" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▶' : '▼'}</button>
        <div class="model-group-title">${escapeHtml(groupName)}<span class="model-group-count">${models.length} 个模型</span></div>
        <input type="password" class="model-group-key" placeholder="分组密钥（${escapeHtml(hint)}）" value="${escapeHtml(getGroupKey(provider))}" oninput="saveGroupKey('${jsProvider}', this.value)" onchange="saveGroupKeyCommitted('${jsProvider}', this)" title="统一配置组内所有模型的密钥（单个模型仍可在其配置里覆盖）">
      </div>
      ${collapsed ? '' : `<div class="model-group-body">${items}</div>`}
    </div>`;
  }).join('');
}

function openModelConfig(id) {
  const model = getModelById(id);
  if (!model) return;
  const preset = MODEL_PRESETS[model.provider];
  document.getElementById('mcId').value = model.id;
  document.getElementById('mcProvider').value = model.provider;
  document.getElementById('mcApiKey').value = model.apiKey || '';
  document.getElementById('mcModel').value = model.model;
  document.getElementById('mcBaseUrl').value = model.baseUrl || preset?.baseUrl || '';
  document.getElementById('mcPresetName').textContent = preset?.name || model.provider;
  document.getElementById('modelConfigDialog').classList.add('show');
}

function closeModelConfig() {
  document.getElementById('modelConfigDialog').classList.remove('show');
}

function saveModelConfig() {
  const id = document.getElementById('mcId').value;
  const apiKey = document.getElementById('mcApiKey').value.trim();
  const model = document.getElementById('mcModel').value.trim();
  const baseUrl = document.getElementById('mcBaseUrl').value.trim();
  if (!model) { alert('请填写模型名称'); return; }
  const ok = updateUserModel(id, { apiKey, model, baseUrl });
  if (ok) {
    closeModelConfig();
    renderModelList();
    renderModelSelects();
  }
}

function confirmDeleteModel(id) {
  if (!confirm('确定删除该模型配置吗？')) return;
  deleteUserModel(id);
  renderModelList();
  renderModelSelects();
}

function showAddModelDialog() {
  document.getElementById('newProvider').value = 'deepseek';
  document.getElementById('newCustomProviderField').style.display = 'none';
  document.getElementById('newCustomProvider').value = '';
  document.getElementById('newApiKey').value = '';
  document.getElementById('newBaseUrl').value = 'https://api.deepseek.com';
  updateNewModelPreset();
  document.getElementById('addModelDialog').classList.add('show');
}

function closeAddModelDialog() {
  document.getElementById('addModelDialog').classList.remove('show');
}

function updateNewModelPreset() {
  const provider = document.getElementById('newProvider').value;
  const isCustom = provider === '__custom__';
  document.getElementById('newCustomProviderField').style.display = isCustom ? 'block' : 'none';
  document.getElementById('newApiKey').placeholder = isCustom ? '可选，留空则无密钥认证' : MODEL_PRESETS[provider]?.apiKeyHint || 'sk-...';
  if (isCustom) {
    document.getElementById('newModel').value = '';
    document.getElementById('newBaseUrl').value = '';
  } else {
    const preset = MODEL_PRESETS[provider];
    if (preset) {
      document.getElementById('newModel').value = preset.models[0] || '';
      document.getElementById('newBaseUrl').value = preset.baseUrl;
    }
  }
}

function saveNewModel() {
  const provider = document.getElementById('newProvider').value;
  const isCustom = provider === '__custom__';
  const finalProvider = isCustom ? document.getElementById('newCustomProvider').value.trim() || 'custom' : provider;
  const apiKey = document.getElementById('newApiKey').value.trim();
  const model = document.getElementById('newModel').value.trim();
  const baseUrl = document.getElementById('newBaseUrl').value.trim();
  if (!model) { alert('请填写模型名称'); return; }
  if (!baseUrl) { alert('请填写 API 地址'); return; }
  // 手动添加也继承分组密钥：单条 apiKey 留空时回落到所在组的统一密钥
  addUserModel({ provider: finalProvider, apiKey: apiKey || getGroupKey(finalProvider), model, baseUrl });
  closeAddModelDialog();
  renderModelList();
  renderModelSelects();
}

async function proxyChatWithModel(model, body, signal) {
  const resp = await fetch('/api/models/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      provider: model.provider,
      api_key: model.apiKey,
      model: model.model,
      base_url: model.baseUrl,
      device_id: (typeof getDeviceId === 'function' ? getDeviceId() : ''),
      ...body,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API ${resp.status}: ${errText.substring(0, 200)}`);
  }
  return resp;
}

async function proxyChat(prompt, level, sessionId, stream = true, signal, branchMeta = {}, extra = {}) {
  // 临时分支模型：苏格拉底追问(socratic)和进阶学习(learn)可单独指定模型
  // 若配置了 branch_model，则这两个节点走独立模型，方便用 llama.cpp 本地服务测试
  let agentModel = getActiveModelForRole('agent');
  if (!agentModel) return null;
  const branchType = branchMeta.branchType;
  const srcMod = branchMeta.sourceModule || '';
  const isSocraticOrLearn = branchType === 'socratic' || branchType === 'learn'
    || srcMod === 'socratic' || srcMod === 'learn';
  if (isSocraticOrLearn && activeModels.branch_model) {
    const branchModel = getModelById(activeModels.branch_model);
    if (branchModel) agentModel = branchModel;
  }
  // 分支锚点使用 camelCase，后端契约是 snake_case：在 API 边界统一转换
  const { graphPath, parentId, sourceModule, branchId, branchLabel, position, ...rest } = branchMeta;
  return proxyChatWithModel(agentModel, {
    prompt,
    level,
    session_id: sessionId,
    stream,
    ...rest,
    parent_id: parentId || '',
    source_module: sourceModule || '',
    branch_type: branchType || '',
    branch_id: branchId || '',
    branch_label: branchLabel || '',
    graph_path: graphPath || [],
    ...extra,
  }, signal);
}

loadUserModels();
