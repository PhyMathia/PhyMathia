const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
// OpenCode Go 预设（2026-09-14 自 https://opencode.ai/zen/go/v1/models 实时拉取；
// 官方列表会滚动更新——预设清单只是初值，弹窗「获取模型列表」可随时在线刷新）。
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
// DeepSeek 官方预置（模型 id 见 https://api-docs.deepseek.com/），
// 密钥在模型面板 DeepSeek 组头统一填一次（platform.deepseek.com 申请）
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

// ====== 模型预设注册表 ======
// 添加模型弹窗「预设供应商」页的事实源：name/tagline 展示、baseUrl 预填、
// models 是勾选清单初值（hot = 默认勾选的推荐项）。清单会过期——用户可点
// 「获取模型列表」在线刷新（POST /api/models/list 代理），或用「其他模型」
// 手填，所以预设清单只是方便，不是门槛。
// 模型 id 口径（2026-09-15 核对各家官方文档）：智谱 glm-5.3 系 / Kimi k3 系
// （k2.5 与 moonshot-v1 已于 2026-08-31 下线，勿再加）/ 百炼 qwen3.8 系 /
// OpenAI gpt-6-astra + gpt-5.6 三档 / Gemini 3.x 系。
function _presetModels(labels, hotIds = []) {
  return Object.entries(labels).map(([id, label]) => ({ id, label, hot: hotIds.includes(id) }));
}

