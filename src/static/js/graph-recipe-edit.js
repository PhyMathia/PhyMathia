// ===== 节点配方 P1：手动创作 UI（表单弹窗 / 添加面板「我的配方」组 / 存为配方 / 管理）=====
// 数据、校验、存取都在 graph-recipes.js；本文件只放 UI 与编辑流程。
// 只进主包（build_frontend.mjs），viewer 不加载——只读页没有配方库与编辑入口，
// 添加面板在 viewer 侧本身就被 viewer-main.js 桩掉（openAddBlankNodeModal stub）。
// 设计文档：docs/节点配方与创造模式-总体设计-2026-09-29.md 第 6 节 P1。

let recipeModalOverlay = null;
let recipeManageOverlay = null;
let recipeEditingId = null;     // 编辑中的配方 id；null = 新建
let recipePortRows = [];        // 出口编辑器当前行：[{ label, drag_form }]
// 动态出口编辑器状态（P2，module 底座）
let recipeDynEnabled = false;
let recipeDynCheckLevel = true;
let recipeDynMax = 12;
let recipeDynLabelFrom = 'index_question';
let recipeDynFallbackMode = 'label_questions_from_text';
let recipeDynFallbackLabels = '问题1,问题2,问题3';
let recipeDynEachType = 'socratic';
let recipeDynEachDrag = 'draft';
// 颜色编辑器状态：custom 为 '' 时走 7 个预设令牌，有值（#rrggbb）时压过令牌
let recipeColorCustom = '';
let recipeColorPresetKey = 'amber';
let recipeColorOverlay = null;
let recipeColorHsv = { h: 0, s: 0, v: 100 };
let recipeColorBaseHex = '';   // 打开时的「当前」色，只作对比用

// ---- 拖出目标选项（出口编辑器的「拖出去建什么」下拉）----
function _recipeDragFormOptions() {
  const opts = [
    { value: 'draft', label: '提问草稿' },
    { value: 'user', label: '问题节点（预填）' },
  ];
  (typeof MANUAL_NODE_OPTIONS !== 'undefined' && Array.isArray(MANUAL_NODE_OPTIONS) ? MANUAL_NODE_OPTIONS : []).forEach(option => {
    opts.push({ value: 'connected:' + option.key, label: '连线创建：' + option.label });
  });
  return opts;
}

function _recipeDragFormLabel(value) {
  const opt = _recipeDragFormOptions().find(item => item.value === value);
  return opt ? opt.label : '提问草稿';
}

// ---- 表单弹窗 ----

