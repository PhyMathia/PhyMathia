// ===== 节点工坊（2026-10-20，创造模式重做 P0–P4）=====
// 设计文档：docs/创造模式重做计划-2026-10-20.md
//
// 三栏：左对话 / 中节点卡＋字段 / 右试跑。中栏是唯一「事实」——它始终是一份
// 合法配方（normalizeRecipeInput 的产物），左栏只把一句话翻成字段改动，右栏拿
// 真材料判决。配方 schema、画布渲染、生成链路一律复用，不另起一套：
//   · 校验/归一化 → graph-recipes.js 的 normalizeRecipeInput / validateRecipe
//   · 试跑提示词 → graph-workflow-prompt.js 的 _recipeWorkflowPrompt
//   · 试跑通道   → proxyChatWithModel + workflow_context（与画布生成同一条）
//   · 放到画布   → graph-custom.js 的 createRecipeNode
//
// 记要（给下一个会话）：
// - 本文件不进 viewer（查看器没有配方库），构建顺序在 harness-apply.js 之后。
// - 端口行（outputRows/inputRows）是编辑缓冲：空标签的行留在缓冲里让人接着打，
//   配方只收有名字的口（归一化会过滤空标签，不缓冲就会「一打字行就消失」）。
// - 文本输入的回调只重画卡片与错误文案，不整块重画字段区——否则每敲一个字就丢焦点。
// - 草稿落 localStorage（phymathia_recipe_draft），入册/丢弃时清空。

const RECIPE_WORKSHOP_API = '/api/harness/recipe/draft';
const RECIPE_WORKSHOP_HISTORY_LIMIT = 12;
const RECIPE_WORKSHOP_UNDO_LIMIT = 5;
const RECIPE_WORKSHOP_FLASH_MS = 2000;

let recipeWorkshop = null;          // 当前草稿状态（null＝没开过）
let recipeWorkshopOverlay = null;   // 全屏壳（只建一次）
let recipeWorkshopSaveTimer = null;
let recipeWorkshopBusy = false;     // 正在等模型（对话补丁）
let recipeWorkshopRunSeq = 0;       // 试跑序号：旧的流式回调按序号丢弃

function _rwDraftKey() {
  return (typeof STORAGE_KEY_RECIPE_DRAFT !== 'undefined') ? STORAGE_KEY_RECIPE_DRAFT : 'phymathia_recipe_draft';
}

function _rwBaseKinds() {
  return (typeof RECIPE_BASE_KINDS !== 'undefined') ? RECIPE_BASE_KINDS : ['module', 'summary', 'knowledge', 'relation', 'note', 'human_note', 'manual', 'question'];
}

function _rwAiBaseKinds() {
  return (typeof RECIPE_AI_BASE_KINDS !== 'undefined') ? RECIPE_AI_BASE_KINDS : ['module', 'summary', 'knowledge', 'relation'];
}

function _rwBaseMeta(kind) {
  const meta = (typeof RECIPE_BASE_META !== 'undefined') ? RECIPE_BASE_META : {};
  return meta[kind] || { label: kind, hint: '' };
}

function _rwPalette() {
  return (typeof RECIPE_PALETTE !== 'undefined') ? RECIPE_PALETTE : [];
}

// 起稿时的空配方：形态与 normalizeRecipeInput 的产物对齐，免得第一次编辑就掉字段
function _rwEmptyRecipe() {
  const now = Date.now();
  return {
    id: 'recipe-' + now + '-' + Math.random().toString(36).slice(2, 8),
    name: '',
    desc: '',
    builtin: false,
    base: { kind: 'module' },
    appearance: { palette: 'amber', shape: 'is-round' },
    generate: {
      prompt: '',
      strict_output: '',
      followup_prompt: '',
      retry_prompt: '',
      context_channel: 'workflow_context',
      model_role: 'agent',
      on_incomplete: { max_retries: 1 },
    },
    ports: { static: [], inputs: [] },
    content_kind: 'markdown',
    aggregation: 'ancestors',
    analysis_phase: false,
    createdAt: now,
    updatedAt: now,
  };
}

function _rwNormalized() {
  if (!recipeWorkshop) return null;
  if (typeof normalizeRecipeInput !== 'function') return recipeWorkshop.recipe;
  return normalizeRecipeInput(recipeWorkshop.recipe);
}

function _rwCurrentRecipe() {
  return _rwNormalized() || (recipeWorkshop && recipeWorkshop.recipe) || _rwEmptyRecipe();
}

// ---- 草稿落盘：500ms 防抖，刷新页面不丢 ----
function _rwSaveDraftSoon() {
  if (!recipeWorkshop || recipeWorkshop.persistMuted) return;
  if (recipeWorkshopSaveTimer) return;
  recipeWorkshopSaveTimer = setTimeout(function () {
    recipeWorkshopSaveTimer = null;
    _rwSaveDraftNow();
  }, 500);
}

function _rwSaveDraftNow() {
  // persistMuted：入册之后这份草稿已经变成配方库里的正式条目，不该再把草稿键写回来
  // （否则「入册/丢弃时清空草稿」这条永远不成立）。下一次编辑由 _rwTouch 解除静音。
  if (!recipeWorkshop || recipeWorkshop.persistMuted) return;
  try {
    localStorage.setItem(_rwDraftKey(), JSON.stringify({
      v: 1,
      recipe: recipeWorkshop.recipe,
      origin: recipeWorkshop.origin,
      conversation: recipeWorkshop.conversation.slice(-RECIPE_WORKSHOP_HISTORY_LIMIT),
      runs: recipeWorkshop.runs.slice(-3),
      // 界面档位跟着草稿走：刷新后还在「一句话」或「手动调」，预览卡的收起状态也不跳
      ui: { mode: recipeWorkshop.mode || 'smart', cardCollapsed: !!recipeWorkshop.cardCollapsed },
      savedAt: Date.now(),
    }));
  } catch (e) { /* 本地写失败：草稿只在内存里，不影响继续编辑 */ }
}

function _rwReadDraft() {
  try {
    const raw = localStorage.getItem(_rwDraftKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.recipe || typeof data.recipe !== 'object') return null;
    const recipe = (typeof normalizeRecipeInput === 'function' ? normalizeRecipeInput(data.recipe) : null) || data.recipe;
    return {
      recipe: recipe,
      origin: String(data.origin || 'new'),
      conversation: Array.isArray(data.conversation) ? data.conversation : [],
      runs: Array.isArray(data.runs) ? data.runs : [],
      ui: (data.ui && typeof data.ui === 'object') ? data.ui : {},
    };
  } catch (e) { return null; }
}

// 撤掉在途的防抖落盘：入册/丢弃时先取消，否则 500ms 后旧草稿又写回来了
// （2026-10-20 真机抓到的：点了入册、检查时草稿键又被写了一遍）
function _rwCancelDraftTimer() {
  if (!recipeWorkshopSaveTimer) return;
  try { clearTimeout(recipeWorkshopSaveTimer); } catch (e) {}
  recipeWorkshopSaveTimer = null;
}

function _rwClearDraftStorage() {
  _rwCancelDraftTimer();
  try { localStorage.removeItem(_rwDraftKey()); } catch (e) {}
}

// ---- 小工具 ----
function _rwEsc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(String(value == null ? '' : value));
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}

function _rwLevel() {
  try {
    if (typeof getLevel === 'function') return getLevel();
    return localStorage.getItem('phymathia_level') || 'university';
  } catch (e) { return 'university'; }
}

function _rwSessionId() {
  try {
    if (typeof _workflowSessionId === 'function') return _workflowSessionId();
    if (typeof getCurrentSessionId === 'function') return getCurrentSessionId() || '';
  } catch (e) { /* 无会话时留空 */ }
  return '';
}

function _rwModel() {
  try {
    if (typeof getActiveModelForRole === 'function') {
      return getActiveModelForRole('agent') || getActiveModelForRole('descriptor') || null;
    }
  } catch (e) { /* 模型槽未初始化 */ }
  return null;
}

function _rwModelPayload(model) {
  if (!model) return null;
  const out = {
    provider: model.provider,
    api_key: model.apiKey,
    model: model.model,
    base_url: model.baseUrl,
  };
  if (/^(hy3|hy3-preview|hy4-preview)$/i.test(String(out.model || '').trim())) {
    out.provider = 'opencode-go';
    out.base_url = 'https://opencode.ai/zen/go/v1';
    if (!out.api_key) out.api_key = '';
  }
  return out;
}

// 字段路径 → 人话（左栏只出现人话，绝不把 ports.static[1].label 摆给用户）
function _rwHumanizePath(path) {
  const text = String(path || '');
  if (!text) return '配方';
  const nameMap = {
    name: '名字',
    desc: '它做什么',
    'base.kind': '底座类型',
    'appearance.palette': '长相颜色',
    'appearance.color': '长相颜色',
    'ports.inputs': '输入口',
    'ports.static': '出口',
    'ports.dynamic': '自动出口',
    'generate.prompt': '生成要求',
    'generate.strict_output': '输出格式要求',
    'generate.followup_prompt': '追问提示词',
    'generate.retry_prompt': '重试提示词',
    'generate.context_channel': '材料怎么交给模型',
    'generate.model_role': '用哪个模型槽',
    content_kind: '内容载体',
    aggregation: '收哪些材料',
    analysis_phase: '先出问题概要',
    on_generated: '生成后自动长节点',
  };
  if (nameMap[text]) return nameMap[text];
  const portMatch = /^ports\.(static|inputs)\[(\d+)\](?:\.(\w+))?$/.exec(text);
  if (portMatch) {
    const which = portMatch[1] === 'static' ? '出口' : '输入口';
    const label = '第 ' + (Number(portMatch[2]) + 1) + ' 个' + which;
    if (portMatch[3] === 'label') return label + '的名字';
    if (portMatch[3] === 'type') return label + '的类型';
    if (portMatch[3] === 'drag_form') return label + '的拖出方式';
    return label;
  }
  return text.replace(/\[\d+\]/g, '').split('.').slice(-1)[0] || text;
}

function _rwChangedLabel(paths) {
  const list = (paths || []).filter(Boolean).slice(0, 3).map(_rwHumanizePath);
  if (!list.length) return '';
  return list.join('、');
}

// 本次 AI 改动的高亮窗口（2 秒后自动消失；冒烟环境 setTimeout 被桩住也不影响状态）
function _rwIsFlashing(path) {
  if (!recipeWorkshop) return false;
  if (!recipeWorkshop.flashUntil || recipeWorkshop.flashUntil < Date.now()) return false;
  const changed = recipeWorkshop.changedFields || [];
  const target = String(path || '');
  if (!target) return false;
  return changed.some(function (item) {
    return item === target || item.indexOf(target + '.') === 0 || item.indexOf(target + '[') === 0;
  });
}

function _rwFlashChanged() {
  if (!recipeWorkshop) return;
  recipeWorkshop.flashUntil = Date.now() + RECIPE_WORKSHOP_FLASH_MS;
  setTimeout(function () {
    if (!recipeWorkshop) return;
    recipeWorkshop.flashUntil = 0;
    recipeWorkshop.changedFields = [];
    _rwRenderFields();
    _rwRenderCard();
  }, RECIPE_WORKSHOP_FLASH_MS);
}

function _rwErrorFor(path) {
  if (!recipeWorkshop) return '';
  const target = String(path || '');
  const hit = (recipeWorkshop.fieldErrors || []).find(function (item) {
    const field = String((item && item.field) || '');
    if (!field) return false;
    return field === target || field.indexOf(target + '.') === 0 || field.indexOf(target + '[') === 0;
  });
  return hit ? String(hit.message || '') : '';
}

function _rwHasError(path) {
  return !!_rwErrorFor(path);
}

function _rwGroupClass(path) {
  const classes = ['rw-group'];
  if (_rwHasError(path)) classes.push('rw-has-error');
  if (_rwIsFlashing(path)) classes.push('rw-flash');
  return classes.join(' ');
}

function _rwGroup(path, label, inner, hint) {
  const boxId = 'rwGroup' + String(path || '').replace(/[^a-zA-Z0-9]/g, '-');
  const error = _rwErrorFor(path);
  return '<div class="' + _rwGroupClass(path) + '" id="' + boxId + '" data-field="' + _rwEsc(path) + '">'
    + '<div class="rw-group-head"><span class="rw-label">' + _rwEsc(label) + '</span>'
    + (hint ? '<span class="rw-hint">' + _rwEsc(hint) + '</span>' : '')
    + '</div>'
    + inner
    + (error ? '<div class="rw-field-error">' + _rwEsc(error) + '</div>' : '')
    + '</div>';
}


// ---- 壳：全屏遮罩 + 三栏（只建一次，之后只换内容）----
function _rwTopNodes() {
  try {
    if (typeof getGraphViewNodes === 'function') return getGraphViewNodes() || [];
    if (typeof graphView !== 'undefined' && graphView && Array.isArray(graphView.nodes)) return graphView.nodes;
  } catch (e) { /* 画布未就绪 */ }
  return [];
}