const MODEL_PRESETS = {
  'opencode-go': {
    name: 'OpenCode Go',
    tagline: '订阅制网关：一个密钥用 GLM / Kimi / DeepSeek / Qwen / GPT 等全家桶',
    baseUrl: OPENCODE_GO_BASE_URL,
    apiKeyHint: '需要订阅密钥（opencode.ai）',
    models: _presetModels(OPENCODE_GO_MODEL_LABELS, ['glm-5.3', 'kimi-k3', 'deepseek-v4-pro', 'hy3']),
  },
  opencode: {
    name: 'OpenCode（免费）',
    tagline: 'zen 免费网关，无需密钥即可使用',
    baseUrl: OPENCODE_BASE_URL,
    apiKeyHint: '可填任意内容',
    keyOptional: true,
    models: _presetModels(OPENCODE_FREE_MODEL_LABELS, ['deepseek-v4-flash-free', 'mimo-v2.5-free']),
  },
  deepseek: {
    name: 'DeepSeek（深度求索）',
    tagline: '官方 API：chat 通用 / reasoner 推理，密钥在 platform.deepseek.com 申请',
    baseUrl: 'https://api.deepseek.com',
    apiKeyHint: 'sk-...',
    docs: 'https://platform.deepseek.com/api_keys',
    models: _presetModels({
      'deepseek-chat': 'DeepSeek Chat（V4 通用）',
      'deepseek-reasoner': 'DeepSeek Reasoner（推理）',
    }, ['deepseek-chat']),
  },
  zhipu: {
    name: '智谱 GLM',
    tagline: 'BigModel 平台官方 API，GLM-5.3 旗舰（2026-08 上线）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyHint: '密钥在 open.bigmodel.cn 获取',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: _presetModels({
      'glm-5.3': 'GLM-5.3（旗舰）',
      'glm-5.3-flash': 'GLM-5.3 Flash（轻量）',
      'glm-5.2': 'GLM-5.2',
      'glm-5': 'GLM-5',
    }, ['glm-5.3']),
  },
  moonshot: {
    name: 'Kimi（月之暗面）',
    tagline: '官方 API，Kimi K3 旗舰；k2.5 与 moonshot-v1 系列已于 2026-08-31 下线',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyHint: 'sk-...',
    docs: 'https://platform.kimi.com/docs/get-api-key',
    models: _presetModels({
      'kimi-k3': 'Kimi K3（旗舰）',
      'kimi-k2.7-code': 'Kimi K2.7 Code（编程）',
      'kimi-k2.6': 'Kimi K2.6（通用）',
    }, ['kimi-k3']),
  },
  qwen: {
    name: '通义千问（阿里云百炼）',
    tagline: '百炼 OpenAI 兼容模式；qwen-plus / qwen-flash 是指向最新版的稳定别名',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyHint: 'sk-...',
    docs: 'https://bailian.console.aliyun.com/',
    models: _presetModels({
      'qwen3.8-max': 'Qwen3.8 Max（旗舰）',
      'qwen3.8-flash': 'Qwen3.8 Flash（性价比）',
      'qwen3.7-plus': 'Qwen3.7 Plus',
      'qwen-plus': 'Qwen Plus（最新别名）',
      'qwen-flash': 'Qwen Flash（最新别名）',
    }, ['qwen3.8-max', 'qwen3.8-flash']),
  },
  doubao: {
    name: '豆包（火山方舟）',
    tagline: '字节方舟网关；模型 ID / 接入点在方舟控制台查看，或点「获取模型列表」在线拉取',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyHint: '密钥在 console.volcengine.com/ark 获取',
    docs: 'https://www.volcengine.com/docs/82379/1330310',
    models: [],
  },
  minimax: {
    name: 'MiniMax',
    tagline: '开放平台官方 API（国内站 api.minimaxi.com；国际站把地址换成 api.minimax.io）',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKeyHint: '密钥在 platform.minimaxi.com 获取',
    models: _presetModels({
      'MiniMax-M3': 'MiniMax M3（旗舰）',
      'MiniMax-M2.7-highspeed': 'MiniMax M2.7 高速版',
    }, ['MiniMax-M3']),
  },
  siliconflow: {
    name: '硅基流动',
    tagline: '一个密钥聚合百家开源模型（DeepSeek/Qwen/GLM…），完整清单点「获取模型列表」',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyHint: 'sk-...',
    docs: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro', hot: true },
      { id: 'Qwen/Qwen3.5-397B-A17B', label: 'Qwen3.5 397B', hot: false },
      { id: 'Qwen/Qwen3-8B', label: 'Qwen3 8B（轻量）', hot: false },
    ],
  },
  openai: {
    name: 'OpenAI',
    tagline: '官方 API：GPT-6 Astra 旗舰 + GPT-5.6 三档（Sol/Terra/Luna）',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyHint: 'sk-...',
    models: _presetModels({
      'gpt-6-astra': 'GPT-6 Astra（旗舰）',
      'gpt-5.6-sol': 'GPT-5.6 Sol（强）',
      'gpt-5.6-terra': 'GPT-5.6 Terra（均衡）',
      'gpt-5.6-luna': 'GPT-5.6 Luna（低价）',
    }, ['gpt-5.6-terra']),
  },
  gemini: {
    name: 'Google Gemini',
    tagline: 'AI Studio 的 OpenAI 兼容端点；密钥在 aistudio.google.com 免费申请',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyHint: 'AI Studio API 密钥',
    docs: 'https://aistudio.google.com/app/apikey',
    models: _presetModels({
      'gemini-3.1-pro': 'Gemini 3.1 Pro',
      'gemini-3.8-flash': 'Gemini 3.8 Flash',
      'gemini-3.5-flash': 'Gemini 3.5 Flash',
      'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite（轻量）',
    }, ['gemini-3.1-pro', 'gemini-3.8-flash']),
  },
  anthropic: {
    name: 'Anthropic Claude',
    tagline: '官方 OpenAI 兼容端点（api.anthropic.com/v1）',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyHint: 'sk-ant-...',
    models: _presetModels({
      'cla-opus-4-5': 'Claude Opus 4.5',
      'cla-sonnet-4-5': 'Claude Sonnet 4.5',
      'cla-haiku-4-5': 'Claude Haiku 4.5（轻量）',
    }, ['cla-sonnet-4-5']),
  },
  openrouter: {
    name: 'OpenRouter（聚合）',
    tagline: '数百模型一个密钥；清单变化快，点「获取模型列表」在线拉取（无需密钥）',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyHint: 'sk-or-...',
    docs: 'https://openrouter.ai/keys',
    models: [],
  },
  groq: {
    name: 'Groq',
    tagline: '云端超快推理（免费档可用）；完整清单点「获取模型列表」',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyHint: 'gsk_...',
    docs: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', hot: true },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', hot: false },
    ],
  },
  ollama: {
    name: 'Ollama（本地）',
    tagline: '本机 Ollama 服务，无需密钥；点「获取模型列表」列出本机已安装模型',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyHint: '本地服务无需密钥',
    keyOptional: true,
    models: [],
  },
  lmstudio: {
    name: 'LM Studio（本地）',
    tagline: '本机 LM Studio 本地服务器（默认端口 1234），无需密钥',
    baseUrl: 'http://localhost:1234/v1',
    apiKeyHint: '本地服务无需密钥',
    keyOptional: true,
    models: [],
  },
  llama: {
    name: 'llama.cpp（本地）',
    tagline: '本机 llama-server（默认端口 8080），无需密钥',
    baseUrl: 'http://localhost:8080/v1',
    apiKeyHint: '本地服务无需密钥',
    keyOptional: true,
    models: [],
  },
};
// const 声明不会挂到全局对象上：显式挂 window，供测试与跨模块读取注册表
window.MODEL_PRESETS = MODEL_PRESETS;