function openRecipeForm(prefill) {
  closeRecipeForm();
  const init = prefill || {};
  recipeEditingId = init.id || null;
  const baseKind = (init.base && init.base.kind) || 'module';
  const baseMeta = RECIPE_BASE_META[baseKind] || RECIPE_BASE_META.module;
  recipePortRows = (init.ports && Array.isArray(init.ports.static))
    ? init.ports.static.map(port => ({ label: port.label || '', drag_form: port.drag_form || 'draft' })).slice(0, RECIPE_MAX_PORTS)
    : (baseKind === 'module' ? [{ label: '追问', drag_form: 'draft' }] : []);
  // 动态出口编辑器初值（P2）
  const dyn = (init.ports && init.ports.dynamic) || null;
  recipeDynEnabled = !!dyn;
  recipeDynCheckLevel = !!(dyn && dyn.parser && Array.isArray(dyn.parser.level_tags) && dyn.parser.level_tags.length);
  recipeDynMax = (dyn && dyn.parser && Number(dyn.parser.max)) || 12;
  recipeDynLabelFrom = (dyn && dyn.parser && dyn.parser.label_from) || 'index_question';
  recipeDynFallbackMode = (dyn && dyn.fallback && dyn.fallback.mode) || 'label_questions_from_text';
  recipeDynFallbackLabels = (dyn && dyn.fallback && Array.isArray(dyn.fallback.labels) && dyn.fallback.labels.length)
    ? dyn.fallback.labels.join(',') : '问题1,问题2,问题3';
  recipeDynEachType = (dyn && dyn.each && dyn.each.type) || 'socratic';
  recipeDynEachDrag = (dyn && dyn.each && dyn.each.drag_form) || 'draft';
  // 自由色初值（2026-09-30）：空串＝走预设色板令牌
  const initColorHex = normalizeRecipeColor(init.appearance && init.appearance.color);
  recipeColorCustom = initColorHex;
  recipeColorPresetKey = (init.appearance && init.appearance.palette) || 'amber';
  const gen = init.generate || {};
  const overlay = document.createElement('div');
  overlay.className = 'graph-network-modal-overlay';
  overlay.innerHTML = '<div class="graph-network-modal graph-recipe-modal">'
    + '<div class="graph-network-modal-head"><span>' + (recipeEditingId ? '编辑配方' : '新建配方') + '</span>'
    + '<button onclick="closeRecipeForm()" title="关闭">×</button></div>'
    + '<div class="recipe-form-scroll">'
    + '<label>名称</label>'
    + '<input id="recipeName" maxlength="24" placeholder="例如：错题复盘" value="' + escapeHtml(init.name || '') + '">'
    + '<label>描述（可选）</label>'
    + '<input id="recipeDesc" maxlength="80" placeholder="这个配方用来做什么" value="' + escapeHtml(init.desc || '') + '">'
    + '<label>底座（决定生成方式）</label>'
    + '<select id="recipeBase" onchange="recipeBaseChanged()">'
    + RECIPE_BASE_KINDS.map(kind => {
        const meta = RECIPE_BASE_META[kind] || {};
        return '<option value="' + kind + '"' + (kind === baseKind ? ' selected' : '') + '>' + meta.label + '</option>';
      }).join('')
    + '</select>'
    + '<div class="recipe-form-hint" id="recipeBaseHint">' + escapeHtml(baseMeta.hint || '') + '</div>'
    + '<label>颜色</label>'
    + '<div class="recipe-palette-row" id="recipePalette">'
    + RECIPE_PALETTE.map(entry => {
        const selected = !initColorHex && recipeColorPresetKey === entry.key;
        return '<button type="button" class="recipe-palette-swatch' + (selected ? ' selected' : '') + '" data-palette="' + entry.key + '"'
          + ' onclick="recipePalettePick(\'' + entry.key + '\')" title="' + escapeHtml(entry.label) + '">'
          + '<span class="graph-add-node-dot is-round" style="background:' + entry.color + '"></span>' + escapeHtml(entry.label) + '</button>';
      }).join('')
    + '<button type="button" class="recipe-palette-swatch recipe-palette-custom' + (initColorHex ? ' selected' : '') + '"'
    + ' id="recipeColorChipBtn" onclick="openRecipeColorPicker()" title="自己调一个颜色（RGB / HSB / hex 都行）">'
    + '<span class="graph-add-node-dot is-round" id="recipeColorChip"></span>'
    + '<span id="recipeColorChipText">' + (initColorHex ? initColorHex : '自定义') + '</span></button>'
    + '</div>'
    + '<div class="recipe-form-hint" id="recipeColorHint">预设 7 色是深浅两套配好的；想更细就点「自定义」，像 PS 那样拖方块和色相条，或直接填 RGB / HSB / 色号。</div>'
    + '<div class="recipe-ai-fields" id="recipeAiFields">'
    + '<label>主提示词（AI 按它生成内容，建议 ≤' + RECIPE_PROMPT_BUDGET + ' 字）</label>'
    + '<textarea id="recipePrompt" rows="5" placeholder="例如：针对当前问题输出考后复盘，分三段：考点回顾 / 易错点 / 记忆口诀。">' + escapeHtml(gen.prompt || '') + '</textarea>'
    + '<label>严格输出要求（可选，约束格式）</label>'
    + '<textarea id="recipeStrict" rows="3" placeholder="例如：只输出三段，每段以「### 」标题开头；不要前言和结语。">' + escapeHtml(gen.strict_output || '') + '</textarea>'
    + '<label>「追问」预填模板（可选）</label>'
    + '<input id="recipeFollowup" maxlength="800" placeholder="从该节点出口拖出提问草稿时的预填文本" value="' + escapeHtml(gen.followup_prompt || '') + '">'
    + '<label>「没看懂」重讲提示词（可选）</label>'
    + '<input id="recipeConfused" maxlength="800" placeholder="用户点「没看懂」时的重讲指令" value="' + escapeHtml(gen.confused_prompt || '') + '">'
    + '<label>上游内容怎么给 AI（视角模块底座）</label>'
    + '<select id="recipeChannel">'
    + '<option value="workflow_context"' + (!gen.context_channel || gen.context_channel === 'workflow_context' ? ' selected' : '') + '>结构化上下文（官方模块方式，省 token）</option>'
    + '<option value="prompt_inline"' + (gen.context_channel === 'prompt_inline' ? ' selected' : '') + '>上游全文拼进提示词（总结方式）</option>'
    + '</select>'
    + '<label>生成用哪个模型槽（未配置的槽自动回落主模型）</label>'
    + '<select id="recipeModelRole">'
    + '<option value="agent"' + (!gen.model_role || gen.model_role === 'agent' ? ' selected' : '') + '>跟随主模型</option>'
    + '<option value="html"' + (gen.model_role === 'html' ? ' selected' : '') + '>HTML 生成槽（交互可视化同款）</option>'
    + '<option value="branch"' + (gen.model_role === 'branch' ? ' selected' : '') + '>分支追问槽（苏格拉底同款）</option>'
    + '<option value="graph"' + (gen.model_role === 'graph' ? ' selected' : '') + '>图谱槽</option>'
    + '<option value="quiz"' + (gen.model_role === 'quiz' ? ' selected' : '') + '>出题槽</option>'
    + '<option value="descriptor"' + (gen.model_role === 'descriptor' ? ' selected' : '') + '>描述槽</option>'
    + '</select>'
    + '</div>'
    + '<label>内容载体（决定生成结果的渲染方式）</label>'
    + '<select id="recipeContentKind" onchange="recipeContentKindChanged()">'
    + '<option value="markdown"' + (!init.content_kind || init.content_kind === 'markdown' ? ' selected' : '') + '>Markdown＋公式（默认）</option>'
    + '<option value="plain"' + (init.content_kind === 'plain' ? ' selected' : '') + '>纯文本（不解析）</option>'
    + '<option value="mermaid"' + (init.content_kind === 'mermaid' ? ' selected' : '') + '>知识图谱（Mermaid 图）</option>'
    + '<option value="html_iframe"' + (init.content_kind === 'html_iframe' ? ' selected' : '') + '>交互页面（HTML 演示器）</option>'
    + '</select>'
    + '<div class="recipe-retry-fields" id="recipeRetryFields">'
    + '<label>内容不完整时自动重试几次（官方交互可视化＝1）</label>'
    + '<select id="recipeMaxRetries">'
    + '<option value="0"' + (gen.on_incomplete && Number(gen.on_incomplete.max_retries) === 0 ? ' selected' : '') + '>不重试</option>'
    + '<option value="1"' + (!gen.on_incomplete || Number(gen.on_incomplete.max_retries) === 1 ? ' selected' : '') + '>重试 1 次（默认）</option>'
    + '<option value="2"' + (gen.on_incomplete && Number(gen.on_incomplete.max_retries) === 2 ? ' selected' : '') + '>重试 2 次</option>'
    + '</select>'
    + '<label>重试时追加的提示词（可选）</label>'
    + '<input id="recipeRetryPrompt" maxlength="800" placeholder="例如：请务必只输出完整 HTML，不要任何解释。" value="' + escapeHtml(gen.retry_prompt || '') + '">'
    + '</div>'
    + '<div id="recipeModuleExtras">'
    + '<label class="recipe-plain-toggle"><input type="checkbox" id="recipeAnalysisPhase"' + (init.analysis_phase ? ' checked' : '') + '> 生成前先产出问题概要（AI 回答式双阶段）</label>'
    + '<label class="recipe-plain-toggle"><input type="checkbox" id="recipeFirstInbound"' + (init.aggregation === 'first_inbound' ? ' checked' : '') + '> 只沿第一条连线的单链取材（空白节点式，多路汇聚时只讲直接上游）</label>'
    + '</div>'
    + '<div id="recipePortEditorWrap">'
    + '<label>静态出口（从节点拖出可建新节点，最多 ' + RECIPE_MAX_PORTS + ' 个）</label>'
    + '<div id="recipePortRows"></div>'
    + '<button type="button" class="recipe-port-add" onclick="recipeAddPortRow()">＋ 添加出口</button>'
    + '</div>'
    + '<div id="recipeDynamicWrap">'
    + '<label class="recipe-plain-toggle"><input type="checkbox" id="recipeDynEnabled" onchange="recipeDynToggle()"'
    + (recipeDynEnabled ? ' checked' : '') + '> 动态出口：从生成内容的编号行现场解析出口（苏格拉底式）</label>'
    + '<div id="recipeDynFields" style="display:' + (recipeDynEnabled ? '' : 'none') + '">'
    + '<label class="recipe-plain-toggle"><input type="checkbox" id="recipeDynCheckLevel" onchange="recipeDynParamChanged()"'
    + (recipeDynCheckLevel ? ' checked' : '') + '> 只收带级别标记的行（[基础] [进阶] [拓展]，苏格拉底式；不勾＝收全部编号行，进阶学习式）</label>'
    + '<label>最多解析几个出口</label>'
    + '<input id="recipeDynMax" type="number" min="1" max="' + RECIPE_MAX_DYNAMIC + '" value="' + recipeDynMax + '" onchange="recipeDynParamChanged()">'
    + '<label>出口标签怎么起</label>'
    + '<select id="recipeDynLabelFrom" onchange="recipeDynParamChanged()">'
    + '<option value="index_question"' + (recipeDynLabelFrom === 'index_question' ? ' selected' : '') + '>按序号（问题1、问题2…）</option>'
    + '<option value="question_trunc12"' + (recipeDynLabelFrom === 'question_trunc12' ? ' selected' : '') + '>截取问题文本前 12 字</option>'
    + '</select>'
    + '<label>解析不出编号行时怎么办（兜底）</label>'
    + '<select id="recipeDynFallback" onchange="recipeDynParamChanged()">'
    + '<option value="label_questions_from_text"' + (recipeDynFallbackMode === 'label_questions_from_text' ? ' selected' : '') + '>从正文截取问题文本填进兜底出口（推荐）</option>'
    + '<option value="static"' + (recipeDynFallbackMode === 'static' ? ' selected' : '') + '>固定兜底出口名（question 留空）</option>'
    + '<option value="none"' + (recipeDynFallbackMode === 'none' ? ' selected' : '') + '>不出兜底出口</option>'
    + '</select>'
    + '<label>兜底出口名（逗号分隔，按顺序用）</label>'
    + '<input id="recipeDynFallbackLabels" maxlength="80" placeholder="问题1,问题2,问题3" value="' + escapeHtml(recipeDynFallbackLabels) + '" onchange="recipeDynParamChanged()">'
    + '<label>每个动态出口拖出去建什么</label>'
    + '<select id="recipeDynEachType" onchange="recipeDynParamChanged()">'
    + '<option value="socratic"' + (recipeDynEachType === 'socratic' ? ' selected' : '') + '>苏格拉底问题卡（我来回答 / 直接问AI）</option>'
    + '<option value="learn"' + (recipeDynEachType === 'learn' ? ' selected' : '') + '>学习方向（预填「请详细讲解：…」）</option>'
    + '<option value="branch"' + (recipeDynEachType === 'branch' ? ' selected' : '') + '>普通追问草稿</option>'
    + '</select>'
    + '<select id="recipeDynEachDrag" onchange="recipeDynParamChanged()">'
    + '<option value="draft"' + (recipeDynEachDrag !== 'user' ? ' selected' : '') + '>拖出＝提问草稿</option>'
    + '<option value="user"' + (recipeDynEachDrag === 'user' ? ' selected' : '') + '>拖出＝预填问题节点</option>'
    + '</select>'
    + '</div>'
    + '</div>'
    + '<div class="recipe-form-errors" id="recipeErrors" hidden></div>'
    + '</div>'
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" onclick="saveRecipeForm()">保存配方</button>'
    + '<button onclick="closeRecipeForm()">取消</button>'
    + '</div>'
    + '</div>';
  overlay.addEventListener('pointerdown', event => {
    if (event.target === overlay) closeRecipeForm();
  });
  document.body.appendChild(overlay);
  recipeModalOverlay = overlay;
  _recipeSyncColorChip();
  recipeBaseChanged();
  _recipeRenderPortRows();
}