function _rwEnsureShell() {
  if (recipeWorkshopOverlay) return recipeWorkshopOverlay;
  const overlay = document.createElement('div');
  overlay.id = 'recipeWorkshop';
  overlay.className = 'rw-overlay';
  overlay.setAttribute('hidden', '');
  overlay.innerHTML = '<div class="rw-shell aurora-glass aurora-glass--dialog" role="dialog" aria-modal="true" aria-label="节点工坊" data-mode="smart">'
    + '<header class="rw-head">'
    + '<div class="rw-brand"><span class="rw-brand-dot" aria-hidden="true"></span><span>节点工坊</span></div>'
    // 两档：一句话（模型配好整份配方）/ 手动调（三栏工作台逐项改）。同一份草稿、同一条起草通道。
    + '<div class="rw-mode-switch" id="rwModeSwitch" role="tablist" aria-label="创作方式">'
    + '<button type="button" class="rw-mode-btn" data-rw-mode="smart" role="tab" aria-selected="true" onclick="rwSetMode(\'smart\')" title="说一句话，名字、材料口、出口、颜色和生成要求由模型一起配好">✦ 一句话</button>'
    + '<button type="button" class="rw-mode-btn" data-rw-mode="manual" role="tab" aria-selected="false" onclick="rwSetMode(\'manual\')" title="逐项自己调，适合改已有节点或精修每个字段">手动调</button>'
    + '</div>'
    + '<ol class="rw-steps" id="rwSteps"></ol>'
    + '<div class="rw-head-actions">'
    + '<span class="rw-head-status" id="rwHeadStatus"></span>'
    + '<button type="button" class="rw-btn rw-btn-ghost rw-legacy" onclick="rwOpenLegacyPreset()" title="旧版创造对话（新版验证通过前保留）">旧版对话</button>'
    + '<button type="button" class="rw-btn rw-btn-ghost rw-close" onclick="closeRecipeWorkshop()" title="关闭（Esc）" aria-label="关闭">✕</button>'
    + '</div>'
    + '</header>'
    + '<div class="rw-body">'
    + '<aside class="rw-chat" aria-label="对话">'
    + '<div class="rw-pane-head">对话</div>'
    + '<div class="rw-chat-log" id="rwChatLog"></div>'
    + '<div class="rw-chat-input">'
    + '<textarea id="rwChatInput" rows="2" placeholder="想要一个什么节点？说一句就行"></textarea>'
    + '<button type="button" class="rw-btn rw-btn-primary" id="rwAskBtn" onclick="rwAsk()">发送</button>'
    + '</div>'
    + '</aside>'
    + '<main class="rw-stage" aria-label="节点卡与字段">'
    // 预览卡是这一栏的页眉，不在滚动区里：卡片永远不压字段，字段只在自己的滚动层走。
    // （2026-10-20 修过一次保存条 sticky 压按钮；2026-10-22 用户反馈卡片 sticky 把
    //  「名字」一行压在底下、字被渐变洗白——这次彻底把卡片挪出滚动流）
    + '<div class="rw-card" id="rwCard"></div>'
    + '<div class="rw-scroll" id="rwScroll">'
    + '<div class="rw-fields" id="rwFields"></div>'
    + '</div>'
    + '<div class="rw-savebar" id="rwSaveBar"></div>'
    + '</main>'
    + '<aside class="rw-run" aria-label="试跑">'
    + '<div class="rw-pane-head">试跑 <span class="rw-pane-hint" id="rwRunHint"></span></div>'
    + '<div class="rw-materials" id="rwMaterials"></div>'
    + '<div class="rw-run-actions" id="rwRunActions"></div>'
    + '<div class="rw-output" id="rwOutput"></div>'
    + '</aside>'
    + '</div>'
    + '<section class="rw-smart" id="rwSmart" aria-label="一句话创造">'
    + '<div class="rw-smart-inner">'
    + '<div class="rw-smart-hero">'
    + '<div class="rw-smart-kicker">✦ 一句话创造</div>'
    + '<h2 class="rw-smart-title">想要一个什么节点？说一句就行</h2>'
    + '<p class="rw-smart-sub">不用填表：说清「喂什么 · 要它干什么 · 吐什么」，Φ 会把名字、材料口、出口、颜色和生成要求一起配好。先给你看结果，满意再放到画布；想逐项改就切右上角「手动调」。</p>'
    + '</div>'
    + '<div class="rw-smart-box">'
    + '<textarea id="rwSmartInput" rows="3" placeholder="比如：做一个受力分析节点，喂一道题和受力图，输出研究对象、受力、方程，出口给「换个条件」和「解释假设」" oninput="rwSmartInputChanged(this.value)" onkeydown="rwSmartKey(event)"></textarea>'
    + '<div class="rw-smart-row">'
    + '<span class="rw-smart-hint" id="rwSmartHint"></span>'
    + '<button type="button" class="rw-btn rw-btn-primary rw-smart-go" id="rwSmartGo" onclick="rwSmartGenerate()">生成节点</button>'
    + '</div>'
    + '</div>'
    + '<div class="rw-smart-examples" id="rwSmartExamples"></div>'
    + '<div class="rw-smart-error" id="rwSmartError" hidden></div>'
    + '<div class="rw-smart-result" id="rwSmartResult"></div>'
    + '</div>'
    + '</section>'
    + '</div>';
  overlay.addEventListener('pointerdown', function (event) {
    if (event.target === overlay) closeRecipeWorkshop();
  });
  overlay.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeRecipeWorkshop();
  });
  // 试跑输出用的是画布同款渲染，正文里的苏格拉底按钮也一并长出来了——那些按钮要
  // 解析宿主节点，而试跑没有宿主。点它们只给一句人话，不放真实流程空跑。
  overlay.addEventListener('click', function (event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('#rwOutput .socratic-actions, #rwOutput .learn-dir-section')) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof toastMsg === 'function') toastMsg('试跑里只看效果；要真的提问，先把节点放到画布');
  }, true);
  document.body.appendChild(overlay);
  recipeWorkshopOverlay = overlay;
  return overlay;
}

// ---- 开合 ----
// opts: { recipe, origin, seedText, pullNodeId } —— recipe 由调用方深拷一份再传。
function openRecipeWorkshop(opts) {
  opts = opts || {};
  if (typeof phyIsReadonly === 'function' && phyIsReadonly()) {
    if (typeof phyReadonlyBlock === 'function') phyReadonlyBlock('打开节点工坊');
    return null;
  }
  const restored = opts.recipe ? null : _rwReadDraft();
  const seed = opts.recipe
    ? (typeof normalizeRecipeInput === 'function' ? normalizeRecipeInput(opts.recipe) : opts.recipe) || opts.recipe
    : (restored && restored.recipe) || _rwEmptyRecipe();
  const savedUi = (restored && restored.ui) || {};
  const seedName = String((seed && seed.name) || '').trim();
  // 默认档位：空白进来＝一句话（新用户不用先学三栏）；从配方库/画布节点进来＝手动；
  // 接上次草稿＝上次停在哪档。显式 opts.mode 永远优先。
  const mode = (opts.mode === 'manual' || opts.mode === 'smart')
    ? opts.mode
    : (savedUi.mode || (opts.recipe || seedName ? 'manual' : 'smart'));
  recipeWorkshop = {
    recipe: JSON.parse(JSON.stringify(seed || _rwEmptyRecipe())),
    origin: String(opts.origin || (restored && restored.origin) || 'new'),
    conversation: (restored && restored.conversation) || [],
    runs: (restored && restored.runs) || [],
    dirty: false,
    saving: false,
    running: false,
    runningSeq: 0,
    persistMuted: false,
    changedFields: [],
    fieldErrors: [],
    flashUntil: 0,
    undoStack: [],
    question: null,
    savedName: '',
    savedAt: 0,
    wishDraft: true,       // 下一轮对话按「从零起稿」发给模型，拿到初稿后转补丁
    trialModelId: '',
    materials: {},
    output: '',
    outputPorts: [],
    runError: '',
    lastRun: null,
    outputRows: [],
    inputRows: [],
    mode: mode,                          // smart（一句话）/ manual（手动调）
    cardCollapsed: !!savedUi.cardCollapsed,
    smartBusy: false,
    smartDone: mode === 'smart' && !!seedName,   // 接草稿时直接把上次配好的结果摆出来
    smartSay: (mode === 'smart' && seedName) ? '上次那句已经配好了，接着改或直接放到画布。' : '',
    smartQuestion: null,
    smartError: '',
    smartInstruction: '',
  };
  _rwSyncRowsFromRecipe();
  _rwEnsureShell();
  recipeWorkshopOverlay.removeAttribute('hidden');
  recipeWorkshopOverlay.setAttribute('data-open', '1');
  if (restored) {
    _rwPushChat('phi', '把上次没弄完的草稿接上了，接着改就行。', { silent: true });
  }
  if (opts.seedText) {
    const chatInput = document.getElementById('rwChatInput');
    if (chatInput) chatInput.value = String(opts.seedText);
    recipeWorkshop.smartInstruction = String(opts.seedText);
  }
  _rwRenderAll();
  const smartInput = document.getElementById('rwSmartInput');
  if (smartInput && typeof smartInput.value === 'string') {
    smartInput.value = String(recipeWorkshop.smartInstruction || '');
  }
  const focusTarget = mode === 'smart'
    ? 'rwSmartInput'
    : (String((_rwCurrentRecipe().name || '') ? 'rwName' : 'rwChatInput'));
  const focusEl = document.getElementById(focusTarget);
  if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
  return recipeWorkshop;
}

function closeRecipeWorkshop(opts) {
  if (!recipeWorkshopOverlay) return;
  if (recipeWorkshop) {
    _rwSaveDraftNow();
    recipeWorkshop.running = false;
  }
  recipeWorkshopOverlay.setAttribute('hidden', '');
  recipeWorkshopOverlay.removeAttribute('data-open');
  // opts.discard：丢弃草稿（入册后清场走这条）
  if (opts && opts.discard) {
    _rwClearDraftStorage();
    recipeWorkshop = null;
  }
}

// 模式菜单里点「创造」：直接开工坊，不再在 400px 面板里聊天（计划 3.7）
function rwOpenFromModeChip() {
  return openRecipeWorkshop({});
}

// 旧版创造对话：保留到新版验证通过（P5 才退役），从这里进旧面板的 preset 聊天
function rwOpenLegacyPreset() {
  closeRecipeWorkshop();
  if (typeof window.chooseHarnessMode === 'function') {
    // legacy:true 才真正切到 preset 相位（不带这个参数，chooseHarnessMode 会把
    // 「创造」当成开新工坊——见 harness.js 的同名分支）
    window.chooseHarnessMode('preset', { legacy: true });
  }
  if (typeof window.openGraphHarness === 'function') window.openGraphHarness();
  else if (typeof window.toggleGraphHarnessWindow === 'function') window.toggleGraphHarnessWindow();
}

// ---- 统一渲染 ----
function _rwRenderAll() {
  _rwRenderSmart();   // 先把壳的 data-mode 与两档状态摆正，再渲染各自的面板
  _rwRenderSteps();
  _rwRenderCard();
  _rwRenderFields();
  _rwRenderChat();
  _rwRenderRun();
}

function _rwRenderSteps() {
  const box = document.getElementById('rwSteps');
  if (!box) return;
  const steps = _rwSteps();
  box.innerHTML = steps.map(function (item, index) {
    const mark = item.state === 'done' ? '✓' : (item.state === 'todo' ? '○' : '·');
    return '<li class="rw-step rw-step-' + item.state + '" data-step="' + item.id + '">'
      + '<button type="button" class="rw-step-btn" onclick="rwJump(\'' + item.id + '\')" title="' + _rwEsc(item.hint || '') + '">'
      + '<span class="rw-step-mark">' + mark + '</span>'
      + '<span class="rw-step-num">' + (index + 1) + '</span>'
      + '<span class="rw-step-label">' + _rwEsc(item.label) + '</span>'
      + '</button>'
      + '</li>';
  }).join('');
}

function _rwSteps() {
  const recipe = _rwCurrentRecipe();
  const inputs = (recipe.ports && recipe.ports.inputs) || [];
  const outputs = (recipe.ports && recipe.ports.static) || [];
  const state = recipeWorkshop || {};
  return [
    { id: 'name', label: '它做什么', state: String(recipe.name || '').trim() ? 'done' : 'todo', hint: '名字与一句话说明' },
    { id: 'inputs', label: '怎么吃材料', state: inputs.length ? 'done' : 'todo', hint: '喂进来的东西，按口分栏' },
    { id: 'outputs', label: '吐出什么', state: outputs.length ? 'done' : 'todo', hint: '卡片上的出口按钮' },
    { id: 'run', label: '试跑', state: (state.runs || []).length ? 'done' : 'todo', hint: '拿真材料跑一次' },
    { id: 'save', label: '入册', state: state.savedName ? 'done' : 'todo', hint: '存进「我的配方」' },
  ];
}

function rwJump(stepId) {
  const id = String(stepId || '');
  if (!recipeWorkshop) return;
  if (id === 'run') {
    const box = document.getElementById('rwMaterials');
    if (box) {
      if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const first = box.querySelector ? box.querySelector('textarea') : null;
      if (first && typeof first.focus === 'function') first.focus();
    }
    _rwPushChat('phi', '右边贴一道真题，点「跑一次」——跑出来什么样，这个节点将来就长什么样。', { silent: true });
    _rwRenderChat();
    return;
  }
  if (id === 'save') {
    rwSaveRecipe();
    return;
  }
  const path = id === 'name' ? 'name' : (id === 'inputs' ? 'ports.inputs' : 'ports.static');
  const boxId = 'rwGroup' + path.replace(/[^a-zA-Z0-9]/g, '-');
  const box = document.getElementById(boxId);
  if (box) {
    if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.classList.add('rw-pulse');
    setTimeout(function () { box.classList.remove('rw-pulse'); }, 900);
  }
}

// ---- 中栏：节点卡（仿真：与画布节点同色、同形状语义、同端口排布）----
function _rwNodeKind(recipe) {
  const base = (recipe.base && recipe.base.kind) || 'module';
  if (base === 'manual') return 'answer';
  if (base === 'question') return 'user';
  return base;
}