const MODELS_STORAGE_KEY = 'phymathia_user_models';
// 模型分组密钥：按 provider 分组，一组共用一个密钥（如 OpenCode Go 订阅 key 组内共用）。
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

// 思考程度（模型条目上的 thinking 字段）：''（default）= 跟随模型默认不发送参数；
// low/high/max 由后端按供应商族映射（reasoning_effort 三档拉伸 / enable_thinking /
// thinking.type / think），上游不认识时自动剥掉重发（见 main.py _thinking_request_params）。
const THINKING_LEVELS = ['low', 'high', 'max'];
window.THINKING_LEVELS = THINKING_LEVELS;

function loadUserModels() {
  try {
    const raw = localStorage.getItem(MODELS_STORAGE_KEY);
    userModelConfigs = raw ? JSON.parse(raw) : [];
  } catch { userModelConfigs = []; }
  loadGroupKeys();
  // 刻意不预置任何模型：列表里只出现用户在「添加模型」里主动加过的条目。
  // （旧版 _ensure* 每次 loadUserModels 都把 OpenCode/DeepSeek 预设全量灌进列表，
  //  用户反馈「没添加过的预设不该出现」——预设只活在添加弹窗里。）
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

// 六个槽位键：删除模型后把指向它的槽位引用一并清空
function _clearActiveModelRefs(ids) {
  let changed = false;
  for (const key of ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model']) {
    if (ids.includes(activeModels[key])) {
      activeModels[key] = '';
      changed = true;
    }
  }
  if (changed) localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels));
}

function deleteUserModel(id) {
  userModelConfigs = userModelConfigs.filter(m => m.id !== id);
  _clearActiveModelRefs([id]);
  saveUserModels();
}

// 整组删除：清理旧版自动预置的大分组（如 37 个 OpenCode Go 条目）的出口
function deleteModelGroup(provider) {
  const ids = userModelConfigs.filter(m => m.provider === provider).map(m => m.id);
  if (!ids.length) return 0;
  userModelConfigs = userModelConfigs.filter(m => m.provider !== provider);
  _clearActiveModelRefs(ids);
  delete modelGroupKeys[provider];
  try { localStorage.setItem(MODEL_GROUP_KEYS_STORAGE, JSON.stringify(modelGroupKeys)); } catch {}
  saveUserModels();
  return ids.length;
}