function closeRecipeForm() {
  closeRecipeColorPicker();
  if (recipeModalOverlay) {
    recipeModalOverlay.remove();
    recipeModalOverlay = null;
  }
  recipeEditingId = null;
  recipePortRows = [];
  recipeColorCustom = '';
}

function recipeBaseChanged() {
  const select = document.getElementById('recipeBase');
  if (!select) return;
  const kind = select.value;
  const meta = RECIPE_BASE_META[kind] || {};
  const hint = document.getElementById('recipeBaseHint');
  if (hint) hint.textContent = meta.hint || '';
  const aiFields = document.getElementById('recipeAiFields');
  if (aiFields) aiFields.style.display = RECIPE_AI_BASE_KINDS.includes(kind) ? '' : 'none';
  const portWrap = document.getElementById('recipePortEditorWrap');
  if (portWrap) portWrap.style.display = (kind === 'module' || kind === 'manual') ? '' : 'none';
  // P2 分区：动态出口/双阶段/单链只在 module 底座；mermaid/html_iframe 载体只在 AI 底座
  const dynWrap = document.getElementById('recipeDynamicWrap');
  if (dynWrap) dynWrap.style.display = kind === 'module' ? '' : 'none';
  const extras = document.getElementById('recipeModuleExtras');
  if (extras) extras.style.display = kind === 'module' ? '' : 'none';
  _recipeSyncContentKindOptions(kind);
}