// opts.compact：只留一行（名字/底座/已保存）——手动档把预览收起时用，给字段腾高度。
// opts.fold：是否带「收起/展开」小按钮（默认手动档才带；一句话档的结果卡不带）。
function _rwCardHtml(opts) {
  opts = opts || {};
  const compact = !!opts.compact;
  const recipe = _rwCurrentRecipe();
  const appearance = recipe.appearance || {};
  const color = (typeof recipeAppearanceColor === 'function') ? recipeAppearanceColor(appearance) : 'var(--accent)';
  const baseMeta = _rwBaseMeta((recipe.base && recipe.base.kind) || 'module');
  const inputs = (recipe.ports && recipe.ports.inputs) || [];
  const outputs = (recipe.ports && recipe.ports.static) || [];
  const dyn = recipe.ports && recipe.ports.dynamic;
  const name = String(recipe.name || '').trim();
  const desc = String(recipe.desc || '').trim();
  const shapeClass = appearance.shape || (baseMeta.shape || 'is-round');
  const saved = recipeWorkshop && recipeWorkshop.savedName;
  const folded = recipeWorkshop && recipeWorkshop.cardCollapsed;
  const inputChips = inputs.length
    ? inputs.map(function (port) {
        const typeLabel = (typeof RECIPE_PORT_TYPE_LABELS !== 'undefined' && RECIPE_PORT_TYPE_LABELS[port.type]) || '';
        return '<span class="rw-chip">' + _rwEsc(port.label) + (typeLabel ? '<em>' + _rwEsc(typeLabel) + '</em>' : '') + '</span>';
      }).join('')
    : '<span class="rw-chip rw-chip-empty">还没有输入口</span>';
  const outputChips = outputs.length
    ? outputs.map(function (port) { return '<span class="rw-chip">' + _rwEsc(port.label) + '</span>'; }).join('')
    : '<span class="rw-chip rw-chip-empty">还没有出口</span>';
  const dynChip = dyn ? '<span class="rw-chip rw-chip-dyn">自动长出问题按钮</span>' : '';
  const flashName = _rwIsFlashing('name');
  const flashInputs = _rwIsFlashing('ports.inputs');
  const flashOutputs = _rwIsFlashing('ports.static') || _rwIsFlashing('ports.dynamic');
  const flashFace = _rwIsFlashing('appearance');
  const withFold = opts.fold !== false && !!(recipeWorkshop && recipeWorkshop.mode === 'manual');
  const foldBtn = withFold
    ? '<button type="button" class="rw-card-fold" onclick="rwToggleCard()" aria-expanded="' + (folded ? 'false' : 'true') + '" title="' + (folded ? '展开预览' : '收起预览，给字段腾地方') + '">' + (folded ? '展开 ▾' : '收起 ▴') + '</button>'
    : '';
  const top = '<div class="rw-card-top">'
    + '<span class="rw-card-dot" style="background:' + color + '" aria-hidden="true"></span>'
    + '<span class="rw-card-name' + (flashName ? ' rw-flash-text' : '') + '">' + _rwEsc(name || '还没起名字') + '</span>'
    + '<span class="rw-card-badge">' + _rwEsc(String(baseMeta.label || '').split('（')[0]) + '</span>'
    + (saved ? '<span class="rw-card-saved">已保存</span>' : '')
    + foldBtn
    + '</div>';
  if (compact) {
    return '<div class="rw-nodecard rw-nodecard-mini ' + _rwEsc(shapeClass) + (saved ? ' rw-nodecard-saved' : '') + '" data-rw-kind="' + _rwEsc(_rwNodeKind(recipe)) + '">' + top + '</div>';
  }
  return '<div class="rw-nodecard ' + _rwEsc(shapeClass) + (saved ? ' rw-nodecard-saved' : '') + '" data-rw-kind="' + _rwEsc(_rwNodeKind(recipe)) + '">'
    + top
    + '<div class="rw-card-desc">' + _rwEsc(desc || '还没写它做什么——下面第二行填一句就够。') + '</div>'
    + '<div class="rw-card-ports">'
    + '<div class="rw-card-port-row' + (flashInputs ? ' rw-flash-text' : '') + '"><span class="rw-port-title">输入</span>' + inputChips + '</div>'
    + '<div class="rw-card-port-row' + (flashOutputs ? ' rw-flash-text' : '') + '"><span class="rw-port-title">出口</span>' + outputChips + dynChip + '</div>'
    + '</div>'
    + '<div class="rw-card-face' + (flashFace ? ' rw-flash-text' : '') + '">'
    + _rwPalette().map(function (entry) {
        return '<button type="button" class="rw-swatch' + ((appearance.palette === entry.key && !appearance.color) ? ' current' : '') + '"'
          + ' style="background:' + entry.color + '" title="' + _rwEsc(entry.label) + '" onclick="rwPickPalette(\'' + entry.key + '\')"></button>';
      }).join('')
    + '</div>'
    + '</div>';
}

function _rwRenderCard() {
  const box = document.getElementById('rwCard');
  if (!box) return;
  box.innerHTML = _rwCardHtml({ compact: !!(recipeWorkshop && recipeWorkshop.cardCollapsed) });
}

// ---- 中栏：字段区（名字 / 它做什么 / 怎么吃材料 / 吐出什么 / 长相 / 高级）----
function _rwSyncRowsFromRecipe() {
  if (!recipeWorkshop) return;
  const recipe = recipeWorkshop.recipe || {};
  const ports = recipe.ports || {};
  recipeWorkshop.inputRows = (Array.isArray(ports.inputs) ? ports.inputs : []).map(function (port) {
    return { label: String((port && port.label) || ''), type: String((port && port.type) || '') };
  });
  recipeWorkshop.outputRows = (Array.isArray(ports.static) ? ports.static : []).map(function (port) {
    return {
      label: String((port && port.label) || ''),
      type: String((port && port.type) || ''),
      drag_form: String((port && port.drag_form) || 'draft'),
    };
  });
}

// 端口行 → 配方。空标签的行留在缓冲里让人接着打，配方只收有名字的口。
function _rwSyncPortsIntoRecipe() {
  if (!recipeWorkshop) return;
  const recipe = recipeWorkshop.recipe = recipeWorkshop.recipe || _rwEmptyRecipe();
  recipe.ports = recipe.ports || {};
  const inputs = recipeWorkshop.inputRows
    .filter(function (row) { return String(row.label || '').trim(); })
    .map(function (row) {
      const item = { label: String(row.label || '').trim().slice(0, 12) };
      if (row.type) item.type = row.type;
      return item;
    });
  if (inputs.length) recipe.ports.inputs = inputs;
  else delete recipe.ports.inputs;
  recipe.ports.static = recipeWorkshop.outputRows
    .filter(function (row) { return String(row.label || '').trim(); })
    .map(function (row) {
      const item = { label: String(row.label || '').trim().slice(0, 12), drag_form: row.drag_form || 'draft' };
      if (row.type) item.type = row.type;
      return item;
    });
}

// 本地校验错误 → 字段（后端也回 field_errors；这里只为了让红框在打字时立刻出现）
function _rwLocalErrorField(message, recipe) {
  const text = String(message || '');
  if (!text) return '';
  if (text.indexOf('名称') === 0 || text.indexOf('已有同名配方') === 0) return 'name';
  if (text.indexOf('描述') === 0) return 'desc';
  if (text.indexOf('提示词槽') === 0) {
    const match = /「([A-Za-z_]+)」/.exec(text);
    return match ? 'generate.' + match[1] : 'generate';
  }
  if (text.indexOf('AI 底座必须填写主提示词') === 0) return 'generate.prompt';
  if (text.indexOf('上下文通道') === 0) return 'generate.context_channel';
  if (text.indexOf('模型槽位') === 0) return 'generate.model_role';
  if (text.indexOf('出口') === 0) return 'ports.static';
  if (text.indexOf('输入端口') === 0) return 'ports.inputs';
  if (text.indexOf('动态出口') === 0) return 'ports.dynamic';
  if (text.indexOf('内容载体') === 0 || text.indexOf('mermaid') === 0) return 'content_kind';
  if (text.indexOf('底座类型') === 0) return 'base.kind';
  if (text.indexOf('色板') === 0) return 'appearance.palette';
  return '';
}

function _rwRefreshValidation() {
  if (!recipeWorkshop) return;
  const recipe = recipeWorkshop.recipe;
  const others = (typeof getUserRecipes === 'function' ? getUserRecipes() : [])
    .filter(function (item) { return item && item.id !== recipe.id; });
  const verdict = (typeof validateRecipe === 'function')
    ? validateRecipe(recipe, others)
    : { ok: true, errors: [] };
  recipeWorkshop.fieldErrors = (verdict.errors || []).map(function (message) {
    return { field: _rwLocalErrorField(message, recipe), message: String(message) };
  });
}

function _rwTouch(opts) {
  opts = opts || {};
  if (!recipeWorkshop) return;
  recipeWorkshop.persistMuted = false;   // 又有改动了：重新开始落盘
  _rwSyncPortsIntoRecipe();
  const normalized = _rwNormalized();
  // 归一化只在它没丢东西时回写：名称空 / 底座非法时保留用户原始输入，
  // 否则用户清空名字再打字会被「归一化返回 null」卡住。
  if (normalized) recipeWorkshop.recipe = normalized;
  recipeWorkshop.dirty = true;
  _rwRefreshValidation();
  _rwSaveDraftSoon();
  // 端口行缓冲是编辑态的唯一事实：这里绝不回灌 _rwSyncRowsFromRecipe，
  // 否则刚点出来的空行会被「归一化把空标签口滤掉」连带抹掉（一打字行就消失）。
  if (opts.structural) {
    _rwRenderFields();
    _rwRenderRun();
  }
  _rwRenderCard();
  _rwRenderSteps();
}

function _rwOption(value, label, current) {
  return '<option value="' + _rwEsc(value) + '"' + (String(value) === String(current) ? ' selected' : '') + '>' + _rwEsc(label) + '</option>';
}

function _rwSelectHtml(handler, options, title) {
  return '<select class="rw-select" title="' + _rwEsc(title || '') + '" onchange="' + handler + '">' + options + '</select>';
}

function _rwPortTypeOptions(current) {
  const labels = (typeof RECIPE_PORT_TYPE_LABELS !== 'undefined') ? RECIPE_PORT_TYPE_LABELS : {};
  const types = (typeof RECIPE_PORT_TYPES !== 'undefined') ? RECIPE_PORT_TYPES : ['text', 'formula', 'diagram', 'html'];
  return _rwOption('', '不限类型', current)
    + types.map(function (type) { return _rwOption(type, labels[type] || type, current); }).join('');
}

function _rwPortFormOptions(current) {
  return _rwOption('draft', '拖出＝草稿', current)
    + _rwOption('user', '拖出＝直接问', current);
}

function _rwPortRowsHtml(kind) {
  const isInput = kind === 'inputs';
  const rows = isInput ? (recipeWorkshop.inputRows || []) : (recipeWorkshop.outputRows || []);
  const body = rows.map(function (row, index) {
    const typeSelect = _rwSelectHtml('rwPortType(\'' + kind + '\',' + index + ',this.value)', _rwPortTypeOptions(row.type), '这个口喂/吐什么东西');
    const formSelect = isInput ? '' : _rwSelectHtml('rwPortForm(' + index + ',this.value)', _rwPortFormOptions(row.drag_form), '拖出这个出口时做什么');
    return '<div class="rw-port-row">'
      + '<input type="text" class="rw-input rw-port-label" maxlength="12" value="' + _rwEsc(row.label || '') + '"'
      + ' placeholder="' + (isInput ? '比如：题目' : '比如：步骤') + '"'
      + ' oninput="rwPortLabel(\'' + kind + '\',' + index + ',this.value)">'
      + typeSelect + formSelect
      + '<button type="button" class="rw-port-remove" onclick="rwRemovePort(\'' + kind + '\',' + index + ')" title="删掉这个口">×</button>'
      + '</div>';
  }).join('');
  const limit = isInput ? (typeof RECIPE_MAX_INPUTS !== 'undefined' ? RECIPE_MAX_INPUTS : 8) : (typeof RECIPE_MAX_PORTS !== 'undefined' ? RECIPE_MAX_PORTS : 8);
  const addBtn = rows.length >= limit
    ? '<div class="rw-port-limit">已经到上限（' + limit + ' 个）</div>'
    : '<button type="button" class="rw-port-add" onclick="rwAddPort(\'' + kind + '\')">＋ 加一个' + (isInput ? '输入口' : '出口') + '</button>';
  return body + addBtn;
}

function _rwDynamicHtml(recipe) {
  const baseKind = (recipe.base && recipe.base.kind) || 'module';
  if (baseKind !== 'module') return '';
  const dyn = recipe.ports && recipe.ports.dynamic;
  const head = '<div class="rw-dyn-head"><span>自动出口</span>'
    + '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwToggleDynamic()">'
    + (dyn ? '关掉' : '按正文自动长出问题按钮') + '</button></div>';
  if (!dyn) return head;
  const parser = dyn.parser || {};
  const each = dyn.each || {};
  const fallback = dyn.fallback || {};
  return head
    + '<div class="rw-dyn-body">'
    + '<label class="rw-sub">最多几个</label>'
    + '<input type="number" class="rw-input rw-input-short" min="1" max="12" value="' + _rwEsc(parser.max || 12) + '" onchange="rwDynamicField(\'max\',this.value)">'
    + '<label class="rw-sub">按钮名字</label>'
    + _rwSelectHtml('rwDynamicField(\'label_from\',this.value)',
        _rwOption('index_question', '问题 1 / 2 / 3', parser.label_from)
        + _rwOption('question_trunc12', '按题目正文前 12 字', parser.label_from), '动态出口的按钮名怎么取')
    + '<label class="rw-sub">点开是什么</label>'
    + _rwSelectHtml('rwDynamicField(\'each_type\',this.value)',
        _rwOption('socratic', '苏格拉底追问', each.type)
        + _rwOption('learn', '进阶学习', each.type)
        + _rwOption('branch', '普通分支', each.type), '动态出口点开后的节点类型')
    + '<label class="rw-sub">解析失败时</label>'
    + _rwSelectHtml('rwDynamicField(\'fallback\',this.value)',
        _rwOption('label_questions_from_text', '从正文里找问题当名字', fallback.mode)
        + _rwOption('static', '用固定名字', fallback.mode)
        + _rwOption('none', '不生长（只留静态出口）', fallback.mode), '正文里没解析出问题时怎么办')
    + '</div>';
}

