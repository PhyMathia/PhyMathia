// ===== 节点配方注册表（官方类型单一事实源，P0 粒度）=====
// 设计文档：docs/节点配方与创造模式-总体设计-2026-09-29.md（第 3 节 schema、第 8.1 节背景）。
// P0 原则：只收敛数据、行为零变化——本表派生原散落三处的硬编码（前端 kind 白名单、
// 添加面板 16 入口、Φ 快照的 available_node_types），渲染/生成逻辑仍读 graph.js 里
// 由本表派生的同名常量；生成提示词四槽、动态出口、内容载体等行为维度 P1 起充实，
// 官方配方「用户配方同模型」的完整形态见设计文档。
// 后端投影在 harness/registry.py，两边由 tests/test_registry_consistency.py 对拍守护；
// 改这张表必须同步改对拍测试，别只改一侧。

const BUILTIN_RECIPES = [
  // —— 视角模块（kind=module × moduleKey，顺序＝添加面板顺序）——
  { key: 'physics', kind: 'module', moduleKey: 'physics', label: '物理视角', color: '#f59e0b', group: 'modules', desc: '' },
  { key: 'math', kind: 'module', moduleKey: 'math', label: '数学视角', color: '#3b82f6', group: 'modules', desc: '' },
  { key: 'graph', kind: 'module', moduleKey: 'graph', label: '知识图谱', color: '#0891b2', group: 'modules', desc: '' },
  { key: 'viz', kind: 'module', moduleKey: 'viz', label: '交互可视化', color: '#f472b6', group: 'modules', desc: '' },
  { key: 'learn', kind: 'module', moduleKey: 'learn', label: '进阶学习', color: '#a855f7', group: 'modules', desc: '' },
  { key: 'socratic', kind: 'module', moduleKey: 'socratic', label: '苏格拉底追问', color: '#f43f5e', group: 'modules', desc: '' },
  // —— AI 组 ——
  { key: 'blank', kind: 'blank', label: 'AI 生成空白', color: '#94a3b8', group: 'ai', desc: '输入任意要求，AI 生成任意内容' },
  { key: 'answer', kind: 'answer', label: 'AI 回答', color: '#10b981', group: 'ai', desc: 'AI 回答节点（含摘要）' },
  { key: 'summary', kind: 'summary', label: 'AI 总结', color: '#0d9488', group: 'ai', desc: 'AI 生成总结' },
  // —— 素材组（data）——
  { key: 'source', kind: 'source', label: '输入', color: '#06b6d4', group: 'data', desc: '导入文件/文本，解析出知识点' },
  { key: 'knowledge', kind: 'knowledge', label: '知识点', color: '#84cc16', group: 'data', desc: '手动记录一个知识点' },
  { key: 'question', kind: 'user', label: '问题', color: '#4a9eff', group: 'data', desc: '提问节点，可接 AI 回答' },
  // —— 人工组（human）——
  // manual 在 module 键空间有历史身份（后端 ALLOWED_MODULE_KEYS / GRAPH_MODULE_META 均含
  // manual 键），注册表带 moduleKey 对齐两侧键空间；它本体不是 module 节点，派生投影不受影响
  { key: 'manual', kind: 'answer', manual: true, moduleKey: 'manual', label: '我的回答', color: 'var(--ink-human)', group: 'human', desc: '手写回答，可继续发散（无摘要）' },
  { key: 'human_note', kind: 'human_note', label: '我的理解', color: 'var(--ink-note)', group: 'human', desc: '批注/笔记，可附公式' },
  { key: 'note', kind: 'note', label: '我的总结', color: 'var(--ink-human)', group: 'human', desc: '汇聚后的手动总结' },
  // —— 结构组（structure）——
  { key: 'hub', kind: 'hub', label: '汇聚', color: '#eab308', group: 'structure', desc: '汇总多路输入，可总结或追问' },
  // —— 无手动入口的类型（hidden：不进添加面板，只作为 kind 存在）——
  // relation：创建口径已移除（Φ 提示词明示勿建、后端 ALLOWED_CREATE_KINDS 不含），
  // 但旧会话数据里可能仍有 relation 节点——注册表收录它只为白名单派生，
  // 让这些节点在保存/恢复时不再被静默抹掉（backlog T75）。
  { key: 'relation', kind: 'relation', label: '联系', color: '#f43f5e', group: 'data', desc: '', hidden: true },
  { key: 'ai_eval', kind: 'ai_eval', label: 'AI 评价', color: '#f59e0b', group: 'ai', desc: '', hidden: true },
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

// Φ 快照的 available_node_types（原 harness.js 内联 16 项字面量；顺序与键序保持逐字一致，
// 避免快照字节漂移——P3 把用户配方并入时才会变）
function deriveHarnessAvailableNodeTypes() {
  const order = ['physics', 'math', 'graph', 'viz', 'socratic', 'learn', 'knowledge', 'human_note', 'note', 'hub', 'summary', 'source', 'blank', 'question', 'answer', 'ai_eval'];
  return order
    .map(key => {
      const recipe = _recipeByKey(key);
      if (!recipe) return null;
      const entry = { kind: recipe.kind };
      if (recipe.kind === 'module') entry.module_key = recipe.moduleKey;
      entry.label = recipe.label;
      return entry;
    })
    .filter(Boolean);
}

window.BUILTIN_RECIPES = BUILTIN_RECIPES;
window.deriveManualNodeOptions = deriveManualNodeOptions;
window.deriveGraphCustomNodeKinds = deriveGraphCustomNodeKinds;
window.deriveHarnessAvailableNodeTypes = deriveHarnessAvailableNodeTypes;

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

// 成对色板（D-R8：只从令牌选，不开放自由 hex）。令牌定义在 graph-override.css
// 的 --ink-* 块（深浅两套）；这里只引用令牌名，JS 侧零 hex 字面量（T8 红线）。
const RECIPE_PALETTE = [
  { key: 'amber', label: '琥珀', color: 'var(--ink-amber)' },
  { key: 'blue', label: '靛蓝', color: 'var(--ink-blue)' },
  { key: 'rose', label: '胭脂', color: 'var(--ink-rose)' },
  { key: 'teal', label: '苍青', color: 'var(--ink-teal)' },
  { key: 'violet', label: '紫墨', color: 'var(--ink-violet)' },
  { key: 'human', label: '赭墨', color: 'var(--ink-human)' },
  { key: 'note', label: '青墨', color: 'var(--ink-note)' },
];
const RECIPE_SHAPES = ['is-round', 'is-square', 'is-diamond', 'is-ring'];
const RECIPE_CONTENT_KINDS = ['markdown', 'plain'];
const RECIPE_CONTEXT_CHANNELS = ['workflow_context', 'prompt_inline'];
const RECIPE_PROMPT_BUDGET = 800;   // 每个提示词槽的建议上限（字符）
const RECIPE_MAX_PORTS = 8;

// aggregation 由底座推导（P1 不在表单暴露；P2/P3 需要时再放开）：
// ancestors=全祖先、self_fields=自身字段、none=人工节点
function _recipeAggregationForBase(baseKind) {
  if (baseKind === 'knowledge') return 'self_fields';
  if (RECIPE_AI_BASE_KINDS.includes(baseKind)) return 'ancestors';
  return 'none';
}

function _recipeDefaultShape(baseKind) {
  return (RECIPE_BASE_META[baseKind] || {}).shape || 'is-round';
}

// 未知字段剥除＋类型收敛（P1 字段白名单）。任何一步失败返回 null。
// 导入/Φ 产出（P3/P4）先过这里再进校验器——脏数据只允许被丢弃，不允许带着进库。
function normalizeRecipeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || '').trim();
  const baseKind = String((raw.base && raw.base.kind) || 'module');
  if (!name || !RECIPE_BASE_KINDS.includes(baseKind)) return null;
  const paletteKey = String((raw.appearance && raw.appearance.palette) || 'amber');
  const shape = String((raw.appearance && raw.appearance.shape) || _recipeDefaultShape(baseKind));
  const g = (raw.generate && typeof raw.generate === 'object') ? raw.generate : {};
  const ports = Array.isArray(raw.ports && raw.ports.static) ? raw.ports.static : [];
  return {
    id: String(raw.id || ('recipe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
    name: name.slice(0, 24),
    desc: String(raw.desc || '').trim().slice(0, 80),
    builtin: false,
    base: { kind: baseKind },
    appearance: { palette: paletteKey, shape },
    generate: {
      prompt: String(g.prompt || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      strict_output: String(g.strict_output || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      followup_prompt: String(g.followup_prompt || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      confused_prompt: String(g.confused_prompt || '').trim().slice(0, RECIPE_PROMPT_BUDGET * 2),
      context_channel: RECIPE_CONTEXT_CHANNELS.includes(g.context_channel) ? g.context_channel : 'workflow_context',
    },
    ports: {
      static: ports.slice(0, RECIPE_MAX_PORTS + 4).map(port => ({
        label: String((port && port.label) || '').trim().slice(0, 12),
        drag_form: String((port && port.drag_form) || 'draft'),
      })).filter(port => port.label),
    },
    content_kind: RECIPE_CONTENT_KINDS.includes(raw.content_kind) ? raw.content_kind : 'markdown',
    aggregation: _recipeAggregationForBase(baseKind),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
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
  const shape = String((recipe.appearance && recipe.appearance.shape) || '');
  if (shape && !RECIPE_SHAPES.includes(shape)) fail('形状不合法');
  const desc = String(recipe.desc || '');
  if (desc.length > 80) fail('描述最长 80 字');
  const g = (recipe.generate && typeof recipe.generate === 'object') ? recipe.generate : {};
  ['prompt', 'strict_output', 'followup_prompt', 'confused_prompt'].forEach(slot => {
    const text = String(g[slot] || '');
    if (text.length > RECIPE_PROMPT_BUDGET) fail('提示词槽「' + slot + '」超预算（建议单项 ≤' + RECIPE_PROMPT_BUDGET + ' 字，当前 ' + text.length + '）');
  });
  if (RECIPE_AI_BASE_KINDS.includes(baseKind) && !String(g.prompt || '').trim()) fail('AI 底座必须填写主提示词');
  if (g.context_channel && !RECIPE_CONTEXT_CHANNELS.includes(g.context_channel)) fail('上下文通道不合法');
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
  if (recipe.content_kind && !RECIPE_CONTENT_KINDS.includes(recipe.content_kind)) fail('内容载体不合法（P1 只支持 markdown / plain）');
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
  return {
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
  const entry = RECIPE_PALETTE.find(item => item.key === (recipe.appearance && recipe.appearance.palette));
  return {
    key: 'recipe',
    label: recipe.name || '配方',
    color: entry ? entry.color : 'var(--accent)',
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

window.RECIPE_BASE_KINDS = RECIPE_BASE_KINDS;
window.RECIPE_AI_BASE_KINDS = RECIPE_AI_BASE_KINDS;
window.RECIPE_BASE_META = RECIPE_BASE_META;
window.RECIPE_PALETTE = RECIPE_PALETTE;
window.RECIPE_SHAPES = RECIPE_SHAPES;
window.RECIPE_CONTENT_KINDS = RECIPE_CONTENT_KINDS;
window.RECIPE_CONTEXT_CHANNELS = RECIPE_CONTEXT_CHANNELS;
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