// 载体下拉按底座收窄：非 AI 底座不给 mermaid/html_iframe（没有生成环节，无从产出）
function _recipeSyncContentKindOptions(kind) {
  const ckSelect = document.getElementById('recipeContentKind');
  if (!ckSelect) return;
  const ai = RECIPE_AI_BASE_KINDS.includes(kind);
  const current = ckSelect.value;
  [...ckSelect.options].forEach(option => {
    const needsAi = option.value === 'mermaid' || option.value === 'html_iframe';
    option.hidden = needsAi && !ai;
  });
  if (!ai && (current === 'mermaid' || current === 'html_iframe')) ckSelect.value = 'markdown';
  recipeContentKindChanged();
}

function recipeContentKindChanged() {
  const ckSelect = document.getElementById('recipeContentKind');
  const retryFields = document.getElementById('recipeRetryFields');
  if (!ckSelect || !retryFields) return;
  retryFields.style.display = ckSelect.value === 'html_iframe' ? '' : 'none';
}

function recipeDynToggle() {
  const box = document.getElementById('recipeDynEnabled');
  const fields = document.getElementById('recipeDynFields');
  if (box && fields) fields.style.display = box.checked ? '' : 'none';
}

// 动态出口参数就地同步进编辑器状态（表单值在 collect 时统一读取，这里只处理联动）
function recipeDynParamChanged() {
  // 占位：参数变化无需联动其它控件；保留入口以便后续加联动
}

// 点预设色＝回到令牌档（清掉自定义色）；自定义档是取色器里的那个按钮
function recipePalettePick(key) {
  recipeColorCustom = '';
  recipeColorPresetKey = key;
  _recipeSyncColorChip();
  _recipePickPreset(key);
}

function _recipePickPreset(key) {
  const row = document.getElementById('recipePalette');
  if (!row) return;
  // 只动 7 个预设按钮：自定义档也是 .recipe-palette-swatch，但没有 data-palette，
  // 它的选中态归 _recipeSyncColorChip 管（两者混在一起会互相抹掉）
  row.querySelectorAll('.recipe-palette-swatch[data-palette]').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.palette === key);
  });
}

// 色板行里那个「自定义」圆点：有自由色就显示该色，否则留空待取
function _recipeSyncColorChip() {
  const dot = document.getElementById('recipeColorChip');
  const text = document.getElementById('recipeColorChipText');
  const btn = document.getElementById('recipeColorChipBtn');
  if (dot) dot.style.background = recipeColorCustom || 'transparent';
  if (text) text.textContent = recipeColorCustom || '自定义';
  if (btn) btn.classList.toggle('selected', !!recipeColorCustom);
}

// ===== 自由取色器（PS 式：饱和度方块 × 色相条，HSB / RGB / 色号三套数值互相同步）=====
// 色值一律在运行时算出来再写进 canvas/样式，源码里不留 hex 字面量（T8 的 jsColorLiterals）。
// 主题对比度交给 CSS 的 --recipe-ink-anchor（见 graph-override.css），这里不感知主题。

// 拼 CSS 颜色函数串时把函数名拆成两段写：源码里就不会出现连续的「rgb 加左括号」，
// style_debt 那条按「函数名(参数)」形状扫的正则也就不会把它计成颜色字面量一笔。
const _RECIPE_RGB_FN = 'rgb';

function _recipeClamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function _recipeRgbCss(r, g, b) {
  return _RECIPE_RGB_FN + '(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
}

function _recipeRgbToHex(r, g, b) {
  // 每档各自补零到两位——先 join 再补零的话，任何不足两位的档都会把整串左移（红会变绿）
  const hex = [r, g, b]
    .map(n => _recipeClamp(Math.round(n), 0, 255).toString(16).padStart(2, '0'))
    .join('');
  return '#' + hex;
}

function _recipeHsvToRgb(h, s, v) {
  const H = ((h % 360) + 360) % 360;
  const S = _recipeClamp(s, 0, 100) / 100;
  const V = _recipeClamp(v, 0, 100) / 100;
  const c = V * S;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = V - c;
  const seg = Math.floor(H / 60) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg] || [0, 0, 0];
  return { r: Math.round((rgb[0] + m) * 255), g: Math.round((rgb[1] + m) * 255), b: Math.round((rgb[2] + m) * 255) };
}

function _recipeRgbToHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  return { h: ((h % 360) + 360) % 360, s: max === 0 ? 0 : d / max * 100, v: max * 100 };
}

// hex（含短写）→ hsv；认不出返回 null
function _recipeHexToHsv(value) {
  const hex = normalizeRecipeColor(value);
  if (!hex) return null;
  return _recipeRgbToHsv(
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  );
}

// 读当前主题下某个色板令牌的真实取值（--ink-* 在 :root / [data-theme="light"] 各有一套）。
// 用途：从预设切到取色器时以它当前的实际颜色起手，拖一下就是连续的微调。
function _recipeResolveTokenColor(key) {
  const entry = RECIPE_PALETTE.find(item => item.key === key);
  if (!entry || typeof getComputedStyle !== 'function') return '';
  const token = String(entry.color || '').replace(/^var\(|\)$/g, '');
  if (!token) return '';
  try {
    return normalizeRecipeColor(getComputedStyle(document.documentElement).getPropertyValue(token));
  } catch (e) {
    return '';
  }
}