function _rwAdvancedHtml(recipe) {
  const g = recipe.generate || {};
  const prompt = String(g.prompt || '');
  const budget = (typeof RECIPE_PROMPT_BUDGET !== 'undefined') ? RECIPE_PROMPT_BUDGET : 800;
  const over = prompt.length > budget;
  const contentKinds = (typeof RECIPE_CONTENT_KINDS !== 'undefined') ? RECIPE_CONTENT_KINDS : ['markdown', 'plain', 'mermaid', 'html_iframe'];
  const kindLabels = { markdown: 'Markdown 正文', plain: '纯文本', mermaid: 'Mermaid 图', html_iframe: '交互网页' };
  const channels = (typeof RECIPE_CONTEXT_CHANNELS !== 'undefined') ? RECIPE_CONTEXT_CHANNELS : ['workflow_context', 'prompt_inline'];
  const roles = (typeof RECIPE_MODEL_ROLES !== 'undefined') ? RECIPE_MODEL_ROLES : ['agent', 'html', 'branch', 'graph', 'quiz', 'descriptor'];
  const aggLabels = { ancestors: '收全部上游', self_fields: '读自身字段', first_inbound: '只收第一条连线', none: '不收材料' };
  const baseKind = (recipe.base && recipe.base.kind) || 'module';
  const onGenerated = recipe.on_generated;
  return '<details class="rw-advanced">'
    + '<summary>高级（写给模型读的要求、内容载体、编码）</summary>'
    + '<div class="rw-adv-body">'
    + _rwGroup('generate.prompt', '生成要求',
        '<textarea class="rw-textarea" rows="6" id="rwPrompt" oninput="rwEditPrompt(\'prompt\',this.value)"'
        + ' placeholder="写给将来生成这个节点的模型：先写什么、再写什么、不要输出什么">' + _rwEsc(prompt) + '</textarea>'
        + '<div class="rw-counter' + (over ? ' rw-counter-over' : '') + '" id="rwPromptCount">' + prompt.length + ' / ' + budget + ' 字</div>',
        '提示词槽 ≤' + budget + ' 字')
    + _rwGroup('generate.strict_output', '输出格式硬要求',
        '<textarea class="rw-textarea" rows="3" oninput="rwEditPrompt(\'strict_output\',this.value)" placeholder="可留空：比如「只输出三段，不要开场白」">' + _rwEsc(g.strict_output || '') + '</textarea>', '')
    + _rwGroup('generate.followup_prompt', '追问时怎么说',
        '<textarea class="rw-textarea" rows="2" oninput="rwEditPrompt(\'followup_prompt\',this.value)" placeholder="可留空：从出口追问时追加的要求">' + _rwEsc(g.followup_prompt || '') + '</textarea>', '')
    + _rwGroup('generate.retry_prompt', '重试时怎么说',
        '<textarea class="rw-textarea" rows="2" oninput="rwEditPrompt(\'retry_prompt\',this.value)" placeholder="可留空：重新生成时追加的要求">' + _rwEsc(g.retry_prompt || '') + '</textarea>', '')
    + _rwGroup('content_kind', '内容载体',
        _rwSelectHtml('rwEditContentKind(this.value)',
          contentKinds.map(function (kind) { return _rwOption(kind, kindLabels[kind] || kind, recipe.content_kind); }).join(''), '这个节点的正文按什么渲染'), '')
    + _rwGroup('generate.context_channel', '材料怎么交给模型',
        _rwSelectHtml('rwEditChannel(this.value)',
          channels.map(function (channel) {
            const label = channel === 'prompt_inline' ? '整段贴进提示词' : '走结构化通道（推荐）';
            return _rwOption(channel, label, g.context_channel);
          }).join(''), '上游材料以哪种方式进入提示词'), '')
    + _rwGroup('generate.model_role', '用哪个模型槽',
        _rwSelectHtml('rwEditModelRole(this.value)',
          roles.map(function (role) { return _rwOption(role, role === 'agent' ? '跟随主模型' : role, g.model_role); }).join(''), '生成这个节点用哪个模型槽位'), '')
    + (baseKind === 'module'
      ? _rwGroup('aggregation', '收哪些材料',
          _rwSelectHtml('rwEditAggregation(this.value)',
            (typeof RECIPE_AGGREGATIONS !== 'undefined' ? RECIPE_AGGREGATIONS : ['ancestors', 'self_fields', 'first_inbound', 'none'])
              .map(function (key) { return _rwOption(key, aggLabels[key] || key, recipe.aggregation); }).join(''), '生成时把哪些上游算进来'), '')
        + _rwGroup('analysis_phase', '先出一段问题概要',
          '<label class="rw-check"><input type="checkbox"' + (recipe.analysis_phase ? ' checked' : '') + ' onchange="rwToggleAnalysis(this.checked)"> 生成正文前先拆题（多花一次调用）</label>', '')
      : '')
    + (onGenerated
      ? _rwGroup('on_generated', '生成后自动长节点',
          '<div class="rw-code">' + _rwEsc(JSON.stringify(onGenerated)) + '</div>'
          + '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwClearOnGenerated()">清掉这套编排</button>', '')
      : '')
    + '</div></details>';
}

function _rwRenderFields() {
  const box = document.getElementById('rwFields');
  if (!box) return;
  const recipe = _rwCurrentRecipe();
  const baseKind = (recipe.base && recipe.base.kind) || 'module';
  const meta = _rwBaseMeta(baseKind);
  const html = [];
  html.push(_rwGroup('name', '名字',
    '<input type="text" class="rw-input" id="rwName" maxlength="24" value="' + _rwEsc(recipe.name || '') + '"'
    + ' placeholder="比如：受力分析" oninput="rwEditName(this.value)">', '最多 24 字'));
  html.push(_rwGroup('desc', '它做什么',
    '<input type="text" class="rw-input" id="rwDesc" maxlength="80" value="' + _rwEsc(recipe.desc || '') + '"'
    + ' placeholder="一句话：喂一道题，拆出力与方程，给两个出口" oninput="rwEditDesc(this.value)">', '最多 80 字'));
  html.push(_rwGroup('base.kind', '这是哪一类',
    '<div class="rw-base-grid">' + _rwBaseKinds().map(function (kind) {
      const item = _rwBaseMeta(kind);
      const current = kind === baseKind;
      return '<button type="button" class="rw-base-chip' + (current ? ' current' : '') + '" onclick="rwEditBase(\'' + kind + '\')"'
        + ' title="' + _rwEsc(item.hint || '') + '">' + _rwEsc(String(item.label || kind).split('（')[0]) + '</button>';
    }).join('') + '</div>', meta.hint || ''));
  html.push(_rwGroup('ports.inputs', '怎么吃材料',
    _rwPortRowsHtml('inputs')
    + '<div class="rw-note">每个口在试跑时占一栏，也决定画布上这根线接到哪。没有具名口就是「一栏材料」。</div>',
    '上游喂进来的东西'));
  html.push(_rwGroup('ports.static', '吐出什么',
    _rwPortRowsHtml('outputs') + _rwDynamicHtml(recipe)
    + '<div class="rw-note">出口是卡片上的按钮，点开＝沿着这个方向继续追问。</div>',
    '卡片上能点走的方向'));
  html.push(_rwGroup('appearance', '长相',
    '<div class="rw-face-row">'
    + _rwPalette().map(function (entry) {
        const current = recipe.appearance && recipe.appearance.palette === entry.key && !recipe.appearance.color;
        return '<button type="button" class="rw-swatch' + (current ? ' current' : '') + '" style="background:' + entry.color + '"'
          + ' title="' + _rwEsc(entry.label) + '" onclick="rwPickPalette(\'' + entry.key + '\')"></button>';
      }).join('')
    + '<input type="text" class="rw-input rw-color-input" maxlength="7" placeholder="#rrggbb"'
    + ' value="' + _rwEsc((recipe.appearance && recipe.appearance.color) || '') + '" onchange="rwEditColor(this.value)">'
    + '</div>', '颜色只影响画布上的点与边框'));
  html.push(_rwAdvancedHtml(recipe));
  box.innerHTML = html.join('');
}

// ---- 字段编辑回调（只重画卡片/错误，不整块重渲染字段——否则打字丢焦点）----
function rwEditName(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.recipe.name = String(value || '');
  recipeWorkshop.wishDraft = false;
  _rwTouch();
}

function rwEditDesc(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.recipe.desc = String(value || '');
  _rwTouch();
}

function rwEditBase(kind) {
  if (!recipeWorkshop) return;
  const next = String(kind || 'module');
  if (_rwBaseKinds().indexOf(next) < 0) return;
  recipeWorkshop.recipe.base = { kind: next };
  // 底座换了，动态出口/双阶段这类只有 module 能用的段要跟着收掉（与归一化同口径）
  if (next !== 'module') {
    if (recipeWorkshop.recipe.ports) delete recipeWorkshop.recipe.ports.dynamic;
    recipeWorkshop.recipe.analysis_phase = false;
    recipeWorkshop.recipe.aggregation = (typeof _rwAggregationForBase === 'function')
      ? _rwAggregationForBase(next)
      : recipeWorkshop.recipe.aggregation;
  }
  _rwTouch({ structural: true });
}

function _rwAggregationForBase(kind) {
  if (kind === 'knowledge') return 'self_fields';
  if (_rwAiBaseKinds().indexOf(kind) >= 0) return 'ancestors';
  return 'none';
}

function rwPickPalette(key) {
  if (!recipeWorkshop) return;
  const palette = recipeWorkshop.recipe.appearance = recipeWorkshop.recipe.appearance || {};
  palette.palette = String(key || 'amber');
  // 选令牌＝放弃自由色（自由色优先，不清掉会「点了没反应」）
  delete palette.color;
  _rwTouch({ structural: true });
}

function rwEditColor(value) {
  if (!recipeWorkshop) return;
  const raw = String(value || '').trim();
  const appearance = recipeWorkshop.recipe.appearance = recipeWorkshop.recipe.appearance || {};
  const normalized = (typeof normalizeRecipeColor === 'function') ? normalizeRecipeColor(raw) : raw;
  if (!raw) {
    delete appearance.color;
  } else if (normalized) {
    appearance.color = normalized;
  } else {
    if (typeof toastMsg === 'function') toastMsg('颜色要写成 #rrggbb 或 #rgb');
    return;
  }
  _rwTouch({ structural: true });
}

function rwAddPort(kind) {
  if (!recipeWorkshop) return;
  if (kind === 'inputs') {
    recipeWorkshop.inputRows.push({ label: '', type: '' });
  } else {
    recipeWorkshop.outputRows.push({ label: '', type: '', drag_form: 'draft' });
  }
  _rwTouch({ structural: true });
  const rows = kind === 'inputs' ? recipeWorkshop.inputRows : recipeWorkshop.outputRows;
  const index = rows.length - 1;
  const box = document.querySelector('#rwFields .rw-port-row:last-of-type input');
  if (box && typeof box.focus === 'function') box.focus();
  void index;
}

function rwRemovePort(kind, index) {
  if (!recipeWorkshop) return;
  const rows = kind === 'inputs' ? recipeWorkshop.inputRows : recipeWorkshop.outputRows;
  const at = Number(index);
  if (!(at >= 0 && at < rows.length)) return;
  rows.splice(at, 1);
  _rwTouch({ structural: true });
}

function rwPortLabel(kind, index, value) {
  if (!recipeWorkshop) return;
  const rows = kind === 'inputs' ? recipeWorkshop.inputRows : recipeWorkshop.outputRows;
  const row = rows[Number(index)];
  if (!row) return;
  row.label = String(value || '');
  _rwTouch();
  _rwRenderSteps();
}

function rwPortType(kind, index, value) {
  if (!recipeWorkshop) return;
  const rows = kind === 'inputs' ? recipeWorkshop.inputRows : recipeWorkshop.outputRows;
  const row = rows[Number(index)];
  if (!row) return;
  row.type = String(value || '');
  _rwTouch();
}

function rwPortForm(index, value) {
  if (!recipeWorkshop) return;
  const row = recipeWorkshop.outputRows[Number(index)];
  if (!row) return;
  row.drag_form = String(value || 'draft') === 'user' ? 'user' : 'draft';
  _rwTouch();
}

function rwToggleDynamic() {
  if (!recipeWorkshop) return;
  const recipe = recipeWorkshop.recipe;
  recipe.ports = recipe.ports || {};
  if (recipe.ports.dynamic) {
    delete recipe.ports.dynamic;
  } else {
    recipe.ports.dynamic = {
      parser: { pattern: 'numbered_list', level_tags: ['基础', '进阶', '拓展'], max: 12, label_from: 'index_question' },
      fallback: { mode: 'label_questions_from_text', labels: ['问题1', '问题2', '问题3'] },
      each: { type: 'socratic', branch_type: 'socratic', drag_form: 'draft' },
    };
  }
  _rwTouch({ structural: true });
}

function rwDynamicField(field, value) {
  if (!recipeWorkshop) return;
  const dyn = recipeWorkshop.recipe.ports && recipeWorkshop.recipe.ports.dynamic;
  if (!dyn) return;
  if (field === 'max') {
    dyn.parser = dyn.parser || {};
    dyn.parser.max = Math.max(1, Math.min(12, Number(value) || 12));
  } else if (field === 'label_from') {
    dyn.parser = dyn.parser || {};
    dyn.parser.label_from = String(value || 'index_question');
  } else if (field === 'each_type') {
    dyn.each = dyn.each || {};
    dyn.each.type = String(value || 'socratic');
    dyn.each.branch_type = dyn.each.type;
  } else if (field === 'fallback') {
    dyn.fallback = dyn.fallback || {};
    dyn.fallback.mode = String(value || 'label_questions_from_text');
  }
  _rwTouch({ structural: true });
}

