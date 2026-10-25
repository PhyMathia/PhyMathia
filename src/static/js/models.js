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
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision',
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
// ⚠️ 2026-09-27：**「OpenCode（免费）」预置已整块删除**（用户决定：不需要给它专门标识）。
// 删除理由不是「清单过期」那么简单，是**这批免费模型第三方根本调不通**：
// 逐个真发验证上游 11 个 `-free` 模型，只有 `space-bunny-free` 能被第三方 API 调用，
// 其余 10 个分三类失败，且**都不是重试或过期能解决的**：
//   - 6 个 `FreeTierError`：free tier can only be used from within OpenCode
//     （网关侧写死的策略——免费额度只给 OpenCode 客户端本身，PhyMathia 作为
//      第三方调用方永远调不通）
//   - 2 个 `RegionError`：not available in your country（muse-spark-1.2/1.3-contributor-free）
//   - `deepseek-v4-flash-free`「Model is unavailable」；`jev-1.13-free`「Internal server error」
// 关键认知：**`-free` 后缀只代表「对 OpenCode 客户端免费」，不代表「对第三方 API 可调用」**。
// 留着一个只含 1 个模型的「免费」预置，会让人以为「填个网址就能白嫖一堆模型」。
//
// 仍然想用免费模型的用户走「手动添加」自己配（就是下面这个入口，2026-09-27 实测可用）：
//   供应商填 `opencode`（或任意自定义名）、baseUrl 填 https://opencode.ai/zen/v1、
//   密钥留空、模型名填 space-bunny-free。
// 加模型时可用「手动添加 → ↻ 获取模型列表」拉全量清单（该接口公开可读，不带 Bearer
// 才读得到，见 docs/dev/models-api.md），但**清单只说明「上游列得出」，不说明
// 「调得动」**——要自己发一发验证；上面那三类失败都不会在清单里体现。