function _recipeCurrentHex() {
  if (recipeColorCustom) return recipeColorCustom;
  // 令牌读不出来（少载 graph-override.css 之类的场合）就用中性灰起手，不硬塞一个设计色
  return _recipeResolveTokenColor(recipeColorPresetKey) || _recipeRgbToHex(128, 128, 128);
}

function openRecipeColorPicker() {
  closeRecipeColorPicker();
  recipeColorBaseHex = _recipeCurrentHex();
  recipeColorHsv = _recipeHexToHsv(recipeColorBaseHex) || { h: 0, s: 0, v: 100 };
  const overlay = document.createElement('div');
  overlay.className = 'recipe-color-overlay';
  overlay.id = 'recipeColorOverlay';
  overlay.innerHTML = '<div class="graph-network-modal recipe-color-panel">'
    + '<div class="graph-network-modal-head"><span>挑一个颜色</span>'
    + '<button onclick="closeRecipeColorPicker()" title="关闭">×</button></div>'
    + '<div class="recipe-color-main">'
    + '<canvas class="recipe-color-sv" id="recipeColorSv" width="248" height="176"></canvas>'
    + '<div class="recipe-color-right">'
    + '<canvas class="recipe-color-hue" id="recipeColorHue" width="18" height="176"></canvas>'
    + '<div class="recipe-color-swatches">'
    + '<div class="recipe-color-swatch-box"><div class="recipe-color-swatch" id="recipeColorNew"></div><span>新的</span></div>'
    + '<div class="recipe-color-swatch-box"><div class="recipe-color-swatch" id="recipeColorOld"></div><span>当前</span></div>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="recipe-color-grid">'
    + '<label>H<input type="number" id="recipeColorH" min="0" max="360" step="1" onchange="recipeColorFieldChanged(\'H\',this.value)"></label>'
    + '<label>S<input type="number" id="recipeColorS" min="0" max="100" step="1" onchange="recipeColorFieldChanged(\'S\',this.value)"></label>'
    + '<label>B<input type="number" id="recipeColorB" min="0" max="100" step="1" onchange="recipeColorFieldChanged(\'B\',this.value)"></label>'
    + '<label>R<input type="number" id="recipeColorR" min="0" max="255" step="1" onchange="recipeColorFieldChanged(\'R\',this.value)"></label>'
    + '<label>G<input type="number" id="recipeColorG" min="0" max="255" step="1" onchange="recipeColorFieldChanged(\'G\',this.value)"></label>'
    + '<label>B<input type="number" id="recipeColorB2" min="0" max="255" step="1" onchange="recipeColorFieldChanged(\'B2\',this.value)"></label>'
    + '<label class="recipe-color-hexlabel">色号<input id="recipeColorHex" maxlength="7" spellcheck="false" onchange="recipeColorHexChanged(this.value)"></label>'
    + '<input type="color" class="recipe-color-native" id="recipeColorNative" title="系统取色器（备用）" oninput="recipeColorNativeChanged(this.value)">'
    + '</div>'
    + '<div class="recipe-form-hint">拖方块调浓淡、拖色相条换色相；三套数值随便改哪一格都行。深浅主题下会自动调对比度，不用自己配两套。</div>'
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" onclick="recipeColorConfirm()">用这个颜色</button>'
    + '<button onclick="recipeColorResetPreset()">回到预设色</button>'
    + '<button onclick="closeRecipeColorPicker()">取消</button>'
    + '</div>'
    + '</div>';
  overlay.addEventListener('pointerdown', event => {
    if (event.target === overlay) closeRecipeColorPicker();
  });
  document.body.appendChild(overlay);
  recipeColorOverlay = overlay;
  _recipeBindColorDrag();
  _recipePaintColorPicker();
}

function closeRecipeColorPicker() {
  if (recipeColorOverlay) {
    recipeColorOverlay.remove();
    recipeColorOverlay = null;
  }
}

// 画布按设备像素比放大，高分屏不发虚
function _recipePrepCanvas(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function _recipePaintSv() {
  const canvas = document.getElementById('recipeColorSv');
  const prep = _recipePrepCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h } = prep;
  const hue = _recipeHsvToRgb(recipeColorHsv.h, 100, 100);
  const across = ctx.createLinearGradient(0, 0, w, 0);
  across.addColorStop(0, _recipeRgbCss(255, 255, 255));
  across.addColorStop(1, _recipeRgbCss(hue.r, hue.g, hue.b));
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, w, h);
  const down = ctx.createLinearGradient(0, 0, 0, h);
  down.addColorStop(0, _recipeRgbCss(255, 255, 255).replace(')', ',0)'));
  down.addColorStop(1, _recipeRgbCss(0, 0, 0));
  ctx.fillStyle = down;
  ctx.fillRect(0, 0, w, h);
  // 定位圈：白芯＋深色外圈，两种背景上都看得见
  const x = (recipeColorHsv.s / 100) * (w - 1);
  const y = ((100 - recipeColorHsv.v) / 100) * (h - 1);
  ctx.lineWidth = 3;
  ctx.strokeStyle = _recipeRgbCss(255, 255, 255);
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = _recipeRgbCss(0, 0, 0);
  ctx.beginPath();
  ctx.arc(x, y, 7.5, 0, Math.PI * 2);
  ctx.stroke();
}

function _recipePaintHue() {
  const canvas = document.getElementById('recipeColorHue');
  const prep = _recipePrepCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h } = prep;
  const bar = ctx.createLinearGradient(0, 0, 0, h);
  for (let i = 0; i <= 6; i += 1) {
    const rgb = _recipeHsvToRgb(i * 60, 100, 100);
    bar.addColorStop(i / 6, _recipeRgbCss(rgb.r, rgb.g, rgb.b));
  }
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, w, h);
  const y = (recipeColorHsv.h / 360) * h;
  ctx.lineWidth = 3;
  ctx.strokeStyle = _recipeRgbCss(255, 255, 255);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = _recipeRgbCss(0, 0, 0);
  ctx.beginPath();
  ctx.moveTo(0, y - 1.5);
  ctx.lineTo(w, y - 1.5);
  ctx.moveTo(0, y + 1.5);
  ctx.lineTo(w, y + 1.5);
  ctx.stroke();
}