function rwEditPrompt(slot, value) {
  if (!recipeWorkshop) return;
  const key = String(slot || 'prompt');
  if (!/^(prompt|strict_output|followup_prompt|retry_prompt)$/.test(key)) return;
  recipeWorkshop.recipe.generate = recipeWorkshop.recipe.generate || {};
  recipeWorkshop.recipe.generate[key] = String(value || '');
  // 计数器就地更新：整块重渲染会让光标跳走
  if (key === 'prompt') {
    const counter = document.getElementById('rwPromptCount');
    const budget = (typeof RECIPE_PROMPT_BUDGET !== 'undefined') ? RECIPE_PROMPT_BUDGET : 800;
    const length = String(value || '').length;
    if (counter) {
      counter.textContent = length + ' / ' + budget + ' 字';
      if (length > budget) counter.classList.add('rw-counter-over');
      else if (counter.classList) counter.classList.remove('rw-counter-over');
    }
  }
  _rwTouch();
}

function rwEditContentKind(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.recipe.content_kind = String(value || 'markdown');
  _rwTouch({ structural: true });
}

function rwEditChannel(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.recipe.generate = recipeWorkshop.recipe.generate || {};
  recipeWorkshop.recipe.generate.context_channel = String(value || 'workflow_context');
  _rwTouch();
}

function rwEditModelRole(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.recipe.generate = recipeWorkshop.recipe.generate || {};
  recipeWorkshop.recipe.generate.model_role = String(value || 'agent');
  _rwTouch();
}

function rwEditAggregation(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.recipe.aggregation = String(value || 'ancestors');
  _rwTouch();
}

function rwToggleAnalysis(checked) {
  if (!recipeWorkshop) return;
  recipeWorkshop.recipe.analysis_phase = !!checked;
  _rwTouch();
}

function rwClearOnGenerated() {
  if (!recipeWorkshop) return;
  delete recipeWorkshop.recipe.on_generated;
  _rwTouch({ structural: true });
  if (typeof toastMsg === 'function') toastMsg('生成后编排已清掉');
}

// ---- 左栏：对话（给建议、答问题、把一句话翻成字段改动）----
const RECIPE_WORKSHOP_EXAMPLES = [
  { key: 'review', label: '错题复盘', brief: '做一个错题复盘节点：喂一道错题，输出错因、正确思路、同类练习，出口给「提示」和「再测一道」。' },
  { key: 'physics', label: '物理建模', brief: '做一个物理建模节点：输入题目和图，输出研究对象、假设、受力、方程、结果检查，出口给「解释假设」和「换个条件」。' },
  { key: 'formula', label: '公式理解', brief: '做一个公式理解节点：喂一个公式，讲清适用条件、各量含义、量纲、常见误用，出口给「推导过程」和「应用练习」。' },
  { key: 'proof', label: '数学证明', brief: '做一个数学证明节点：喂一道证明题，输出已知条件、关键思路、证明步骤、条件检查，出口给「给个提示」和「反例检查」。' },
];

function _rwPushChat(role, text, opts) {
  if (!recipeWorkshop) return;
  opts = opts || {};
  recipeWorkshop.conversation.push({
    role: role === 'me' ? 'me' : 'phi',
    text: String(text || ''),
    at: Date.now(),
    changed: Array.isArray(opts.changed) ? opts.changed.slice(0, 8) : [],
    question: opts.question || null,
    kind: String(opts.kind || ''),
  });
  if (recipeWorkshop.conversation.length > 40) {
    recipeWorkshop.conversation = recipeWorkshop.conversation.slice(-40);
  }
  _rwSaveDraftSoon();
  if (!opts.silent) _rwRenderChat();
}

function _rwExamplesHtml() {
  return RECIPE_WORKSHOP_EXAMPLES.map(function (item) {
    return '<button type="button" class="rw-example" onclick="rwUseExample(\'' + item.key + '\')">' + _rwEsc(item.label) + '</button>';
  }).join('');
}

function _rwChatItemHtml(item) {
  const isMe = item.role === 'me';
  const changed = Array.isArray(item.changed) ? item.changed : [];
  const chips = changed.length
    ? '<div class="rw-changed-chips">改了：' + changed.map(function (path) {
        return '<span class="rw-chip rw-chip-changed">' + _rwEsc(_rwHumanizePath(path)) + '</span>';
      }).join('') + '</div>'
    : '';
  const question = item.question
    ? '<div class="rw-question">'
      + '<div class="rw-question-text">' + _rwEsc(item.question.text || '') + '</div>'
      + (item.question.field
        ? '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwGotoField(\'' + _rwEsc(item.question.field) + '\')">指给我看</button>'
        : '')
      + '</div>'
    : '';
  const undo = item.undo ? '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwUndoAi()">撤回这次改动</button>' : '';
  return '<div class="rw-msg ' + (isMe ? 'rw-msg-me' : 'rw-msg-phi') + (item.kind === 'warn' ? ' rw-msg-warn' : '') + '">'
    + '<div class="rw-msg-who">' + (isMe ? '我' : 'Φ') + '</div>'
    + '<div class="rw-msg-body">' + _rwEsc(item.text || '').replace(/\n/g, '<br>') + chips + question + undo + '</div>'
    + '</div>';
}

function _rwRenderChat() {
  const log = document.getElementById('rwChatLog');
  if (!log) return;
  const state = recipeWorkshop;
  const conversation = state ? state.conversation : [];
  if (!conversation.length) {
    log.innerHTML = '<div class="rw-empty">'
      + '<div class="rw-empty-title">想做点什么节点？</div>'
      + '<div class="rw-empty-sub">说一句就行——中间那张卡会跟着长出来，卡上每一项都能直接点开改，改完在右边拿一道真题试跑。</div>'
      + '<div class="rw-examples">' + _rwExamplesHtml() + '</div>'
      + '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini rw-copy-node" onclick="rwStartFromCanvasNode()">从画布上某个节点复制一份</button>'
      + '</div>';
  } else {
    log.innerHTML = conversation.map(_rwChatItemHtml).join('');
  }
  if (typeof log.scrollHeight === 'number') log.scrollTop = log.scrollHeight;
  _rwRenderAskState();
}

function _rwRenderAskState() {
  const btn = document.getElementById('rwAskBtn');
  if (!btn) return;
  const busy = recipeWorkshopBusy;
  if ('disabled' in btn) btn.disabled = busy;
  btn.textContent = busy ? '想想…' : '发送';
}

function rwUseExample(key) {
  const hit = RECIPE_WORKSHOP_EXAMPLES.filter(function (item) { return item.key === key; })[0];
  if (!hit) return;
  const input = document.getElementById('rwChatInput');
  if (!input) return;
  input.value = hit.brief;
  rwAsk();
}

function rwGotoField(path) {
  const raw = String(path || '');
  const boxIds = [
    'rwGroup' + raw.replace(/[^a-zA-Z0-9]/g, '-'),
    'rwGroup' + raw.replace(/\[.*$/, '').replace(/[^a-zA-Z0-9]/g, '-'),
  ];
  let box = null;
  for (let i = 0; i < boxIds.length && !box; i += 1) box = document.getElementById(boxIds[i]);
  if (!box) return;
  if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  box.classList.add('rw-pulse');
  setTimeout(function () { box.classList.remove('rw-pulse'); }, 900);
}

function _rwShouldDraft() {
  if (!recipeWorkshop) return true;
  if (recipeWorkshop.wishDraft) return true;
  const recipe = _rwCurrentRecipe();
  return !String(recipe.name || '').trim() && !String((recipe.generate || {}).prompt || '').trim();
}

async function rwAsk() {
  if (!recipeWorkshop || recipeWorkshopBusy) return;
  const input = document.getElementById('rwChatInput');
  const text = String((input && input.value) || '').trim();
  if (!text) return;
  if (input) input.value = '';
  _rwPushChat('me', text);
  await _rwRequestDraft(text);
}

// 一次草稿往返：只回它想改的那部分，服务端合并＋归一化＋校验
async function _rwRequestDraft(instruction) {
  if (!recipeWorkshop) return null;
  const model = _rwModel();
  if (!model) {
    _rwPushChat('phi', '这台机器还没配主模型——先到「模型配置」里选一个，否则我只能陪你说话、不能替你起草。', { kind: 'warn' });
    _rwRenderChat();
    return null;
  }
  if (typeof fetch !== 'function') return null;
  recipeWorkshopBusy = true;
  _rwRenderAskState();
  const snapshot = JSON.parse(JSON.stringify(recipeWorkshop.recipe || {}));
  try {
    const resp = await fetch(RECIPE_WORKSHOP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: instruction,
        draft: _rwShouldDraft() ? null : snapshot,
        mode: _rwShouldDraft() ? 'draft' : 'patch',
        history: recipeWorkshop.conversation.slice(-6).map(function (item) {
          return { role: item.role === 'me' ? 'me' : 'phi', text: item.text };
        }),
        user_recipes: (typeof getUserRecipes === 'function' ? getUserRecipes() : []).map(function (item) {
          return { id: item.id, name: item.name };
        }),
        model: _rwModelPayload(model),
        level: _rwLevel(),
        session_id: _rwSessionId(),
      }),
    });
    const data = await resp.json().catch(function () { return null; });
    if (!resp.ok || !data) {
      const reason = (data && ((data.errors && data.errors[0] && data.errors[0].reason) || data.say)) || ('HTTP ' + resp.status);
      _rwPushChat('phi', '这次没接上模型：' + String(reason).slice(0, 160), { kind: 'warn' });
      return null;
    }
    if (data.status === 'error') {
      _rwPushChat('phi', String(data.say || '这次没生成出可用的草稿，再试一次。'), { kind: 'warn' });
      if (Array.isArray(data.field_errors) && data.field_errors.length) {
        recipeWorkshop.fieldErrors = data.field_errors;
        _rwRenderFields();
      }
      return null;
    }
    if (data.recipe && typeof data.recipe === 'object') {
      if (recipeWorkshop.undoStack.length >= RECIPE_WORKSHOP_UNDO_LIMIT) recipeWorkshop.undoStack.shift();
      recipeWorkshop.undoStack.push({
        recipe: snapshot,
        label: String(data.say || '这次改动'),
        at: Date.now(),
      });
      recipeWorkshop.recipe = JSON.parse(JSON.stringify(data.recipe));
      _rwSyncRowsFromRecipe();
      recipeWorkshop.changedFields = Array.isArray(data.changed) ? data.changed : [];
      recipeWorkshop.fieldErrors = Array.isArray(data.field_errors) ? data.field_errors : [];
      recipeWorkshop.question = data.question || null;
      recipeWorkshop.wishDraft = false;
      recipeWorkshop.dirty = true;
      _rwSaveDraftNow();
      const say = String(data.say || '').trim() || '改好了，卡片上高亮的就是。';
      const chips = recipeWorkshop.changedFields.slice(0, 6);
      _rwPushChat('phi', say + (chips.length && data.mode === 'patch' ? '（只动了 ' + chopsHuman(chips) + '）' : ''), {
        changed: chips,
        question: data.question || null,
        undo: true,
      });
      if (Array.isArray(data.warnings) && data.warnings.length) {
        _rwPushChat('phi', data.warnings.join('；'), { kind: 'warn' });
      }
      _rwRenderAll();
      _rwFlashChanged();
      return data;
    }
    _rwPushChat('phi', String(data.say || '好的。'), { question: data.question || null });
    _rwRenderAll();
    return data;
  } catch (err) {
    _rwPushChat('phi', '这次没接上模型：' + String((err && err.message) || err).slice(0, 160), { kind: 'warn' });
    return null;
  } finally {
    recipeWorkshopBusy = false;
    _rwRenderAskState();
  }
}

// 「只动了 X、Y」里的人话拼接（chops＝截断后的变更路径）
function chopsHuman(paths) {
  const labels = (paths || []).map(_rwHumanizePath);
  if (!labels.length) return '几处';
  if (labels.length === 1) return labels[0];
  return labels.slice(0, -1).join('、') + ' 和 ' + labels[labels.length - 1];
}

function rwUndoAi() {
  if (!recipeWorkshop || !recipeWorkshop.undoStack.length) {
    if (typeof toastMsg === 'function') toastMsg('没有可撤回的改动了');
    return;
  }
  const last = recipeWorkshop.undoStack.pop();
  recipeWorkshop.recipe = JSON.parse(JSON.stringify(last.recipe || _rwEmptyRecipe()));
  _rwSyncRowsFromRecipe();
  recipeWorkshop.changedFields = [];
  recipeWorkshop.fieldErrors = [];
  recipeWorkshop.question = null;
  recipeWorkshop.dirty = true;
  _rwRefreshValidation();
  _rwSaveDraftNow();
  _rwPushChat('phi', '已经把「' + String(last.label || '上次改动').slice(0, 40) + '」那次撤回，卡片回到之前的样子。');
  _rwRenderAll();
}

// 从画布上已有的配方节点复制一份进来（P4：反向拉取的另一半入口）
function rwStartFromCanvasNode() {
  const nodes = _rwTopNodes().filter(function (node) {
    return node && (node.recipe || (node.recipeId && typeof getUserRecipes === 'function'
      && getUserRecipes().some(function (item) { return item.id === node.recipeId; })));
  });
  if (!nodes.length) {
    _rwPushChat('phi', '画布上还没有配方节点。先随便建一个，或者在右边试跑满意后直接「放到画布」。');
    _rwRenderChat();
    return;
  }
  _rwPushChat('phi', '画布上这几个是配方节点，点一个把它的设置复制进来：');
  nodes.slice(0, 6).forEach(function (node) {
    const recipe = node.recipe || (getUserRecipes().filter(function (item) { return item.id === node.recipeId; })[0] || {});
    _rwPushChat('phi', '· ' + String(recipe.name || node.label || node.id), {
      silent: true,
      kind: 'pick',
      question: null,
      changed: [],
    });
  });
  recipeWorkshop.pickNodes = nodes.slice(0, 6).map(function (node) {
    return { id: node.id, name: String((node.recipe && node.recipe.name) || node.label || node.id) };
  });
  _rwRenderChat();
  _rwRenderPickList();
}