function confirmDeleteModelGroup(provider) {
  const preset = MODEL_PRESETS[provider];
  const name = (preset && preset.name) || provider;
  const count = userModelConfigs.filter(m => m.provider === provider).length;
  if (!count) return;
  if (!confirm(`确定删除「${name}」分组的全部 ${count} 个模型吗？（分组密钥也会一并删除）`)) return;
  deleteModelGroup(provider);
  renderModelList();
  renderModelSelects();
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
  // 悬空引用清理：槽位指向已删除的条目时回空（不强行回退到任何预设——
  // 列表里只该有用户主动加过的模型，回空由界面提示补配）
  for (const key of ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model']) {
    if (activeModels[key] && !getModelById(activeModels[key])) activeModels[key] = '';
  }
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
      descEl.textContent = select.value ? '' : '未配置模型。请在下方「管理自定义模型」里添加';
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
    container.innerHTML = '<div class="model-empty">暂无模型。点击下方「添加模型」：<br>从预设供应商勾选添加（只需填密钥），或手动配置</div>';
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
      const showThinking = THINKING_LEVELS.includes(m.thinking);
      return `<div class="model-item">
        <div class="model-item-info">
          <div class="model-item-name">${escapeHtml(m.label || m.model)}${showThinking ? `<span class="model-item-thinking">思考:${escapeHtml(m.thinking)}</span>` : ''}</div>
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
        <button class="model-group-refresh" onclick="openModelListUpdate('${jsProvider}')" title="从上游更新模型列表（对比新增 / 已下线）">${UI_ICON_SVG.reset}</button>
        <button class="model-group-del" onclick="confirmDeleteModelGroup('${jsProvider}')" title="删除该分组的全部模型">${UI_ICON_SVG.trash}</button>
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
  document.getElementById('mcThinking').value = model.thinking || '';
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
  const thinking = document.getElementById('mcThinking').value || '';
  if (!model) { alert('请填写模型名称'); return; }
  const ok = updateUserModel(id, { apiKey, model, baseUrl, thinking });
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

// ====== 添加模型：预设供应商 / 手动添加 双模式 =====
// 设计对齐主流 Agent 客户端：预设页只需选供应商 + 填密钥 + 勾模型（地址已预填、
// 清单可在线刷新）；手动页填供应商名/地址/密钥 + 每行一个模型。
// 列表里只出现这里加过的条目——预设本身不落库。

let _addModelTab = 'preset'; // 'preset' | 'manual'

function switchAddModelTab(tab) {
  _addModelTab = tab === 'manual' ? 'manual' : 'preset';
  const presetBtn = document.getElementById('amTabPreset');
  const manualBtn = document.getElementById('amTabManual');
  const presetPane = document.getElementById('amPresetPane');
  const manualPane = document.getElementById('amManualPane');
  if (!presetBtn || !manualBtn || !presetPane || !manualPane) return;
  presetBtn.classList.toggle('active', _addModelTab === 'preset');
  manualBtn.classList.toggle('active', _addModelTab === 'manual');
  presetPane.hidden = _addModelTab !== 'preset';
  manualPane.hidden = _addModelTab !== 'manual';
}

function showAddModelDialog() {
  // 供应商下拉选项从 MODEL_PRESETS 现算——注册表是唯一事实源，HTML 不再手写第二份
  const select = document.getElementById('newProvider');
  if (select) {
    select.innerHTML = Object.entries(MODEL_PRESETS)
      .map(([id, p]) => `<option value="${escapeHtml(id)}">${escapeHtml(p.name)}</option>`).join('');
    select.value = Object.keys(MODEL_PRESETS)[0];
  }
  document.getElementById('newCustomProvider').value = '';
  document.getElementById('newApiKey').value = '';
  document.getElementById('newExtraModels').value = '';
  document.getElementById('newManualModels').value = '';
  document.getElementById('manualFetchStatus').textContent = '';
  updateNewModelPreset();
  switchAddModelTab('preset');
  document.getElementById('addModelDialog').classList.add('show');
}

function closeAddModelDialog() {
  document.getElementById('addModelDialog').classList.remove('show');
}

function _presetModelRowHtml(id, label, checked) {
  // id 进 value 属性做 HTML 转义；label 是注册表文案（同样转义防未来被自由输入污染）
  return `<label class="am-model-check">
    <input type="checkbox" value="${escapeHtml(id)}"${checked ? ' checked' : ''}>
    <span class="am-model-check-name">${escapeHtml(label || id)}</span>
    <span class="am-model-check-id">${escapeHtml(id)}</span>
  </label>`;
}

function updateNewModelPreset() {
  const provider = document.getElementById('newProvider').value;
  const preset = MODEL_PRESETS[provider];
  if (!preset) return;
  document.getElementById('newBaseUrl').value = preset.baseUrl;
  document.getElementById('newApiKey').placeholder = preset.keyOptional
    ? (preset.apiKeyHint || '可选，本地/免费服务可留空')
    : (preset.apiKeyHint || 'sk-...');
  const metaEl = document.getElementById('newProviderMeta');
  if (metaEl) {
    const link = preset.docs ? ` · <a href="${escapeHtml(preset.docs)}" target="_blank" rel="noopener">获取密钥</a>` : '';
    metaEl.innerHTML = escapeHtml(preset.tagline || '') + link;
  }
  const listEl = document.getElementById('presetModelList');
  if (listEl) {
    const rows = preset.models.map(m => _presetModelRowHtml(m.id, m.label, !!m.hot));
    listEl.innerHTML = rows.length
      ? rows.join('')
      : '<div class="am-model-empty">未内置清单——点右侧「获取模型列表」在线拉取，或在下方手动填写</div>';
  }
  const statusEl = document.getElementById('presetFetchStatus');
  if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('am-fetch-error'); }
}

function toggleAllPresetModels() {
  const boxes = Array.from(document.querySelectorAll('#presetModelList input[type="checkbox"]'));
  if (!boxes.length) return;
  const checkAll = boxes.some(b => !b.checked);
  boxes.forEach(b => { b.checked = checkAll; });
}

// 「其他模型」输入解析：中英文逗号 / 换行分隔，支持「id | 显示名」
function _parseExtraModelInput(text) {
  return String(text || '').split(/[,，\n]+/).map(s => s.trim()).filter(Boolean).map(seg => {
    const sepIdx = seg.indexOf('|');
    if (sepIdx === -1) return { model: seg, label: '' };
    return { model: seg.slice(0, sepIdx).trim(), label: seg.slice(sepIdx + 1).trim() };
  }).filter(e => e.model);
}

function _setFetchStatus(elId, text, isError) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('am-fetch-error', !!isError);
}

// 添加弹窗密钥取值：优先弹窗输入；留空时回落到该供应商已保存的分组密钥——
// 组里已有密钥时不填也能在线拉清单（与「添加」时空密钥继承组密钥同口径）。
// 返回 fromSaved 让状态行说明密钥来源，用户不至于疑惑密钥从哪来的。
function _dialogApiKeyWithFallback(provider) {
  const typed = document.getElementById('newApiKey').value.trim();
  if (typed) return { key: typed, fromSaved: false };
  const saved = getGroupKey(provider);
  return { key: saved, fromSaved: !!saved };
}

// 在线补充行去重（纯逻辑，冒烟直测）：已列出的 id 不再追加，保持上游顺序。
// 上游清单本身由后端去重排序，这里只管「清单 vs 弹窗已列出」的差集。
function _freshIdsNotListed(listedIds, freshIds) {
  const seen = new Set(Array.isArray(listedIds) ? listedIds : []);
  return (Array.isArray(freshIds) ? freshIds : []).filter(id => !seen.has(id));
}

async function fetchProviderModelList() {
  const provider = document.getElementById('newProvider').value;
  const baseUrl = document.getElementById('newBaseUrl').value.trim();
  const { key: apiKey, fromSaved } = _dialogApiKeyWithFallback(provider);
  const btn = document.getElementById('presetFetchBtn');
  _setFetchStatus('presetFetchStatus', fromSaved ? '正在获取…（密钥留空，使用已保存的分组密钥）' : '正在获取…', false);
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/models/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, api_key: apiKey, base_url: baseUrl }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `API ${resp.status}`);
    if (provider !== document.getElementById('newProvider').value) return; // 异步期间换了供应商，弃用
    const listEl = document.getElementById('presetModelList');
    // 已列出的全部行（内置预设 + 之前的在线补充）都是去重口径——重复点获取只刷新统计，
    // 不再堆出多个「在线获取的补充模型」段（2026-09-25 用户反馈）
    const listed = listEl ? Array.from(listEl.querySelectorAll('.am-model-check input')).map(cb => cb.value) : [];
    const fresh = _freshIdsNotListed(listed, data.models || []);
    if (listEl && fresh.length) {
      const empty = listEl.querySelector('.am-model-empty');
      if (empty) empty.remove();
      // 追加段独立标记：全选/统计能区分「内置」与「在线补充」；标签只保留一份
      if (!listEl.querySelector('.am-model-group-label')) {
        listEl.insertAdjacentHTML('beforeend', '<div class="am-model-group-label">在线获取的补充模型</div>');
      }
      listEl.insertAdjacentHTML('beforeend', fresh.map(id => _presetModelRowHtml(id, id, false)).join(''));
    }
    _setFetchStatus('presetFetchStatus', fresh.length
      ? `新增 ${fresh.length} 个可选项（共 ${data.models.length} 个）`
      : `已列出全部 ${data.models.length} 个模型`, false);
  } catch (e) {
    _setFetchStatus('presetFetchStatus', `获取失败：${e.message}（可手填模型名）`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function fetchManualModelList() {
  const provider = document.getElementById('newCustomProvider').value.trim();
  const baseUrl = document.getElementById('newBaseUrl').value.trim();
  const { key: apiKey, fromSaved } = _dialogApiKeyWithFallback(provider);
  if (!baseUrl) { _setFetchStatus('manualFetchStatus', '请先填写 API 地址', true); return; }
  const btn = document.getElementById('manualFetchBtn');
  _setFetchStatus('manualFetchStatus', fromSaved ? '正在获取…（密钥留空，使用已保存的分组密钥）' : '正在获取…', false);
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/models/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, api_key: apiKey, base_url: baseUrl }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `API ${resp.status}`);
    const ids = data.models || [];
    if (!ids.length) throw new Error('上游返回了空列表');
    const ta = document.getElementById('newManualModels');
    if (ta) ta.value = ids.join('\n');
    _setFetchStatus('manualFetchStatus', `已填入 ${ids.length} 个模型，可删减`, false);
  } catch (e) {
    _setFetchStatus('manualFetchStatus', `获取失败：${e.message}（可手动逐行填写）`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 纯添加核心（无 DOM，冒烟直测）：同 provider+model 重复跳过；密钥走组密钥通道
// （非空时统一落组并同步既有条目，空则继承组里已有密钥）。返回实际新增条数。
function addModelsForProvider(provider, apiKey, baseUrl, entries) {
  const preset = MODEL_PRESETS[provider];
  const finalBaseUrl = baseUrl || preset?.baseUrl || '';
  const effectiveKey = apiKey || getGroupKey(provider) || '';
  let added = 0;
  for (const e of entries) {
    if (!e || !e.model) continue;
    if (userModelConfigs.some(c => c.provider === provider && c.model === e.model)) continue;
    addUserModel({ provider, apiKey: effectiveKey, model: e.model, label: e.label || e.model, baseUrl: finalBaseUrl });
    added++;
  }
  if (apiKey) saveGroupKey(provider, apiKey);
  return added;
}

function _savePresetModels() {
  const provider = document.getElementById('newProvider').value;
  const preset = MODEL_PRESETS[provider];
  if (!preset) { alert('请选择供应商'); return -1; }
  const apiKey = document.getElementById('newApiKey').value.trim();
  const baseUrl = document.getElementById('newBaseUrl').value.trim() || preset.baseUrl;
  const labelOf = id => preset.models.find(m => m.id === id)?.label || '';
  const entries = [];
  document.querySelectorAll('#presetModelList input[type="checkbox"]:checked').forEach(cb => {
    entries.push({ model: cb.value, label: labelOf(cb.value) });
  });
  for (const extra of _parseExtraModelInput(document.getElementById('newExtraModels').value)) {
    if (!entries.some(e => e.model === extra.model)) entries.push(extra);
  }
  if (!entries.length) { alert('请至少勾选或填写一个模型'); return -1; }
  return addModelsForProvider(provider, apiKey, baseUrl, entries);
}

function _saveManualModels() {
  const provider = document.getElementById('newCustomProvider').value.trim();
  const baseUrl = document.getElementById('newBaseUrl').value.trim();
  const apiKey = document.getElementById('newApiKey').value.trim();
  if (!provider) { alert('请填写供应商名称'); return -1; }
  if (!baseUrl) { alert('请填写 API 地址'); return -1; }
  const entries = [];
  for (const line of String(document.getElementById('newManualModels').value || '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const sepIdx = raw.indexOf('|');
    const model = (sepIdx === -1 ? raw : raw.slice(0, sepIdx)).trim();
    const label = (sepIdx === -1 ? '' : raw.slice(sepIdx + 1)).trim();
    if (model) entries.push({ model, label });
  }
  if (!entries.length) { alert('请至少填写一个模型（每行一个）'); return -1; }
  return addModelsForProvider(provider, apiKey, baseUrl, entries);
}

function saveNewModel() {
  const added = _addModelTab === 'manual' ? _saveManualModels() : _savePresetModels();
  if (added < 0) return; // 校验失败已在对应分支提示
  closeAddModelDialog();
  renderModelList();
  renderModelSelects();
  if (typeof showToast === 'function') {
    showToast(added > 0 ? `已添加 ${added} 个模型` : '没有新增模型（可能都已添加过）', 2600);
  }
}

// ====== 组级「更新模型列表」：已添加分组的在线刷新 ======
// 预设清单只是初值，已添加的分组也不会自己跟上上游——组头 ↻ 按钮经
// /api/models/list 在线拉取，与本地条目做差集：新增的可勾选加入，上游已
// 不列出的（下线或未开放）可勾选移除。两段都默认不勾：延续「没主动添加的
// 不进列表」的拍板，也防聚合商一拉几百个被一键灌爆；移除是破坏性操作同理。

// 纯 diff（无 DOM，冒烟直测）：入参去空白去重后对比。added 按上游顺序，
// removed 保持本地出现顺序。
function diffUpstreamModels(existingIds, upstreamIds) {
  const norm = arr => (Array.isArray(arr) ? arr : []).map(s => String(s == null ? '' : s).trim()).filter(Boolean);
  const upstream = [];
  const upSet = new Set();
  for (const id of norm(upstreamIds)) {
    if (!upSet.has(id)) { upSet.add(id); upstream.push(id); }
  }
  const local = [];
  const localSet = new Set();
  for (const id of norm(existingIds)) {
    if (!localSet.has(id)) { localSet.add(id); local.push(id); }
  }
  return {
    added: upstream.filter(id => !localSet.has(id)),
    removed: local.filter(id => !upSet.has(id)),
  };
}

// 纯应用核心（无 DOM，冒烟直测）：新增走 addModelsForProvider（重复跳过、
// 密钥继承组密钥通道），移除逐条 deleteUserModel（悬空槽位引用一并清）。
// 返回实际新增/移除条数。
function _applyModelListDiff(provider, baseUrl, addedEntries, removedModelIds) {
  let addedCount = 0;
  if (Array.isArray(addedEntries) && addedEntries.length) {
    addedCount = addModelsForProvider(provider, getGroupKey(provider), baseUrl, addedEntries);
  }
  const removeSet = new Set(Array.isArray(removedModelIds) ? removedModelIds : []);
  let removedCount = 0;
  if (removeSet.size) {
    const doomed = userModelConfigs.filter(c => c.provider === provider && removeSet.has(c.model));
    for (const m of doomed) deleteUserModel(m.id);
    removedCount = doomed.length;
  }
  return { added: addedCount, removed: removedCount };
}

// 当前更新会话的上下文：{ provider, baseUrl, diff }；异步回包时靠引用比对弃用过期结果
let _modelUpdateCtx = null;

function openModelListUpdate(provider) {
  const entry = userModelConfigs.find(m => m.provider === provider);
  if (!entry) return;
  const baseUrl = entry.baseUrl || MODEL_PRESETS[provider]?.baseUrl || '';
  if (!baseUrl) { alert('该分组没有可用的 API 地址，请先在单个模型配置里补上'); return; }
  _modelUpdateCtx = { provider, baseUrl, diff: null };
  document.getElementById('umGroupTitle').textContent = MODEL_PRESETS[provider]?.name || provider;
  document.getElementById('umNewSection').hidden = true;
  document.getElementById('umStaleSection').hidden = true;
  document.getElementById('umSameNote').hidden = true;
  document.getElementById('umNewList').innerHTML = '';
  document.getElementById('umStaleList').innerHTML = '';
  document.getElementById('updateModelsDialog').classList.add('show');
  _fetchModelListForUpdate();
}

function refetchModelListUpdate() {
  if (_modelUpdateCtx) _fetchModelListForUpdate();
}

function closeModelListUpdate() {
  document.getElementById('updateModelsDialog').classList.remove('show');
  _modelUpdateCtx = null;
}

async function _fetchModelListForUpdate() {
  const ctx = _modelUpdateCtx;
  if (!ctx) return;
  const provider = ctx.provider;
  const fetchBtn = document.getElementById('umFetchBtn');
  const applyBtn = document.getElementById('umApplyBtn');
  const statusEl = document.getElementById('umFetchStatus');
  statusEl.textContent = '正在从上游获取模型列表…';
  statusEl.classList.remove('um-fetch-error');
  if (fetchBtn) fetchBtn.disabled = true;
  if (applyBtn) applyBtn.disabled = true;
  try {
    const apiKey = getGroupKey(provider) || (userModelConfigs.find(m => m.provider === provider)?.apiKey) || '';
    const resp = await fetch('/api/models/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, api_key: apiKey, base_url: ctx.baseUrl }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `API ${resp.status}`);
    // 回包时弹窗已关或已换分组 → 弃用（与添加弹窗「异步期间切换则弃用」同守卫）
    if (_modelUpdateCtx !== ctx || !document.getElementById('updateModelsDialog').classList.contains('show')) return;
    const existing = userModelConfigs.filter(m => m.provider === provider).map(m => m.model);
    const diff = diffUpstreamModels(existing, data.models || []);
    ctx.diff = diff;
    _renderUpdateDialog(provider, diff, (data.models || []).length);
  } catch (e) {
    if (_modelUpdateCtx !== ctx) return;
    statusEl.textContent = `获取失败：${e.message}（可点「重新获取」重试）`;
    statusEl.classList.add('um-fetch-error');
  } finally {
    if (fetchBtn) fetchBtn.disabled = false;
  }
}

function _renderUpdateDialog(provider, diff, upstreamTotal) {
  const preset = MODEL_PRESETS[provider];
  const localEntries = userModelConfigs.filter(m => m.provider === provider);
  const presetLabelOf = id => (preset?.models || []).find(m => m.id === id)?.label || '';
  const localLabelOf = id => {
    const hit = localEntries.find(m => m.model === id);
    return hit ? (hit.label || hit.model) : id;
  };
  const statusEl = document.getElementById('umFetchStatus');
  statusEl.classList.remove('um-fetch-error');
  statusEl.textContent = `上游共 ${upstreamTotal} 个模型：新增 ${diff.added.length}，已下线 ${diff.removed.length}，已有 ${localEntries.length - diff.removed.length} 个不受影响`;
  document.getElementById('umNewList').innerHTML = '';
  document.getElementById('umStaleList').innerHTML = '';
  document.getElementById('umNewAll').checked = false;
  document.getElementById('umStaleAll').checked = false;
  // 计数一并重置：上一次打开留下的数字不能漏进这次的小节头
  document.getElementById('umNewCount').textContent = '0';
  document.getElementById('umStaleCount').textContent = '0';
  document.getElementById('umNewSection').hidden = !diff.added.length;
  document.getElementById('umStaleSection').hidden = !diff.removed.length;
  document.getElementById('umSameNote').hidden = !!(diff.added.length || diff.removed.length);
  if (diff.added.length) {
    document.getElementById('umNewCount').textContent = String(diff.added.length);
    document.getElementById('umNewList').innerHTML = diff.added.map(id => _presetModelRowHtml(id, presetLabelOf(id) || id, false)).join('');
  }
  if (diff.removed.length) {
    document.getElementById('umStaleCount').textContent = String(diff.removed.length);
    document.getElementById('umStaleList').innerHTML = diff.removed.map(id => _presetModelRowHtml(id, localLabelOf(id), false)).join('');
  }
  const applyBtn = document.getElementById('umApplyBtn');
  if (applyBtn) applyBtn.disabled = !(diff.added.length || diff.removed.length);
}

// 小节头「全选」复选框：只管自己小节里的行
function toggleUmSectionAll(listId, checked) {
  document.querySelectorAll('#' + listId + ' input[type="checkbox"]').forEach(cb => { cb.checked = !!checked; });
}

function applyModelListUpdate() {
  const ctx = _modelUpdateCtx;
  if (!ctx || !ctx.diff) return;
  const provider = ctx.provider;
  const addedEntries = Array.from(document.querySelectorAll('#umNewList input[type="checkbox"]:checked')).map(cb => {
    const id = cb.value;
    return { model: id, label: (MODEL_PRESETS[provider]?.models || []).find(m => m.id === id)?.label || '' };
  });
  const removedIds = Array.from(document.querySelectorAll('#umStaleList input[type="checkbox"]:checked')).map(cb => cb.value);
  if (!addedEntries.length && !removedIds.length) { closeModelListUpdate(); return; }
  const res = _applyModelListDiff(provider, ctx.baseUrl, addedEntries, removedIds);
  closeModelListUpdate();
  renderModelList();
  renderModelSelects();
  if (typeof showToast === 'function') {
    showToast(`已更新「${MODEL_PRESETS[provider]?.name || provider}」：新增 ${res.added} 个，移除 ${res.removed} 个`, 2600);
  }
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
      thinking: model.thinking || '',
      device_id: (typeof getDeviceId === 'function' ? getDeviceId() : ''),
      // 网关会话分桶：没有聊天会话 id 的旧格式调用按功能落稳定桶
      // （后端按 session_bucket 白名单消毒后用作 x-opencode-session）；
      // 主聊天 proxyChat 传的是 session_id，优先级更高
      session_bucket: body.session_bucket || 'phymathia-web',
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