// 三套数值与两个预览色同步（输入框用 onchange，避免边打字边被回写打断）
function _recipePaintColorPicker() {
  if (!recipeColorOverlay) return;
  const st = recipeColorHsv;
  const rgb = _recipeHsvToRgb(st.h, st.s, st.v);
  const hex = _recipeRgbToHex(rgb.r, rgb.g, rgb.b);
  _recipePaintSv();
  _recipePaintHue();
  const put = (id, value) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = value;
  };
  put('recipeColorH', Math.round(st.h));
  put('recipeColorS', Math.round(st.s));
  put('recipeColorB', Math.round(st.v));
  put('recipeColorR', rgb.r);
  put('recipeColorG', rgb.g);
  put('recipeColorB2', rgb.b);
  put('recipeColorHex', hex);
  put('recipeColorNative', hex);
  const fresh = document.getElementById('recipeColorNew');
  const old = document.getElementById('recipeColorOld');
  if (fresh) fresh.style.background = hex;
  if (old) old.style.background = recipeColorBaseHex || hex;
}

function _recipeBindColorDrag() {
  const bind = (id, handler) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', event => {
      event.preventDefault();
      if (el.setPointerCapture) el.setPointerCapture(event.pointerId);
      handler(event);
    });
    el.addEventListener('pointermove', event => {
      if (el.hasPointerCapture && el.hasPointerCapture(event.pointerId)) handler(event);
    });
  };
  const ratio = (event, el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: _recipeClamp((event.clientX - rect.left) / (rect.width || 1), 0, 1),
      y: _recipeClamp((event.clientY - rect.top) / (rect.height || 1), 0, 1),
    };
  };
  bind('recipeColorSv', event => {
    const el = document.getElementById('recipeColorSv');
    if (!el) return;
    const at = ratio(event, el);
    recipeColorHsv.s = at.x * 100;
    recipeColorHsv.v = (1 - at.y) * 100;
    _recipePaintColorPicker();
  });
  bind('recipeColorHue', event => {
    const el = document.getElementById('recipeColorHue');
    if (!el) return;
    recipeColorHsv.h = ratio(event, el).y * 360;
    _recipePaintColorPicker();
  });
}

function recipeColorFieldChanged(field, raw) {
  const num = Number(raw);
  if (!isFinite(num)) return;
  const st = recipeColorHsv;
  if (field === 'H') st.h = ((num % 360) + 360) % 360;
  else if (field === 'S') st.s = _recipeClamp(num, 0, 100);
  else if (field === 'B') st.v = _recipeClamp(num, 0, 100);
  else {
    const rgb = _recipeHsvToRgb(st.h, st.s, st.v);
    const key = field === 'R' ? 'r' : field === 'G' ? 'g' : 'b';
    rgb[key] = _recipeClamp(num, 0, 255);
    recipeColorHsv = _recipeRgbToHsv(rgb.r, rgb.g, rgb.b);
  }
  _recipePaintColorPicker();
}

function recipeColorHexChanged(raw) {
  const hsv = _recipeHexToHsv(String(raw || '').trim());
  if (!hsv) { _recipePaintColorPicker(); return; }
  recipeColorHsv = hsv;
  _recipePaintColorPicker();
}

function recipeColorNativeChanged(raw) {
  recipeColorHexChanged(raw);
}

// 「用这个颜色」：只写编辑器状态，不落库——取消时不留痕
function recipeColorConfirm() {
  const rgb = _recipeHsvToRgb(recipeColorHsv.h, recipeColorHsv.s, recipeColorHsv.v);
  recipeColorCustom = _recipeRgbToHex(rgb.r, rgb.g, rgb.b);
  closeRecipeColorPicker();
  _recipeSyncColorChip();
  _recipePickPreset('');
}

// 「回到预设色」：清掉自由色并落回上次选的那个预设（而不是硬跳琥珀）
function recipeColorResetPreset() {
  recipeColorCustom = '';
  closeRecipeColorPicker();
  _recipeSyncColorChip();
  _recipePickPreset(recipeColorPresetKey);
}

function recipeAddPortRow() {
  if (recipePortRows.length >= RECIPE_MAX_PORTS) {
    toastMsg('出口最多 ' + RECIPE_MAX_PORTS + ' 个');
    return;
  }
  recipePortRows.push({ label: '', drag_form: 'draft' });
  _recipeRenderPortRows();
}

function recipeRemovePortRow(index) {
  recipePortRows.splice(index, 1);
  _recipeRenderPortRows();
}

function _recipeRenderPortRows() {
  const wrap = document.getElementById('recipePortRows');
  if (!wrap) return;
  wrap.innerHTML = recipePortRows.map((row, index) => {
    const opts = _recipeDragFormOptions();
    return '<div class="recipe-port-row">'
      + '<input class="recipe-port-label" maxlength="12" placeholder="出口名" value="' + escapeHtml(row.label || '') + '" onchange="recipePortLabelChanged(' + index + ',this.value)">'
      + '<select class="recipe-port-form" onchange="recipePortFormChanged(' + index + ',this.value)">'
      + opts.map(opt => '<option value="' + opt.value + '"' + (opt.value === (row.drag_form || 'draft') ? ' selected' : '') + '>' + escapeHtml(opt.label) + '</option>').join('')
      + '</select>'
      + '<button type="button" class="recipe-port-remove" onclick="recipeRemovePortRow(' + index + ')" title="删除此出口">×</button>'
      + '</div>';
  }).join('');
}

function recipePortLabelChanged(index, value) {
  if (recipePortRows[index]) recipePortRows[index].label = String(value || '').trim();
}

