// ===== 节点配方注册表（官方类型单一事实源，P0 粒度）=====
// 设计文档：docs/节点配方与创造模式-总体设计-2026-09-29.md（第 3 节 schema、第 8.1 节背景）。
// P0 原则：只收敛数据、行为零变化——本表派生原散落三处的硬编码（前端 kind 白名单、
// 添加面板 16 入口；第三处 Φ 快照的 available_node_types 已于 2026-10-06 随死通道
// T111 退役，见 docs/dev/harness.md 当日节），渲染/生成逻辑仍读 graph.js 里
// 由本表派生的同名常量；生成提示词四槽、动态出口、内容载体等行为维度 P1 起充实，
// 官方配方「用户配方同模型」的完整形态见设计文档。
// 后端投影在 harness/registry.py，两边由 tests/test_registry_consistency.py 对拍守护；
// 改这张表必须同步改对拍测试，别只改一侧。

const BUILTIN_RECIPES = [
  // —— 视角模块（kind=module × moduleKey，顺序＝添加面板顺序）——
  { key: 'physics', kind: 'module', moduleKey: 'physics', label: '物理视角', color: 'var(--node-physics)', group: 'modules', desc: '' },
  { key: 'math', kind: 'module', moduleKey: 'math', label: '数学视角', color: 'var(--node-math)', group: 'modules', desc: '' },
  { key: 'graph', kind: 'module', moduleKey: 'graph', label: '知识图谱', color: 'var(--node-graph)', group: 'modules', desc: '' },
  { key: 'viz', kind: 'module', moduleKey: 'viz', label: '交互可视化', color: 'var(--node-viz)', group: 'modules', desc: '' },
  { key: 'learn', kind: 'module', moduleKey: 'learn', label: '进阶学习', color: 'var(--node-learn)', group: 'modules', desc: '' },
  { key: 'socratic', kind: 'module', moduleKey: 'socratic', label: '苏格拉底追问', color: 'var(--node-socratic)', group: 'modules', desc: '' },
  // —— AI 组 ——
  { key: 'blank', kind: 'blank', label: 'AI 生成空白', color: 'var(--node-any)', group: 'ai', desc: '输入任意要求，AI 生成任意内容' },
  { key: 'answer', kind: 'answer', label: 'AI 回答', color: 'var(--node-answer)', group: 'ai', desc: 'AI 回答节点（含摘要）' },
  { key: 'summary', kind: 'summary', label: 'AI 总结', color: 'var(--node-summary)', group: 'ai', desc: 'AI 生成总结' },
  // —— 素材组（data）——
  { key: 'source', kind: 'source', label: '输入', color: 'var(--node-source)', group: 'data', desc: '导入文件/文本，解析出知识点' },
  { key: 'knowledge', kind: 'knowledge', label: '知识点', color: 'var(--node-knowledge)', group: 'data', desc: '手动记录一个知识点' },
  { key: 'question', kind: 'user', label: '问题', color: 'var(--node-question)', group: 'data', desc: '提问节点，可接 AI 回答' },
  // —— 人工组（human）——
  // manual 在 module 键空间有历史身份（后端 ALLOWED_MODULE_KEYS / GRAPH_MODULE_META 均含
  // manual 键），注册表带 moduleKey 对齐两侧键空间；它本体不是 module 节点，派生投影不受影响
  { key: 'manual', kind: 'answer', manual: true, moduleKey: 'manual', label: '我的回答', color: 'var(--ink-human)', group: 'human', desc: '手写回答，可继续发散（无摘要）' },
  { key: 'human_note', kind: 'human_note', label: '我的理解', color: 'var(--ink-note)', group: 'human', desc: '批注/笔记，可附公式' },
  { key: 'note', kind: 'note', label: '我的总结', color: 'var(--ink-human)', group: 'human', desc: '汇聚后的手动总结' },
  // —— 结构组（structure）——
  { key: 'hub', kind: 'hub', label: '汇聚', color: 'var(--node-hub)', group: 'structure', desc: '汇总多路输入，可总结或追问' },
  // —— 无手动入口的类型（hidden：不进添加面板，只作为 kind 存在）——
  // relation：创建口径已移除（Φ 提示词明示勿建、后端 ALLOWED_CREATE_KINDS 不含），
  // 但旧会话数据里可能仍有 relation 节点——注册表收录它只为白名单派生，
  // 让这些节点在保存/恢复时不再被静默抹掉（backlog T75）。
  { key: 'relation', kind: 'relation', label: '联系', color: 'var(--node-relation)', group: 'data', desc: '', hidden: true },
  { key: 'ai_eval', kind: 'ai_eval', label: 'AI 评价', color: 'var(--node-ai-eval)', group: 'ai', desc: '', hidden: true },
];

function _recipeByKey(key) {
  return BUILTIN_RECIPES.find(recipe => recipe.key === key) || null;
}