// ====== 模型预设注册表 ======
// 添加模型弹窗「预设供应商」页的事实源：name/tagline 展示、baseUrl 预填、
// models 是勾选清单初值（hot = 默认勾选的推荐项）。清单会过期——用户可点
// 「获取模型列表」在线刷新（POST /api/models/list 代理），或用「其他模型」
// 手填，所以预设清单只是方便，不是门槛。
// 模型 id 口径（2026-09-15 核对各家官方文档）：智谱 glm-5.3 系 / Kimi k3 系
// （k2.5 与 moonshot-v1 已于 2026-08-31 下线，勿再加）/ 百炼 qwen3.8 系 /
// OpenAI gpt-6-astra + gpt-5.6 三档 / Gemini 3.x 系 /
// 小米 MiMo v2.6 系（2026-10-11 核对 mimo.mi.com 官方 model.md，v2.5 系 10-21 下线）。
// 标签口径（2026-10-11 用户拍板）：label 一律光模型名，不挂（旗舰）（性价比）这类注解；
// 档位/定位说明放供应商 tagline，不进模型名。
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
  deepseek: {
    name: 'DeepSeek（深度求索）',
    tagline: '官方 API：chat 通用 / reasoner 推理，密钥在 platform.deepseek.com 申请',
    baseUrl: 'https://api.deepseek.com',
    apiKeyHint: 'sk-...',
    docs: 'https://platform.deepseek.com/api_keys',
    models: _presetModels({
      'deepseek-chat': 'DeepSeek Chat',
      'deepseek-reasoner': 'DeepSeek Reasoner',
    }, ['deepseek-chat']),
  },
  zhipu: {
    name: '智谱 GLM',
    tagline: 'BigModel 平台官方 API，GLM-5.3 旗舰（2026-08 上线）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyHint: '密钥在 open.bigmodel.cn 获取',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: _presetModels({
      'glm-5.3': 'GLM-5.3',
      'glm-5.3-flash': 'GLM-5.3 Flash',
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
      'kimi-k3': 'Kimi K3',
      'kimi-k2.7-code': 'Kimi K2.7 Code',
      'kimi-k2.6': 'Kimi K2.6',
    }, ['kimi-k3']),
  },
  qwen: {
    name: '通义千问（阿里云百炼）',
    tagline: '百炼 OpenAI 兼容模式；qwen-plus / qwen-flash 是指向最新版的稳定别名',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyHint: 'sk-...',
    docs: 'https://bailian.console.aliyun.com/',
    models: _presetModels({
      'qwen3.8-max': 'Qwen3.8 Max',
      'qwen3.8-flash': 'Qwen3.8 Flash',
      'qwen3.7-plus': 'Qwen3.7 Plus',
      'qwen-plus': 'Qwen Plus',
      'qwen-flash': 'Qwen Flash',
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
      'MiniMax-M3': 'MiniMax M3',
      'MiniMax-M2.7-highspeed': 'MiniMax M2.7 高速版',
    }, ['MiniMax-M3']),
  },
  mimo: {
    name: '小米 MiMo',
    tagline: '小米官方 API，v2.6 系 1M 上下文深度思考（ultraspeed 限流需联系官方定制）；v2.5 系 2026-10-21 下线勿再加',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKeyHint: 'sk-...（Token 套餐密钥为 tp-... / ttp-...）',
    docs: 'https://platform.xiaomimimo.com/#/console/api-keys',
    models: _presetModels({
      'mimo-v2.6-pro': 'MiMo V2.6 Pro',
      'mimo-v2.6-flash': 'MiMo V2.6 Flash',
      'mimo-v2.6-pro-ultraspeed': 'MiMo V2.6 Pro UltraSpeed',
    }, ['mimo-v2.6-pro', 'mimo-v2.6-flash']),
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
      { id: 'Qwen/Qwen3-8B', label: 'Qwen3 8B', hot: false },
    ],
  },
  openai: {
    name: 'OpenAI',
    tagline: '官方 API：GPT-6 Astra 旗舰 + GPT-5.6 三档（Sol/Terra/Luna）',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyHint: 'sk-...',
    models: _presetModels({
      'gpt-6-astra': 'GPT-6 Astra',
      'gpt-5.6-sol': 'GPT-5.6 Sol',
      'gpt-5.6-terra': 'GPT-5.6 Terra',
      'gpt-5.6-luna': 'GPT-5.6 Luna',
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
      'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
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
      'cla-haiku-4-5': 'Claude Haiku 4.5',
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

// 组密钥写入（2026-10-24 重做语义，密钥丢失复盘）：
//  · trim 后落盘——粘贴带换行/空格的钥原样送上游必 401（看着像「钥没了」）
//  · 只同步给**继承了组密钥**的条目（自己没钥，或钥＝旧组钥）；单条目在配置
//    弹窗里单独设过的钥是用户的显式选择，不被组密钥覆盖（旧版无差别覆盖）
//  · 清空＝显式动作：继承的条目钥一并清，并把条目 id 记进「待清空清单」——
//    服务端整包上传默认「缺钥＝保留」，只有清单点名的才真删
function saveGroupKey(provider, key) {
  const prev = modelGroupKeys[provider] || '';
  const next = String(key == null ? '' : key).trim();
  modelGroupKeys[provider] = next;
  try { localStorage.setItem(MODEL_GROUP_KEYS_STORAGE, JSON.stringify(modelGroupKeys)); } catch (e) {}
  let changed = false;
  for (const cfg of userModelConfigs) {
    if (cfg.provider !== provider) continue;
    const inherited = !cfg.apiKey || cfg.apiKey === prev; // 空＝还没有钥，等于旧组钥＝继承来的
    if (!inherited) continue;                            // 单条目自有钥：不动
    if (cfg.apiKey === next) continue;
    if (cfg.apiKey && !next) _markModelKeyCleared(cfg.id);
    cfg.apiKey = next;
    changed = true;
  }
  if (changed) saveUserModels();
  else scheduleModelsSync(); // 只动了组密钥、条目没变也要上传（saveUserModels 里已含镜像写入）
  _refreshGroupKeyBadges(provider);
}

// 备份导入通道（ui-backup.js 调用）：合并组密钥——本地仍持有的组密钥优先
// （与导入时 apiKey 合并同口径），缺失的组从备份补入；saveGroupKey 顺带把组密钥
// 同步到组内条目并走统一保存出口。按 localStorage 判「本地仍持有」，replace 模式
// 清过存储后内存已被 reloadModelsFromStorage 拉空，两处口径一致。
function importModelGroupKeys(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(MODEL_GROUP_KEYS_STORAGE) || '{}') || {}; } catch (e) {}
  for (const [provider, key] of Object.entries(incoming)) {
    if (typeof key !== 'string' || !key) continue;
    if (!stored[provider]) saveGroupKey(provider, key);
  }
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

// 分组密钥失焦提交：全量重渲染（刷新组内徽标）+ 输入框闪绿提示保存成功。
// 空值只可能是人主动清空（或密码管理器把框清掉）——清空前确认一次：点开面板、
// 按了下退格再点别处，不该把整组密钥抹掉（旧版 oninput 逐键落盘，这种手滑当场
// 就写进了 auth.json）。逐键保存已经删掉：只有失焦这一处落盘。
function saveGroupKeyCommitted(provider, inputEl) {
  const raw = String((inputEl && inputEl.value) || '').trim();
  const prev = getGroupKey(provider);
  if (!raw && prev) {
    const preset = MODEL_PRESETS[provider];
    const name = (preset && preset.name) || provider;
    if (!confirm('清空「' + name + '」的分组密钥？组内继承该密钥的模型会一起失去密钥。')) {
      renderModelList();
      return;
    }
  }
  saveGroupKey(provider, raw);
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

// 思考程度：2026-10-11 起改挂**槽位**（activeModels 的 <role>_thinking 键），不再挂模型条目
// ——同一个模型主聊天要深思、出题/可视化不要，档位跟着用途走而不是跟着模型走。取值：
// ''（跟随模型默认，不发思考参数）/ on / off / low / high / max，由后端按供应商族映射
// （reasoning_effort 三档拉伸＋off→"none" / enable_thinking / thinking.type / think），
// 上游不认识时自动剥掉重发（见 llm_common.thinking_request_params）。布尔开关族
// （qwen/zhipu/ollama/mimo）界面用 on/off 两档；effort 族 off 发 reasoning_effort:"none"
// （OpenAI gpt-5.1 起的正式取值），旧端点不支持就 400 剥参退化。
const THINKING_LEVELS = ['low', 'high', 'max'];
const THINKING_BOOLEAN_PROVIDERS = ['qwen', 'zhipu', 'ollama', 'mimo'];
window.THINKING_LEVELS = THINKING_LEVELS;
window.THINKING_BOOLEAN_PROVIDERS = THINKING_BOOLEAN_PROVIDERS;

// 槽位思考档位选项（纯函数，冒烟直测）：布尔族 跟随默认/开/关 三档，effort 族
// 跟随默认/关/low/high/max 五档。role==='graph'（Φ 槽）的「跟随默认」含义不同：
// 不发思考参数＝交给 Φ 面板按钮/后端相位默认，故文案改「自动」
function _thinkingOptionsFor(provider, role) {
  const autoLabel = role === 'graph' ? '思考：自动（Φ 按钮可覆盖）' : '思考：跟随模型默认';
  if (THINKING_BOOLEAN_PROVIDERS.includes(provider)) {
    return [{ value: '', label: autoLabel }, { value: 'on', label: '思考：开' }, { value: 'off', label: '思考：关' }];
  }
  return [
    { value: '', label: autoLabel },
    { value: 'off', label: '思考：关' },
    { value: 'low', label: '思考：low' },
    { value: 'high', label: '思考：high' },
    { value: 'max', label: '思考：max' },
  ];
}

// 滑块档位（纯函数，冒烟直测）：下拉选项转「按思考强度升序」的滑块档，附短标签与悬浮
// 说明。effort 族序：关 → 默认 → 浅(low) → 深(high) → 最深(max)；布尔族：关 → 默认 → 开。
// graph 槽「默认」叫「自动」（Φ 按钮可覆盖），与 _thinkingOptionsFor 口径一致。
function _thinkingSliderEntries(options, role) {
  const isBoolean = (options || []).some(o => o.value === 'on');
  const order = isBoolean ? { off: 0, '': 1, on: 2 } : { off: 0, '': 1, low: 2, high: 3, max: 4 };
  const short = isBoolean ? { off: '关', '': '默认', on: '开' }
    : { off: '关', '': (role === 'graph' ? '自动' : '默认'), low: '浅', high: '深', max: '最深' };
  const autoTitle = role === 'graph' ? '自动＝由 Φ 面板深度思考按钮/相位默认决定' : '跟随模型默认＝不发思考参数';
  const titles = isBoolean ? { off: '强制关闭思考', '': autoTitle, on: '开启思考' }
    : { off: '强制关闭思考', '': autoTitle, low: '低强度思考', high: '高强度思考', max: '最高强度思考' };
  return (options || []).slice()
    .sort((a, b) => (order[a.value] !== undefined ? order[a.value] : 9) - (order[b.value] !== undefined ? order[b.value] : 9))
    .map(o => ({ value: o.value, short: short[o.value] || o.value || '默认', title: titles[o.value] || '' }));
}

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
  try { localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify(userModelConfigs)); } catch (e) {}
  scheduleModelsSync();
}

// ====== 模型配置服务端同步（T284，2026-10-11） ======
// 真相源＝服务端按账号落盘的 models.json（GET/POST /api/models/config，整包读写）；
// localStorage 镜像只当缓存与离线兜底。此前配置只存浏览器——换端口/换主机名打开、
// 清浏览器数据、无痕窗口、多账号切命名空间，任一事件都表现为「配置全丢」（用户实报）。
// 冲突解决＝服务端 updatedAt 新盖旧（时间戳由服务端打，不信客户端时钟）。
// 剩余已知竞态（刻意接受）：两个标签页同时编辑，后上传者整体覆盖——挂起未上传时
// visibilitychange 拉取会跳过，正常「切走再切回」即对齐。
const MODELS_CONFIG_SYNC_PATH = '/api/models/config';
const MODELS_SYNCED_AT_KEY = 'phymathia_models_synced_at';
let _modelsSyncTimer = null;
let _modelsSyncInflight = false;
let _modelsDirtyAfterInflight = false;
let _modelsSyncedAt = 0; // 服务端最后确认的 updatedAt（上传成功或采纳服务端时推进）
// 显式清空清单（2026-10-24）：服务端整包上传的密钥是**合并**语义——缺钥＝不知道，
// 保留原钥。所以「人主动把钥清空」必须单独点名，否则清不掉（且会被回包补回来）。
// 这份清单随下一次整包上传发出，成功才销账（失败＝403 只读查阅/离线，留着下次）。
let _pendingModelKeyClears = [];
function _markModelKeyCleared(id) {
  const mid = String(id || '');
  if (!mid) return;
  if (!_pendingModelKeyClears.includes(mid)) _pendingModelKeyClears.push(mid);
}

// 纯函数（冒烟直测）：给定服务端时间戳与本地状态，决定同步动作。
// serverTs<=0＝服务端还没有存档：本地有数据就整体上传（首启迁移／服务端存档丢失自愈）。
function _modelsSyncAction(serverTs, localTs, localHas) {
  if (!(serverTs > 0)) return localHas ? 'push' : 'none';
  if (!localHas) return 'adopt';
  return serverTs >= localTs ? 'adopt' : 'push';
}

function _localModelsHasAny() {
  return userModelConfigs.length > 0
    || Object.keys(modelGroupKeys).some(k => modelGroupKeys[k])
    || Object.keys(activeModels).some(k => activeModels[k]);
}

function _modelsSyncBlob() {
  return {
    userModels: userModelConfigs,
    modelGroupKeys: modelGroupKeys,
    activeModels: activeModels,
    clearKeys: _pendingModelKeyClears.slice(), // 显式清空清单（服务端唯一删钥口）
  };
}

// 回包补钥（2026-10-24）：服务端合并后把 auth 里的钥回传，本地镜像缺的按 id 补回。
// 只补不删、只填空位——不覆盖本地已有钥，也不触发二次上传。
function _applyServerKeyMerge(data) {
  if (!data || typeof data !== 'object') return false;
  const keys = data.modelKeys, groups = data.groupKeys;
  let changed = false;
  if (keys && typeof keys === 'object') {
    for (const cfg of userModelConfigs) {
      if (!cfg || !cfg.id || cfg.apiKey) continue;
      const k = keys[cfg.id];
      if (typeof k === 'string' && k) { cfg.apiKey = k; changed = true; }
    }
  }
  if (groups && typeof groups === 'object') {
    for (const provider of Object.keys(groups)) {
      if (groups[provider] && !modelGroupKeys[provider]) { modelGroupKeys[provider] = groups[provider]; changed = true; }
    }
  }
  if (!changed) return false;
  try { localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify(userModelConfigs)); } catch (e) {}
  try { localStorage.setItem(MODEL_GROUP_KEYS_STORAGE, JSON.stringify(modelGroupKeys)); } catch (e) {}
  // 面板正开着且焦点在密钥框里时不重渲染（会吞掉正在输入的字符），徽标下一帧再说
  try {
    const active = document.activeElement;
    if (!active || !active.classList || !active.classList.contains('model-group-key')) {
      renderModelList();
      renderModelSelects();
    }
    for (const provider of Object.keys(modelGroupKeys)) _refreshGroupKeyBadges(provider);
  } catch (e) {}
  return true;
}