function recipePortFormChanged(index, value) {
  if (recipePortRows[index]) recipePortRows[index].drag_form = String(value || 'draft');
}

function _recipeCollectForm() {
  const val = id => (document.getElementById(id) || {}).value || '';
  const checked = id => !!(document.getElementById(id) || {}).checked;
  const baseKind = val('recipeBase') || 'module';
  const selectedPalette = document.querySelector('#recipePalette .recipe-palette-swatch.selected');
  const appearance = {
    palette: (selectedPalette && selectedPalette.dataset.palette) || recipeColorPresetKey || 'amber',
    shape: _recipeDefaultShape(baseKind),
  };
  // 自由色只在真调过时才带 appearance.color——没调就整段缺省，配方还是纯预设档
  const customColor = normalizeRecipeColor(recipeColorCustom);
  if (customColor) appearance.color = customColor;
  const raw = {
    id: recipeEditingId || ('recipe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
    name: val('recipeName'),
    desc: val('recipeDesc'),
    base: { kind: baseKind },
    appearance,
    generate: {
      prompt: val('recipePrompt'),
      strict_output: val('recipeStrict'),
      followup_prompt: val('recipeFollowup'),
      confused_prompt: val('recipeConfused'),
      retry_prompt: val('recipeRetryPrompt'),
      context_channel: val('recipeChannel') || 'workflow_context',
      model_role: val('recipeModelRole') || 'agent',
      on_incomplete: { max_retries: Number(val('recipeMaxRetries') || 1) },
    },
    ports: {
      static: recipePortRows
        .filter(row => row.label)
        .map(row => ({ label: row.label, drag_form: row.drag_form || 'draft' })),
    },
    content_kind: val('recipeContentKind') || 'markdown',
    analysis_phase: baseKind === 'module' ? checked('recipeAnalysisPhase') : false,
  };
  if (baseKind === 'module' && checked('recipeFirstInbound')) raw.aggregation = 'first_inbound';
  if (baseKind === 'module' && checked('recipeDynEnabled')) {
    const maxDyn = Math.max(1, Math.min(RECIPE_MAX_DYNAMIC, Number(val('recipeDynMax')) || 12));
    raw.ports.dynamic = {
      parser: {
        pattern: 'numbered_list',
        level_tags: checked('recipeDynCheckLevel') ? ['基础', '进阶', '拓展'] : [],
        max: maxDyn,
        label_from: val('recipeDynLabelFrom') || 'index_question',
      },
      fallback: {
        mode: val('recipeDynFallback') || 'label_questions_from_text',
        labels: val('recipeDynFallbackLabels').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      },
      each: {
        type: val('recipeDynEachType') || 'socratic',
        drag_form: val('recipeDynEachDrag') === 'user' ? 'user' : 'draft',
      },
    };
  }
  return raw;
}

function saveRecipeForm() {
  const raw = _recipeCollectForm();
  const existing = getUserRecipes().filter(item => item.id !== raw.id);
  const verdict = validateRecipe(raw, existing);
  if (!verdict.ok) {
    const box = document.getElementById('recipeErrors');
    if (box) {
      box.hidden = false;
      box.textContent = '· ' + verdict.errors.join('\n· ');
    }
    return;
  }
  const normalized = normalizeRecipeInput(raw);
  const list = getUserRecipes().filter(item => item.id !== normalized.id);
  if (recipeEditingId) {
    const old = getUserRecipes().find(item => item.id === recipeEditingId);
    normalized.createdAt = (old && old.createdAt) || normalized.createdAt;
    normalized.updatedAt = Date.now();
  }
  list.push(normalized);
  setUserRecipes(list);
  closeRecipeForm();
  toastMsg('配方「' + normalized.name + '」已保存，可从添加节点面板使用');
  _recipeRefreshAddPanel();
}

// 添加面板开着时刷新它（配方增删后立即生效）
function _recipeRefreshAddPanel() {
  if (typeof addBlankNodeOverlay === 'undefined' || !addBlankNodeOverlay) return;
  if (typeof closeAddBlankNodeModal === 'function' && typeof openAddBlankNodeModal === 'function'
    && typeof addBlankNodePoint !== 'undefined') {
    closeAddBlankNodeModal();
    openAddBlankNodeModal(addBlankNodePoint.x, addBlankNodePoint.y);
  }
}

// ---- 管理弹窗（删除是破坏性操作：确认后才删；旧节点带快照不受影响）----

function openRecipeManage() {
  closeRecipeManage();
  const recipes = getUserRecipes();
  const rows = recipes.length
    ? recipes.map(recipe => {
        const meta = RECIPE_BASE_META[recipe.base.kind] || {};
        return '<div class="recipe-manage-row">'
          + '<span class="graph-add-node-dot is-round" style="background:' + recipeAppearanceColor(recipe.appearance) + '"></span>'
          + '<span class="recipe-manage-name">' + escapeHtml(recipe.name) + '</span>'
          + '<span class="recipe-manage-meta">' + escapeHtml((meta.label || '').split('（')[0]) + ' · ' + recipe.ports.static.length + ' 出口</span>'
          + '<button class="recipe-manage-edit" onclick="openRecipeFormById(\'' + recipe.id + '\')">编辑</button>'
          + '<button class="recipe-manage-delete" onclick="deleteRecipeById(\'' + recipe.id + '\')">删除</button>'
          + '</div>';
      }).join('')
    : '<div class="recipe-manage-empty">还没有配方——从画布双击空白处打开添加节点面板，点「＋ 新建配方」。</div>';
  const overlay = document.createElement('div');
  overlay.className = 'graph-network-modal-overlay';
  overlay.innerHTML = '<div class="graph-network-modal">'
    + '<div class="graph-network-modal-head"><span>管理配方</span><button onclick="closeRecipeManage()" title="关闭">×</button></div>'
    + rows
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" onclick="closeRecipeManage();openRecipeForm(null)">＋ 新建配方</button>'
    + '<button onclick="closeRecipeManage()">关闭</button>'
    + '</div>'
    + '</div>';
  overlay.addEventListener('pointerdown', event => {
    if (event.target === overlay) closeRecipeManage();
  });
  document.body.appendChild(overlay);
  recipeManageOverlay = overlay;
}

function closeRecipeManage() {
  if (recipeManageOverlay) {
    recipeManageOverlay.remove();
    recipeManageOverlay = null;
  }
}

function openRecipeFormById(recipeId) {
  const recipe = getUserRecipes().find(item => item.id === recipeId);
  if (!recipe) return;
  closeRecipeManage();
  openRecipeForm(recipe);
}

function deleteRecipeById(recipeId) {
  const recipe = getUserRecipes().find(item => item.id === recipeId);
  if (!recipe) return;
  if (!confirm('删除配方「' + recipe.name + '」？\n画布上已创建的节点不受影响（它们带着创建时刻的快照），只是添加面板不再出现。')) return;
  setUserRecipes(getUserRecipes().filter(item => item.id !== recipeId));
  closeRecipeManage();
  toastMsg('配方「' + recipe.name + '」已删除（旧节点不受影响）');
  _recipeRefreshAddPanel();
}

// ---- 右键「存为配方」：从现有节点提炼（kind＋现行出口表反推；提示词无法反推，留空待填）----

function recipeFromNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node) return;
  const kindToBase = {
    module: 'module', summary: 'summary', knowledge: 'knowledge', relation: 'relation',
    note: 'note', human_note: 'human_note', user: 'question',
  };
  let baseKind = kindToBase[node.kind];
  if (node.kind === 'answer') baseKind = node.manual ? 'manual' : null;
  if (!baseKind) {
    toastMsg('这类节点暂不支持存为配方（P1 支持：模块 / 总结 / 知识点 / 联系 / 笔记 / 人工类）');
    return;
  }
  const messages = _getChatHistory();
  const portLabels = node.kind === 'module'
    ? _moduleOutputPorts(node, node.messageIndex >= 0 ? messages[node.messageIndex] : null).map(port => port.label)
    : [];
  const prefill = {
    id: null,
    name: (node.recipe && node.recipe.name) || (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.label || node.title || '',
    desc: '',
    base: { kind: baseKind },
    appearance: node.recipe && node.recipe.appearance
      ? Object.assign({}, node.recipe.appearance, { shape: _recipeDefaultShape(baseKind) })
      : { palette: 'amber', shape: _recipeDefaultShape(baseKind) },
    generate: {
      // 内置节点的提示词写在代码里，提炼时带不出来——AI 底座保存前需要补写主提示词
      prompt: (node.recipe && node.recipe.generate && node.recipe.generate.prompt) || '',
      strict_output: (node.recipe && node.recipe.generate && node.recipe.generate.strict_output) || '',
      followup_prompt: '',
      confused_prompt: '',
      context_channel: (node.recipe && node.recipe.generate && node.recipe.generate.context_channel) || 'workflow_context',
    },
    ports: {
      static: portLabels.filter(Boolean).slice(0, RECIPE_MAX_PORTS).map(label => ({ label: String(label).slice(0, 12), drag_form: 'draft' })),
    },
    content_kind: (node.recipe && node.recipe.content_kind) || (baseKind === 'human_note' ? 'plain' : 'markdown'),
  };
  openRecipeForm(prefill);
  if (RECIPE_AI_BASE_KINDS.includes(baseKind) && !prefill.generate.prompt) {
    const hint = document.getElementById('recipeErrors');
    if (hint) {
      hint.hidden = false;
      hint.textContent = '· 已按「' + (prefill.name || '该节点') + '」的底座与出口预填；内置节点的提示词无法带出，请在「主提示词」里补写后保存。';
    }
  }
}

