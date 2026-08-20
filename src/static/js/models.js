const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_DEFAULT_KEY = '';
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
};

const MODELS_STORAGE_KEY = 'phymathia_user_models';

let userModelConfigs = [];
let activeModels = { agent_model: '', html_model: '', descriptor_model: '', quiz_model: '', graph_model: '', branch_model: '' };

function loadUserModels() {
  try {
    const raw = localStorage.getItem(MODELS_STORAGE_KEY);
    userModelConfigs = raw ? JSON.parse(raw) : [];
  } catch { userModelConfigs = []; }
  _ensureOpencodeFreeModels();
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
      cfg = { provider: 'opencode', apiKey: OPENCODE_DEFAULT_KEY, model: modelId, label, baseUrl: OPENCODE_BASE_URL };
      addUserModel(cfg);
    } else {
      const next = {
        ...cfg,
        apiKey: OPENCODE_DEFAULT_KEY,
        model: modelId,
        label,
        baseUrl: OPENCODE_BASE_URL,
      };
      if (cfg.apiKey !== next.apiKey || cfg.model !== next.model || cfg.label !== next.label || cfg.baseUrl !== next.baseUrl) {
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
  for (const key of ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model']) {
    const model = getModelById(activeModels[key]);
    if (model && model.provider === 'opencode' && !OPENCODE_FREE_MODELS.includes(model.model)) {
      activeModels[key] = fallbackOpencode ? fallbackOpencode.id : '';
    }
  }
  if (!activeModels.agent_model && fallbackOpencode) activeModels.agent_model = fallbackOpencode.id;
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
  const descriptorEmptyOpt = '<option value="">— 不启用（回退默认摘要）—</option>';
  const quizEmptyOpt = '<option value="">— 不启用（默认用主模型）—</option>';
  const opts = allModels.map(m =>
    `<option value="${m.id}">${m.name}</option>`
  ).join('');

  agentSelect.innerHTML = emptyOpt + opts;
  htmlSelect.innerHTML = emptyOpt + opts;
  if (descriptorSelect) descriptorSelect.innerHTML = descriptorEmptyOpt + opts;
  quizSelect.innerHTML = quizEmptyOpt + opts;
  graphSelect.innerHTML = '<option value="">— 不启用（默认用主模型）—</option>' + opts;
  agentSelect.value = activeModels.agent_model || '';
  htmlSelect.value = activeModels.html_model || '';
  if (descriptorSelect) descriptorSelect.value = activeModels.descriptor_model || '';
  quizSelect.value = activeModels.quiz_model || '';
  graphSelect.value = activeModels.graph_model || '';
  if (branchSelect) {
    branchSelect.innerHTML = '<option value="">— 不启用（跟随主模型）—</option>' + opts;
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
    if (type === 'quiz') {
      descEl.textContent = select.value ? '' : '未配置时默认用主模型生成检测题、深度问答评分与单题解析';
      tagsEl.innerHTML = select.value ? '' : '<span class="model-tag">可选</span>';
    } else if (type === 'graph') {
      descEl.textContent = select.value ? '' : '未配置时默认使用主模型（建议选擅长结构化输出的模型）';
      tagsEl.innerHTML = select.value ? '' : '<span class="model-tag">可选</span>';
    } else if (type === 'branch') {
      descEl.textContent = select.value ? '' : '未配置时苏格拉底/进阶学习跟随主模型；配置后单独走该模型';
      tagsEl.innerHTML = select.value ? '' : '<span class="model-tag">可选</span>';
    } else {
      descEl.textContent = select.value ? '' : '未配置模型。请选择模型（可直接使用免费模型）';
      tagsEl.innerHTML = select.value ? '' : '<span class="model-tag">未配置</span>';
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

function toggleModelPanel(e) {
  e?.stopPropagation();
  const panel = document.getElementById('modelPanel');
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show');
  if (willShow) _positionPanelBelowBtn(panel, e?.currentTarget);
  renderModelList();
}

function renderModelList() {
  const container = document.getElementById('modelList');
  if (!container) return;
  if (userModelConfigs.length === 0) {
    container.innerHTML = '<div class="model-empty">暂无自定义模型，点击下方按钮添加</div>';
    return;
  }
  container.innerHTML = userModelConfigs.map(m => {
    const preset = MODEL_PRESETS[m.provider];
    return `<div class="model-item">
      <div class="model-item-info">
        <div class="model-item-name">${preset?.name || m.provider} · ${m.label || m.model}</div>
        <div class="model-item-key">${m.apiKey ? UI_ICON_SVG.check + ' 密钥已配置' : UI_ICON_SVG.key + ' 密钥可留空（后端环境变量）'}</div>
      </div>
      <div class="model-item-actions">
        <button class="model-item-btn" onclick="openModelConfig('${m.id}')" title="配置">${UI_ICON_SVG.sliders}</button>
        <button class="model-item-btn model-item-btn-del" onclick="confirmDeleteModel('${m.id}')" title="删除">${UI_ICON_SVG.trash}</button>
      </div>
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
  addUserModel({ provider: finalProvider, apiKey, model, baseUrl });
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
  if ((branchType === 'socratic' || branchType === 'learn') && activeModels.branch_model) {
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