// 添加节点面板的 16 入口（P0 与原 MANUAL_NODE_OPTIONS 字面量逐字段一致；
// module 组原本就没有 desc，派生时 desc 为空串则不设键，保持形状不变）
function deriveManualNodeOptions() {
  return BUILTIN_RECIPES
    .filter(recipe => !recipe.hidden)
    .map(recipe => {
      const option = { key: recipe.key, kind: recipe.kind, label: recipe.label, color: recipe.color, group: recipe.group };
      if (recipe.desc) option.desc = recipe.desc;
      return option;
    });
}

// 自定义节点 kind 白名单（原 GRAPH_CUSTOM_NODE_KINDS 11 项 ＋ relation＝12 项，T75 修复）
function deriveGraphCustomNodeKinds() {
  const kinds = [];
  BUILTIN_RECIPES.forEach(recipe => {
    if (!kinds.includes(recipe.kind)) kinds.push(recipe.kind);
  });
  return kinds;
}

window.BUILTIN_RECIPES = BUILTIN_RECIPES;
window.deriveManualNodeOptions = deriveManualNodeOptions;
window.deriveGraphCustomNodeKinds = deriveGraphCustomNodeKinds;

// ===== 用户配方（P1 基础配方层）：schema 最小子集 / 色板 / 校验器 / 存取 =====
// 设计文档第 3、6 节（P1）：配方是纯数据 JSON（D-R2），节点走「现有 kind 底座＋
// recipeId＋内嵌快照」的覆盖层路线（D-R3）——本文件只放数据与纯函数，UI 在
// graph-recipe-edit.js。后端同构校验器在 harness/recipes.py，两侧由
// tests/test_recipe_schema.py 对拍（改任何一侧先同步另一侧）。

// P1 底座集合：base.kind 决定节点落库形态与生成路径（S1 九种里 answer 的
// 双阶段与 blank 的单父链聚合是 S3 维度，P2/P3 再开）。
const RECIPE_BASE_KINDS = ['module', 'summary', 'knowledge', 'relation', 'note', 'human_note', 'manual', 'question'];
// 有 AI 生成槽的底座（其余为人工手填，generate 可整段缺省）
const RECIPE_AI_BASE_KINDS = ['module', 'summary', 'knowledge', 'relation'];
const RECIPE_BASE_META = {
  module: { label: '视角模块（AI 生成，配出口）', family: 'modules', shape: 'is-round', hint: '像「物理视角」那样：挂在上游下面生成一块内容，出口可拖出追问。' },
  summary: { label: 'AI 总结（读全部上游全文）', family: 'ai', shape: 'is-round', hint: '把上游节点全文收进提示词再生成，适合汇总、提炼类。' },
  knowledge: { label: '知识点解释（读自身标题/摘要/公式）', family: 'data', shape: 'is-ring', hint: '像「知识点」节点：按自身字段生成解释。' },
  relation: { label: '联系（读全部上游，短文）', family: 'data', shape: 'is-ring', hint: '说明上游节点间的联系，一段短文，需至少两条入边。' },
  note: { label: '我的总结（手填）', family: 'human', shape: 'is-square', hint: '人工书写，不调 AI。' },
  human_note: { label: '我的理解（手填，纯文本）', family: 'human', shape: 'is-square', hint: '批注/笔记，内容按纯文本渲染。' },
  manual: { label: '我的回答（手填）', family: 'human', shape: 'is-square', hint: '人工书写回答，可继续发散。' },
  question: { label: '问题（手填）', family: 'data', shape: 'is-ring', hint: '提问节点，接 AI 回答或继续追问。' },
};

// 成对色板（D-R8 的预设档）。令牌定义在 graph-override.css 的 --ink-* 块（深浅两套）；
// 这里只引用令牌名，JS 侧零 hex 字面量（T8 红线）。色相彼此隔开，与官方节点色不同族。
const RECIPE_PALETTE = [
  { key: 'amber', label: '琥珀', color: 'var(--ink-amber)' },
  { key: 'blue', label: '靛蓝', color: 'var(--ink-blue)' },
  { key: 'rose', label: '胭脂', color: 'var(--ink-rose)' },
  { key: 'teal', label: '苍青', color: 'var(--ink-teal)' },
  { key: 'violet', label: '紫墨', color: 'var(--ink-violet)' },
  { key: 'human', label: '赭墨', color: 'var(--ink-human)' },
  { key: 'note', label: '青墨', color: 'var(--ink-note)' },
];
// 自由取色档（2026-09-30 用户拍板，D-R8 从「只许令牌」放宽为「令牌 + 任意 RGB」）。
// 存 #rrggbb（短写 #rgb 落库时补齐成长写），有 appearance.color 就压过 palette 令牌。
// 深浅主题的适配不在 JS 做，而在 CSS：返回的色值是 color-mix(...var(--recipe-ink-anchor))，
// 锚点随 data-theme 变——切主题时画布不必重绘（applyTheme 不触发 graph 重渲染）。
const RECIPE_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
// 自定义墨色往锚点掺的比例：深色主题掺白、浅色主题掺黑，接近成对令牌的手工位移
const RECIPE_COLOR_MIX = 'color-mix(in srgb, ';

