// Harness agent test battery: calls the local harness API with many
// instruction types and scores the outputs. Run with node:
//   node scripts/harness_battery.mjs [baseUrl] [model] [outJson]
import { GRAPHS, graphById, resolveLabels } from './harness_graphs.mjs';
const BASE = process.argv[2] || 'http://localhost:5052';
const MODEL = process.argv[3] || 'deepseek-v4-flash-free';

// mock 上游支持（T57）：MOCK_UPSTREAM=http://127.0.0.1:5061/v1 时把模型指向本地 mock
// （scripts/mock_upstream.mjs）——不花钱跑 battery；不设则走真实上游。
const MOCK_BASE = process.env.MOCK_UPSTREAM || '';
const MODEL_CFG = MOCK_BASE
  ? { provider: 'opencode-go', api_key: 'mock', model: MODEL, base_url: MOCK_BASE }
  : { provider: 'opencode', api_key: '', model: MODEL, base_url: 'https://opencode.ai/zen/v1' };

function makeSnapshot() {
  return {
    version: 1,
    nodes: [
      { id: 'A', kind: 'knowledge', label: '导数', content: '导数就是函数在某一点的瞬时变化率，表示切线的斜率。', formula: "f'(x)=\lim_{\Delta x\to 0}\frac{\Delta y}{\Delta x}" },
      { id: 'B', kind: 'knowledge', label: '极限', content: '当自变量趋近某个值时函数值趋近的值。', formula: '' },
      { id: 'C', kind: 'module', module_key: 'physics', label: '物理视角', content: '速度是位移对时间的导数。', formula: '' },
      { id: 'D', kind: 'human_note', label: '我的理解', content: '导数就是斜率，变化越快导数越大。', formula: '' },
    ],
    edges: [
      { key: 'B:out-0->A:in-0', from: 'B', to: 'A', relation: '依赖', label: '需要先掌握' },
      { key: 'A:out-0->C:in-0', from: 'A', to: 'C', relation: '物理意义', label: '从物理直觉理解导数' },
      { key: 'A:out-0->D:in-0', from: 'A', to: 'D', relation: '补充视角', label: '用户理解' },
    ],
  };
}