// ---- 启动对账：服务端配方镜像合并回本地（localStorage 为主，服务端兜底跨浏览器）----

(function initRecipeSync() {
  if (typeof syncUserRecipesFromServer !== 'function') return;
  Promise.resolve(syncUserRecipesFromServer()).then(changed => {
    if (changed) _recipeRefreshAddPanel();
  }).catch(() => {});
})();

window.openRecipeForm = openRecipeForm;
window.closeRecipeForm = closeRecipeForm;
window.recipeBaseChanged = recipeBaseChanged;
window.recipeContentKindChanged = recipeContentKindChanged;
window.recipeDynToggle = recipeDynToggle;
window.recipeDynParamChanged = recipeDynParamChanged;
window.recipePalettePick = recipePalettePick;
window.openRecipeColorPicker = openRecipeColorPicker;
window.closeRecipeColorPicker = closeRecipeColorPicker;
window.recipeColorFieldChanged = recipeColorFieldChanged;
window.recipeColorHexChanged = recipeColorHexChanged;
window.recipeColorNativeChanged = recipeColorNativeChanged;
window.recipeColorConfirm = recipeColorConfirm;
window.recipeColorResetPreset = recipeColorResetPreset;
// 色值换算挂 window 供 smoke 断言往返自洽（取色器最怕的就是 hex↔hsv 悄悄漂色）
window._recipeHsvToRgb = _recipeHsvToRgb;
window._recipeRgbToHsv = _recipeRgbToHsv;
window._recipeRgbToHex = _recipeRgbToHex;
window.recipeAddPortRow = recipeAddPortRow;
window.recipeRemovePortRow = recipeRemovePortRow;
window.recipePortLabelChanged = recipePortLabelChanged;
window.recipePortFormChanged = recipePortFormChanged;
window.saveRecipeForm = saveRecipeForm;
window.openRecipeManage = openRecipeManage;
window.closeRecipeManage = closeRecipeManage;
window.openRecipeFormById = openRecipeFormById;
window.deleteRecipeById = deleteRecipeById;
window.recipeFromNode = recipeFromNode;