function normalizeRecipeColor(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!RECIPE_COLOR_RE.test(raw)) return '';
  if (raw.length === 4) return '#' + raw[1] + raw[1] + raw[2] + raw[2] + raw[3] + raw[3];
  return raw;
}

// 配方外观的最终色值：自定义色优先（带主题适配），否则回色板令牌，再否则中性色。
// 节点渲染、添加面板圆点、管理列表圆点三处共用，保证同一个配方处处同色。
function recipeAppearanceColor(appearance) {
  const custom = normalizeRecipeColor(appearance && appearance.color);
  if (custom) return RECIPE_COLOR_MIX + custom + ' 75%, var(--recipe-ink-anchor))';
  const entry = RECIPE_PALETTE.find(item => item.key === (appearance && appearance.palette));
  return entry ? entry.color : 'var(--accent)';
}
const RECIPE_SHAPES = ['is-round', 'is-square', 'is-diamond', 'is-ring'];
// P2 载体扩展：mermaid/html_iframe 复用官方「知识图谱/交互可视化」的现成渲染器，
// 只允许 AI 底座声明（渲染分派见 _renderCustomNodeContentHtml / 生成侧归一见
// _generateCustomNode）；formulas_list 留给 P4 生态再议
const RECIPE_CONTENT_KINDS = ['markdown', 'plain', 'mermaid', 'html_iframe'];
const RECIPE_CONTEXT_CHANNELS = ['workflow_context', 'prompt_inline'];
// 模型槽位（models.js 六槽的子集引用；agent 是缺省跟随主模型）
const RECIPE_MODEL_ROLES = ['agent', 'html', 'branch', 'graph', 'quiz', 'descriptor'];
const RECIPE_PROMPT_BUDGET = 800;   // 每个提示词槽的建议上限（字符）
const RECIPE_MAX_PORTS = 8;
// ── P2 动态出口（S2 维度，苏格拉底/进阶学习式）──
const RECIPE_PARSER_PATTERNS = ['numbered_list'];      // 内置解析器枚举（不开放自由正则）
const RECIPE_LABEL_FROM = ['index_question', 'question_trunc12'];
const RECIPE_FALLBACK_MODES = ['static', 'label_questions_from_text', 'none'];
const RECIPE_DYNAMIC_PORT_TYPES = ['socratic', 'learn', 'branch'];
const RECIPE_MAX_DYNAMIC = 12;                          // 与官方 _parsePortQuestions 上限一致
// ── P2 取材与编排（S3 维度）──
const RECIPE_AGGREGATIONS = ['ancestors', 'self_fields', 'first_inbound', 'none'];
const RECIPE_ON_GENERATED_KINDS = ['answer', 'module', 'blank', 'user', 'note', 'human_note'];
const RECIPE_ON_GENERATED_CONTENT_FROM = ['', 'self_content', 'self_directions'];
const RECIPE_MAX_ON_GENERATED = 4;

// aggregation 由底座推导（P1 口径），P2 起允许 module 底座显式声明 first_inbound
// （空白节点式单父链取材）；其余底座保持推导值
function _recipeAggregationForBase(baseKind, override) {
  if (baseKind === 'module' && override === 'first_inbound') return 'first_inbound';
  if (baseKind === 'knowledge') return 'self_fields';
  if (RECIPE_AI_BASE_KINDS.includes(baseKind)) return 'ancestors';
  return 'none';
}

function _recipeDefaultShape(baseKind) {
  return (RECIPE_BASE_META[baseKind] || {}).shape || 'is-round';
}

