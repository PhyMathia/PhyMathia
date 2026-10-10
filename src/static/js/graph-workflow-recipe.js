// ====== 配方节点生成 P2 负责制（2026-10-10 自 graph-workflow.js 拆出，T261 纯搬家）=====
// 概要步 _recipeGenerateAnalysis 与生成后建点/连线；概要步提示词在 prompt 件
// _recipeWorkflowPrompt（跨文件调用），编辑入口在 graph-recipe-edit.js。
// ---- 配方 P2 助手：双阶段概要 / on_generated 编排 ----

// 配方双阶段的概要步（analysis_phase）：与 _generateAnalysis 同一条提示词与流式
// 通道，但不接管 busy/status（正文生成仍由 _generateCustomNode 主导），失败不拦正文
async function _recipeGenerateAnalysis(node, nodeSignal) {
  const question = _findQuestionContentUpstream(node);
  if (!question.trim()) return;
  const analysisHash = _simpleHash(question + '|' + (node.requirements || ''));
  if (node.analysis && node.analysisHash === analysisHash) return;
  const workflowContext = {
    mode: 'analysis',
    target: { kind: 'module', label: (node.recipe && node.recipe.name) || '配方' },
    question,
    requirements: node.requirements || '',
  };
  const prompt = '请分析用户问题，只输出简洁的问题概要。'
    + '要求：1) 核心物理概念；2) 核心数学结构；3) 物理与数学的关系；4) 相关知识点。'
    + '不要输出完整答案，不要输出 XML 标签，不要生成任何模块内容，控制在300字以内。';
  const signal = _workflowNodeSignal(nodeSignal);
  try {
    let resp = null;
    if (typeof getActiveModelForRole === 'function' && typeof proxyChat === 'function') {
      const agentModel = getActiveModelForRole('agent');
      if (agentModel) {
        resp = await proxyChat(prompt,
          typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          true,
          signal,
          { parentId: String(node.timestamp || ''), branchLabel: '配方概要', workflowContext }
        );
      }
    }
    if (!resp || !resp.ok) return;
    let analysis = '';
    for await (const piece of _sseContentFrames(resp)) {
      analysis += piece;
      if (_workflowNodeAborted(nodeSignal)) break;
    }
    let cleaned = analysis.trim();
    if (typeof stripXmlTags === 'function') cleaned = stripXmlTags(cleaned).trim();
    if (!cleaned) return;
    if (cleaned.length > 1200) cleaned = cleaned.slice(0, 1200);
    const live = _findGraphNode(node.id);
    if (!live || live.busy !== true) return;   // 概要生成期间节点被删/状态被改：不回写
    live.analysis = cleaned;
    live.analysisHash = analysisHash;
  } catch (err) {
    console.warn('Recipe analysis phase failed (content generation continues):', err);
  }
}

// on_generated 编排钩子（P2）：配方节点生成成功后按声明建节点＋连线，再把带 AI
// 底座的新节点送回工作流（复刻 harness _generateHarnessCreatedContent 的回填口径）。
// 只跑一次（节点上的 onGeneratedAt 标记），重生成不重复搭链；chain_check 按声明
// 顺序补全缺失的链边（find_missing_expansion_chains 的数据驱动版）。
function _recipeAfterGenerated(node) {
  const recipe = node && node.recipeId && node.recipe ? node.recipe : null;
  const spec = recipe && recipe.on_generated;
  if (!spec || !Array.isArray(spec.create) || !spec.create.length) return;
  // 只跑一次＋链深 1：on_generated 建出的节点不再触发自己的 on_generated，
  // 防止「配方 A 生成配方 A」类声明无限自 spawning
  if (node.onGeneratedAt || node.fromRecipeChain) return;
  try {
    const created = _recipeCreateOnGeneratedNodes(node, spec);
    if (!created.length) return;
    _recipeConnectOnGenerated(node, spec, created);
    node.onGeneratedAt = Date.now();
    _saveCustomNodes();
    renderGraphCanvas();
    const aiIds = created.filter(item => item.ai).map(item => item.id);
    if (aiIds.length) runWorkflowNodes(aiIds);
  } catch (err) {
    console.warn('Recipe on_generated failed:', err);
  }
}

