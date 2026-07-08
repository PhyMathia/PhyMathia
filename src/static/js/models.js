const MODEL_PRESETS = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], apiKeyHint: 'sk-' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], apiKeyHint: 'sk-' },
  llama: { name: 'llama.ccp (本地)', baseUrl: 'http://localhost:8080/v1', models: [], apiKeyHint: '可选，留空' },
};

const MODELS_STORAGE_KEY = 'phymathia_user_models';

let userModelConfigs = [];
let activeModels = { agent_model: '', html_model: '' };

function loadUserModels() {
  try {
    const raw = localStorage.getItem(MODELS_STORAGE_KEY);
    userModelConfigs = raw ? JSON.parse(raw) : [];
  } catch { userModelConfigs = []; }
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
  saveUserModels();
  localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels));
}

function getAllModels() {
  const result = [];
  for (const cfg of userModelConfigs) {
    const preset = MODEL_PRESETS[cfg.provider];
    result.push({ id: cfg.id, name: (preset?.name || cfg.provider) + ' · ' + cfg.model, desc: preset?.name || cfg.provider, tags: [cfg.model], provider: cfg.provider, hasKey: !!cfg.apiKey });
  }
  return result;
}

function getModelById(id) {
  return userModelConfigs.find(m => m.id === id) || null;
}

function getActiveModelForRole(role) {
  const key = role === 'agent' ? 'agent_model' : 'html_model';
  const id = activeModels[key];
  if (!id) return null;
  return getModelById(id);
}

async function fetchModels() {
  loadUserModels();
  try { const raw = localStorage.getItem('phymathia_active_models'); if (raw) activeModels = JSON.parse(raw); } catch {}
  renderModelSelects();
}

function renderModelSelects() {
  const allModels = getAllModels();
  const agentSelect = document.getElementById('agentModelSelect');
  const htmlSelect = document.getElementById('htmlModelSelect');
  if (!agentSelect || !htmlSelect) return;

  const emptyOpt = '<option value="">— 使用本地 Mock —</option>';
  const opts = allModels.map(m =>
    `<option value="${m.id}">${m.name}</option>`
  ).join('');

  agentSelect.innerHTML = emptyOpt + opts;
  htmlSelect.innerHTML = emptyOpt + opts;
  agentSelect.value = activeModels.agent_model || '';
  htmlSelect.value = activeModels.html_model || '';
  updateModelMeta('agent');
  updateModelMeta('html');
}

function updateModelMeta(type) {
  const select = document.getElementById(type === 'agent' ? 'agentModelSelect' : 'htmlModelSelect');
  const descEl = document.getElementById(type === 'agent' ? 'agentModelDesc' : 'htmlModelDesc');
  const tagsEl = document.getElementById(type === 'agent' ? 'agentModelTags' : 'htmlModelTags');
  if (!select || !descEl || !tagsEl) return;
  const model = getModelById(select.value);
  if (model) {
    const preset = MODEL_PRESETS[model.provider];
    descEl.textContent = (preset?.name || model.provider) + ' · ' + model.model;
    tagsEl.innerHTML = `<span class="model-tag">${model.provider}</span><span class="model-tag">${model.apiKey ? '✅ 已配置密钥' : '⚠️ 未配置密钥'}</span>`;
  } else {
    descEl.textContent = select.value ? '' : '使用本地 Mock 回答进行测试';
    tagsEl.innerHTML = select.value ? '' : '<span class="model-tag">🔄 Mock</span>';
  }
}

async function onModelChange(type) {
  const select = document.getElementById(type === 'agent' ? 'agentModelSelect' : 'htmlModelSelect');
  updateModelMeta(type);
  if (type === 'agent') activeModels.agent_model = select.value;
  else activeModels.html_model = select.value;
  localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels));
  const model = getModelById(select.value);
  if (model && !model.apiKey) {
    setTimeout(() => { if (confirm('该模型尚未配置 API 密钥，是否立即配置？')) openModelConfig(model.id); }, 300);
  }
}

function toggleModelPanel(e) {
  e?.stopPropagation();
  const panel = document.getElementById('modelPanel');
  panel.classList.toggle('show');
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
        <div class="model-item-name">${preset?.name || m.provider} · ${m.model}</div>
        <div class="model-item-key">${m.apiKey ? '✅ 密钥已配置' : '⚠️ 未配置密钥'}</div>
      </div>
      <div class="model-item-actions">
        <button class="model-item-btn" onclick="openModelConfig('${m.id}')" title="配置">⚙️</button>
        <button class="model-item-btn model-item-btn-del" onclick="confirmDeleteModel('${m.id}')" title="删除">🗑️</button>
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

async function proxyChat(prompt, level, sessionId, stream = true) {
  const agentModel = getActiveModelForRole('agent');
  if (!agentModel) return null;
  const resp = await fetch('/api/models/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: agentModel.provider,
      api_key: agentModel.apiKey,
      model: agentModel.model,
      base_url: agentModel.baseUrl,
      prompt,
      level,
      session_id: sessionId,
      stream,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API ${resp.status}: ${errText.substring(0, 200)}`);
  }
  return resp;
}

loadUserModels();