const only = process.argv[5] ? process.argv[5].split(',') : [];
const scenarios = [
  { id: 'eval-focus', label: '评价用户理解（聚焦 D）', instruction: '评价一下我对导数的理解', phase: 'normal', focus: ['D'], expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeTargets: ['D'] } },
  { id: 'eval-general', label: '整体评价（无焦点）', instruction: '帮我看看这个知识网络有什么问题', phase: 'normal', focus: [], expect: { phase: 'evaluate', opType: 'create_eval_node' } },
  { id: 'add-physics', label: '给导数加物理视角（聚焦 A）', instruction: '给导数加一个物理视角', phase: 'normal', focus: ['A'], expect: { phase: 'normal', updateOrCreateModule: 'physics' } },
  { id: 'delete-node', label: '删除节点（聚焦 B）', instruction: '把极限这个节点删掉，它太基础了', phase: 'normal', focus: ['B'], expect: { phase: 'normal', deleteTargets: ['B'] } },
  { id: 'fix-definition', label: '修正定义（聚焦 A）', instruction: '把导数的定义改得更严谨一些', phase: 'normal', focus: ['A'], expect: { phase: 'normal', updateTargets: ['A'] } },
  { id: 'expand-chain', label: '进阶学习链（聚焦 A）', instruction: '为导数生成进阶学习链', phase: 'normal', focus: ['A'], expect: { phase: 'expand', hasAnswer: true, hasLearn: true } },
  { id: 'chat-only', label: '纯问答（不应改图）', instruction: '导数的物理意义是什么？', phase: 'normal', focus: [], expect: { phase: 'normal', noOps: true } },
  { id: 'ambiguous', label: '模糊指令（不应乱改）', instruction: '帮我改一下这个', phase: 'normal', focus: [], expect: { phase: 'normal', noDestructive: true } },
  { id: 'cross-ref', label: '跨引用改名（斜率→瞬时变化率）', instruction: '把斜率改成瞬时变化率', phase: 'normal', focus: [], expect: { phase: 'normal', updateTargets: ['D'], allowedUpdateIds: ['D'] } },
  { id: 'add-isolated', label: '新增知识点（孤点）', instruction: '新增一个知识点：链式法则，内容为复合函数求导规则', phase: 'normal', focus: [], expect: { phase: 'normal', noIsolated: true } },
  { id: 'multi-eval', label: '评价两个目标', instruction: '评价一下我的理解和物理视角', phase: 'normal', focus: ['D', 'C'], expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeTargets: ['D', 'C'] } },
  { id: 'apply-evals', label: '应用评价（含 ai_eval 节点）', instruction: '应用建议', phase: 'normal', focus: [], snapshotExtra: 'evals', expect: { noEvalCreate: true, hasRealEdit: true } },
  { id: 'edge-update', label: '修改连线关系', instruction: '把极限到导数的连线关系改成前置', phase: 'normal', focus: [], expect: { phase: 'normal', updateEdge: true } },
  { id: 'delete-missing', label: '删除不存在的节点', instruction: '把 H 节点删掉，它超纲了', phase: 'normal', focus: [], expect: { phase: 'normal', noCrash: true } },
  { id: 'add-math', label: '补数学视角（聚焦 A）', instruction: '给导数补一个数学视角', phase: 'normal', focus: ['A'], expect: { phase: 'normal', createModule: 'math', connectedFrom: ['A'] } },
  { id: 'update-label', label: '改标题（聚焦 B）', instruction: '把极限节点的标题改成「极限的定义」', phase: 'normal', focus: ['B'], expect: { phase: 'normal', updateTargets: ['B'] } },
  { id: 'update-formula', label: '补公式（聚焦 A）', instruction: '给导数补充严格的极限定义公式', phase: 'normal', focus: ['A'], expect: { phase: 'normal', updateTargets: ['A'] } },
  { id: 'delete-two', label: '删除两个节点', instruction: '把极限和物理视角都删掉，太基础了', phase: 'normal', focus: ['B', 'C'], expect: { phase: 'normal', deleteTargets: ['B', 'C'] } },
  { id: 'remove-edge', label: '删除连线', instruction: '把极限到导数的连线删掉', phase: 'normal', focus: [], expect: { phase: 'normal', removeEdgeKey: 'B:out-0->A:in-0' } },
  { id: 'connect-pair', label: '连接两个已有节点', instruction: '把我的理解和物理视角连接起来', phase: 'normal', focus: [], expect: { phase: 'normal', connectPair: ['D', 'C'] } },
  { id: 'add-edge-existing', label: '连接已连节点（不应重复）', instruction: '把极限和导数连接起来', phase: 'normal', focus: [], expect: { phase: 'normal', noDuplicateAddEdge: ['B:out-0->A:in-0'], noCrash: true } },
  { id: 'multi-create', label: '一次新增两个知识点', instruction: '新增两个知识点：链式法则和隐函数求导，并给出简要内容', phase: 'normal', focus: [], expect: { phase: 'normal', createCount: 2, noIsolated: true } },
  { id: 'expand-multi', label: '两个目标进阶链', instruction: '为导数和极限都生成进阶学习链', phase: 'normal', focus: ['A', 'B'], expect: { phase: 'expand', hasAnswer: true, hasLearn: true, expandAllTargets: ['A', 'B'] } },
  { id: 'add-socratic', label: '加苏格拉底追问（聚焦 A）', instruction: '给导数加一个苏格拉底追问', phase: 'normal', focus: ['A'], expect: { phase: 'normal', createModule: 'socratic', connectedFrom: ['A'] } },
  { id: 'add-learn', label: '加进阶学习模块（聚焦 A）', instruction: '加一个进阶学习模块', phase: 'normal', focus: ['A'], expect: { phase: 'expand', hasAnswer: true, hasLearn: true } },
  { id: 'level-middle', label: '中学难度评价', instruction: '用中学难度评价一下我的理解', phase: 'normal', focus: ['D'], level: 'middle', expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeTargets: ['D'] } },
  { id: 'level-research', label: '科研难度评价', instruction: '用科研深度评价这个网络', phase: 'normal', focus: [], level: 'research', expect: { phase: 'evaluate', opType: 'create_eval_node' } },
  { id: 'empty-instruction', label: '空指令（不应报错）', instruction: '', phase: 'normal', focus: [], expect: { noCrash: true } },
  { id: 'whitespace-instruction', label: '纯空白指令', instruction: '   ', phase: 'normal', focus: [], expect: { noCrash: true } },
  { id: 'long-instruction', label: '超长指令', instruction: '请帮我仔细审阅一下当前这个知识网络，重点检查导数、极限、物理视角和我的理解这四个节点之间的逻辑关系是否清晰，导数定义是否严谨，物理视角是否准确，我的理解是否存在偏差，如果有问题请直接指出并给出修改建议，最好能把缺少的前置概念也补上。', phase: 'normal', focus: [], expect: { noCrash: true } },
  { id: 'formula-edit', label: '按指定公式修改（聚焦 A）', instruction: '把导数的公式改成标准极限定义形式 f\\\'(x)=lim_{dx->0} (f(x+dx)-f(x))/dx', phase: 'normal', focus: ['A'], expect: { phase: 'normal', updateTargets: ['A'] } },
  { id: 'delete-derivative', label: '删除核心知识点 A', instruction: '把导数节点删掉', phase: 'normal', focus: ['A'], expect: { phase: 'normal', deleteTargets: ['A'] } },
  { id: 'ref-by-content', label: '按内容引用节点', instruction: '把「当自变量趋近某个值时函数值趋近的值」这个节点改得更清楚', phase: 'normal', focus: [], expect: { phase: 'normal', updateTargets: ['B'], allowedUpdateIds: ['B'] } },
  { id: 'apply-conflict', label: '冲突评价应用', instruction: '应用建议', phase: 'normal', focus: [], snapshotExtra: 'evals-conflict', expect: { noEvalCreate: true, hasRealEdit: true, noCrash: true } },
  { id: 'chat-thanks', label: '寒暄（不应改图）', instruction: '谢谢，明白了', phase: 'normal', focus: [], expect: { phase: 'normal', noOps: true, noCrash: true } },
  { id: 'eval-evalnode', label: '评价评价节点（应拒绝）', instruction: '评价一下 E1 这个评价节点', phase: 'normal', focus: [], snapshotExtra: 'evals', expect: { noEvalOnEval: true, noCrash: true } },
  { id: 'big-graph', label: '大图整体评价', instruction: '整体评价这个网络', phase: 'normal', focus: [], snapshotExtra: 'big', expect: { noCrash: true, noDestructive: true } },
  // ---- 创造模式（P3）：配方三件套。preset-create 即「藏起官方苏格拉底、从零配出等价物」
  // 的硬验收场景——指令不提「苏格拉底」，快照也不含官方类型清单，模型只能靠需求描述配出
  // 带级别校验＋socratic 出口＋正文截取兜底的等价配方
  { id: 'preset-create-socratic', label: '创造模式：从零配出追问器（藏官方苏格拉底）', phase: 'preset',
    instruction: '帮我造一个「三级追问」节点：生成内容只输出一个标题加三条编号行，级别标记分别是 [基础]、[进阶]、[拓展]，每行一个问题不给答案；出口从这三行现场解析（只收带级别标记的行），拖出去是提问卡（我来回答/直接问AI）；万一模型没按格式输出，兜底出口要把正文里的句子截出来当问题文本。',
    focus: [], expect: { phase: 'preset', recipeCreate: { levelTags: true, eachType: 'socratic', fallback: 'label_questions_from_text' } } },
  { id: 'preset-create-followup', label: '创造模式：配一个双出口复盘配方', phase: 'preset',
    instruction: '造一个「考点复盘」配方：分「考点回顾」「记忆口诀」两段输出，出口有两个：「再测一道」拖出去建预填问题节点，「追问」拖出去建提问草稿。',
    focus: [], expect: { phase: 'preset', recipeCreate: { staticPorts: 2 } } },
  { id: 'preset-update-recipe', label: '创造模式：改已有配方', phase: 'preset',
    snapshotExtra: 'recipes',
    instruction: '把「错题复盘」的主提示词改成：分考点、易错点、口诀三段输出。',
    focus: [], expect: { phase: 'preset', recipeUpdate: 'recipe-b1' } },
  { id: 'preset-delete-recipe', label: '创造模式：删已有配方', phase: 'preset',
    snapshotExtra: 'recipes',
    instruction: '请删除配方「错题复盘」，我不再需要它。',
    focus: [], expect: { phase: 'preset', recipeDelete: 'recipe-b1' } },
  {
    id: 'feedback-iterate', label: '反馈迭代：加物理视角后再要求深入',
    turns: [
      { instruction: '给导数加一个物理视角', phase: 'normal', focus: ['A'], expect: { updateOrCreateModule: 'physics' } },
      { instruction: '物理视角还是太简单，请结合平均速度与瞬时速度的对比再深入展开', phase: 'normal', focus: ['C'], expect: { updateTargets: ['C'], noNewPhysicsModule: true } },
    ],
    expect: { finalSnapshotEquals: undefined },
  },
  {
    id: 'undo-edit', label: '撤销修改（update → 恢复原样）',
    turns: [
      { instruction: '把导数的内容改得更严谨', phase: 'normal', focus: ['A'], expect: { updateTargets: ['A'] } },
      { instruction: '撤销刚才的修改，恢复原样', phase: 'normal', focus: ['A'], expect: { statusUndo: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'undo-create', label: '撤销新增节点',
    turns: [
      { instruction: '新增知识点：链式法则，内容为复合函数求导规则', phase: 'normal', focus: [], expect: { createCount: 1 } },
      { instruction: '把刚才新增的链式法则撤销', phase: 'normal', focus: [], expect: { statusUndo: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'undo-delete', label: '撤销删除（恢复被删节点）',
    turns: [
      { instruction: '把极限这个节点删掉', phase: 'normal', focus: ['B'], expect: { deleteTargets: ['B'] } },
      { instruction: '把刚才删除的极限恢复回来', phase: 'normal', focus: ['B'], expect: { statusUndo: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'undo-all', label: '全部撤销（多步回退）',
    turns: [
      { instruction: '给导数补一个数学视角', phase: 'normal', focus: ['A'], expect: { createModule: 'math' } },
      { instruction: '把极限的标题改成「极限的定义」', phase: 'normal', focus: ['B'], expect: { updateTargets: ['B'] } },
      { instruction: '把刚才所有修改全部撤销', phase: 'normal', focus: [], expect: { statusUndo: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'feedback-iterate2', label: '反馈迭代（带历史上下文）',
    turns: [
      { instruction: '给导数加一个物理视角', phase: 'normal', focus: ['A'], expect: { updateOrCreateModule: 'physics' } },
      { instruction: '物理视角还是太简单，请结合平均速度与瞬时速度的对比再深入展开', phase: 'normal', focus: ['C'], expect: { updateTargets: ['C'], noNewPhysicsModule: true } },
    ],
    expect: {},
  },
  {
    id: 'clarify-ambiguous', label: '信息不足应澄清或保守',
    instruction: '帮我改一下这个', phase: 'normal', focus: [],
    expect: { noCrash: true, noDestructive: true, allowClarify: true },
  },
  {
    id: 'chain-task', label: '链式任务（一步两动作，宽松）',
    instruction: '给导数加一个物理视角，再基于它生成进阶学习', phase: 'normal', focus: ['A'],
    expect: { noCrash: true, hasRealEdit: true },
  },
];
// ===== 真实反馈挖掘场景（Round 3：来自 logs/harness_usage.jsonl 的真实用户指令模式） =====
const feedbackScenarios = [
  {
    id: 'fb-ask-followup', label: '真实反馈：追问某个模块节点',
    turns: [
      { instruction: '追问物理视角节点', phase: 'normal', focus: [], expect: { noCrash: true, noDestructive: true, allowClarify: true } },
    ],
  },
  {
    id: 'fb-confused-module', label: '真实反馈：表达没看懂',
    turns: [
      { instruction: '物理视角我没看懂', phase: 'normal', focus: [], expect: { noCrash: true, noDestructive: true, allowClarify: true } },
    ],
  },
  {
    id: 'fb-genealogy', label: '真实反馈：生成知识谱系',
    turns: [
      { instruction: '帮我生成「导数」这个知识点对应的知识谱系', phase: 'normal', focus: [], expect: { noCrash: true, noRelationNode: true, hasRealEdit: true } },
    ],
  },
  {
    id: 'fb-gibberish', label: '真实反馈：纯乱码输入',
    turns: [
      { instruction: '5555', phase: 'normal', focus: [], expect: { noCrash: true, noDestructive: true, noOps: true } },
      { instruction: '哇哇哇哇', phase: 'normal', focus: [], expect: { noCrash: true, noDestructive: true, noOps: true } },
    ],
  },
  {
    id: 'fb-greeting-capability', label: '真实反馈：寒暄+能力询问',
    turns: [
      { instruction: '你好，你能做什么？', phase: 'normal', focus: [], expect: { noCrash: true, noOps: true, noDestructive: true } },
    ],
  },
  {
    id: 'fb-create-quoted-vague', label: '真实反馈：引号目标的模糊新增',
    turns: [
      { instruction: '帮我新增一个关于「导数」的知识点', phase: 'normal', focus: [], expect: { noCrash: true, noDestructive: true, allowClarify: true } },
    ],
  },
];

// L1 = 核心冒烟（每次改动后快速回归）；L2 = 边界/复杂场景
const L1_IDS = [
  'eval-focus','add-physics','delete-node','fix-definition','expand-chain',
  'apply-evals','chat-only','ambiguous',
];

function tierOf(sc) { return L1_IDS.includes(sc.id) ? 'L1' : 'L2'; }

// 归一化快照用于相等比较（忽略 version 与 UI 字段）
function normSnapshot(s) {
  const nodes = (s && s.nodes ? s.nodes : []).map(n => ({
    id: String(n.id || ''),
    kind: String(n.kind || ''),
    label: String(n.label || ''),
    content: String(n.content || ''),
    formula: String(n.formula || ''),
    module_key: String(n.module_key || n.moduleKey || ''),
  }));
  const edges = (s && s.edges ? s.edges : []).map(e => ({
    key: String(e.key || e.edge_key || ''),
    from: String(e.from || ''),
    to: String(e.to || ''),
    relation: String(e.relation || ''),
    label: String(e.label || ''),
  }));
  const sort = (arr) => arr.slice().sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return { nodes: sort(nodes), edges: sort(edges) };
}

function snapshotsEqual(a, b) {
  return JSON.stringify(normSnapshot(a)) === JSON.stringify(normSnapshot(b));
}



// ===== 跨图语义场景（Phase 2：同一场景跑多张图） =====

// ===== 复合场景：琐碎变体合并为多轮（每轮仍独立断言） =====
const compositeScenarios = [
  {
    id: 'composite-modify', label: '复合：修改流（标题→公式→正文）',
    turns: [
      { instruction: '把极限节点的标题改成「极限的定义」', phase: 'normal', focus: ['B'], expect: { updateTargets: ['B'] } },
      { instruction: '给导数补充严格的极限定义公式', phase: 'normal', focus: ['A'], expect: { updateTargets: ['A'] } },
      { instruction: '把导数的定义改得更严谨一些', phase: 'normal', focus: ['A'], expect: { updateTargets: ['A'] } },
    ],
  },
  {
    id: 'composite-delete', label: '复合：删除流（单个→两个）',
    turns: [
      { instruction: '把极限这个节点删掉，它太基础了', phase: 'normal', focus: ['B'], expect: { deleteTargets: ['B'] } },
      { instruction: '把物理视角也删掉', phase: 'normal', focus: ['C'], expect: { deleteTargets: ['C'] } },
    ],
  },
  {
    id: 'composite-connect', label: '复合：连线流（删除连线→连接配对→防重复）',
    turns: [
      { instruction: '把极限到导数的连线删掉', phase: 'normal', focus: [], expect: { removeEdgeKey: 'B:out-0->A:in-0' } },
      { instruction: '把我的理解和物理视角连接起来', phase: 'normal', focus: [], expect: { connectPair: ['D', 'C'] } },
      { instruction: '把极限和导数连接起来', phase: 'normal', focus: [], expect: { addEdgeBetween: ['B', 'A'], noCrash: true } },
    ],
  },
  {
    id: 'composite-eval', label: '复合：评价流（聚焦→多目标）',
    turns: [
      { instruction: '评价一下我对导数的理解', phase: 'normal', focus: ['D'], expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeTargets: ['D'] } },
      { instruction: '再评价一下物理视角', phase: 'normal', focus: ['C'], expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeTargets: ['C'] } },
    ],
  },
];

// ===== 第三轮：复杂图 G9 + 对话式迭代场景 =====
const complexScenarios = [
  {
    id: 'c9-feedback-deepen', label: '反馈迭代：内容不够好→按建议改好', graphs: ['G9'],
    turns: [
      { instruction: '给「简谐运动」的物理视角补充更深入的内容，结合回复力与位移成正比', phase: 'normal', focus: ['m1-phy'], expect: { updateTargets: ['m1-phy'] } },
      { instruction: '还是太简单了。我想要的物理视角是：明确写出回复力 F=-kx、与位移成正比，并和数学视角的 x=Acos(wt+phi) 对应起来', phase: 'normal', focus: ['m1-phy'], expect: { updateTargets: ['m1-phy'], noNewPhysicsModule: true } },
    ],
  },
  {
    id: 'c9-feedback-structural', label: '反馈迭代：结构建议→补连线', graphs: ['G9'],
    turns: [
      { instruction: '给「简谐运动」的物理视角补充内容', phase: 'normal', focus: ['m1-phy'], expect: { updateTargets: ['m1-phy'] } },
      { instruction: '你补的内容没有和数学视角建立联系，请把物理视角和数学视角连接起来，关系标为「对应」', phase: 'normal', focus: ['m1-phy'], expect: { connectPair: ['m1-phy', 'm1-math'] } },
    ],
  },
  {
    id: 'c9-undo-selective', label: '选择性反悔：只撤简谐运动簇，保留导数簇', graphs: ['G9'],
    turns: [
      { instruction: '把「简谐运动」的物理视角内容改得更严谨', phase: 'normal', focus: ['m1-phy'], expect: { updateTargets: ['m1-phy'] } },
      { instruction: '把「导数」的物理视角也改得更严谨', phase: 'normal', focus: ['m3-phy'], expect: { updateTargets: ['m3-phy'] } },
      { instruction: '刚才简谐运动那边的改动不要了，恢复原样，导数那边保留', phase: 'normal', focus: ['m1-phy'], expect: { noCrash: true } },
    ],
    expect: { restoreTargets: ['m1-phy'], changedTargets: ['m3-phy'] },
  },
  {
    id: 'c9-undo-natural', label: '自然措辞反悔：改回去', graphs: ['G9'],
    turns: [
      { instruction: '把「简谐运动」的物理视角内容改得更严谨', phase: 'normal', focus: ['m1-phy'], expect: { updateTargets: ['m1-phy'] } },
      { instruction: '我觉得还是改回去比较好', phase: 'normal', focus: ['m1-phy'], expect: { noCrash: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'c9-undo-created', label: '反悔新建对象：把刚才加的节点撤掉', graphs: ['G9'],
    turns: [
      { instruction: '给「简谐运动」新增一个知识点：固有频率，内容为系统自由振动的频率', phase: 'normal', focus: ['m1-phy'], expect: { createCount: 1, noIsolated: true } },
      { instruction: '把刚才加的「固有频率」撤掉', phase: 'normal', focus: ['@last:node:固有频率'], expect: { noCrash: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'c9-undo-all', label: '复杂图全部撤销', graphs: ['G9'],
    turns: [
      { instruction: '把「简谐运动」的物理视角内容改得更严谨', phase: 'normal', focus: ['m1-phy'], expect: { updateTargets: ['m1-phy'] } },
      { instruction: '把「导数」的数学视角内容改得更严谨', phase: 'normal', focus: ['m3-math'], expect: { updateTargets: ['m3-math'] } },
      { instruction: '把所有修改全部撤销，回到最初', phase: 'normal', focus: [], expect: { statusUndo: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'c9-clarify-duplicate', label: '同名歧义：改「我的理解」', graphs: ['G9'],
    turns: [
      { instruction: '把「我的理解」的内容改得更清楚一些', phase: 'normal', focus: [], expect: { noCrash: true, allowedUpdateLabels: ['我的理解'] } },
    ],
  },
  {
    id: 'c9-multi-cluster', label: '跨簇不串：只改导数的物理视角', graphs: ['G9'],
    turns: [
      { instruction: '给「导数」的物理视角补充内容', phase: 'normal', focus: ['m3-phy'], expect: { updateTargets: ['m3-phy'], allowedUpdateIds: ['m3-phy'] } },
    ],
  },
  {
    id: 'c9-apply-eval', label: '复杂图应用评价建议', graphs: ['G9'],
    turns: [
      { instruction: '应用建议', phase: 'normal', focus: [], expect: { noEvalCreate: true, hasRealEdit: true, noCrash: true } },
    ],
  },
  {
    id: 'organize-wrong-edge', label: '整理关系：修正标错的关系', snapshotExtra: 'wrong-edge',
    turns: [
      { instruction: '检查这些连线的关系是否标错：把明显标错的关系改对，并给出具体理由；不要创建单独的“联系”节点', phase: 'normal', focus: [], expect: { hasEdgeCleanup: true, noRelationNode: true, noCrash: true } },
    ],
  },
  {
    id: 'organize-multiturn', label: '整理关系（多轮）：先整理再精简', graphs: ['G1'],
    turns: [
      { instruction: '整理这些知识点之间的关系：删掉牵强、空泛的连线，保留能说清理由的', phase: 'normal', focus: [], expect: { noRelationNode: true, noCrash: true } },
      { instruction: '再严格一点：只保留最核心的主线关系，把次要的也删掉', phase: 'normal', focus: [], expect: { hasEdgeCleanup: true, noRelationNode: true, noCrash: true } },
    ],
  },
  {
    id: 'organize-angle', label: '整理关系：按物理意义建立联系', graphs: ['G1'],
    turns: [
      { instruction: '从物理意义的角度建立联系：把相关知识点按“物理意义”连起来，并给每条连线一个具体的物理理由', phase: 'normal', focus: [], expect: { hasAddEdge: true, noRelationNode: true, noCrash: true } },
    ],
  },
  {
    id: 'expand-quality', label: '进阶链质量：answer 内容不能空泛', graphs: ['G1'],
    turns: [
      { instruction: '为导数生成进阶学习链', phase: 'normal', focus: ['A'], expect: { phase: 'expand', hasAnswer: true, hasLearn: true, noFluffyAnswer: true, noCrash: true } },
    ],
  },
  {
    id: 'expand-feedback', label: '进阶链反馈迭代：太浅了再深入', graphs: ['G1'],
    turns: [
      { instruction: '为导数生成进阶学习链', phase: 'normal', focus: ['A'], expect: { phase: 'expand', hasAnswer: true, hasLearn: true } },
      { instruction: '太浅了，请结合高阶导数的几何意义和泰勒展开再深入展开', phase: 'normal', focus: ['A'], expect: { hasRealEdit: true, noNewLearnModule: true, noCrash: true } },
    ],
  },
  {
    id: 'expand-level-research', label: '科研难度进阶链', graphs: ['G1'],
    turns: [
      { instruction: '用科研深度为导数生成进阶学习链', phase: 'normal', focus: ['A'], level: 'research', expect: { phase: 'expand', hasAnswer: true, hasLearn: true, noCrash: true } },
    ],
  },
  {
    id: 'organize-relations-fix', label: '整理关系：删除空泛的“相关”连线', snapshotExtra: 'weak-edge',
    turns: [
      { instruction: '整理这些知识点之间的关系：把“相关/有联系”这类空泛、牵强的连线删掉或改成有明确逻辑依据的关系，只保留能说清理由的连线；不要创建单独的“联系”节点', phase: 'normal', focus: [], expect: { noRelationNode: true, hasEdgeCleanup: true, noCrash: true } },
    ],
  },
  {
    id: 'organize-relations', label: '整理关系：只用连线，不建联系节点', graphs: ['G9'],
    turns: [
      { instruction: '整理这些知识点之间的关系：删掉牵强的连线，补上遗漏的连线；每条连线必须用一句具体的话说明为什么有关，禁止“相关/有联系/关联”这类空泛关系；不要创建单独的“联系”节点，直接连线即可', phase: 'normal', focus: [], expect: { noRelationNode: true, noCrash: true } },
    ],
  },
  {
    id: 'c9-health-after', label: '复杂图修改后一致性体检（断链/孤儿/重复不增加）', graphs: ['G9'],
    turns: [
      { instruction: '给「简谐运动」的物理视角补充更深入的内容，结合回复力与位移成正比', phase: 'normal', focus: ['m1-phy'], expect: { updateTargets: ['m1-phy'] } },
    ],
    expect: { healthAfter: true },
  },
  {
    id: 'readable-summary', label: '人性化摘要：多操作后 summary 不含原始 ID',
    turns: [
      { instruction: '给导数补一个数学视角，并新增两个知识点：链式法则和隐函数求导，把它们连到导数上并说明关系', phase: 'normal', focus: ['A'], expect: { summaryReadable: true, hasAddEdge: true, createCount: 2, noCrash: true } },
    ],
  },
  {
    id: 'c9-conversation', label: '对话：先问答后按上下文建点', graphs: ['G9'],
    turns: [
      { instruction: '简谐运动的回复力有什么特点？', phase: 'normal', focus: [], expect: { noOps: true } },
      { instruction: '把刚才说的内容整理成一个知识点加进图里', phase: 'normal', focus: [], expect: { createCount: 1, noIsolated: true, noCrash: true } },
    ],
  },
];

const crossScenarios = [
  {
    id: 'x-eval-understanding', label: '跨图：评价「我的理解」', graphs: ['G2', 'G3', 'G4'],
    graphTurns: {
      G2: [{ instruction: '评价一下「我的理解」', phase: 'normal', focusLabels: ['我的理解'], expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeLabels: ['我的理解'] } }],
      G3: [{ instruction: '评价一下「我的理解」', phase: 'normal', focusLabels: ['我的理解'], expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeLabels: ['我的理解'] } }],
      G4: [{ instruction: '评价一下「我的理解」', phase: 'normal', focusLabels: ['我的理解'], expect: { phase: 'evaluate', opType: 'create_eval_node', mustIncludeLabels: ['我的理解'] } }],
    },
  },
  {
    id: 'x-add-physics', label: '跨图：加物理视角（已有则扩展）', graphs: ['G2', 'G3'],
    graphTurns: {
      G2: [{ instruction: '给「电场」加一个物理视角', phase: 'normal', focusLabels: ['电场'], expect: { updateOrCreateModule: 'physics' } }],
      G3: [{ instruction: '给「矩阵」加一个物理视角', phase: 'normal', focusLabels: ['矩阵'], expect: { updateOrCreateModule: 'physics' } }],
    },
  },
  {
    id: 'x-delete', label: '跨图：删除指定节点', graphs: ['G2'],
    turns: [{ instruction: '把「电场强度」删掉，它与「电场」重复了', phase: 'normal', focusLabels: ['电场强度'], expect: { deleteLabels: ['电场强度'] } }],
  },
  {
    id: 'x-undo', label: '跨图：撤销修改', graphs: ['G2'],
    turns: [
      { instruction: '把「我的理解」的内容改得更严谨', phase: 'normal', focusLabels: ['我的理解'], expect: { updateLabels: ['我的理解'] } },
      { instruction: '撤销刚才的修改，恢复原样', phase: 'normal', focusLabels: ['我的理解'], expect: { statusUndo: true } },
    ],
    expect: { finalSnapshotEquals: 'before' },
  },
  {
    id: 'x-expand', label: '跨图：进阶学习链', graphs: ['G4'],
    turns: [{ instruction: '为「数学视角」生成进阶学习链', phase: 'normal', focusLabels: ['数学视角'], expect: { phase: 'expand', hasAnswer: true, hasLearn: true } }],
  },
  {
    id: 'x-big-eval', label: '大图整体评价（含孤立/同名）', graphs: ['G5'],
    turns: [{ instruction: '整体评价这个网络', phase: 'normal', focus: [], expect: { noCrash: true, noDestructive: true } }],
  },
  {
    id: 'x-big-add', label: '大图新增知识点', graphs: ['G5'],
    turns: [{ instruction: '新增一个知识点：洛必达法则，用于求极限', phase: 'normal', focus: [], expect: { noCrash: true, noIsolated: true } }],
  },
  {
    id: 'x-duplicate-update', label: '同名节点歧义：改「导数」', graphs: ['G6'],
    turns: [{ instruction: '把「导数」改成更严谨的表述', phase: 'normal', focus: [], expect: { noCrash: true, allowedUpdateLabels: ['导数'] } }],
  },
  {
    id: 'x-readonly', label: '只读根节点保护', graphs: ['G8'],
    turns: [{ instruction: '把根问题这个节点删掉', phase: 'normal', focus: [], expect: { noCrash: true, noDeleteIds: ['ROOT'] } }],
  },
  {
    id: 'x-empty-graph', label: '空图不崩溃', graphs: ['G7'],
    turns: [{ instruction: '评价一下这个图', phase: 'normal', focus: [], expect: { noCrash: true } }],
  },
];

function makeEvalSnapshot() {
  const s = makeSnapshot();
  const ev = [
    { id: 'E1', kind: 'ai_eval', label: '对「我的理解」的建议', target_node_id: 'D', target_label: '我的理解', suggestion: '把“斜率”改为“割线斜率的极限”，补充极限结构', priority: 'high' },
    { id: 'E2', kind: 'ai_eval', label: '对「物理视角」的建议', target_node_id: 'C', target_label: '物理视角', suggestion: '补充瞬时速度 v(t)=dx/dt 的严格定义', priority: 'medium' },
  ];
  s.nodes.push(...ev);
  s.edges.push(
    { key: 'D:out-0->E1:in-0', from: 'D', to: 'E1', relation: '评价', label: '评价' },
    { key: 'C:out-0->E2:in-0', from: 'C', to: 'E2', relation: '评价', label: '评价' },
  );
  return s;
}

function makeConflictSnapshot() {
  const s = makeSnapshot();
  const ev = [
    { id: 'E1', kind: 'ai_eval', label: '对「我的理解」的建议', target_node_id: 'D', target_label: '我的理解', suggestion: '把标题改成「瞬时变化率」并补充极限结构', priority: 'high' },
    { id: 'E2', kind: 'ai_eval', label: '对「我的理解」的建议2', target_node_id: 'D', target_label: '我的理解', suggestion: '保持标题不变，只补充物理例子即可', priority: 'low' },
  ];
  s.nodes.push(...ev);
  s.edges.push(
    { key: 'D:out-0->E1:in-0', from: 'D', to: 'E1', relation: '评价', label: '评价' },
    { key: 'D:out-0->E2:in-0', from: 'D', to: 'E2', relation: '评价', label: '评价' },
  );
  return s;
}

function makeWrongEdgeSnapshot() {
  const s = makeSnapshot();
  // 把 A->C 的“物理意义”故意标错为“反例”
  const e = s.edges.find(x => x.key === 'A:out-0->C:in-0');
  if (e) { e.relation = '反例'; e.label = '导数是物理视角的反例'; }
  return s;
}

function makeWeakEdgeSnapshot() {
  const s = makeSnapshot();
  // 故意加一条空泛的“相关”边：C(物理视角) -> D(我的理解)
  s.edges.push({ key: 'C:out-0->D:in-0', from: 'C', to: 'D', relation: '相关', label: '有联系' });
  return s;
}

function makeBigSnapshot() {
  const s = makeSnapshot();
  const extraNodes = [
    { id: 'E', kind: 'knowledge', label: '连续', content: '函数在某点连续的定义。' },
    { id: 'F', kind: 'knowledge', label: '微分', content: '函数的线性主部。' },
    { id: 'G', kind: 'module', module_key: 'math', label: '数学视角', content: '导数是差商的极限。' },
    { id: 'H', kind: 'module', module_key: 'graph', label: '知识图谱', content: '概念关系图。' },
    { id: 'I', kind: 'module', module_key: 'viz', label: '交互可视化', content: 'HTML 演示。' },
    { id: 'J', kind: 'module', module_key: 'learn', label: '进阶学习', content: '泰勒展开方向。' },
    { id: 'K', kind: 'human_note', label: '我的疑问', content: '为什么导数是极限？' },
    { id: 'L', kind: 'answer', label: 'AI 回答', content: '因为导数定义为差商极限。' },
    { id: 'M', kind: 'knowledge', label: '复合函数', content: '链式法则。' },
    { id: 'N', kind: 'knowledge', label: '反函数', content: '反函数求导。' },
    { id: 'O', kind: 'knowledge', label: '隐函数', content: '隐函数求导。' },
    { id: 'P', kind: 'knowledge', label: '参数方程', content: '参数方程求导。' },
  ];
  s.nodes.push(...extraNodes);
  s.edges.push(
    { key: 'B:out-0->E:in-0', from: 'B', to: 'E', relation: '依赖' },
    { key: 'A:out-0->F:in-0', from: 'A', to: 'F', relation: '导出' },
    { key: 'A:out-0->G:in-0', from: 'A', to: 'G', relation: '数学意义' },
    { key: 'A:out-0->H:in-0', from: 'A', to: 'H', relation: '模块' },
    { key: 'A:out-0->I:in-0', from: 'A', to: 'I', relation: '模块' },
    { key: 'A:out-0->J:in-0', from: 'A', to: 'J', relation: '进阶' },
    { key: 'A:out-0->K:in-0', from: 'A', to: 'K', relation: '补充视角' },
    { key: 'K:out-0->L:in-0', from: 'K', to: 'L', relation: '回答' },
    { key: 'F:out-0->M:in-0', from: 'F', to: 'M', relation: '拓展' },
    { key: 'F:out-0->N:in-0', from: 'F', to: 'N', relation: '拓展' },
    { key: 'F:out-0->O:in-0', from: 'F', to: 'O', relation: '拓展' },
    { key: 'F:out-0->P:in-0', from: 'F', to: 'P', relation: '拓展' },
  );
  return s;
}

function opName(op) { return op && (op.op || op.type || ''); }

function scoreScenario(sc, data) {
  const issues = [];
  const ops = Array.isArray(data.operations) ? data.operations : [];
  const ex = sc.expect || {};

  if (!data.status || data.status === 'error' || data.status === 'parse_error' || data.status === 'invalid') {
    issues.push('状态异常: ' + data.status + ' ' + JSON.stringify((data.errors || []).map(e => e.reason)));
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    issues.push('errors: ' + data.errors.map(e => e.reason).join(' | '));
  }

  if (ex.phase) {
    const actual = data.phase ? data.phase : (ops.length === 0 ? 'normal' : (ops.every(o => opName(o) === 'create_eval_node') ? 'evaluate' : (ops.some(o => opName(o) === 'create_node' && (o.kind === 'answer' || o.module_key === 'learn')) ? 'expand' : 'normal')));
    if (actual !== ex.phase) issues.push('阶段不符: 期望 ' + ex.phase + '，实际 ' + actual);
  }
  if (ex.opType && ops.length && !ops.every(o => opName(o) === ex.opType)) {
    issues.push('操作类型不符: 期望全部为 ' + ex.opType + '，实际 ' + [...new Set(ops.map(opName))].join(','));
  }
  // 创造模式（P3）：配方三件套的判定（op 层结构由后端校验器保证，这里钉行为要点）
  if (ex.recipeCreate) {
    const create = ops.find(o => opName(o) === 'create_recipe');
    if (!create) { issues.push('未产出 create_recipe'); }
    else {
      const r = create.recipe || {};
      const dyn = (r.ports && r.ports.dynamic) || null;
      if (ex.recipeCreate.levelTags && !(dyn && dyn.parser && Array.isArray(dyn.parser.level_tags) && dyn.parser.level_tags.length >= 3)) {
        issues.push('动态出口缺级别白名单 level_tags: ' + JSON.stringify(dyn && dyn.parser && dyn.parser.level_tags));
      }
      if (ex.recipeCreate.eachType && !(dyn && dyn.each && dyn.each.type === ex.recipeCreate.eachType)) {
        issues.push('动态出口 each.type 不符: ' + JSON.stringify(dyn && dyn.each));
      }
      if (ex.recipeCreate.fallback && !(dyn && dyn.fallback && dyn.fallback.mode === ex.recipeCreate.fallback)) {
        issues.push('动态出口兜底方式不符: ' + JSON.stringify(dyn && dyn.fallback));
      }
      if (ex.recipeCreate.staticPorts) {
        const count = (r.ports && Array.isArray(r.ports.static)) ? r.ports.static.length : 0;
        if (count < ex.recipeCreate.staticPorts) issues.push('静态出口不足: 期望 ≥' + ex.recipeCreate.staticPorts + '，实际 ' + count);
      }
    }
  }
  if (ex.recipeUpdate) {
    const upd = ops.find(o => opName(o) === 'update_recipe');
    if (!upd) issues.push('未产出 update_recipe');
    else if (String(upd.recipe_id || '') !== ex.recipeUpdate) issues.push('update_recipe 目标不符: ' + upd.recipe_id);
  }
  if (ex.recipeDelete) {
    const del = ops.find(o => opName(o) === 'delete_recipe');
    if (!del) issues.push('未产出 delete_recipe');
    else if (String(del.recipe_id || '') !== ex.recipeDelete) issues.push('delete_recipe 目标不符: ' + del.recipe_id);
  }
  if (ex.createModule && !ops.some(o => opName(o) === 'create_node' && o.kind === 'module' && (o.module_key || o.moduleKey) === ex.createModule)) {
    issues.push('未创建 ' + ex.createModule + ' 模块');
  }
  if (ex.updateOrCreateModule) {
    const created = ops.some(o => opName(o) === 'create_node' && o.kind === 'module' && (o.module_key || o.moduleKey) === ex.updateOrCreateModule);
    const existingIds = ex.existingModuleIds && ex.existingModuleIds.length ? ex.existingModuleIds : ['C'];
    const updated = ops.some(o => opName(o) === 'update_node' && existingIds.includes(o.id));
    if (!created && !updated) issues.push('既未创建也未扩展现有 ' + ex.updateOrCreateModule + ' 模块');
  }
  if (ex.deleteTargets) {
    const deleted = ops.filter(o => opName(o) === 'delete_node').map(o => o.id);
    for (const t of ex.deleteTargets) if (!deleted.includes(t)) issues.push('未删除目标 ' + t + '，实际删除: ' + deleted.join(','));
    if (deleted.some(d => !ex.deleteTargets.includes(d))) issues.push('删除了非目标节点: ' + deleted.filter(d => !ex.deleteTargets.includes(d)).join(','));
  }
  if (ex.updateTargets) {
    const updated = ops.filter(o => opName(o) === 'update_node').map(o => o.id);
    for (const t of ex.updateTargets) if (!updated.includes(t)) issues.push('未修改目标 ' + t + '，实际修改: ' + updated.join(','));
  }
  if (ex.mustIncludeTargets) {
    const evalTargets = ops.filter(o => opName(o) === 'create_eval_node').map(o => o.target_node_id || o.target);
    for (const t of ex.mustIncludeTargets) if (!evalTargets.includes(t)) issues.push('未评价目标 ' + t);
  }
  if (ex.allowedUpdateIds) {
    const touched = ops.filter(o => ['update_node', 'delete_node'].includes(opName(o))).map(o => o.id);
    const wrong = touched.filter(id => id && !ex.allowedUpdateIds.includes(id));
    if (wrong.length) issues.push('改错了节点: ' + wrong.join(',') + '（允许: ' + ex.allowedUpdateIds.join(',') + '）');
  }
  if (ex.hasAnswer && !ops.some(o => opName(o) === 'create_node' && o.kind === 'answer')) issues.push('缺少 answer 节点');
  if (ex.hasLearn && !ops.some(o => opName(o) === 'create_node' && o.kind === 'module' && (o.module_key || o.moduleKey) === 'learn')) issues.push('缺少 learn 模块');
  if (ex.noOps && ops.length) issues.push('纯问答却生成了 ' + ops.length + ' 条操作');
  if (ex.noDestructive) {
    const destructive = ops.filter(o => ['delete_node', 'update_node'].includes(opName(o)));
    if (destructive.length) issues.push('模糊指令却执行了破坏性操作: ' + JSON.stringify(destructive.map(o => [opName(o), o.id])));
  }
  if (ex.noIsolated) {
    const createdIds = new Set(ops.filter(o => opName(o) === 'create_node').map(o => o.assigned_id || o.id || o.temp_id));
    const edgeEndpoints = new Set();
    ops.filter(o => opName(o) === 'add_edge').forEach(o => { edgeEndpoints.add(o.from); edgeEndpoints.add(o.to); });
    const isolated = [...createdIds].filter(id => !edgeEndpoints.has(id));
    if (isolated.length) issues.push('孤立新节点: ' + isolated.join(','));
  }
  if (ex.connectedFrom) {
    const createdModuleIds = ops.filter(o => opName(o) === 'create_node' && o.kind === 'module').map(o => o.assigned_id || o.id || o.temp_id);
    const edges = ops.filter(o => opName(o) === 'add_edge');
    const connected = ex.connectedFrom.some(src => edges.some(e => e.from === src && createdModuleIds.includes(e.to)));
    if (!connected) issues.push('新模块未从期望节点引出连线');
  }
  if (!String(data.summary || '').trim()) issues.push('缺少 summary');
  if (ex.summaryReadable) {
    const s = String(data.summary || '');
    const rawId = /(hn_\d+|knowledge-custom-\d+|:\w+-\d+->|edge_key|temp_id|\b[A-Za-z]+-\d{6,}\b)/;
    const longDigit = /\d{10,}/;
    const actionWords = /新增|修改|删除|连线|评价|进阶|调整|补充|整理|扩展/;
    if (rawId.test(s) || longDigit.test(s)) issues.push('summary 包含原始标识: ' + s.slice(0, 100));
    else if (!actionWords.test(s)) issues.push('summary 缺少动作性描述: ' + s.slice(0, 100));
  }
  if (ex.noEvalCreate && ops.some(o => opName(o) === 'create_eval_node')) issues.push('apply 阶段仍创建了评价节点');
  if (ex.hasRealEdit && !ops.some(o => ['update_node', 'delete_node', 'add_edge', 'remove_edge', 'update_edge'].includes(opName(o)))) issues.push('apply 阶段没有真实修改操作');
  if (ex.updateEdge) {
    const hasUpdate = ops.some(o => opName(o) === 'update_edge');
    const removes = ops.filter(o => opName(o) === 'remove_edge').map(o => o.edge_key || o.key);
    const adds = ops.filter(o => opName(o) === 'add_edge').map(o => o.edge_key || o.key);
    const hasRemap = removes.length && removes.some(k => adds.includes(k));
    if (!hasUpdate && !hasRemap) issues.push('未修改连线（既没有 update_edge，也没有 remove+add 重连）');
  }
  if (ex.removeEdgeKey) {
    const removes = ops.filter(o => opName(o) === 'remove_edge').map(o => o.edge_key || o.key);
    const reAdds = ops.filter(o => opName(o) === 'add_edge').map(o => o.edge_key || o.key);
    if (!removes.includes(ex.removeEdgeKey)) issues.push('未删除连线 ' + ex.removeEdgeKey);
    if (reAdds.includes(ex.removeEdgeKey)) issues.push('删除后又重新添加了同一条连线');
  }
  if (ex.connectPair) {
    const [a, b] = ex.connectPair;
    const pairs = ops.filter(o => opName(o) === 'add_edge').map(o => [o.from, o.to]);
    const ok = pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    if (!ok) issues.push('未连接节点对 ' + a + '-' + b);
  }
  if (ex.noDuplicateAddEdge) {
    const addedKeys = ops.filter(o => opName(o) === 'add_edge').map(o => o.edge_key || o.key);
    const dup = addedKeys.filter(k => ex.noDuplicateAddEdge.includes(k));
    if (dup.length) issues.push('重复添加已有连线: ' + dup.join(','));
  }
  if (ex.createCount) {
    const created = ops.filter(o => opName(o) === 'create_node').length;
    if (created < ex.createCount) issues.push('新增节点不足: 期望 >= ' + ex.createCount + '，实际 ' + created);
  }
  if (ex.expandAllTargets) {
    const answers = ops.filter(o => opName(o) === 'create_node' && o.kind === 'answer').length;
    const learns = ops.filter(o => opName(o) === 'create_node' && o.kind === 'module' && (o.module_key || o.moduleKey) === 'learn').length;
    if (answers < ex.expandAllTargets.length) issues.push('answer 节点数不足: ' + answers + '/' + ex.expandAllTargets.length);
    if (learns < ex.expandAllTargets.length) issues.push('learn 模块数不足: ' + learns + '/' + ex.expandAllTargets.length);
  }
  if (ex.hasAddEdge && !ops.some(o => opName(o) === 'add_edge')) {
    issues.push('应新增至少一条连线');
  }
  if (ex.noFluffyAnswer) {
    const answers = ops.filter(o => opName(o) === 'create_node' && o.kind === 'answer');
    for (const a of answers) {
      const c = String(a.content || '').trim();
      if (!c) issues.push('answer 节点内容为空');
      else if (/^(深入学习|继续学习|进阶学习|了解更多|建议学习)[^，。!！?？]{0,12}$/.test(c)) issues.push('answer 内容空泛: ' + c.slice(0, 40));
    }
  }
  if (ex.noNewLearnModule) {
    const dup = ops.filter(o => opName(o) === 'create_node' && o.kind === 'module' && (o.module_key || o.moduleKey) === 'learn');
    if (dup.length) issues.push('反馈迭代时又新建了 learn 模块（应扩展现有节点）');
  }
  if (ex.hasEdgeCleanup && !ops.some(o => opName(o) === 'remove_edge' || opName(o) === 'update_edge')) {
    issues.push('应修改/删除至少一条牵强连线（remove_edge 或 update_edge）');
  }
  if (ex.noRelationNode && ops.some(o => opName(o) === 'create_node' && (o.kind === 'relation'))) {
    issues.push('不应创建 kind=relation 的联系节点（关系应直接用连线表达）');
  }
  if (ex.noEvalOnEval) {
    const evalTargets = ops.filter(o => opName(o) === 'create_eval_node').map(o => o.target_node_id || o.target);
    const bad = evalTargets.filter(t => ['E1', 'E2'].includes(t));
    if (bad.length) issues.push('对 AI 评价节点生成了评价: ' + bad.join(','));
  }
  if (ex.noNewPhysicsModule) {
    const dup = ops.filter(o => opName(o) === 'create_node' && o.kind === 'module' && (o.module_key || o.moduleKey) === 'physics');
    if (dup.length) issues.push('反馈迭代时又新建了物理视角模块（应扩展现有节点）');
  }
  if (ex.statusUndo && data.status !== 'undo') issues.push('期望走撤销路径（status=undo），实际 ' + data.status);
  if (ex.allowClarify && data.status === 'clarify') {
    // 澄清是允许的保守行为
  }
  if (ex.addEdgeBetween) {
    const [a, b] = ex.addEdgeBetween;
    const pairs = ops.filter(o => opName(o) === 'add_edge').map(o => [o.from, o.to]);
    const ok = pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    if (!ok) issues.push('未重新连接节点对 ' + a + '-' + b);
  }
  if (ex.noDeleteIds) {
    const deleted = ops.filter(o => opName(o) === 'delete_node').map(o => o.id);
    const bad = deleted.filter(id => ex.noDeleteIds.includes(id));
    if (bad.length) issues.push('删除了受保护节点: ' + bad.join(','));
  }
  if (ex.noCrash && (data.status === 'error' || data.status === 'parse_error')) issues.push('不应报错');

  const passed = issues.length === 0;
  return { passed, issues, opCount: ops.length, opsSummary: ops.map(o => opName(o) + ':' + (o.label || o.id || '')).slice(0, 10) };
}

async function callHealth(snapshot) {
  const r = await fetch(BASE + '/api/harness/graph/health', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot }), signal: AbortSignal.timeout(60000),
  });
  return await r.json();
}

async function callReview(payload) {
  const r = await fetch(BASE + '/api/harness/graph/review', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(240000),
  });
  return await r.json();
}

function buildTurnPayload(snapshot, turn, history, prevOps, prevSnapshot, allPrevOps, initialSnapshot) {
  return {
    snapshot,
    instruction: turn.instruction,
    model: MODEL_CFG,
    max_tokens: 6000,
    phase: turn.phase || 'normal',
    level: turn.level || 'university',
    focus_node_ids: turn.focus || [],
    harness_history: history,
    previous_ops: prevOps || [],
    previous_snapshot: prevSnapshot || null,
    all_previous_ops: allPrevOps || [],
    initial_snapshot: initialSnapshot || null,
    retries: 2,
  };
}

function makeInitialSnapshot(sc, graph) {
  if (graph) return { version: 1, nodes: graph.nodes, edges: graph.edges };
  if (sc.snapshotExtra === 'weak-edge') return makeWeakEdgeSnapshot();
  if (sc.snapshotExtra === 'wrong-edge') return makeWrongEdgeSnapshot();
  if (sc.snapshotExtra === 'evals') return makeEvalSnapshot();
  if (sc.snapshotExtra === 'evals-conflict') return makeConflictSnapshot();
  if (sc.snapshotExtra === 'big') return makeBigSnapshot();
  if (sc.snapshotExtra === 'recipes') return makeRecipesSnapshot();
  return makeSnapshot();
}

// 创造模式（P3）：带已有配方清单的快照（模拟用户配方库非空——Φ 需据此查重/删除）
function makeRecipesSnapshot() {
  const snap = makeSnapshot();
  snap.user_recipes = [
    { id: 'recipe-b1', name: '错题复盘', desc: '考后复盘', base_kind: 'module', content_kind: 'markdown', ports: '静态 2' },
  ];
  return snap;
}

function turnScore(turn, data) {
  const pseudo = { id: turn.id || 'turn', label: turn.label || '', expect: turn.expect || {} };
  return scoreScenario(pseudo, data);
}


// 语义目标 -> 图内 id：把 focusLabels / expect 里的 label 字段解析成该图的真实 id
function translateTurnForGraph(graph, turn) {
  const t = { ...turn };
  if (t.focusLabels) t.focus = resolveLabels(graph, t.focusLabels);
  const ex = { ...(t.expect || {}) };
  if (ex.updateLabels) ex.updateTargets = resolveLabels(graph, ex.updateLabels);
  if (ex.deleteLabels) ex.deleteTargets = resolveLabels(graph, ex.deleteLabels);
  if (ex.mustIncludeLabels) ex.mustIncludeTargets = resolveLabels(graph, ex.mustIncludeLabels);
  if (ex.allowedUpdateLabels) ex.allowedUpdateIds = resolveLabels(graph, ex.allowedUpdateLabels);
  if (ex.connectLabels && ex.connectLabels.length === 2) {
    ex.connectPair = resolveLabels(graph, ex.connectLabels);
  }
  if (ex.updateOrCreateModule) {
    const key = ex.updateOrCreateModule;
    ex.existingModuleIds = (graph.nodes || [])
      .filter(n => n.kind === 'module' && (n.module_key || n.moduleKey) === key)
      .map(n => n.id);
  }
  t.expect = ex;
  return t;
}

async function runTurns(sc, idx, graph, total) {
  const gid = graph ? graph.id : 'G1';
  const graphTurns = sc.graphTurns ? sc.graphTurns[gid] : null;
  const rawTurns = graphTurns || sc.turns || [{
    instruction: sc.instruction, phase: sc.phase, focus: sc.focus, focusLabels: sc.focusLabels, level: sc.level, expect: sc.expect, label: sc.label,
  }];
  const turns = graph ? rawTurns.map(t => translateTurnForGraph(graph, t)) : rawTurns;
  let snapshot = makeInitialSnapshot(sc, graph);
  const beforeSnapshot = JSON.parse(JSON.stringify(snapshot));
  const history = [];
  const turnResults = [];
  const t0 = Date.now();
  const overallIssues = [];
  let lastOps = [];
  let lastBeforeSnapshot = null;
  let allOps = [];
  let lastMarkers = {};
  const initialSnapshot = JSON.parse(JSON.stringify(snapshot));
  for (let ti = 0; ti < turns.length; ti++) {
    const rawTurn = turns[ti];
    const turn = { ...rawTurn, focus: (rawTurn.focus || []).map(f => {
      if (typeof f === 'string' && f.startsWith('@last:')) return lastMarkers[f] || f;
      return f;
    }) };
    const payload = buildTurnPayload(snapshot, turn, history, lastOps, lastBeforeSnapshot, allOps, initialSnapshot);
    try {
      const data = await callReview(payload);
      const score = turnScore(turn, data);
      turnResults.push({ turn: ti, status: data.status, score, data });
      if (data && data.next_snapshot && (data.status === 'ok' || data.status === 'undo')) {
        lastBeforeSnapshot = JSON.parse(JSON.stringify(snapshot));
        lastOps = (data.operations || []).slice();
        if (data.status === 'ok') allOps = allOps.concat((data.operations || []).slice());
        snapshot = data.next_snapshot;
      }
      {
        const markers = {};
        for (const o of (data.operations || [])) {
          if (opName(o) === 'create_node') {
            const id = o.assigned_id || o.id || o.temp_id;
            if (!id) continue;
            markers['@last:any'] = id;
            const key = o.module_key || o.moduleKey || '';
            if (key) markers['@last:module:' + key] = id;
            const label = o.label || '';
            if (label) markers['@last:node:' + label] = id;
          }
        }
        if (Object.keys(markers).length) lastMarkers = markers;
      }
      history.push({ role: 'user', instruction: turn.instruction, phase: data.phase || turn.phase || 'normal' });
      history.push({
        role: 'assistant',
        summary: data.summary || '',
        operations: (data.operations || []).map(o => ({
          op: o.op, id: o.id, temp_id: o.temp_id, assigned_id: o.assigned_id,
          from: o.from, to: o.to, edge_key: o.edge_key, label: o.label, patch: o.patch, kind: o.kind,
        })),
        status: data.status,
      });
      if (!score.passed) overallIssues.push('第 ' + (ti + 1) + ' 轮: ' + score.issues.join(' / '));
    } catch (e) {
      turnResults.push({ turn: ti, status: 'network_error', score: { passed: false, issues: ['请求失败: ' + e.message], opCount: 0 }, data: null });
      overallIssues.push('第 ' + (ti + 1) + ' 轮请求失败: ' + e.message);
    }
  }
  const ex = sc.expect || {};
  if (ex.finalSnapshotEquals === 'before' && !snapshotsEqual(snapshot, beforeSnapshot)) {
    overallIssues.push('最终快照未恢复到修改前');
  }
  if (ex.healthAfter) {
    try {
      const healthInitial = await callHealth(initialSnapshot);
      const healthFinal = await callHealth(snapshot);
      const cnt = function (issues, type) { return (issues || []).filter(function (i) { return i.type === type; }).length; };
      if (cnt(healthFinal.issues, 'broken_edge') > 0) overallIssues.push('体检：最终图存在断链');
      if (cnt(healthFinal.issues, 'orphan') > cnt(healthInitial.issues, 'orphan')) overallIssues.push('体检：孤儿节点数量增加（初始 ' + cnt(healthInitial.issues, 'orphan') + ' → 最终 ' + cnt(healthFinal.issues, 'orphan') + '）');
      if (cnt(healthFinal.issues, 'duplicate_label') > cnt(healthInitial.issues, 'duplicate_label')) overallIssues.push('体检：重复知识点增加');
      if (cnt(healthFinal.issues, 'duplicate_module') > cnt(healthInitial.issues, 'duplicate_module')) overallIssues.push('体检：重复模块增加');
    } catch (e) {
      overallIssues.push('体检请求失败: ' + e.message);
    }
  }
  if (ex.restoreTargets) {
    for (const id of ex.restoreTargets) {
      const beforeNode = (beforeSnapshot.nodes || []).find(n => String(n.id) === String(id));
      const finalNode = (snapshot.nodes || []).find(n => String(n.id) === String(id));
      if (!finalNode) { overallIssues.push('restoreTarget 节点已不存在: ' + id); continue; }
      for (const f of ['content', 'label', 'formula']) {
        if (String((beforeNode || {})[f] || '') !== String(finalNode[f] || '')) {
          overallIssues.push('restoreTarget 未恢复: ' + id + '.' + f);
        }
      }
    }
  }
  if (ex.changedTargets) {
    for (const id of ex.changedTargets) {
      const beforeNode = (beforeSnapshot.nodes || []).find(n => String(n.id) === String(id));
      const finalNode = (snapshot.nodes || []).find(n => String(n.id) === String(id));
      if (!finalNode) { overallIssues.push('changedTarget 节点不存在: ' + id); continue; }
      const same = ['content', 'label', 'formula'].every(f => String((beforeNode || {})[f] || '') === String(finalNode[f] || ''));
      if (same) overallIssues.push('changedTarget 未保留修改: ' + id);
    }
  }
  const passed = overallIssues.length === 0;
  const opCount = turnResults.reduce((acc, tr) => acc + (tr.score.opCount || 0), 0);
  console.log('[' + (idx + 1) + '/' + (total || filtered.length) + '] ' + sc.id + '@' + gid + ' (' + (Date.now() - t0) + 'ms) ' + (passed ? 'PASS' : 'FAIL') + ' turns=' + turns.length);
  if (!passed) console.log('   ' + overallIssues.join('\n   '));
  return {
    ...sc, graph: gid, status: turnResults.length ? turnResults[turnResults.length - 1].status : 'none',
    summary: '', score: { passed, issues: overallIssues, opCount }, turns: turnResults, finalSnapshot: snapshot,
  };
}

const tierArg = process.argv[6] || '';
const graphArg = process.argv[7] || '';
const allScenarios = [...scenarios, ...compositeScenarios, ...complexScenarios, ...crossScenarios, ...feedbackScenarios];
const filtered = (only.length ? allScenarios.filter(s => only.includes(s.id)) : allScenarios)
  .filter(s => !tierArg || tierOf(s) === tierArg)
  .map(s => ({ ...s, tier: tierOf(s) }));
const results = [];
let ri = 0;
// 先展开跨图场景（一个场景 × N 张图 = N 次执行），保证进度计数与总数一致
const runQueue = [];
for (const sc of filtered) {
  const gs = sc.graphs && sc.graphs.length ? sc.graphs.map(graphById) : [null];
  for (const g of gs) {
    const gidNow = g ? g.id : 'G1';
    if (graphArg && gidNow !== graphArg) continue;
    runQueue.push({ sc, g });
  }
}
for (const { sc, g } of runQueue) {
  results.push(await runTurns(sc, ri, g, runQueue.length));
  ri++;
}

const passedCount = results.filter(r => r.score.passed).length;
console.log('\n===== 汇总: ' + passedCount + '/' + results.length + ' 通过 =====');
for (const r of results) {
  console.log('- ' + r.id + ': ' + (r.score.passed ? 'PASS' : 'FAIL') + ' (' + r.status + ') ops=' + r.score.opCount);
}
const outFile = process.argv[4];
if (outFile) {
  const fs = await import('node:fs');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
}