function _rwRenderPickList() {
  const log = document.getElementById('rwChatLog');
  if (!log || !recipeWorkshop || !recipeWorkshop.pickNodes) return;
  const list = recipeWorkshop.pickNodes;
  const extra = document.createElement('div');
  extra.className = 'rw-pick-list';
  extra.innerHTML = list.map(function (item) {
    return '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwPullNode(\'' + _rwEsc(item.id) + '\')">' + _rwEsc(item.name) + '</button>';
  }).join('');
  log.appendChild(extra);
}

function rwPullNode(nodeId) {
  const node = _rwTopNodes().filter(function (item) { return String(item.id) === String(nodeId); })[0];
  if (!node) return;
  const recipe = node.recipe
    || (typeof getUserRecipes === 'function' ? getUserRecipes().filter(function (item) { return item.id === node.recipeId; })[0] : null);
  if (!recipe) {
    if (typeof toastMsg === 'function') toastMsg('这个节点没带配方快照，拉不进来');
    return;
  }
  const copy = JSON.parse(JSON.stringify(recipe));
  // 从画布节点拉进来＝另存草稿，不覆盖原配方（计划 3.6「从画布另存草稿」）
  copy.id = 'recipe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  copy.createdAt = Date.now();
  openRecipeWorkshop({ recipe: copy, origin: 'new' });
  _rwPushChat('phi', '把画布上「' + String(recipe.name || '这个节点') + '」的设置复制进来了，现在改的是新草稿，原来的不会变。');
  _rwRenderChat();
}

// ---- 右栏：试跑台（真材料、真模型、真输出）----
function _rwInputPorts(recipe) {
  const inputs = (recipe.ports && recipe.ports.inputs) || [];
  return Array.isArray(inputs) ? inputs : [];
}

function _rwMaterialsKeys(recipe) {
  const inputs = _rwInputPorts(recipe);
  if (!inputs.length) return ['general'];
  return inputs.map(function (port, index) { return 'in-' + index; });
}

function _rwTrialCandidates() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('phymathia_user_models') || '[]');
  } catch (e) { list = []; }
  return Array.isArray(list) ? list.filter(function (item) { return item && item.model; }) : [];
}

function _rwTrialModel() {
  const state = recipeWorkshop;
  if (state && state.trialModelId) {
    if (typeof getModelById === 'function') {
      const picked = getModelById(state.trialModelId);
      if (picked) return picked;
    }
  }
  try {
    if (typeof getActiveModelForRole === 'function') return getActiveModelForRole('agent') || null;
  } catch (e) { /* 槽位未初始化 */ }
  return null;
}

function rwTrialModelChanged(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.trialModelId = String(value || '');
  _rwRenderRun();
}

function rwMaterialChanged(key, value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.materials[String(key)] = String(value || '');
  _rwSaveDraftSoon();
}

// 试跑用与画布真生成同一条通道：提示词走 _recipeWorkflowPrompt、材料走
// workflow_context（不是另外拼一份），否则「试跑骗人」比没有更糟（计划 3.5 风险条）。
function _rwBuildWorkflowContext(recipe) {
  const state = recipeWorkshop || {};
  const inputs = _rwInputPorts(recipe);
  const upstream = [];
  if (inputs.length) {
    const typeLabels = (typeof RECIPE_PORT_TYPE_LABELS !== 'undefined') ? RECIPE_PORT_TYPE_LABELS : {};
    inputs.forEach(function (port, index) {
      const text = String((state.materials || {})['in-' + index] || '').trim();
      if (!text) return;
      upstream.push({
        label: String(port.label || ('输入' + (index + 1))),
        content: text,
        input_port: String(port.label || ''),
        input_type: typeLabels[port.type] || '',
      });
    });
  } else {
    const text = String((state.materials || {}).general || '').trim();
    if (text) upstream.push({ label: '材料', content: text });
  }
  return {
    target: { kind: _rwNodeKind(recipe), module: '', label: String(recipe.name || '配方') },
    question: upstream.length ? String(upstream[0].content || '') : '',
    mode: 'module',
    requirements: '',
    upstream: upstream,
  };
}

function _rwPseudoNode(recipe) {
  return {
    id: 'workshop-preview',
    kind: _rwNodeKind(recipe),
    moduleKey: '',
    manual: false,
    // recipeId 必须有值：_nodeRecipeSnapshot 用它判「这是配方节点」，空串会让
    // 动态出口预览静默退回静态出口（2026-10-20 冒烟抓到的坑）。
    recipeId: String(recipe.id || 'workshop-preview'),
    recipe: (typeof recipeEmbedSnapshot === 'function' ? recipeEmbedSnapshot(recipe) : null) || recipe,
    title: String(recipe.name || ''),
    summary: '',
    formulas: [],
    content: '',
    requirements: '',
    analysis: '',
    timestamp: 0,
    messageIndex: -1,
  };
}

function _rwComputeOutputPorts(recipe, content) {
  const staticPorts = (recipe.ports && recipe.ports.static) || [];
  if (typeof _recipeDynamicPorts === 'function') {
    const node = _rwPseudoNode(recipe);
    node.content = String(content || '');
    const dynamic = _recipeDynamicPorts(node, String(content || '')) || [];
    if (dynamic.length) {
      return dynamic.map(function (port) { return { label: String(port.label || ''), type: port.type || '', dynamic: true }; });
    }
  }
  return staticPorts.map(function (port) { return { label: String(port.label || ''), type: port.type || '', dynamic: false }; });
}

function _rwOutputHtml() {
  const state = recipeWorkshop;
  if (!state) return '';
  if (state.runError) {
    return '<div class="rw-out-error">' + _rwEsc(state.runError) + '</div>';
  }
  if (state.running) {
    return '<div class="rw-out-live"><div class="rw-out-live-head">生成中…</div>'
      + '<div class="rw-out-raw">' + _rwEsc(state.output || '（等着第一段字）') + '</div></div>';
  }
  if (!state.output) {
    return '<div class="rw-out-empty">跑出来的正文会显示在这里——那就是这个节点将来在画布上的样子。</div>';
  }
  const ports = (state.outputPorts || []).map(function (port) {
    return '<span class="rw-chip rw-chip-out">出口：' + _rwEsc(port.label) + (port.dynamic ? '<em>自动</em>' : '') + '</span>';
  }).join('');
  const body = (typeof renderMarkdown === 'function')
    ? renderMarkdown(String(state.output || ''), {})
    : '<pre>' + _rwEsc(state.output) + '</pre>';
  return '<div class="rw-out-body">' + body + '</div>'
    + (ports ? '<div class="rw-out-ports">' + ports + '</div>' : '')
    + '<div class="rw-quickfix"><span class="rw-quickfix-title">哪里不对？</span>'
    + '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwQuickFix(\'vague\')">太空泛</button>'
    + '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwQuickFix(\'steps\')">没分步骤</button>'
    + '<button type="button" class="rw-btn rw-btn-ghost rw-btn-mini" onclick="rwQuickFix(\'formula\')">公式没渲染</button>'
    + '</div>';
}

function _rwRenderMaterials() {
  const box = document.getElementById('rwMaterials');
  if (!box) return;
  const recipe = _rwCurrentRecipe();
  const inputs = _rwInputPorts(recipe);
  const state = recipeWorkshop || {};
  const materials = state.materials || {};
  const keys = _rwMaterialsKeys(recipe);
  box.innerHTML = keys.map(function (key, index) {
    const label = inputs.length ? String(inputs[index].label || ('输入' + (index + 1))) : '材料';
    const value = String(materials[key] || '');
    const typeLabel = inputs.length && inputs[index] && inputs[index].type && (typeof RECIPE_PORT_TYPE_LABELS !== 'undefined')
      ? (RECIPE_PORT_TYPE_LABELS[inputs[index].type] || '') : '';
    return '<div class="rw-material">'
      + '<div class="rw-material-head"><span>' + _rwEsc(label) + '</span>'
      + (typeLabel ? '<em>' + _rwEsc(typeLabel) + '</em>' : '')
      + '</div>'
      + '<textarea rows="4" class="rw-textarea" oninput="rwMaterialChanged(\'' + key + '\',this.value)"'
      + ' placeholder="' + (inputs.length ? ('贴一段' + _rwEsc(label) + '进来') : '贴一道题进来') + '">' + _rwEsc(value) + '</textarea>'
      + '</div>';
  }).join('');
}

// 把输出区画进 DOM：renderMarkdown 吐出的是 <span class="math-raw">，必须再调
// renderMath 才会变成 KaTeX（2026-10-20 真机：不调就是一行带反斜杠的裸 TeX）。
function _rwPaintOutput() {
  const box = document.getElementById('rwOutput');
  if (!box || !recipeWorkshop) return;
  box.innerHTML = _rwOutputHtml();
  if (recipeWorkshop.running) return;   // 流式中是纯文本，没必要每帧排版
  if (typeof renderMath === 'function') { try { renderMath(box); } catch (e) { /* 渲染失败不挡跑 */ } }
  if (typeof renderMermaidInElement === 'function') { try { renderMermaidInElement(box); } catch (e) {} }
}

function _rwRenderRun() {
  if (!recipeWorkshop) return;
  _rwRenderMaterials();
  const actions = document.getElementById('rwRunActions');
  const hint = document.getElementById('rwRunHint');
  const model = _rwTrialModel();
  const candidates = _rwTrialCandidates();
  if (hint) hint.textContent = model ? ('模型：' + String(model.model || '')) : '还没配模型';
  if (actions) {
    const options = '<option value="">跟主模型一样</option>' + candidates.map(function (item) {
      const id = String(item.id || '');
      const label = String(item.name || item.model || id);
      return '<option value="' + _rwEsc(id) + '"' + (id === String(recipeWorkshop.trialModelId || '') ? ' selected' : '') + '>' + _rwEsc(label) + '</option>';
    }).join('');
    actions.innerHTML = '<div class="rw-run-row">'
      + '<button type="button" class="rw-btn rw-btn-primary" id="rwRunBtn" onclick="rwRunTrial()"'
      + (recipeWorkshop.running || !model ? ' disabled' : '') + '>'
      + (recipeWorkshop.running ? '生成中…' : ((recipeWorkshop.runs || []).length ? '再跑一次' : '跑一次')) + '</button>'
      + '<select class="rw-select" onchange="rwTrialModelChanged(this.value)" title="试跑用哪个模型">' + options + '</select>'
      + '</div>'
      + (model ? '' : '<div class="rw-out-error">先到「模型配置」里选一个主模型，这里才能真正跑。</div>');
  }
  _rwPaintOutput();
  _rwRenderSaveBar();
}

let recipeWorkshopOutputTimer = null;
function _rwScheduleOutputRender() {
  if (recipeWorkshopOutputTimer) return;
  recipeWorkshopOutputTimer = setTimeout(function () {
    recipeWorkshopOutputTimer = null;
    _rwPaintOutput();
  }, 120);
}

async function rwRunTrial() {
  if (!recipeWorkshop || recipeWorkshop.running) return;
  const state = recipeWorkshop;
  const recipe = _rwNormalized() || _rwCurrentRecipe();
  const model = _rwTrialModel();
  if (!model) {
    state.runError = '先到「模型配置」里选一个主模型';
    _rwRenderRun();
    return;
  }
  const wf = _rwBuildWorkflowContext(recipe);
  if (!wf.upstream.length) {
    state.runError = '先贴一点材料——什么都不给，试跑看不出这个节点的真实水平。';
    _rwRenderRun();
    return;
  }
  _rwEnsurePrompt();     // 试跑与入册用同一份提示词，别让「能跑」和「能存」两套
  if (typeof proxyChatWithModel !== 'function') {
    state.runError = '生成通道不可用（页面还没准备好），刷新一次再试。';
    _rwRenderRun();
    return;
  }
  const seq = ++recipeWorkshopRunSeq;
  state.running = true;
  state.runError = '';
  state.output = '';
  state.outputPorts = [];
  state.lastPrompt = (typeof _recipeWorkflowPrompt === 'function')
    ? _recipeWorkflowPrompt(_rwPseudoNode(recipe), recipe, wf, String(recipe.name || '配方'))
    : String((recipe.generate || {}).prompt || '');
  const startedAt = Date.now();
  _rwRenderRun();
  try {
    const resp = await proxyChatWithModel(model, {
      prompt: state.lastPrompt,
      level: _rwLevel(),
      session_id: _rwSessionId(),
      stream: true,
      session_bucket: 'phymathia-workshop',
      parent_id: '',
      source_module: '',
      branch_type: 'blank',
      branch_id: '',
      branch_label: String(recipe.name || '配方'),
      graph_path: [],
      workflow_context: wf,
    });
    if (!resp || !resp.ok) {
      const detail = resp && typeof resp.text === 'function' ? String(await resp.text()).slice(0, 160) : '';
      throw new Error('HTTP ' + (resp && resp.status) + (detail ? '：' + detail : ''));
    }
    if (!resp.body || typeof _sseContentFrames !== 'function') {
      throw new Error('这条响应不是流式的，拿不到输出');
    }
    let acc = '';
    for await (const piece of _sseContentFrames(resp)) {
      if (!recipeWorkshop || recipeWorkshopRunSeq !== seq) return;
      acc += piece;
      state.output = acc;
      _rwScheduleOutputRender();
    }
    if (!recipeWorkshop || recipeWorkshopRunSeq !== seq) return;
    state.output = acc.trim() ? acc : acc;
    state.outputPorts = _rwComputeOutputPorts(recipe, acc);
    const run = {
      at: Date.now(),
      model: String(model.model || ''),
      ms: Date.now() - startedAt,
      chars: acc.length,
      materials: JSON.parse(JSON.stringify(state.materials || {})),
    };
    state.runs.push(run);
    if (state.runs.length > 8) state.runs = state.runs.slice(-8);
    state.lastRun = run;
    _rwSaveDraftNow();
  } catch (err) {
    if (!recipeWorkshop || recipeWorkshopRunSeq !== seq) return;
    state.runError = '试跑失败：' + String((err && err.message) || err).slice(0, 200);
  } finally {
    if (recipeWorkshop && recipeWorkshopRunSeq === seq) {
      state.running = false;
      _rwRenderRun();
      _rwRenderSteps();
    }
  }
}