// 服务端 blob → 内存＋本地镜像。返回是否采纳（调用方负责按需重渲染）。
// 采纳＝服务端赢：挂起的清空清单一并丢弃（它针对的是旧本地状态，留着会误删）
function _adoptModelsConfig(blob) {
  if (!blob || typeof blob !== 'object') return false;
  _pendingModelKeyClears = [];
  if (Array.isArray(blob.userModels)) userModelConfigs = blob.userModels.filter(m => m && typeof m === 'object');
  if (blob.modelGroupKeys && typeof blob.modelGroupKeys === 'object') modelGroupKeys = { ...blob.modelGroupKeys };
  if (blob.activeModels && typeof blob.activeModels === 'object') activeModels = { ...blob.activeModels };
  try {
    localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify(userModelConfigs));
    localStorage.setItem(MODEL_GROUP_KEYS_STORAGE, JSON.stringify(modelGroupKeys));
    localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels));
  } catch (e) {}
  return true;
}

function _stampSynced(ts) {
  _modelsSyncedAt = Number(ts) || 0;
  try { localStorage.setItem(MODELS_SYNCED_AT_KEY, String(_modelsSyncedAt)); } catch (e) {}
}

function scheduleModelsSync(delay = 400) {
  // 乐观打点：改动一发生就推进本地同步戳。本应用服务端就在本机（同一时钟），
  // 浏览器时间戳与服务端时间戳可直接比较——删/改模型后立刻关页，下次启动按
  // 「本地较新→补传」走，不会被「服务端较新→采纳」回滚；上传成功后本戳被
  // 服务端回戳覆盖为真相值。
  _stampSynced(Date.now() / 1000);
  clearTimeout(_modelsSyncTimer);
  _modelsSyncTimer = setTimeout(() => { _modelsSyncTimer = null; flushModelsSync(); }, delay);
}