// 按 spec.create 建节点：base.recipe 指官方配方 key（如 learn → moduleKey=learn）
// 或用户配方 id（带内嵌快照，复用 createRecipeNode 同款模板）
function _recipeCreateOnGeneratedNodes(node, spec) {
  const created = [];
  spec.create.forEach((item, index) => {
    const kind = item.base && item.base.kind;
    if (!kind) return;
    const id = 'recipe-gen-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const pos = { x: (node.x || 0) + 60 + index * 40, y: (node.y || 0) + 260 + index * 220 };
    const selfLabel = node.label || node.title || (node.recipe && node.recipe.name) || '节点';
    let label = item.label || '';
    if (item.label_template) label = item.label_template.replace(/\{self\.label\}/g, selfLabel);
    if (!label) label = kind === 'module' ? '生成模块' : '生成节点';
    let content = '';
    if (item.content_from === 'self_content') content = node.content || '';
    else if (item.content_from === 'self_directions') {
      const dyn = node.recipe && node.recipe.ports && node.recipe.ports.dynamic;
      const parsed = dyn ? (typeof _recipeParseNumberedList === 'function'
        ? _recipeParseNumberedList(node.content, dyn.parser) : []) : [];
      content = parsed.map((entry, i) => (i + 1) + '. ' + entry.question).join('\n') || (node.content || '');
    }
    const recipeRef = item.base.recipe || '';
    let moduleKey = '';
    let embed = null;
    if (recipeRef) {
      const builtin = (typeof BUILTIN_RECIPES !== 'undefined' ? BUILTIN_RECIPES : []).find(r => r.key === recipeRef);
      if (builtin && builtin.kind === 'module') {
        moduleKey = builtin.moduleKey || builtin.key;
      } else {
        const userRecipe = (typeof getUserRecipes === 'function' ? getUserRecipes() : []).find(r => r.id === recipeRef);
        embed = userRecipe && typeof recipeEmbedSnapshot === 'function' ? recipeEmbedSnapshot(userRecipe) : null;
      }
    }
    const manualFlag = kind === 'note' || kind === 'human_note';
    const newNode = {
      id,
      kind,
      moduleKey: kind === 'module' ? moduleKey : '',
      manual: manualFlag,
      recipeId: embed ? recipeRef : '',
      recipe: embed,
      fromRecipeChain: true,
      // label 全 kind 都设：harness 建的 answer 节点（「X的进阶学习」）就靠这个字段显示
      label,
      title: '',
      content,
      status: content ? 'done' : 'empty',
      summary: content.slice(0, 120),
      analysis: '',
      analysisHash: '',
      inputHash: '',
      generatedAt: 0,
      requirements: '',
      busy: false,
      generated: false,
      maxItems: 0,
      items: [],
      edges: [],
      fileId: '',
      fileName: '',
      generatedNodeIds: [],
      category: '',
      formulas: [],
      knowledgeKey: '',
      x: pos.x,
      y: pos.y,
      depth: kind === 'user' ? 1 : kind === 'answer' ? 2 : 3,
      targetAngle: 0,
      isRoot: false,
      messageIndex: -1,
      timestamp: Date.now(),
      pinned: false,
      fixedX: null,
      fixedY: null,
      customWidth: null,
      customHeight: null,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
    };
    graphView.nodes.push(newNode);
    graphView.nodeById[id] = newNode;
    // 与 harness _generateHarnessCreatedContent 同口径：module/blank/summary/answer(!manual)
    // 交回工作流生成；note/user/human_note 是人工节点不生成
    created.push({
      id,
      as: item.as || ('$' + index),
      ai: kind === 'module' || kind === 'blank' || (kind === 'answer'),
    });
  });
  return created;
}

// 按 spec.connect 建边（去重），chain_check＝再按声明顺序补全缺失的链边
function _recipeConnectOnGenerated(node, spec, created) {
  const byAs = new Map(created.map(item => [item.as, item.id]));
  const resolve = ref => (ref === 'self' ? node.id : (byAs.get(ref) || ''));
  const edgeKey = (from, to) => from + '|' + to;
  const existing = new Set((graphView.edges || []).map(edge => edgeKey(String(edge.from), String(edge.to))));
  const addEdge = (fromId, toId, relation) => {
    if (!fromId || !toId || fromId === toId) return;
    const key = edgeKey(fromId, toId);
    if (existing.has(key)) return;
    existing.add(key);
    graphView.edges.push({
      from: fromId,
      fromPort: 'out-0',
      to: toId,
      toPort: 'in-0',
      type: 'custom',
      custom: true,
      relation: String(relation || ''),
      label: String(relation || ''),
    });
  };
  (spec.connect || []).forEach(item => {
    addEdge(resolve(item.from), resolve(item.to), item.relation);
  });
  if (!spec.chain_check) return;
  // 补链（find_missing_expansion_chains 思路）：按 create 声明顺序两两核对，
  // 缺的边用声明里的 relation（没有则「模块」）补上
  let prev = node.id;
  spec.create.forEach(item => {
    const cur = byAs.get(item.as);
    if (!cur) return;
    const declared = (spec.connect || []).find(c => resolve(c.from) === prev && resolve(c.to) === cur);
    addEdge(prev, cur, declared ? declared.relation : '模块');
    prev = cur;
  });
}