const RECIPE_WORKSHOP_QUICK_FIXES = {
  vague: '输出太空泛：每一步都要给出依据（定理或公式）与具体代入，不要只给结论。',
  steps: '没分步骤：正文拆成「第一步 / 第二步…」，每步单独成段，段首标出这一步在干什么。',
  formula: '公式没渲染：所有数学式一律用 $...$（行内）或 $$...$$（独立）包起来，不要用纯文本写公式。',
};

function rwQuickFix(key) {
  if (!recipeWorkshop) return;
  const line = RECIPE_WORKSHOP_QUICK_FIXES[String(key || '')];
  if (!line) return;
  const g = recipeWorkshop.recipe.generate = recipeWorkshop.recipe.generate || {};
  const current = String(g.prompt || '').trim();
  if (current.indexOf(line) >= 0) {
    if (typeof toastMsg === 'function') toastMsg('这条要求已经在生成要求里了');
    return;
  }
  g.prompt = (current ? current + '\n' : '') + line;
  _rwTouch({ structural: true });
  _rwPushChat('phi', '生成要求里补了一条：' + line + ' 点「再跑一次」看效果。');
  _rwRenderChat();
}


// AI 底座必须有主提示词（校验器硬规则）。工坊的承诺是「不写一行提示词」——所以
// 空着的时候按卡上已有的信息起一版：名字、它做什么、喂什么、吐什么。用户随时可以
// 在「高级」里改。这不是偷偷兜底：起完会在左栏说一声（计划 3.1「AI 做副驾」）。
function _rwSuggestPrompt(recipe) {
  const name = String(recipe.name || '这个节点').trim();
  const desc = String(recipe.desc || '').trim();
  const inputs = ((recipe.ports && recipe.ports.inputs) || []).map(function (port) { return String(port.label || ''); }).filter(Boolean);
  const outputs = ((recipe.ports && recipe.ports.static) || []).map(function (port) { return String(port.label || ''); }).filter(Boolean);
  const lines = [];
  lines.push('你在生成「' + name + '」的正文。' + (desc ? desc + '。' : ''));
  if (inputs.length) lines.push('材料：' + inputs.join('、') + '，来自上游连线。');
  lines.push('只输出这个节点的正文：不要开场白，不要复述输入，也不要解释你在做什么。');
  if (outputs.length) {
    lines.push('正文按「' + outputs.join(' / ') + '」的顺序分段，每段先给一句小标题，再写内容。');
  } else {
    lines.push('正文分 2~3 段，先给结论再给依据。');
  }
  lines.push('如出现公式，一律用 $...$（行内）或 $...$（独立）包起来。');
  return lines.join('\n');
}

function _rwEnsurePrompt() {
  if (!recipeWorkshop) return false;
  const recipe = recipeWorkshop.recipe;
  const baseKind = (recipe.base && recipe.base.kind) || 'module';
  if (_rwAiBaseKinds().indexOf(baseKind) < 0) return false;
  recipe.generate = recipe.generate || {};
  if (String(recipe.generate.prompt || '').trim()) return false;
  recipe.generate.prompt = _rwSuggestPrompt(recipe);
  recipeWorkshop.autoPrompt = true;
  _rwTouch({ structural: true });
  _rwPushChat('phi', '生成要求还空着，我先按卡上的信息起了一版（高级里能改），不满意直接说「再具体点」。');
  _rwRenderChat();
  return true;
}

// ---- 一句话创造（2026-10-22）----
// 两档共用同一份草稿、同一条 /api/harness/recipe/draft：第一次是「从零起草」，
// 之后是补丁（再说一句＝改，不会把已经配好的东西冲掉）。手动档是这台工作台的
// 逐项版；智能档只留「说一句 → 看结果 → 放到画布」。
function rwSetMode(mode) {
  if (!recipeWorkshop) return;
  const next = String(mode || '') === 'manual' ? 'manual' : 'smart';
  if (recipeWorkshop.mode === next) return;
  recipeWorkshop.mode = next;
  _rwSaveDraftSoon();
  _rwRenderAll();
  const target = next === 'manual'
    ? (String(_rwCurrentRecipe().name || '').trim() ? 'rwName' : 'rwChatInput')
    : 'rwSmartInput';
  const el = document.getElementById(target);
  if (el && typeof el.focus === 'function' && el.focus) el.focus();
}

// 预览卡收起：手动档字段很多，卡片收起后只留一行名字，字段区多出两百来像素
function rwToggleCard() {
  if (!recipeWorkshop) return;
  recipeWorkshop.cardCollapsed = !recipeWorkshop.cardCollapsed;
  _rwSaveDraftSoon();
  _rwRenderCard();
}

function rwSmartInputChanged(value) {
  if (!recipeWorkshop) return;
  recipeWorkshop.smartInstruction = String(value == null ? '' : value);
}