async function flushModelsSync() {
  if (_modelsSyncInflight) { _modelsDirtyAfterInflight = true; return; }
  _modelsSyncInflight = true;
  const sentClears = _pendingModelKeyClears.slice(); // 本次随包发出的清空清单
  try {
    const resp = await fetch(MODELS_CONFIG_SYNC_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_modelsSyncBlob()),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      if (data && typeof data.updatedAt === 'number') _stampSynced(data.updatedAt);
      _applyServerKeyMerge(data); // 服务端保留下来的钥补回本地镜像
      _pendingModelKeyClears = _pendingModelKeyClears.filter(id => !sentClears.includes(id));
    }
    // 非 2xx（含只读查阅 403、离线）：静默放弃，本地镜像仍在；下次改动或下次加载再收敛
  } catch (e) {
  } finally {
    _modelsSyncInflight = false;
    if (_modelsDirtyAfterInflight) { _modelsDirtyAfterInflight = false; scheduleModelsSync(0); }
  }
}

// 启动对齐：服务端空＋本地有 → 首启迁移上传；服务端较新或本地空 → 采纳服务端；
// 本地较新（上次上传没成）→ 补传。GET 失败静默＝保持本地镜像，行为与旧版一致。
async function syncModelsConfigFromServer() {
  try {
    _modelsSyncedAt = Number(localStorage.getItem(MODELS_SYNCED_AT_KEY) || 0) || 0;
  } catch (e) {}
  let blob = null;
  try {
    const resp = await fetch(MODELS_CONFIG_SYNC_PATH, { cache: 'no-cache' });
    if (resp.ok) blob = await resp.json();
  } catch (e) {}
  const serverTs = blob && typeof blob === 'object' ? (Number(blob.updatedAt) || 0) : 0;
  const action = _modelsSyncAction(serverTs, _modelsSyncedAt, _localModelsHasAny());
  if (action === 'adopt') {
    if (_adoptModelsConfig(blob)) _stampSynced(serverTs);
  } else if (action === 'push') {
    scheduleModelsSync(0);
  }
}

// 切回标签页时对齐其他标签页的改动（本地有挂起上传就不拉，防把未上传改动盖掉）
async function refreshModelsIfServerNewer() {
  if (_modelsSyncInflight || _modelsSyncTimer != null) return;
  let blob = null;
  try {
    const resp = await fetch(MODELS_CONFIG_SYNC_PATH, { cache: 'no-cache' });
    if (resp.ok) blob = await resp.json();
  } catch (e) {}
  const serverTs = blob && typeof blob === 'object' ? (Number(blob.updatedAt) || 0) : 0;
  if (serverTs > _modelsSyncedAt && _adoptModelsConfig(blob)) {
    _stampSynced(serverTs);
    renderModelSelects();
    renderModelList();
  }
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshModelsIfServerNewer();
  });
}

// 导入备份等「绕过 save* 直写 localStorage」的通道：先用它把内存拉回最新，再 scheduleModelsSync(0)
function reloadModelsFromStorage() {
  loadUserModels();
  try {
    const raw = localStorage.getItem('phymathia_active_models');
    if (raw) activeModels = JSON.parse(raw) || activeModels;
  } catch (e) {}
  try {
    _modelsSyncedAt = Number(localStorage.getItem(MODELS_SYNCED_AT_KEY) || 0) || 0;
  } catch (e) {}
}

// activeModels 的统一写出口：本地镜像＋调度服务端同步（槽位/思考档变更走这里）
function persistActiveModels() {
  try { localStorage.setItem('phymathia_active_models', JSON.stringify(activeModels)); } catch (e) {}
  scheduleModelsSync();
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
  if (changed) persistActiveModels();
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
    result.push({ id: cfg.id, name: (preset?.name || cfg.provider) + ' · ' + display, desc: preset?.name || cfg.provider, tags: [display], provider: cfg.provider, hasKey: !!(cfg.apiKey || getGroupKey(cfg.provider)) });
  }
  return result;
}

// 六个槽位键：agent_model 等（模型引用）＋ <role>_thinking（槽位思考档位，2026-10-11 起）
const SLOT_MODEL_KEYS = { agent: 'agent_model', html: 'html_model', descriptor: 'descriptor_model', quiz: 'quiz_model', graph: 'graph_model', branch: 'branch_model' };

// 条目读取：条目自己没有钥时按组密钥回落（返回浅拷贝，调用点只读）。
// 有这一层，组密钥与条目钥万一不同步（历史遗留、某一版把组钥写空又写回），
// 发送链也不会带着空钥出去 401——8 处直读 model.apiKey 的调用点零改动受益。
function getModelById(id) {
  const cfg = userModelConfigs.find(m => m.id === id) || null;
  if (!cfg || cfg.apiKey) return cfg;
  const groupKey = getGroupKey(cfg.provider);
  return groupKey ? { ...cfg, apiKey: groupKey } : cfg;
}

function getActiveModelForRole(role) {
  const id = activeModels[SLOT_MODEL_KEYS[role] || 'descriptor_model'];
  if (!id) return null;
  return getModelById(id);
}

