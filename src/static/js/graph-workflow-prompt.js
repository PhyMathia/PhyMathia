// ====== 工作流上下文收集与提示词拼装（2026-10-10 自 graph-workflow.js 拆出，T261 纯搬家）=====
// 纯函数段：从节点上游链收集问题/输出生成 workflowContext，拼各模块提示词；
// 被 graph-workflow.js 的生成段与配方段运行期调用（函数声明全脚本提升）。
function _simpleHash(value) {
  let hash = 5381;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function _nodeStoredContent(node) {
  if (!node) return '';
  if (node.messageIndex >= 0) {
    const msg = _getChatHistory()[node.messageIndex] || null;
    if (node.kind === 'user') return msg?.content || '';
    if (node.kind === 'answer') return _graphSummary(msg?.content || '') || '';
    if (node.kind === 'module') return _nodeContent(msg, node);
  }
  // 派生追问节点（sq- 前缀自定义节点，messageIndex=-1）落到这里返回其 markdown 内容
  return node.summary || node.content || '';
}

function _findQuestionContentUpstream(node) {
  const visited = new Set();
  function walk(current) {
    if (!current || visited.has(current.id)) return '';
    visited.add(current.id);
    if (current.kind === 'user') return _nodeStoredContent(current);
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    for (const edge of incoming) {
      const source = _findGraphNode(edge.from);
      const found = walk(source);
      if (found) return found;
    }
    return '';
  }
  return walk(node);
}

function _nodeOutputContent(node, seen) {
  if (!node) return '';
  seen = seen || new Set();
  if (seen.has(node.id)) return '';
  seen.add(node.id);
  // hub（存量汇聚）与 junction（2026-10-11 中转）都无自己的内容：入边内容拼接后
  // 当自己的输出——追问链穿过它们时，下游看到的就是上游本身。两者差别只在收集
  // 清单里：hub 作为集合点出现在上游清单，junction 透明不出场（见
  // _collectUpstreamPath：它的"内容"就是上游拼接，再进一份等于每篇上游写两遍）。
  if (node.kind === 'hub' || node.kind === 'junction') {
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === node.id && !edge.draft && !edge.link);
    return incoming
      .map(edge => _nodeOutputContent(_findGraphNode(edge.from), seen))
      .filter(Boolean)
      .join('\n\n');
  }
  if (node.kind === 'answer' && !node.manual && node.messageIndex < 0) {
    return node.analysis || _findQuestionContentUpstream(node) || '';
  }
  return _nodeStoredContent(node);
}

function _collectUpstreamPath(node) {
  const ordered = [];
  const orderedIds = new Set();
  // T263 喂料分路：记录每个祖先经由哪条入边（toPort）进入，具名输入口分组用
  function collect(current, viaPort) {
    if (!current || orderedIds.has(current.id)) return;
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    for (const edge of incoming) {
      const source = _findGraphNode(edge.from);
      if (source) collect(source, edge.toPort || 'in-0');
    }
    if (!orderedIds.has(current.id)) {
      orderedIds.add(current.id);
      // 中转节点（2026-10-11）透明：上游照常递归（内容经 _nodeOutputContent 直通），
      // 自身不进取材清单——否则上游每篇内容会在提示词里出现两遍
      if (current.kind !== 'junction') {
        ordered.push({ node: current, port: viaPort || '' });
      }
    }
  }
  collect(node, '');
  return ordered.map(entry => {
    const item = entry.node;
    const raw = _nodeOutputContent(item);
    return {
      kind: item.kind,
      timestamp: item.timestamp || '',
      module: item.moduleKey || '',
      manual: !!item.manual,
      // 节点标题（2026-10-10 ③）：note/我的回答 起的名优先于品类名进下游喂料标签
      title: item.title || '',
      analysis: item.kind === 'answer' && !item.manual ? (item.analysis || '') : '',
      summary: _graphSummary(raw) || '',
      content: raw,
      toPort: entry.port,
    };
  });
}