function rwSmartKey(event) {
  if (!event || event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  rwSmartGenerate();
}

function rwSmartUseExample(key) {
  const item = RECIPE_WORKSHOP_EXAMPLES.filter(function (entry) { return entry.key === String(key); })[0];
  if (!item || !recipeWorkshop) return;
  const input = document.getElementById('rwSmartInput');
  if (input) input.value = item.brief;
  recipeWorkshop.smartInstruction = item.brief;
  rwSmartGenerate();
}

function _rwSmartModelLabel() {
  const model = _rwModel();
  return model ? ('用 ' + String(model.model || '当前主模型') + ' 来配') : '还没配主模型——先去「模型设置」选一个';
}

// 只更新状态区，不重刷整块智能面板：输入框里正在打的字不能被重渲染吃掉
function _rwRenderSmart() {
  const state = recipeWorkshop;
  const mode = state ? (state.mode || 'smart') : 'smart';
  const shell = document.querySelector('.rw-shell');
  if (shell) shell.setAttribute('data-mode', mode);
  const buttons = document.querySelectorAll('.rw-mode-btn');
  for (let i = 0; i < buttons.length; i += 1) {
    const btn = buttons[i];
    const on = String(btn.getAttribute('data-rw-mode')) === mode;
    if (btn.classList) btn.classList.toggle('current', on);
    if (btn.setAttribute) btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  const hint = document.getElementById('rwSmartHint');
  if (hint) hint.textContent = _rwSmartModelLabel();
  const go = document.getElementById('rwSmartGo');
  if (go) {
    const busy = !!(state && (state.smartBusy || (recipeWorkshopBusy && mode === 'smart')));
    if ('disabled' in go) go.disabled = busy;
    go.textContent = busy ? '正在配…' : (state && state.smartDone ? '再改一句' : '生成节点');
  }
  const examples = document.getElementById('rwSmartExamples');
  if (examples && !(examples.getAttribute && examples.getAttribute('data-ready'))) {
    if (examples.setAttribute) examples.setAttribute('data-ready', '1');
    examples.innerHTML = RECIPE_WORKSHOP_EXAMPLES.map(function (item) {
      return '<button type="button" class="rw-example" onclick="rwSmartUseExample(\'' + item.key + '\')">' + _rwEsc(item.label) + '</button>';
    }).join('');
  }
  const errBox = document.getElementById('rwSmartError');
  if (errBox) {
    const text = String((state && state.smartError) || '');
    errBox.textContent = text;
    if (text) errBox.removeAttribute('hidden');
    else errBox.setAttribute('hidden', '');
  }
  const result = document.getElementById('rwSmartResult');
  if (result) result.innerHTML = _rwSmartResultHtml();
}

function _rwSmartResultHtml() {
  const state = recipeWorkshop;
  if (!state) return '';
  if (!state.smartDone) {
    return '<div class="rw-smart-empty">配好之后这里会先给你看一张节点卡——不满意就再说一句改，满意就一键放到画布。'
      + '也可以直接点上面的例子试试。</div>';
  }
  const say = String(state.smartSay || '').trim();
  const question = state.smartQuestion && state.smartQuestion.text
    ? '<div class="rw-smart-question">Φ 还想确认一句：' + _rwEsc(String(state.smartQuestion.text)) + '</div>'
    : '';
  return '<div class="rw-smart-preview">' + _rwCardHtml({ fold: false }) + '</div>'
    + (say ? '<div class="rw-smart-say">Φ 说：' + _rwEsc(say) + '</div>' : '')
    + question
    + '<div class="rw-smart-actions">'
    + '<button type="button" class="rw-btn rw-btn-primary" onclick="rwSmartPlace()">放到画布</button>'
    + '<button type="button" class="rw-btn" onclick="rwSmartRefine()">进工坊微调</button>'
    + '<button type="button" class="rw-btn rw-btn-ghost" onclick="rwSmartReset()">换一个想法</button>'
    + '</div>'
    + '<div class="rw-smart-note">「放到画布」会先入册再放节点；之后还能在配方管理里改。</div>';
}

async function rwSmartGenerate() {
  if (!recipeWorkshop || recipeWorkshop.smartBusy || recipeWorkshopBusy) return;
  const input = document.getElementById('rwSmartInput');
  const typed = (input && typeof input.value === 'string') ? input.value : '';
  const text = String(typed || recipeWorkshop.smartInstruction || '').trim();
  if (!text) {
    if (typeof toastMsg === 'function') toastMsg('先用一句话说清你想要什么节点');
    if (input && typeof input.focus === 'function') input.focus();
    return;
  }
  if (!_rwModel()) {
    recipeWorkshop.smartError = '这台机器还没配主模型：关掉工坊，到右上角「模型设置」里选一个，再回来试。';
    _rwRenderSmart();
    return;
  }
  recipeWorkshop.smartInstruction = text;
  recipeWorkshop.smartError = '';
  recipeWorkshop.smartBusy = true;
  _rwRenderSmart();
  let data = null;
  try {
    data = await _rwRequestDraft(text);
  } catch (err) {
    if (recipeWorkshop) recipeWorkshop.smartError = '这次没接上模型：' + String((err && err.message) || err).slice(0, 160);
  } finally {
    if (recipeWorkshop) recipeWorkshop.smartBusy = false;
  }
  if (!recipeWorkshop) return;
  if (data && data.status === 'ok') {
    recipeWorkshop.smartDone = true;
    recipeWorkshop.smartSay = String(data.say || '').trim();
    recipeWorkshop.smartQuestion = data.question || null;
    recipeWorkshop.smartError = '';
    recipeWorkshop.smartInstruction = '';
    if (input) input.value = '';
    _rwSaveDraftNow();
  } else if (!recipeWorkshop.smartError) {
    const warn = (recipeWorkshop.conversation || []).slice().reverse().filter(function (item) {
      return item && item.kind === 'warn';
    })[0];
    recipeWorkshop.smartError = warn ? String(warn.text || '') : '这次没生成出可用的草稿，再试一次。';
  }
  _rwRenderSmart();
}

function rwSmartPlace() {
  if (!recipeWorkshop) return;
  if (!rwSaveRecipe()) {
    const errors = (recipeWorkshop.fieldErrors || [])
      .map(function (item) { return String((item && item.message) || ''); })
      .filter(Boolean);
    recipeWorkshop.smartError = errors.length
      ? ('还差一点：' + errors.slice(0, 3).join('；'))
      : '还差一点才能放到画布，先「进工坊微调」补一下。';
    _rwRenderSmart();
    return;
  }
  rwPlaceOnCanvas();
}

function rwSmartRefine() {
  if (!recipeWorkshop) return;
  recipeWorkshop.mode = 'manual';
  _rwSaveDraftNow();
  _rwRenderAll();
  if (typeof toastMsg === 'function') toastMsg('切到手动档了：每个字段都能直接点开改');
}

function rwSmartReset() {
  if (!recipeWorkshop) return;
  const hasWork = !!String(_rwCurrentRecipe().name || '').trim();
  if (hasWork && typeof confirm === 'function' && !confirm('把刚配好的这个节点清掉，重新说一句？已经放到画布的节点不受影响。')) return;
  recipeWorkshop.recipe = _rwEmptyRecipe();
  _rwSyncRowsFromRecipe();
  recipeWorkshop.smartDone = false;
  recipeWorkshop.smartSay = '';
  recipeWorkshop.smartQuestion = null;
  recipeWorkshop.smartError = '';
  recipeWorkshop.smartInstruction = '';
  recipeWorkshop.wishDraft = true;      // 下一轮回到「从零起草」
  recipeWorkshop.savedName = '';
  recipeWorkshop.changedFields = [];
  recipeWorkshop.fieldErrors = [];
  recipeWorkshop.undoStack = [];
  const input = document.getElementById('rwSmartInput');
  if (input) input.value = '';
  _rwSaveDraftNow();
  _rwRenderAll();
}

// ---- 入册与落地（P4）----
function _rwUpstreamCandidates() {
  const recipe = _rwCurrentRecipe();
  const inputs = _rwInputPorts(recipe);
  const labels = inputs.map(function (port) { return String(port.label || ''); }).filter(Boolean);
  return _rwTopNodes().filter(function (node) {
    return node && !node.recipeId && String(node.label || node.title || '').trim();
  }).slice(0, 8).map(function (node) {
    const title = String(node.label || node.title || node.id);
    const looksRelevant = labels.some(function (label) { return title.indexOf(label) >= 0 || label.indexOf(title) >= 0; });
    return { id: String(node.id), title: title, relevant: looksRelevant };
  }).sort(function (a, b) { return Number(b.relevant) - Number(a.relevant); });
}

function rwToggleWire(nodeId, checked) {
  if (!recipeWorkshop) return;
  const wires = recipeWorkshop.wires = recipeWorkshop.wires || {};
  const key = String(nodeId);
  if (checked) wires[key] = true;
  else delete wires[key];
  _rwRenderSaveBar();
}

function _rwRenderSaveBar() {
  const box = document.getElementById('rwSaveBar');
  if (!box) return;
  const state = recipeWorkshop;
  if (!state) { box.innerHTML = ''; return; }
  const candidates = _rwUpstreamCandidates();
  const wires = state.wires || {};
  const wireList = candidates.length
    ? '<div class="rw-wire-list">' + candidates.map(function (item) {
        return '<label class="rw-wire"><input type="checkbox"' + (wires[item.id] ? ' checked' : '')
          + ' onchange="rwToggleWire(\'' + _rwEsc(item.id) + '\',this.checked)"> '
          + _rwEsc(item.title) + (item.relevant ? '<em>看起来对得上</em>' : '') + '</label>';
      }).join('') + '</div>'
    : '<div class="rw-note">画布上还没有能接的上游节点。</div>';
  box.innerHTML = '<div class="rw-savebar-inner">'
    + '<button type="button" class="rw-btn rw-btn-primary" onclick="rwSaveRecipe()">'
    + (state.savedName ? '再存一次' : '入册') + '</button>'
    + '<button type="button" class="rw-btn" onclick="rwPlaceOnCanvas()">放到画布</button>'
    + '<span class="rw-save-status">' + (state.savedName ? ('已入册：' + _rwEsc(state.savedName)) : '还没入册') + '</span>'
    + '<details class="rw-wire-box"><summary>放到画布时接上谁</summary>' + wireList + '</details>'
    + '<button type="button" class="rw-btn rw-btn-ghost rw-discard" onclick="rwDiscardDraft()">丢弃草稿</button>'
    + '</div>';
}

function rwSaveRecipe() {
  if (!recipeWorkshop) return false;
  _rwSyncPortsIntoRecipe();
  _rwEnsurePrompt();   // AI 底座没有主提示词时，按卡片信息起一版（校验器硬规则）
  const raw = JSON.parse(JSON.stringify(recipeWorkshop.recipe || {}));
  if (!String(raw.name || '').trim()) {
    recipeWorkshop.fieldErrors = [{ field: 'name', message: '先给它起个名字' }];
    _rwRenderFields();
    if (typeof toastMsg === 'function') toastMsg('先给它起个名字');
    rwGotoField('name');
    return false;
  }
  const list = (typeof getUserRecipes === 'function') ? getUserRecipes() : [];
  const others = list.filter(function (item) { return item.id !== raw.id; });
  const verdict = (typeof validateRecipe === 'function') ? validateRecipe(raw, others) : { ok: true, errors: [] };
  if (!verdict.ok) {
    recipeWorkshop.fieldErrors = (verdict.errors || []).map(function (message) {
      return { field: _rwLocalErrorField(message, raw), message: String(message) };
    });
    _rwRenderFields();
    _rwPushChat('phi', '还差几处才能入册：' + (verdict.errors || []).slice(0, 3).join('；'), { kind: 'warn' });
    _rwRenderChat();
    return false;
  }
  const normalized = (typeof normalizeRecipeInput === 'function' ? normalizeRecipeInput(raw) : raw) || raw;
  const existing = list.filter(function (item) { return item.id === normalized.id; })[0];
  if (existing) normalized.createdAt = existing.createdAt || normalized.createdAt;
  normalized.updatedAt = Date.now();
  const next = list.filter(function (item) { return item.id !== normalized.id; }).concat([normalized]);
  if (typeof setUserRecipes === 'function') setUserRecipes(next);
  recipeWorkshop.recipe = normalized;
  recipeWorkshop.savedName = normalized.name;
  recipeWorkshop.savedAt = Date.now();
  if (recipeWorkshop.origin === 'new') recipeWorkshop.origin = normalized.id;
  recipeWorkshop.fieldErrors = [];
  recipeWorkshop.persistMuted = true;    // 先静音再清：清完不能又被写回来
  _rwClearDraftStorage();
  _rwRenderAll();
  _rwPushChat('phi', '已经入册「' + normalized.name + '」，现在可以在添加面板里找到它，也可以直接「放到画布」。');
  _rwRenderChat();
  if (typeof toastMsg === 'function') toastMsg('配方「' + normalized.name + '」已入册');
  if (typeof _recipeRefreshAddPanel === 'function') _recipeRefreshAddPanel();
  return true;
}

function _rwFreePoint() {
  const nodes = _rwTopNodes();
  let maxX = null;
  let sumY = 0;
  let count = 0;
  nodes.forEach(function (node) {
    const x = Number(node && node.x);
    const y = Number(node && node.y);
    if (isFinite(x)) maxX = (maxX === null) ? x : Math.max(maxX, x);
    if (isFinite(y)) { sumY += y; count += 1; }
  });
  if (maxX === null) return { x: 0, y: 0 };
  return { x: Math.round(maxX + 280), y: Math.round(count ? sumY / count : 0) };
}

function rwPlaceOnCanvas() {
  if (!recipeWorkshop) return;
  if (!recipeWorkshop.savedName && !rwSaveRecipe()) return;
  const recipe = _rwNormalized() || recipeWorkshop.recipe;
  if (typeof createRecipeNode !== 'function') {
    if (typeof toastMsg === 'function') toastMsg('画布还没准备好，先刷新一次');
    return;
  }
  const point = _rwFreePoint();
  try {
    if (typeof addBlankNodePoint !== 'undefined' && addBlankNodePoint) {
      addBlankNodePoint.x = point.x;
      addBlankNodePoint.y = point.y;
    }
  } catch (e) { /* addBlankNodePoint 是全局 let，极端情况下取不到就按原点放 */ }
  const nodeId = createRecipeNode(recipe.id, recipe);
  if (!nodeId) {
    if (typeof toastMsg === 'function') toastMsg('放到画布失败');
    return;
  }
  const wires = recipeWorkshop.wires || {};
  const sources = Object.keys(wires).filter(function (key) { return wires[key]; });
  let wired = 0;
  if (sources.length) {
    try {
      const gs = (typeof _graphState === 'function') ? _graphState() : null;
      if (gs) {
        gs.connections = Array.isArray(gs.connections) ? gs.connections : [];
        sources.forEach(function (sourceId, index) {
          gs.connections.push({
            from: String(sourceId),
            to: nodeId,
            fromPort: 'out-0',
            toPort: 'in-' + index,
            type: 'primary',
          });
          wired += 1;
        });
        if (typeof _saveGraphState === 'function') _saveGraphState(gs);
        if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
      }
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('workshop wire failed', e);
    }
  }
  closeRecipeWorkshop({ discard: true });
  if (typeof toastMsg === 'function') {
    toastMsg('「' + String(recipe.name || '节点') + '」已放到画布' + (wired ? '，并接上了 ' + wired + ' 个上游' : ''));
  }
}

function rwDiscardDraft() {
  if (!recipeWorkshop) return;
  const hasWork = !!(recipeWorkshop.savedName || String(_rwCurrentRecipe().name || '').trim());
  if (hasWork && typeof confirm === 'function' && !confirm('丢掉这份草稿？已经入册的配方不受影响。')) return;
  _rwClearDraftStorage();
  recipeWorkshop = null;
  if (recipeWorkshopOverlay) {
    recipeWorkshopOverlay.setAttribute('hidden', '');
    recipeWorkshopOverlay.removeAttribute('data-open');
  }
  if (typeof toastMsg === 'function') toastMsg('草稿已丢弃');
}

// ---- 入口：从配方库/画布节点进入工坊（P4）----
function openRecipeWorkshopForRecipe(recipeId) {
  const recipes = (typeof getUserRecipes === 'function') ? getUserRecipes() : [];
  const recipe = recipes.filter(function (item) { return item.id === recipeId; })[0];
  if (!recipe) {
    if (typeof toastMsg === 'function') toastMsg('配方不存在或已删除');
    return null;
  }
  return openRecipeWorkshop({ recipe: recipe, origin: recipe.id });
}

// 画布节点 → 工坊：**另存一份草稿**（计划 3.6「从画布另存草稿」）。原节点带着创建
// 时刻的快照、原配方也留在库里——工坊里改的是副本，撞了也不毁别人正在用的配方。
// 「改已有配方」走进配方管理列表的「工坊里改」（openRecipeWorkshopForRecipe）。
function openRecipeWorkshopForNode(nodeId) {
  const node = _rwTopNodes().filter(function (item) { return String(item.id) === String(nodeId); })[0];
  if (!node) return null;
  const recipe = node.recipe
    || (typeof getRecipeById === 'function' ? getRecipeById(node.recipeId) : null)
    || (typeof getUserRecipes === 'function' ? getUserRecipes().filter(function (item) { return item.id === node.recipeId; })[0] : null);
  if (!recipe) {
    if (typeof toastMsg === 'function') toastMsg('这个节点没带配方快照，拉不进来');
    return null;
  }
  const copy = JSON.parse(JSON.stringify(recipe));
  copy.id = 'recipe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  copy.createdAt = Date.now();
  const opened = openRecipeWorkshop({ recipe: copy, origin: 'new' });
  _rwPushChat('phi', '把画布上「' + String(recipe.name || '这个节点') + '」的设置复制成了新草稿——原节点和原配方都不会变。');
  _rwRenderChat();
  return opened;
}

// ---- 导出（行内 onclick 与冒烟用）----
window.openRecipeWorkshop = openRecipeWorkshop;
window.closeRecipeWorkshop = closeRecipeWorkshop;
window.openRecipeWorkshopForRecipe = openRecipeWorkshopForRecipe;
window.openRecipeWorkshopForNode = openRecipeWorkshopForNode;
window.rwOpenFromModeChip = rwOpenFromModeChip;
window.rwOpenLegacyPreset = rwOpenLegacyPreset;
window.rwAsk = rwAsk;
window.rwUseExample = rwUseExample;
window.rwUndoAi = rwUndoAi;
window.rwJump = rwJump;
window.rwGotoField = rwGotoField;
window.rwEditName = rwEditName;
window.rwEditDesc = rwEditDesc;
window.rwEditBase = rwEditBase;
window.rwPickPalette = rwPickPalette;
window.rwEditColor = rwEditColor;
window.rwAddPort = rwAddPort;
window.rwRemovePort = rwRemovePort;
window.rwPortLabel = rwPortLabel;
window.rwPortType = rwPortType;
window.rwPortForm = rwPortForm;
window.rwToggleDynamic = rwToggleDynamic;
window.rwDynamicField = rwDynamicField;
window.rwEditPrompt = rwEditPrompt;
window.rwEditContentKind = rwEditContentKind;
window.rwEditChannel = rwEditChannel;
window.rwEditModelRole = rwEditModelRole;
window.rwEditAggregation = rwEditAggregation;
window.rwToggleAnalysis = rwToggleAnalysis;
window.rwClearOnGenerated = rwClearOnGenerated;
window.rwMaterialChanged = rwMaterialChanged;
window.rwTrialModelChanged = rwTrialModelChanged;
window.rwRunTrial = rwRunTrial;
window.rwQuickFix = rwQuickFix;
window.rwSaveRecipe = rwSaveRecipe;
window.rwPlaceOnCanvas = rwPlaceOnCanvas;
window.rwDiscardDraft = rwDiscardDraft;
window.rwToggleWire = rwToggleWire;
window.rwStartFromCanvasNode = rwStartFromCanvasNode;
window.rwPullNode = rwPullNode;
// 一句话档（2026-10-22）与预览卡收起
window.rwSetMode = rwSetMode;
window.rwToggleCard = rwToggleCard;
window.rwSmartInputChanged = rwSmartInputChanged;
window.rwSmartKey = rwSmartKey;
window.rwSmartUseExample = rwSmartUseExample;
window.rwSmartGenerate = rwSmartGenerate;
window.rwSmartPlace = rwSmartPlace;
window.rwSmartRefine = rwSmartRefine;
window.rwSmartReset = rwSmartReset;
// 冒烟与后续会话用的内部探针（只读）
function _recipeWorkshopState() { return recipeWorkshop; }
window._recipeWorkshopState = _recipeWorkshopState;
// 冒烟用：清空状态与壳（顶层 let 的绑定不在 window 上，外部只能经函数清）
function _rwResetForSmoke() {
  recipeWorkshop = null;
  recipeWorkshopOverlay = null;
  recipeWorkshopBusy = false;
  recipeWorkshopRunSeq = 0;
  recipeWorkshopSaveTimer = null;
}
window._rwResetForSmoke = _rwResetForSmoke;
window._rwSteps = _rwSteps;
window._rwBuildWorkflowContext = _rwBuildWorkflowContext;
window._rwComputeOutputPorts = _rwComputeOutputPorts;
window._rwHumanizePath = _rwHumanizePath;
window._rwEmptyRecipe = _rwEmptyRecipe;
window._rwSyncRowsFromRecipe = _rwSyncRowsFromRecipe;
window._rwSaveDraftNow = _rwSaveDraftNow;
window._rwReadDraft = _rwReadDraft;
window._rwRequestDraft = _rwRequestDraft;
window._rwRenderSmart = _rwRenderSmart;
window._rwSmartResultHtml = _rwSmartResultHtml;
window._rwChangedHuman = chopsHuman;