// 槽位思考档位（纯读，冒烟直测）：跟随**提供模型的那个槽**——槽配了自己的模型就用
// 该槽档位；槽空（与主模型相同）连思考也跟主模型，保住「与主模型相同」的字面语义。
// 例外：graph（Φ 槽）空时返回 ''——主模型档位灌进 Φ 请求会绕过 T97 相位档位
// （evaluate 深/chat 浅），Φ 的思考归面板按钮与相位默认，见 harness-run 发送点。
function getSlotThinkingForRole(role) {
  const own = activeModels[SLOT_MODEL_KEYS[role]] ? getModelById(activeModels[SLOT_MODEL_KEYS[role]]) : null;
  if (own) return activeModels[role + '_thinking'] || '';
  if (role === 'graph') return '';
  if (role === 'agent') return '';
  return activeModels.agent_thinking || '';
}
window.getSlotThinkingForRole = getSlotThinkingForRole;

// 槽位思考下拉的档位选项按「实际会被调用的模型」的供应商族渲染：槽空时跟随主模型，
// 就用主模型的族；主模型也没有时给 effort 族全集（后端按真实供应商映射，错档无害）
function _slotThinkingProvider(role) {
  const model = getActiveModelForRole(role) || (role !== 'agent' ? getActiveModelForRole('agent') : null);
  return model ? model.provider : '';
}

async function fetchModels() {
  loadUserModels();
  try { const raw = localStorage.getItem('phymathia_active_models'); if (raw) activeModels = JSON.parse(raw); } catch {}
  // T284：先与服务端真相源对齐（首启迁移上传／服务端较新采纳／本地较新补传），
  // 再跑下面的思考档迁移与悬空清理——迁移的是对齐后的最终状态
  await syncModelsConfigFromServer();
  // 一次性迁移（2026-10-11）：旧版思考档位挂在模型条目上，播种到指向它的槽位后删条目
  // 字段——槽位是思考档位的唯一事实源。布尔族旧档位（low/high/max）语义都是「开」，归一
  // 为 on。条目字段此后无写入方（配置弹窗已删该输入）；备份恢复回来的旧条目下次加载再迁。
  let thinkingMigrated = false;
  for (const role of Object.keys(SLOT_MODEL_KEYS)) {
    const model = activeModels[SLOT_MODEL_KEYS[role]] ? getModelById(activeModels[SLOT_MODEL_KEYS[role]]) : null;
    if (model && model.thinking && !activeModels[role + '_thinking']) {
      activeModels[role + '_thinking'] = THINKING_BOOLEAN_PROVIDERS.includes(model.provider) && model.thinking !== 'off'
        ? 'on'
        : model.thinking;
      thinkingMigrated = true;
    }
  }
  for (const m of userModelConfigs) {
    if (m.thinking !== undefined) { delete m.thinking; thinkingMigrated = true; }
  }
  if (thinkingMigrated) saveUserModels();
  // 悬空引用清理：槽位指向已删除的条目时回空（不强行回退到任何预设——
  // 列表里只该有用户主动加过的模型，回空由界面提示补配）
  for (const key of ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model']) {
    if (activeModels[key] && !getModelById(activeModels[key])) activeModels[key] = '';
  }
  persistActiveModels();
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
  // 简略模式统一控件（2026-10-25）：值恒取主槽（agent）现值，仅展示不落盘；
  // 滑块档位组随主模型供应商族渲染（六槽刷新已先把无效存量档位归一）
  const unifiedSelect = document.getElementById('unifiedModelSelect');
  if (unifiedSelect) {
    unifiedSelect.innerHTML = emptyOpt + opts;
    unifiedSelect.value = activeModels.agent_model || '';
    updateUnifiedModelMeta();
    _refreshUnifiedThinkingSlider();
  }
}

// 槽位/统一模型的描述行与徽标（isMain＝主槽口径：空值提示「未配置」而非「可选」）
function _fillModelMeta(selectValue, descEl, tagsEl, isMain) {
  const model = getModelById(selectValue);
  if (model) {
    const preset = MODEL_PRESETS[model.provider];
    descEl.textContent = (preset?.name || model.provider) + ' · ' + (model.label || model.model);
      tagsEl.innerHTML = `<span class="model-tag">${model.provider}</span><span class="model-tag">${model.apiKey ? UI_ICON_SVG.check + ' 已配置密钥' : UI_ICON_SVG.key + ' 密钥可留空'}</span>`;
  } else if (isMain) {
    descEl.textContent = selectValue ? '' : '未配置模型。请在下方「管理自定义模型」里添加';
    tagsEl.innerHTML = selectValue ? '' : '<span class="model-tag">未配置</span>';
  } else {
    // 其余角色统一口径：留空即与主模型相同，仅描述回退行为，不再各写一份角色说明
    descEl.textContent = selectValue ? '' : '默认与主模型相同，无需单独配置';
    tagsEl.innerHTML = selectValue ? '' : '<span class="model-tag">可选</span>';
  }
}

function updateModelMeta(type) {
  _refreshSlotThinkingSelect(type);
  const selectMap = { agent: 'agentModelSelect', html: 'htmlModelSelect', descriptor: 'descriptorModelSelect', quiz: 'quizModelSelect', graph: 'graphModelSelect', branch: 'branchModelSelect' };
  const descMap = { agent: 'agentModelDesc', html: 'htmlModelDesc', descriptor: 'descriptorModelDesc', quiz: 'quizModelDesc', graph: 'graphModelDesc', branch: 'branchModelDesc' };
  const tagsMap = { agent: 'agentModelTags', html: 'htmlModelTags', descriptor: 'descriptorModelTags', quiz: 'quizModelTags', graph: 'graphModelTags', branch: 'branchModelTags' };
  const select = document.getElementById(selectMap[type]);
  const descEl = document.getElementById(descMap[type]);
  const tagsEl = document.getElementById(tagsMap[type]);
  if (!select || !descEl || !tagsEl) return;
  _fillModelMeta(select.value, descEl, tagsEl, type === 'agent');
}

// 简略模式统一模型的 meta（恒按主槽口径展示）
function updateUnifiedModelMeta() {
  const select = document.getElementById('unifiedModelSelect');
  const descEl = document.getElementById('unifiedModelDesc');
  const tagsEl = document.getElementById('unifiedModelTags');
  if (!select || !descEl || !tagsEl) return;
  _fillModelMeta(select.value, descEl, tagsEl, true);
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
  persistActiveModels();
  // 主模型换了供应商族时，回落主模型的空槽思考选项也要跟着换族（如 on 只在布尔族有效）
  _refreshSlotThinkingSelects();
}