// 动态出口声明（P2）的剥除与收敛：parser/fallback/each 全走白名单
function _normalizeRecipeDynamic(rawDynamic) {
  const d = (rawDynamic && typeof rawDynamic === 'object') ? rawDynamic : {};
  const p = (d.parser && typeof d.parser === 'object') ? d.parser : null;
  if (!p) return null;
  const pattern = RECIPE_PARSER_PATTERNS.includes(p.pattern) ? p.pattern : 'numbered_list';
  const levelTags = Array.isArray(p.level_tags)
    ? p.level_tags.map(tag => String(tag || '').trim().slice(0, 6)).filter(Boolean).slice(0, 4)
    : [];
  const max = Math.max(1, Math.min(RECIPE_MAX_DYNAMIC, Number(p.max) || RECIPE_MAX_DYNAMIC));
  const labelFrom = RECIPE_LABEL_FROM.includes(p.label_from) ? p.label_from : 'index_question';
  const f = (d.fallback && typeof d.fallback === 'object') ? d.fallback : {};
  const fallbackMode = RECIPE_FALLBACK_MODES.includes(f.mode) ? f.mode : 'label_questions_from_text';
  const fallbackLabels = Array.isArray(f.labels)
    ? f.labels.map(label => String(label || '').trim().slice(0, 12)).filter(Boolean).slice(0, RECIPE_MAX_PORTS)
    : [];
  const e = (d.each && typeof d.each === 'object') ? d.each : {};
  const eachType = RECIPE_DYNAMIC_PORT_TYPES.includes(e.type) ? e.type : 'socratic';
  return {
    parser: { pattern, level_tags: levelTags, max, label_from: labelFrom },
    fallback: { mode: fallbackMode, labels: fallbackLabels },
    each: {
      type: eachType,
      branch_type: e.branch_type || eachType,
      drag_form: e.drag_form === 'user' ? 'user' : 'draft',
    },
  };
}

// on_generated 编排声明（P2）的剥除与收敛：create/connect 白名单化
function _normalizeRecipeOnGenerated(rawSpec) {
  const s = (rawSpec && typeof rawSpec === 'object') ? rawSpec : null;
  if (!s) return null;
  const create = Array.isArray(s.create)
    ? s.create.map(item => {
        if (!item || typeof item !== 'object') return null;
        const base = (item.base && typeof item.base === 'object') ? item.base : {};
        const kind = RECIPE_ON_GENERATED_KINDS.includes(base.kind) ? base.kind : '';
        if (!kind) return null;
        const out = { as: String(item.as || '').trim().slice(0, 8), base: { kind } };
        const recipeRef = String(base.recipe || '').trim().slice(0, 64);
        if (recipeRef) out.base.recipe = recipeRef;
        if (item.label_template) out.label_template = String(item.label_template).slice(0, 40);
        else if (item.label) out.label = String(item.label).slice(0, 24);
        const contentFrom = RECIPE_ON_GENERATED_CONTENT_FROM.includes(item.content_from) ? item.content_from : '';
        if (contentFrom) out.content_from = contentFrom;
        return out;
      }).filter(Boolean).slice(0, RECIPE_MAX_ON_GENERATED)
    : [];
  if (!create.length) return null;
  const refs = new Set(create.map(item => item.as));
  const connect = Array.isArray(s.connect)
    ? s.connect.map(item => {
        if (!item || typeof item !== 'object') return null;
        const from = String(item.from || '').trim();
        const to = String(item.to || '').trim();
        if (from !== 'self' && !refs.has(from)) return null;
        if (!refs.has(to)) return null;
        return { from, to, relation: String(item.relation || '').trim().slice(0, 12) };
      }).filter(Boolean)
    : [];
  return {
    create,
    connect,
    chain_check: s.chain_check === true,
  };
}