// 单父链取材（P2，空白节点式）：只沿每个节点的第一条入边回溯一条链，
// 与 _collectUpstreamPath 输出同形（含自身，answer 仍被抽出进 analysis 槽）
function _collectInboundChain(node) {
  const chain = [];
  const ports = [];
  const visited = new Set();
  let current = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    // 中转节点（2026-10-11）穿透：自身不进链，顺它的第一条入边继续往上走——
    // 单链取材对它是"线的一截"，不是链上的一环
    if (current.kind === 'junction') {
      const hop = (graphView.edges || []).find(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
      current = hop ? _findGraphNode(hop.from) : null;
      continue;
    }
    chain.push(current);
    const incoming = (graphView.edges || []).find(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    ports.push(incoming ? (incoming.toPort || 'in-0') : '');
    current = incoming ? _findGraphNode(incoming.from) : null;
  }
  chain.reverse();
  ports.reverse();
  return chain.map((item, index) => {
    const raw = _nodeOutputContent(item);
    return {
      kind: item.kind,
      timestamp: item.timestamp || '',
      module: item.moduleKey || '',
      manual: !!item.manual,
      title: item.title || '',
      analysis: item.kind === 'answer' && !item.manual ? (item.analysis || '') : '',
      summary: _graphSummary(raw) || '',
      content: raw,
      toPort: ports[index] || '',
    };
  });
}

function _buildWorkflowContextForNode(node) {
  const meta = node.recipeId && node.recipe && node.recipe.name
    ? { label: node.recipe.name }
    : node.kind === 'module'
    ? (GRAPH_MODULE_META[node.moduleKey] || { label: node.moduleKey || '模块节点' })
    : node.kind === 'answer'
      ? { label: node.manual ? (node.title || '我的回答') : '问题分析' }
      : node.kind === 'hub'
        ? { label: '汇聚' }
        : node.kind === 'junction'
          ? { label: '中转' }
          : node.kind === 'summary'
          ? { label: 'AI 总结' }
      : node.kind === 'note'
          ? { label: node.title || '我的总结' }
          : node.kind === 'source'
            ? { label: '输入' }
            : node.kind === 'knowledge'
              ? { label: '知识点' }
              : node.kind === 'relation'
                ? { label: '知识联系' }
            : { label: '问题' };
  // 配方单链取材（P2，aggregation: first_inbound＝空白节点式）：只沿第一条入边
  // 回溯单父链，不收全祖先——多路汇聚的画布上节点只讲它直接挂着的那条线
  const recipeAgg = node.recipeId && node.recipe ? node.recipe.aggregation : '';
  const allUpstream = recipeAgg === 'first_inbound' ? _collectInboundChain(node) : _collectUpstreamPath(node);
  const analysisNode = allUpstream.find(item => item.kind === 'answer' && !item.manual);
  const upstream = allUpstream.filter(item => !(item.kind === 'answer' && !item.manual));
  const questionNode = upstream.find(item => item.kind === 'user');
  // T263 喂料分路：目标配方声明了具名输入口时，上游条目标注「来自哪个输入口」，
  // 结构化载荷与内联文本都按口分组；未声明（旧配方/旧快照）不设键，载荷形状与今日一致
  const declaredInputs = (node.recipeId && typeof _recipeInputPorts === 'function') ? _recipeInputPorts(node) : [];
  const typeLabels = typeof RECIPE_PORT_TYPE_LABELS !== 'undefined' ? RECIPE_PORT_TYPE_LABELS : {};
  const portMetaFor = (toPort) => {
    if (!declaredInputs.length || !toPort) return null;
    const m = /^in-(\d+)$/.exec(String(toPort));
    if (!m) return null;
    const named = declaredInputs[parseInt(m[1], 10)];
    if (named) return { label: named.label, type: named.type || '' };
    return { label: '其他输入', type: '' };
  };
  return {
    target: { kind: node.kind, module: node.moduleKey || '', label: meta.label || node.moduleKey || '节点' },
    question: questionNode ? questionNode.content : '',
    analysis: analysisNode ? analysisNode.analysis : '',
    mode: 'module',
    requirements: node.requirements || '',
    upstream: upstream.map(item => {
      const entry = {
        kind: item.kind,
        module: item.module,
        label: item.kind === 'user'
          ? '问题'
          : item.kind === 'note'
            ? (item.title || '我的总结')
            : item.kind === 'knowledge'
              ? '知识点'
              : item.kind === 'relation'
                ? '知识联系'
                : item.kind === 'source'
                  ? '输入'
          : item.kind === 'answer'
            ? (item.manual ? (item.title || '我的回答') : '问题分析')
            : ((GRAPH_MODULE_META[item.module] || {}).label || item.module || '上游节点'),
        summary: item.summary,
        analysis: item.analysis || '',
        content: (item.content || '').slice(0, 800),
      };
      const portMeta = portMetaFor(item.toPort);
      if (portMeta) {
        entry.input_port = portMeta.label;
        if (portMeta.type) entry.input_type = typeLabels[portMeta.type] || portMeta.type;
      }
      return entry;
    }),
  };
}

// T263：内联上游文本（summary/relation 与配方 prompt_inline 共用）。条目带 input_port
// （目标配方声明了具名输入口）时按口分组加小标题；未声明保持旧拼法逐条平铺。
function _upstreamInlineText(upstream) {
  const items = (upstream || []).filter(item => item && item.content);
  if (!items.some(item => item.input_port)) {
    return items.map(item => item.label + '：\n' + item.content).join('\n\n').slice(0, 8000);
  }
  const order = [];
  const byPort = new Map();
  items.forEach(item => {
    const key = item.input_port || '';
    if (!byPort.has(key)) { byPort.set(key, []); order.push(key); }
    byPort.get(key).push(item);
  });
  return order.map(key => {
    const body = byPort.get(key)
      .map(item => item.label + (item.input_type ? '（' + item.input_type + '）' : '') + '：\n' + item.content)
      .join('\n\n');
    return key ? '【输入「' + key + '」】\n' + body : body;
  }).join('\n\n').slice(0, 8000);
}

function _nodeInputHash(node) {
  const incoming = (graphView.edges || []).filter(edge => String(edge.to) === node.id && !edge.draft && !edge.link);
  // T263：仅当目标配方声明具名输入口时才把接线口计入哈希——旧图哈希逐字节不变，
  // 不会触发存量节点全量重生成；新配方换口接线能正确触发重生成
  const usePorts = !!(node.recipeId && typeof _recipeInputPorts === 'function' && _recipeInputPorts(node).length);
  const parts = incoming
    .map(edge => (edge.fromPort || 'out-0') + '=' + _nodeOutputContent(_findGraphNode(edge.from)) + (usePorts ? '@' + (edge.toPort || 'in-0') : ''))
    .sort();
  return _simpleHash((node.moduleKey || '') + '|' + (node.recipeId || '') + '|' + (node.requirements || '') + '|' + parts.join('|'));
}

// 配方节点的生成提示词（P1）：按底座路由。四槽来自节点内嵌快照（node.recipe），
// 与官方分支同构：module 走结构化 workflow_context（或声明 prompt_inline 时上游全文内联），
// summary/relation 上游全文内联，knowledge 用自身字段；人工底座不会走到这里。
function _recipeWorkflowPrompt(node, recipe, workflowContext, targetLabel) {
  const g = (recipe.generate || {});
  const baseKind = (recipe.base && recipe.base.kind) || 'module';
  const name = recipe.name || targetLabel || '配方';
  let inline = '';
  if (baseKind === 'summary' || baseKind === 'relation' || (baseKind === 'module' && g.context_channel === 'prompt_inline')) {
    inline = _upstreamInlineText(workflowContext.upstream);
  } else if (baseKind === 'knowledge') {
    inline = [
      node.title || name,
      node.summary || '',
      (node.formulas || []).join('\n'),
    ].filter(Boolean).join('\n\n');
  }
  const parts = [];
  parts.push('请生成「' + name + '」节点内容。');
  if (baseKind === 'module' || baseKind === 'summary') {
    parts.push('只输出该节点正文，不要输出完整学习卡片的 XML 标签，不要重复其他模块内容。');
  }
  if (g.prompt) parts.push(g.prompt);
  if (g.strict_output) parts.push(g.strict_output);
  if (inline) {
    parts.push('如出现公式仍按 <formula> 规范标注。\n\n' + (inline || '（暂无已连接的上游内容）'));
  }
  return parts.join('\n\n');
}

function _workflowPromptForNode(node, workflowContext) {
  const targetLabel = workflowContext.target.label || '节点';
  if (node.recipeId && node.recipe) {
    return _recipeWorkflowPrompt(node, node.recipe, workflowContext, targetLabel);
  }
  if (node.kind === 'hub') {
    return '这是汇聚节点，由上游连线收集内容，不需要 AI 生成。';
  }
  if (node.kind === 'summary') {
    const upstreamText = (workflowContext.upstream || [])
      .map(item => (item.content ? item.label + '：\n' + item.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8000);
    return '请根据以下已连接内容生成一份简明、结构化的 AI 总结。'
      + '要求：提炼物理直觉、数学本质、关键结论、公式和后续建议；只输出总结正文；不要输出完整学习卡片 XML，不要输出 <summary> 标签，不要输出其他模块正文；如出现公式仍按 <formula> 规范标注。\n\n'
      + (upstreamText || '（暂无已连接的上游内容）');
  }
  if (node.kind === 'relation') {
    const upstreamText = (workflowContext.upstream || [])
      .map(item => (item.content ? item.label + '：\n' + item.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8000);
    return '请基于以下已连接节点，用一句简短中文说明它们之间的联系。'
      + '要求：内容简短，最好不超过100字；如果涉及多个节点，说明它们之间共同的知识关系；不要输出XML标签，不要重复完整节点内容；如出现公式仍按 <formula> 规范标注。\n\n'
      + (upstreamText || '（暂无已连接的上游内容）');
  }
  if (node.kind === 'knowledge') {
    const sourceText = [
      node.title || '知识点',
      node.summary || '',
      (node.formulas || []).join('\n'),
    ].filter(Boolean).join('\n\n');
    return '请为以下知识点生成一段准确、简洁的中文解释。'
      + '要求：说明核心含义、物理或数学本质、适用条件；不要输出XML标签；如出现公式仍按 <formula> 规范标注；不要重复来源文件全文。\n\n'
      + (sourceText || '（暂无知识点内容）');
  }
  if (node.kind === 'answer' && !node.manual) {
    return '请根据用户问题生成问题分析节点的完整内容。'
      + '按 PhyMathia 系统提示词输出完整学习卡片 XML，包含 physics/math/graph/viz/learn/socratic 等标签，末尾输出 <summary>。';
  }
  if (node.kind === 'module') {
    const strictInstruction = _strictModuleOutputInstruction(node.moduleKey || workflowContext.target.module || '');
    return '请基于工作流上下文中的隐藏问题分析保持一致性，但不要重复分析内容。'
      + '请生成「' + targetLabel + '」节点内容。'
      + '只输出该模块正文，不要输出完整学习卡片的 XML 标签，不要重复其他模块内容。'
      + (strictInstruction ? '\n\n' + strictInstruction : '');
  }
  if (node.manual) {
    return '这是“我的回答”节点，由用户手动填写即可，不需要 AI 生成。';
  }
  return '请生成问题节点内容。';
}

function _strictModuleOutputInstruction(moduleKey) {
  if (moduleKey === 'socratic') {
    return '严格按以下格式输出，不得增加前言、答案、解释或任何其他模块：\n'
      + '### 苏格拉底追问\n'
      + '1. [基础] 只写一个基础引导问题\n'
      + '2. [进阶] 只写一个进阶引导问题\n'
      + '3. [拓展] 只写一个拓展引导问题\n'
      + '不要使用 XML 标签，不要输出“进阶学习方向”，不要展开问题背景，不要写“想一想”等引导语。';
  }
  if (moduleKey === 'learn') {
    return '严格按以下格式输出，不得增加前言、公式段、步骤讲解或任何其他模块：\n'
      + '### 进阶学习方向\n'
      + '1. 方向1\n'
      + '2. 方向2\n'
      + '3. 方向3\n'
      + '不要使用 XML 标签，不要输出“苏格拉底追问”，每条方向只保留一个短句，不要展开学习步骤。';
  }
  if (moduleKey === 'graph') {
    return '严格输出知识图谱 Mermaid 代码，不要输出其他模块、不要输出 XML 标签：\n'
      + '用 ```mermaid ... ``` 代码块包裹；至少 3 个上游 + 3 个下游概念，中文标注，箭头表示关系，节点文字避免括号（可用下划线替代）。';
  }
  if (moduleKey === 'viz') {
    return '严格输出 ```html ... ``` 完整 HTML 交互可视化页面，禁止只输出文字描述而不输出 HTML：\n'
      + '页面内顶部必须包含图说四段（用页面内可见标题/提示框呈现，缺一不可）：\n'
      + '**这张图在讲什么**：2~4 句大白话说明图的核心结论；\n'
      + '**怎么看这张图**：1. 2. 3. 编号观察步骤，每步“操作 → 会看到什么”；\n'
      + '**和公式的联系**：图中现象与公式如何互相印证；\n'
      + '**自测**：1 个不实际操作就答不出的问题（只提问不给答案）。\n'
      + '每个滑块/按钮旁标注对应物理量/数学量及在公式中的位置，关键结论数值旁给出对应公式。\n'
      + '不要输出 XML 标签，不要输出其他模块内容。';
  }
  return '';
}

// ====== SSE 帧读取：本文件三个流式通道共用的一份 ======
// 三个流式函数（模块节点 / 问题分析 / 空白节点）原本各抄一份：getReader →
// TextDecoder → 拆 \n\n → 逐行取 data: → 跳 [DONE] → JSON.parse → 错误帧抛错 →
// 吐 delta.content。同样的逻辑改一次要改三处，漏一处就只在那一条通道上出问题，
// 而症状是「某类节点偶发不更新」——极难查。这里抽成唯一的读取口，三处共用。
//
// **别把「唯一」读成「全仓唯一」**：全仓另有 4 处各自一份 getReader() 副本