// ====== 槽位思考档位（2026-10-11 从模型条目迁来，见 fetchModels 迁移注释）======
// 2026-10-25 起界面从下拉换思考强度滑块（createThinkingSlider，见 thinking-slider.js）：
// 档位序/短标签走 _thinkingSliderEntries，存储键与取值语义不变（仍是 <role>_thinking）。

// 挂载点惰性建滑块（每挂载点只建一次，onChange 闭包捕获角色/统一路径）
function _ensureThinkingSliderOn(mount, onChangeCb) {
  if (!mount) return null;
  if (mount._ts) return mount._ts;
  try {
    mount._ts = window.createThinkingSlider(mount, { options: [], value: '', onChange: onChangeCb });
  } catch (e) {
    mount._ts = null;
  }
  return mount._ts;
}

// 单个槽位思考滑块：档位按实际会被调用的模型的供应商族渲染；存量档位在新族下
// 无效（如 on 只在布尔族有效）时回「跟随默认」并落盘（原下拉同语义）
function _refreshSlotThinkingSelect(role) {
  const mount = document.getElementById(role + 'ModelThinking');
  if (!mount) return;
  const slider = _ensureThinkingSliderOn(mount, v => onSlotThinkingChange(role, v));
  const entries = _thinkingSliderEntries(_thinkingOptionsFor(_slotThinkingProvider(role), role), role);
  const current = activeModels[role + '_thinking'] || '';
  const valid = entries.some(e => e.value === current);
  if (slider) {
    slider.setOptions(entries);
    slider.setValue(valid ? current : '');
  }
  if (!valid && current) {
    activeModels[role + '_thinking'] = '';
    persistActiveModels();
  }
}

function _refreshSlotThinkingSelects() {
  for (const role of Object.keys(SLOT_MODEL_KEYS)) _refreshSlotThinkingSelect(role);
}

function onSlotThinkingChange(role, value) {
  let v = value;
  if (typeof v !== 'string') {   // 兼容无第二参调用：从挂载点滑块读当前值
    const mount = document.getElementById(role + 'ModelThinking');
    v = (mount && mount._ts && typeof mount._ts.getValue === 'function') ? mount._ts.getValue() : '';
  }
  if (typeof v !== 'string') v = '';
  activeModels[role + '_thinking'] = v || '';
  persistActiveModels();
}

// ====== 模型面板 简略/详细模式（2026-10-25） ======
// 简略＝一个模型＋一个思考滑块统一六槽：改模型写 6 个 *_model 键，改思考档写 6 个
// *_thinking 键；首次改动前把当时的详细配置快照进 localStorage，切回详细模式自动还原
// 并清快照——老配置不丢。简略模式展示恒取主槽（agent）现值，仅展示不落盘。
const MODEL_PANEL_MODE_KEY = 'phymathia_model_config_mode';
const MODEL_DETAIL_SNAPSHOT_KEY = 'phymathia_model_detail_snapshot';

function getModelPanelMode() {
  try { return localStorage.getItem(MODEL_PANEL_MODE_KEY) === 'detail' ? 'detail' : 'simple'; } catch (e) { return 'simple'; }
}

function setModelPanelMode(mode) { applyModelPanelMode(mode); }

function applyModelPanelMode(mode) {
  if (mode !== 'detail') mode = 'simple';
  try { localStorage.setItem(MODEL_PANEL_MODE_KEY, mode); } catch (e) {}
  const panel = document.getElementById('modelPanel');
  if (panel && panel.classList) {
    panel.classList.toggle('mode-simple', mode === 'simple');
    panel.classList.toggle('mode-detail', mode === 'detail');
  }
  const btnSimple = document.getElementById('modelModeBtnSimple');
  const btnDetail = document.getElementById('modelModeBtnDetail');
  if (btnSimple && btnSimple.classList) btnSimple.classList.toggle('current', mode === 'simple');
  if (btnDetail && btnDetail.classList) btnDetail.classList.toggle('current', mode === 'detail');
  if (mode === 'detail') _restoreDetailSnapshot();
  renderModelSelects();
}

function _hasDetailSnapshot() {
  try { return !!localStorage.getItem(MODEL_DETAIL_SNAPSHOT_KEY); } catch (e) { return false; }
}

function _takeDetailSnapshot() {
  const models = {}, thinking = {};
  for (const role of Object.keys(SLOT_MODEL_KEYS)) {
    models[SLOT_MODEL_KEYS[role]] = activeModels[SLOT_MODEL_KEYS[role]] || '';
    thinking[role + '_thinking'] = activeModels[role + '_thinking'] || '';
  }
  try {
    localStorage.setItem(MODEL_DETAIL_SNAPSHOT_KEY, JSON.stringify({ models, thinking, savedAt: Date.now() }));
  } catch (e) {
    return false;
  }
  // 写后复核：setItem 静默失败（配额/隐私模式等）就绝不能继续销毁原配置
  return _hasDetailSnapshot();
}

function _restoreDetailSnapshot() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(MODEL_DETAIL_SNAPSHOT_KEY) || 'null'); } catch (e) {}
  if (!snap || !snap.models) return false;
  for (const role of Object.keys(SLOT_MODEL_KEYS)) {
    activeModels[SLOT_MODEL_KEYS[role]] = snap.models[SLOT_MODEL_KEYS[role]] || '';
    activeModels[role + '_thinking'] = (snap.thinking || {})[role + '_thinking'] || '';
  }
  try { localStorage.removeItem(MODEL_DETAIL_SNAPSHOT_KEY); } catch (e) {}
  persistActiveModels();
  return true;
}