// 未知字段剥除＋类型收敛（P1 字段白名单）。任何一步失败返回 null。
// 导入/Φ 产出（P3/P4）先过这里再进校验器——脏数据只允许被丢弃，不允许带着进库。
function normalizeRecipeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || '').trim();
  const baseKind = String((raw.base && raw.base.kind) || 'module');
  if (!name || !RECIPE_BASE_KINDS.includes(baseKind)) return null;
  const paletteKey = String((raw.appearance && raw.appearance.palette) || 'amber');
  const customColor = normalizeRecipeColor(raw.appearance && raw.appearance.color);
  // 形状不是配方参数（2026-10-09 用户拍板）：一律按底座推导，输入里的 shape 忽略——
  // 此前 Φ 能写、却只在「添加节点」面板圆点生效、节点卡不生效（设了不生效）。
  const shape = _recipeDefaultShape(baseKind);
  const g = (raw.generate && typeof raw.generate === 'object') ? raw.generate : {};
  const ports = Array.isArray(raw.ports && raw.ports.static) ? raw.ports.static : [];
  const dynamic = _normalizeRecipeDynamic(raw.ports && raw.ports.dynamic);
  const onGenerated = _normalizeRecipeOnGenerated(raw.on_generated);
  const modelRole = RECIPE_MODEL_ROLES.includes(g.model_role) ? g.model_role : 'agent';
  const incomplete = (g.on_incomplete && typeof g.on_incomplete === 'object')
    ? Math.max(0, Math.min(2, Number(g.on_incomplete.max_retries) || 0))
    : 1;
  const contentKind = RECIPE_CONTENT_KINDS.includes(raw.content_kind) ? raw.content_kind : 'markdown';
  const portsOut = {
    static: ports.slice(0, RECIPE_MAX_PORTS + 4).map(port => ({
      label: String((port && port.label) || '').trim().slice(0, 12),
      drag_form: String((port && port.drag_form) || 'draft'),
    })).filter(port => port.label),
  };
  if (dynamic) portsOut.dynamic = dynamic;   // 无声明不设键（与后端 normalize 同形，对拍友好）
  const out = {
    id: String(raw.id || ('recipe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
    name: name.slice(0, 24),
    desc: String(raw.desc || '').trim().slice(0, 80),
    builtin: false,
    base: { kind: baseKind },
    // 自由色是可选段：不声明就不设键（与后端 normalize 同形，对拍/快照友好）
    appearance: customColor
      ? { palette: paletteKey, color: customColor, shape }
      : { palette: paletteKey, shape },
    generate: {
      prompt: String(g.prompt || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      strict_output: String(g.strict_output || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      followup_prompt: String(g.followup_prompt || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      confused_prompt: String(g.confused_prompt || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      retry_prompt: String(g.retry_prompt || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      context_channel: RECIPE_CONTEXT_CHANNELS.includes(g.context_channel) ? g.context_channel : 'workflow_context',
      model_role: modelRole,
      on_incomplete: { max_retries: incomplete },
    },
    ports: portsOut,
    content_kind: contentKind,
    aggregation: _recipeAggregationForBase(baseKind, raw.aggregation),
    analysis_phase: baseKind === 'module' ? raw.analysis_phase === true : false,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  if (onGenerated) out.on_generated = onGenerated;
  return out;
}

// 校验器（前后端同构）：返回 { ok, errors }。existing 用于名称查重（同 id 除外）。
function validateRecipe(recipe, existing) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (!recipe || typeof recipe !== 'object') return { ok: false, errors: ['配方不是对象'] };
  const name = String(recipe.name || '').trim();
  if (!name) fail('名称不能为空');
  else if (name.length > 24) fail('名称最长 24 字');
  const baseKind = String((recipe.base && recipe.base.kind) || '');
  if (!RECIPE_BASE_KINDS.includes(baseKind)) fail('底座类型不在 P1 支持范围');
  const paletteKey = String((recipe.appearance && recipe.appearance.palette) || '');
  if (!RECIPE_PALETTE.some(entry => entry.key === paletteKey)) fail('色板不合法（只能从成对色板令牌选）');
  // 自由色是可选段：给了就必须是真的 hex（表单只吐合法值，这里挡手改/导入的脏数据）
  const rawColor = recipe.appearance && recipe.appearance.color;
  if (rawColor && !normalizeRecipeColor(rawColor)) fail('自定义颜色不合法（要 #rrggbb 或 #rgb）');
  const shape = String((recipe.appearance && recipe.appearance.shape) || '');
  if (shape && !RECIPE_SHAPES.includes(shape)) fail('形状不合法');
  const desc = String(recipe.desc || '');
  if (desc.length > 80) fail('描述最长 80 字');
  const g = (recipe.generate && typeof recipe.generate === 'object') ? recipe.generate : {};
  ['prompt', 'strict_output', 'followup_prompt', 'confused_prompt', 'retry_prompt'].forEach(slot => {
    const text = String(g[slot] || '');
    if (text.length > RECIPE_PROMPT_BUDGET) fail('提示词槽「' + slot + '」超预算（建议单项 ≤' + RECIPE_PROMPT_BUDGET + ' 字，当前 ' + text.length + '）');
  });
  if (RECIPE_AI_BASE_KINDS.includes(baseKind) && !String(g.prompt || '').trim()) fail('AI 底座必须填写主提示词');
  if (g.context_channel && !RECIPE_CONTEXT_CHANNELS.includes(g.context_channel)) fail('上下文通道不合法');
  if (g.model_role && !RECIPE_MODEL_ROLES.includes(g.model_role)) fail('模型槽位不合法（agent/html/branch/graph/quiz/descriptor）');
  const ports = (recipe.ports && Array.isArray(recipe.ports.static)) ? recipe.ports.static : [];
  if (ports.length > RECIPE_MAX_PORTS) fail('出口最多 ' + RECIPE_MAX_PORTS + ' 个');
  const seenLabels = new Set();
  ports.forEach(port => {
    const label = String((port && port.label) || '').trim();
    if (!label) fail('存在没有名字的出口');
    else if (label.length > 12) fail('出口「' + label + '」名字最长 12 字');
    if (seenLabels.has(label)) fail('出口名字重复：「' + label + '」');
    seenLabels.add(label);
    const form = String((port && port.drag_form) || 'draft');
    if (form !== 'draft' && form !== 'user' && !/^connected:[a-z_]+$/.test(form)) fail('出口「' + label + '」的拖出目标不合法');
  });
  // 动态出口（P2）：仅 module 底座可声明；解析器/兜底/端口行为全走枚举
  const dyn = (recipe.ports && recipe.ports.dynamic) || null;
  if (dyn) {
    if (baseKind !== 'module') fail('动态出口只支持视角模块底座');
    const parser = dyn.parser || {};
    if (!RECIPE_PARSER_PATTERNS.includes(parser.pattern)) fail('动态出口解析器不合法（P2 只支持 numbered_list）');
    if (parser.label_from && !RECIPE_LABEL_FROM.includes(parser.label_from)) fail('动态出口标签方式不合法');
    if (parser.max && (Number(parser.max) < 1 || Number(parser.max) > RECIPE_MAX_DYNAMIC)) fail('动态出口上限须在 1～' + RECIPE_MAX_DYNAMIC + ' 之间');
    const fb = dyn.fallback || {};
    if (fb.mode && !RECIPE_FALLBACK_MODES.includes(fb.mode)) fail('动态出口兜底方式不合法');
    if (Array.isArray(fb.labels) && fb.labels.length > RECIPE_MAX_PORTS) fail('兜底出口名最多 ' + RECIPE_MAX_PORTS + ' 个');
    const each = dyn.each || {};
    if (each.type && !RECIPE_DYNAMIC_PORT_TYPES.includes(each.type)) fail('动态出口的端口行为不合法（socratic/learn/branch）');
  }
  const aiBase = RECIPE_AI_BASE_KINDS.includes(baseKind);
  if (recipe.content_kind && !RECIPE_CONTENT_KINDS.includes(recipe.content_kind)) fail('内容载体不合法（markdown / plain / mermaid / html_iframe）');
  if ((recipe.content_kind === 'mermaid' || recipe.content_kind === 'html_iframe') && !aiBase) fail('mermaid / html_iframe 载体需要 AI 底座');
  if (recipe.aggregation === 'first_inbound' && baseKind !== 'module') fail('单链取材（first_inbound）只支持视角模块底座');
  if (recipe.analysis_phase && baseKind !== 'module') fail('双阶段概要（analysis_phase）只支持视角模块底座');
  // on_generated（P2）：create 引用与 connect 目标必须闭环
  const og = recipe.on_generated || null;
  if (og) {
    const refs = new Set((og.create || []).map(item => item && item.as));
    (og.create || []).forEach((item, index) => {
      if (!item || !item.as) { fail('生成后动作第 ' + (index + 1) + ' 项缺少 as 引用'); return; }
      if (!item.base || !RECIPE_ON_GENERATED_KINDS.includes(item.base.kind)) fail('生成后动作「' + (item.as || index) + '」的底座不合法');
    });
    (og.connect || []).forEach(item => {
      if (!item) return;
      if (item.from !== 'self' && !refs.has(item.from)) fail('生成后连线 from 引用未声明：「' + item.from + '」');
      if (!refs.has(item.to)) fail('生成后连线 to 引用未声明：「' + item.to + '」');
    });
  }
  const dup = (existing || []).some(item => item && item.name === name && item.id !== recipe.id);
  if (dup) fail('已有同名配方：「' + name + '」');
  return { ok: errors.length === 0, errors };
}

// ---- 存取：localStorage 为主、服务端 /api/kv/node_recipes 镜像（fire-and-forget）----
// 键名是纯字符串常量（杜绝 T52 式拼接键事故）；默认空、绝不预置（D-R7）。
function _recipeStorageKey() {
  return typeof STORAGE_KEY_NODE_RECIPES !== 'undefined' ? STORAGE_KEY_NODE_RECIPES : 'phymathia_node_recipes';
}

function getUserRecipes() {
  try {
    const raw = localStorage.getItem(_recipeStorageKey());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeRecipeInput).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function setUserRecipes(recipes) {
  const list = (recipes || []).map(normalizeRecipeInput).filter(Boolean);
  try {
    localStorage.setItem(_recipeStorageKey(), JSON.stringify(list));
  } catch (e) { /* 本地写失败：服务端镜像仍在，下次启动能兜回来 */ }
  if (typeof fetch === 'function') {
    fetch('/api/kv/' + encodeURIComponent('node_recipes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: list }),
    }).catch(() => {});
  }
  return list;
}

// 启动时服务端对账：按 id 取并集，冲突取 updatedAt 新的一方。返回是否有变化
// （有则调用方刷新添加面板）。查看器不载 graph-recipe-edit.js，不会调到这里。
async function syncUserRecipesFromServer() {
  if (typeof fetch !== 'function') return false;
  let serverList = null;
  try {
    const resp = await fetch('/api/kv/' + encodeURIComponent('node_recipes'));
    if (resp && resp.ok) {
      const data = await resp.json();
      if (data && Array.isArray(data.value)) serverList = data.value;
    }
  } catch (e) { serverList = null; }
  if (!serverList) return false;
  const local = getUserRecipes();
  const byId = new Map(local.map(item => [item.id, item]));
  let changed = false;
  serverList.forEach(raw => {
    const item = normalizeRecipeInput(raw);
    if (!item) return;
    const prev = byId.get(item.id);
    if (!prev) { byId.set(item.id, item); changed = true; }
    else if ((item.updatedAt || 0) > (prev.updatedAt || 0)) { byId.set(item.id, item); changed = true; }
  });
  if (!changed) return false;
  try {
    localStorage.setItem(_recipeStorageKey(), JSON.stringify([...byId.values()]));
  } catch (e) {}
  return true;
}

// ---- 节点侧助手（渲染/工作流/交互挂载点共用）----
// 节点内嵌快照（recipeEmbedSnapshot 的产物）挂在 node.recipe 上；删配方不毁旧节点（3.4 节）。
function recipeEmbedSnapshot(recipe) {
  const r = normalizeRecipeInput(recipe);
  if (!r) return null;
  const snapshot = {
    id: r.id,
    name: r.name,
    desc: r.desc,
    base: r.base,
    appearance: r.appearance,
    generate: r.generate,
    ports: r.ports,
    content_kind: r.content_kind,
    aggregation: r.aggregation,
  };
  if (r.analysis_phase) snapshot.analysis_phase = true;
  if (r.on_generated) snapshot.on_generated = r.on_generated;
  return snapshot;
}

function _nodeRecipeSnapshot(node) {
  if (!node || !node.recipeId || !node.recipe || typeof node.recipe !== 'object') return null;
  return node.recipe;
}

// 配方节点的外观入口（_nodeAttribute 顶部优先读取）。attr key 固定 'recipe'：
// 该 key 在 GRAPH_NODE_ATTRIBUTES 有一条中性兜底（var(--accent)），draft 节点
// 从配方端口拖出时用它渲染；具体颜色由快照的色板令牌给 --node-attr。
function _recipeNodeAttribute(node) {
  const recipe = _nodeRecipeSnapshot(node);
  if (!recipe) return null;
  return {
    key: 'recipe',
    label: recipe.name || '配方',
    color: recipeAppearanceColor(recipe.appearance),
  };
}

// 静态出口表（_moduleOutputPorts / answer 分支优先读取）。
// 返回渲染层端口 meta：type/branchType 走 branch+followup（= 拖出建提问草稿），
// drag_form 单独放 dragCreates 字段，由 _createBranchNodeFromOutput 路由。
function _recipeStaticPorts(node) {
  const recipe = _nodeRecipeSnapshot(node);
  if (!recipe || !Array.isArray(recipe.ports && recipe.ports.static)) return [];
  return recipe.ports.static.map(port => ({
    label: port.label,
    type: 'branch',
    branchType: 'followup',
    attribute: 'recipe',
    question: '',
    dragCreates: port.drag_form || 'draft',
  }));
}

// ---- 动态出口（P2）：numbered_list 内置解析器 ----
// 正则与官方 _parsePortQuestions（graph-render.js）同一条——苏格拉底/进阶学习的
// 编号行契约，但按配方参数化（级别白名单 level_tags、上限 max、标签方式 label_from）。
// 级别标记映射：命中 level_tags 第 N 项 → basic/advanced/expand（前三个），超出留空。
const RECIPE_NUMBERED_LIST_SOURCE = '(?:^|\\n)\\s*(?:[-*+]|\\d+[.)])\\s*(?:\\[([^\\]]+)\\])?\\s*([^\\n]+)';

function _recipeParseNumberedList(content, parser) {
  const items = [];
  const max = Math.max(1, Math.min(Number(parser && parser.max) || RECIPE_MAX_DYNAMIC, RECIPE_MAX_DYNAMIC));
  const levelTags = (parser && Array.isArray(parser.level_tags)) ? parser.level_tags : [];
  const re = new RegExp(RECIPE_NUMBERED_LIST_SOURCE, 'g');
  let match;
  while ((match = re.exec(String(content || ''))) && items.length < max) {
    const rawLevel = (match[1] || '').trim();
    const question = (match[2] || '').trim();
    if (!question) continue;
    const tagIndex = levelTags.findIndex(tag => rawLevel.indexOf(tag) === 0);
    if (levelTags.length && tagIndex < 0) continue;   // 声明了级别白名单就只收带标记的行（learn 式空表＝不校验）
    items.push({
      question,
      level: tagIndex === 0 ? 'basic' : tagIndex === 1 ? 'advanced' : tagIndex === 2 ? 'expand' : '',
    });
  }
  return items;
}

function _recipeTruncLabel(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
}

// label_questions_from_text 兜底（治 T56）：解析不出编号行时，从正文非空行
// 截取问题文本填进兜底端口——出口不再「看起来正常、点上去静默」
function _recipeQuestionTextsFromContent(content, want) {
  const out = [];
  const limit = Math.max(1, Number(want) || 3);
  String(content || '').split('\n').forEach(line => {
    if (out.length >= limit) return;
    const text = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[-*+]|\d+[.)])?\s*(?:\[[^\]]*\])?\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (text.length >= 4 && text !== '' && !/^[#>|_`~-]+$/.test(text)) {
      out.push({ question: text.slice(0, 120), level: '' });
    }
  });
  return out;
}

// 配方节点的动态出口（_moduleOutputPorts 配方分支调用）：解析成功→按 each 声明
// 产出端口 meta；解析失败→按 fallback.mode 兜底。attribute 统一 'recipe'
// （外观走配方色板），socratic/learn 端口类型让草稿自动长出对应交互形态。
function _recipeDynamicPorts(node, content) {
  const recipe = _nodeRecipeSnapshot(node);
  const dyn = recipe && recipe.ports && recipe.ports.dynamic;
  if (!dyn || !dyn.parser) return [];
  const each = dyn.each || {};
  const type = each.type || 'socratic';
  const branchType = each.branch_type || type;
  const dragForm = each.drag_form === 'user' ? 'user' : 'draft';
  const mk = (question, label, level) => ({
    label,
    type,
    branchType,
    attribute: 'recipe',
    question: question || '',
    level: level || '',
    dragCreates: dragForm,
  });
  const parsed = _recipeParseNumberedList(content, dyn.parser);
  const labelFrom = dyn.parser.label_from || 'index_question';
  if (parsed.length) {
    return parsed.map((item, index) => mk(
      item.question,
      labelFrom === 'question_trunc12' ? _recipeTruncLabel(item.question, 12) : '问题' + (index + 1),
      item.level
    ));
  }
  const fb = dyn.fallback || {};
  if (fb.mode === 'none') return [];
  if (!fb.mode || fb.mode === 'label_questions_from_text') {
    const texts = _recipeQuestionTextsFromContent(content, (fb.labels || []).length || 3);
    if (texts.length) {
      return texts.map((item, index) => mk(item.question, (fb.labels && fb.labels[index]) || '问题' + (index + 1), ''));
    }
    // 正文也没的可截：退到固定名兜底（question 仍为空，但 draftAskAi 会提示而不是静默）
  }
  const labels = (fb.labels && fb.labels.length) ? fb.labels : ['问题1', '问题2', '问题3'];
  return labels.map(label => mk('', label, ''));
}

window.RECIPE_BASE_KINDS = RECIPE_BASE_KINDS;
window.RECIPE_AI_BASE_KINDS = RECIPE_AI_BASE_KINDS;
window.RECIPE_BASE_META = RECIPE_BASE_META;
window.RECIPE_PALETTE = RECIPE_PALETTE;
window.RECIPE_COLOR_MIX = RECIPE_COLOR_MIX;
window.normalizeRecipeColor = normalizeRecipeColor;
window.recipeAppearanceColor = recipeAppearanceColor;
window.RECIPE_SHAPES = RECIPE_SHAPES;
window.RECIPE_CONTENT_KINDS = RECIPE_CONTENT_KINDS;
window.RECIPE_CONTEXT_CHANNELS = RECIPE_CONTEXT_CHANNELS;
window.RECIPE_MODEL_ROLES = RECIPE_MODEL_ROLES;
window.RECIPE_PARSER_PATTERNS = RECIPE_PARSER_PATTERNS;
window.RECIPE_LABEL_FROM = RECIPE_LABEL_FROM;
window.RECIPE_FALLBACK_MODES = RECIPE_FALLBACK_MODES;
window.RECIPE_DYNAMIC_PORT_TYPES = RECIPE_DYNAMIC_PORT_TYPES;
window.RECIPE_AGGREGATIONS = RECIPE_AGGREGATIONS;
window.RECIPE_ON_GENERATED_KINDS = RECIPE_ON_GENERATED_KINDS;
window.RECIPE_MAX_DYNAMIC = RECIPE_MAX_DYNAMIC;
window.RECIPE_PROMPT_BUDGET = RECIPE_PROMPT_BUDGET;
window.RECIPE_MAX_PORTS = RECIPE_MAX_PORTS;
window.normalizeRecipeInput = normalizeRecipeInput;
window.validateRecipe = validateRecipe;
window.getUserRecipes = getUserRecipes;
window.setUserRecipes = setUserRecipes;
window.syncUserRecipesFromServer = syncUserRecipesFromServer;
window.recipeEmbedSnapshot = recipeEmbedSnapshot;
window._nodeRecipeSnapshot = _nodeRecipeSnapshot;
window._recipeNodeAttribute = _recipeNodeAttribute;
window._recipeStaticPorts = _recipeStaticPorts;
window._recipeDynamicPorts = _recipeDynamicPorts;
window._recipeParseNumberedList = _recipeParseNumberedList;
window._recipeQuestionTextsFromContent = _recipeQuestionTextsFromContent;
