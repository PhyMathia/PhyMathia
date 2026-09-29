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