// 简略模式统一写入：模型键必写（六槽同值）；thinkingLevel 传字符串才写思考键——
// 只换模型不动思考。与现状全等时不写不快照。返回是否真写了。
function applyUnifiedConfig(modelId, thinkingLevel) {
  const model = modelId || '';
  const hasLevel = typeof thinkingLevel === 'string';
  const level = hasLevel ? thinkingLevel : '';
  const roles = Object.keys(SLOT_MODEL_KEYS);
  const modelChanged = roles.some(role => (activeModels[SLOT_MODEL_KEYS[role]] || '') !== model);
  const thinkChanged = hasLevel && roles.some(role => (activeModels[role + '_thinking'] || '') !== level);
  if (!modelChanged && !thinkChanged) return false;
  if (!_hasDetailSnapshot() && !_takeDetailSnapshot()) return false; // 快照落不了盘→拒绝统一（fail-safe，见 _takeDetailSnapshot）
  for (const role of roles) activeModels[SLOT_MODEL_KEYS[role]] = model;
  if (hasLevel) for (const role of roles) activeModels[role + '_thinking'] = level;
  persistActiveModels();
  renderModelSelects();
  return true;
}

// 简略模式统一下拉：只换模型，思考档保持各自现值（快照语义见上）
function onUnifiedModelChange(modelId) {
  applyUnifiedConfig(modelId || '');
}

// 简略模式统一滑块：六槽思考档同写
function onUnifiedThinkingChange(level) {
  const sel = document.getElementById('unifiedModelSelect');
  applyUnifiedConfig(sel ? sel.value : (activeModels.agent_model || ''), level || '');
}

// 简略模式统一滑块刷新：档位组随主模型供应商族渲染；展示值取主槽（无效存量档回默认）
function _refreshUnifiedThinkingSlider() {
  const mount = document.getElementById('unifiedThinkingSlider');
  if (!mount) return;
  const slider = _ensureThinkingSliderOn(mount, v => onUnifiedThinkingChange(v));
  const entries = _thinkingSliderEntries(_thinkingOptionsFor(_slotThinkingProvider('agent'), 'agent'), 'agent');
  const current = activeModels.agent_thinking || '';
  const valid = entries.some(e => e.value === current);
  if (slider) {
    slider.setOptions(entries);
    slider.setValue(valid ? current : '');
  }
  if (!valid && current) {
    activeModels.agent_thinking = '';
    persistActiveModels();
  }
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
        <input type="password" class="model-group-key" placeholder="分组密钥（${escapeHtml(hint)}）" value="${escapeHtml(getGroupKey(provider))}" autocomplete="new-password" spellcheck="false" data-lpignore="true" onchange="saveGroupKeyCommitted('${jsProvider}', this)" title="统一配置组内密钥；单条目在配置里单独设过的钥不会被覆盖。失焦才落盘（逐键写会把半截钥存进去）">
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
  // 思考档位不再在条目上配置（2026-10-11 迁到模型面板各槽位），此弹窗只管密钥/名称/地址
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
  // 人主动把条目密钥清空 → 点名删除（服务端合并语义下缺钥只代表「不知道」）
  const stored = userModelConfigs.find(m => m.id === id) || null;
  if (stored && stored.apiKey && !apiKey) _markModelKeyCleared(id);
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

// opts.free: true=免费（上游标价 0）/ false=付费 / undefined=上游没标价不标注；
// opts.probe: 'preset'（添加弹窗）| 'update'（更新弹窗）时渲染行内测活按钮。
// 测活按钮在 label 里，点击会连带勾选框——onclick 里 preventDefault 掉。
function _presetModelRowHtml(id, label, checked, opts) {
  const badge = (opts && opts.free === true)
    ? '<span class="am-model-free" title="上游标价为 0（免费档可用）">免费</span>'
    : (opts && opts.free === false)
      ? '<span class="am-model-free is-paid" title="上游标价非 0（付费档）">付费</span>'
      : '';
  const probe = (opts && opts.probe)
    ? `<span class="am-probe-wrap"><button type="button" class="am-probe-btn" onclick="event.preventDefault();event.stopPropagation();_probePresetRow(this,'${opts.probe}')">测活</button><span class="am-probe-state"></span></span>`
    : '';
  // id 进 value 属性做 HTML 转义；label 是注册表文案（同样转义防未来被自由输入污染）
  return `<label class="am-model-check">
    <input type="checkbox" value="${escapeHtml(id)}"${checked ? ' checked' : ''}>
    <span class="am-model-check-name">${escapeHtml(label || id)}</span>
    <span class="am-model-check-id">${escapeHtml(id)}</span>${badge}${probe}
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

// ====== T60 模型探活：列表里有 ≠ 能用，真发一条最小消息验证 ======
// 免费网关常把付费档模型也列进清单（82 个混着），现场换模型的踩坑重灾区。
// 结果按 provider|baseUrl|model 缓存 5 分钟，避免反复点重复烧调用。
const _modelProbeCache = new Map();   // key -> { ok, detail, at }
const MODEL_PROBE_TTL_MS = 5 * 60 * 1000;

function _modelProbeKey(provider, baseUrl, model) {
  return [provider || '', baseUrl || '', model || ''].join('|');
}

async function _probeModelLive(provider, baseUrl, model, apiKey) {
  const key = _modelProbeKey(provider, baseUrl, model);
  const hit = _modelProbeCache.get(key);
  if (hit && Date.now() - hit.at < MODEL_PROBE_TTL_MS) return hit;
  const resp = await fetch('/api/models/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, api_key: apiKey || '', base_url: baseUrl || '', model }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json().catch(() => ({}));
  const result = { ok: !!data.ok, detail: String(data.detail || (data.ok ? '可用' : '探活失败')), at: Date.now() };
  _modelProbeCache.set(key, result);
  return result;
}

function _paintProbeState(row, result) {
  const state = row && row.querySelector('.am-probe-state');
  if (!state) return;
  state.textContent = result.ok ? '✓ 可用' : '✗ 不可用';
  state.title = result.detail || '';
  state.classList.toggle('am-probe-ok', !!result.ok);
  state.classList.toggle('am-probe-bad', !result.ok);
}

// 行内「测活」按钮（添加/更新两个弹窗共用）：凭据与地址取各自弹窗的当前值
async function _probePresetRow(btn, ctxType) {
  const row = btn.closest('.am-model-check');
  const input = row && row.querySelector('input[type="checkbox"]');
  const model = input ? input.value : '';
  if (!model) return;
  let provider = '', baseUrl = '', apiKey = '';
  if (ctxType === 'update') {
    const ctx = _modelUpdateCtx;
    if (!ctx) return;
    provider = ctx.provider;
    baseUrl = ctx.baseUrl;
    apiKey = getGroupKey(provider) || (userModelConfigs.find(m => m.provider === provider)?.apiKey) || '';
  } else {
    provider = document.getElementById('newProvider').value;
    baseUrl = document.getElementById('newBaseUrl').value.trim();
    apiKey = _dialogApiKeyWithFallback(provider).key;
  }
  btn.disabled = true;
  const state = row.querySelector('.am-probe-state');
  if (state) { state.textContent = '探活中…'; state.classList.remove('am-probe-ok', 'am-probe-bad'); }
  let result;
  try {
    result = await _probeModelLive(provider, baseUrl, model, apiKey);
  } catch (e) {
    result = { ok: false, detail: String((e && e.message) || e), at: 0 };
  }
  btn.disabled = false;
  _paintProbeState(row, result);
}

// 批量测活（添加弹窗）：只探勾选的，4 路并发，状态行报进度
async function probeCheckedPresetModels() {
  const boxes = Array.from(document.querySelectorAll('#presetModelList input[type="checkbox"]:checked'));
  if (!boxes.length) { _setFetchStatus('presetFetchStatus', '先勾选要探活的模型', true); return; }
  const provider = document.getElementById('newProvider').value;
  const baseUrl = document.getElementById('newBaseUrl').value.trim();
  const apiKey = _dialogApiKeyWithFallback(provider).key;
  const btn = document.getElementById('presetProbeBtn');
  if (btn) btn.disabled = true;
  const total = boxes.length;
  let done = 0, okCount = 0;
  const queue = boxes.map(b => b.value);
  const worker = async () => {
    while (queue.length) {
      const model = queue.shift();
      const r = await _probeModelLive(provider, baseUrl, model, apiKey)
        .catch(e => ({ ok: false, detail: String((e && e.message) || e), at: 0 }));
      done++;
      if (r.ok) okCount++;
      const safe = (window.CSS && CSS.escape) ? CSS.escape(model) : model.replace(/"/g, '\\"');
      const input = document.querySelector(`#presetModelList input[value="${safe}"]`);
      _paintProbeState(input && input.closest('.am-model-check'), r);
      _setFetchStatus('presetFetchStatus', `探活中… ${done}/${total}（可用 ${okCount}）`, false);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (btn) btn.disabled = false;
  _setFetchStatus('presetFetchStatus', `探活完成：${total} 个里可用 ${okCount} 个${okCount < total ? '（✗ 的别选，选了也会被上游拒）' : ''}`, false);
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
    // T60：上游带定价字段时标免费/付费并把免费的排前面；opencode 这类不带
    // 定价的网关没有标注，真活假活交给「测活」（/api/models/probe）
    const meta = (data.meta && typeof data.meta === 'object') ? data.meta : {};
    if (listEl && fresh.length) {
      const empty = listEl.querySelector('.am-model-empty');
      if (empty) empty.remove();
      const ordered = fresh.slice().sort((a, b) => ((meta[b] && meta[b].free) ? 1 : 0) - ((meta[a] && meta[a].free) ? 1 : 0));
      // 追加段独立标记：全选/统计能区分「内置」与「在线补充」；标签只保留一份
      if (!listEl.querySelector('.am-model-group-label')) {
        listEl.insertAdjacentHTML('beforeend', '<div class="am-model-group-label">在线获取的补充模型</div>');
      }
      listEl.insertAdjacentHTML('beforeend', ordered.map(id => _presetModelRowHtml(id, id, false, { free: meta[id] ? meta[id].free : undefined, probe: 'preset' })).join(''));
    }
    const freeCount = fresh.filter(id => meta[id] && meta[id].free === true).length;
    _setFetchStatus('presetFetchStatus', fresh.length
      ? `新增 ${fresh.length} 个可选项（共 ${data.models.length} 个${freeCount ? `，免费 ${freeCount}` : ''}）——拿不准就点「测活勾选项」`
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
    showToast(added > 0 ? `已添加 ${added} 个模型` : '没有新增模型（可能都已添加过）');
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
    ctx.meta = (data.meta && typeof data.meta === 'object') ? data.meta : {};
    _renderUpdateDialog(provider, diff, (data.models || []).length, ctx.meta);
  } catch (e) {
    if (_modelUpdateCtx !== ctx) return;
    statusEl.textContent = `获取失败：${e.message}（可点「重新获取」重试）`;
    statusEl.classList.add('um-fetch-error');
  } finally {
    if (fetchBtn) fetchBtn.disabled = false;
  }
}

function _renderUpdateDialog(provider, diff, upstreamTotal, meta) {
  meta = (meta && typeof meta === 'object') ? meta : {};
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
    document.getElementById('umNewList').innerHTML = diff.added.map(id => _presetModelRowHtml(id, presetLabelOf(id) || id, false, { free: meta[id] ? meta[id].free : undefined, probe: 'update' })).join('');
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
    showToast(`已更新「${MODEL_PRESETS[provider]?.name || provider}」：新增 ${res.added} 个，移除 ${res.removed} 个`);
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
      // 思考档位：调用方按槽位传（getSlotThinkingForRole）；未传时回落条目遗留字段
      // （迁移前的旧备份/未刷新页面场景），两者皆空＝跟随模型默认不发参
      thinking: body.thinking || model.thinking || '',
      device_id: (typeof getDeviceId === 'function' ? getDeviceId() : ''),
      // 网关会话分桶：没有聊天会话 id 的旧格式调用按功能落稳定桶
      // （后端按 session_bucket 白名单消毒后用作 x-opencode-session）；
      // proxyChat（分支/苏格拉底发送）传的是 session_id，优先级更高
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
  // 槽位思考档位：苏格拉底/进阶学习走 branch 槽，其余走主模型槽（槽空连思考一起跟主模型）
  return proxyChatWithModel(agentModel, {
    prompt,
    level,
    session_id: sessionId,
    stream,
    thinking: getSlotThinkingForRole(isSocraticOrLearn ? 'branch' : 'agent'),
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
// 模型面板简略/详细模式（默认简略）：boot 即套用，面板首开即所见即所得；
// 顺带把七个思考滑块建好（renderModelSelects → updateModelMeta → _refreshSlotThinkingSelect）
applyModelPanelMode(getModelPanelMode());
