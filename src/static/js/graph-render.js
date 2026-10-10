// ===== PhyMathia 知识网络画布：节点渲染、端口、高亮与布局 =====

function _nodeAttribute(node) {
  // 节点配方（P1）：配方节点的外观（名称标签＋色板令牌）优先于底座默认值
  const recipeAttr = typeof _recipeNodeAttribute === 'function' ? _recipeNodeAttribute(node) : null;
  if (recipeAttr) return recipeAttr;
  if (node.kind === 'draft') {
    return GRAPH_NODE_ATTRIBUTES[node.portMeta && node.portMeta.attribute] || GRAPH_NODE_ATTRIBUTES.followup;
  }
  if (node.kind === 'module') {
    return GRAPH_NODE_ATTRIBUTES[node.moduleKey] || GRAPH_NODE_ATTRIBUTES.question;
  }
  if (node.kind === 'blank') {
    return GRAPH_NODE_ATTRIBUTES[node.moduleKey] || GRAPH_NODE_ATTRIBUTES.any;
  }
  if (node.kind === 'human_note') return GRAPH_NODE_ATTRIBUTES.human_note;
  if (node.kind === 'ai_eval') return GRAPH_NODE_ATTRIBUTES.ai_eval;
  if (node.kind === 'answer') return node.manual ? GRAPH_NODE_ATTRIBUTES.manual : GRAPH_NODE_ATTRIBUTES.answer;
  if (node.kind === 'hub' || node.kind === 'summary' || node.kind === 'note') {
    return GRAPH_NODE_ATTRIBUTES[node.kind] || GRAPH_NODE_ATTRIBUTES.manual;
  }
  if (node.kind === 'source' || node.kind === 'knowledge' || node.kind === 'relation') {
    return GRAPH_NODE_ATTRIBUTES[node.kind] || GRAPH_NODE_ATTRIBUTES.question;
  }
  if (node.kind === 'user') {
    if (node.attribute && GRAPH_NODE_ATTRIBUTES[node.attribute]) return GRAPH_NODE_ATTRIBUTES[node.attribute];
    if (node.moduleKey && GRAPH_NODE_ATTRIBUTES[node.moduleKey]) return GRAPH_NODE_ATTRIBUTES[node.moduleKey];
    if (node.branchType === 'socratic') return GRAPH_NODE_ATTRIBUTES.socratic;
    if (node.branchType === 'learn') return GRAPH_NODE_ATTRIBUTES.learn;
    if (node.branchType === 'followup') return GRAPH_NODE_ATTRIBUTES.followup;
    return GRAPH_NODE_ATTRIBUTES.question;
  }
  return GRAPH_NODE_ATTRIBUTES.question;
}

// 连线自由化（2026-10-10）：结构连线不再做语义裁判——除「不能自己连自己」外
// 一律放行。原 kind×端口白名单矩阵（hub 出口白名单、summary 只接 hub out-0、
// note 只接 hub out-1、answer 的 AI/手写分流、human_note/blank 出口白名单、
// module→user/draft 属性匹配、兜底 return false）整体移除。
// 端口身份没丢、也从未依赖这一步：hub 的 out-0/out-1（AI 总结/我的总结）与
// user 的 AI/手写回答口，在建点/拖拽时就由 portMeta 把身份落定了，连线层只是
// 把已有的点连起来。Φ 的 add_edge（harness-apply.js）本就不经 _canConnect、
// 联系线模式（graph-custom.js）向来任意两节点仅禁自连——手动结构连线此前比
// 另两条都严，现在对齐同一红线。
// fromPort 形参保留仅为调用点签名对称（连线不再看端口）。
// 自连保留拦截：自环没有语义，且输入侧没有可挂的端口。
function _canConnect(fromNode, fromPort, toNode) {
  return !!fromNode && !!toNode && fromNode.id !== toNode.id;
}

function _flashInvalidConnection() {
  if (!graphCanvas) return;
  graphCanvas.classList.remove('invalid-link');
  void graphCanvas.offsetWidth;
  graphCanvas.classList.add('invalid-link');
  setTimeout(() => graphCanvas.classList.remove('invalid-link'), 500);
}

function _nodeActions(node) {
  if (node.kind === 'answer' && !node.manual && node.messageIndex < 0) return '';
  if (node.messageIndex < 0 && (node.manual || node.kind === 'hub')) return '';
  if (node.messageIndex < 0) {
    const isBusy = !!node.busy;
    const label = isBusy ? '生成中...' : node.content ? '重新生成' : '生成';
    return '<div class="graph-node-actions">'
      + _iconRegenButton('runWorkflowNode(\'' + node.id + '\',' + (node.content ? 'true' : 'false') + ')', isBusy ? '生成中...' : (node.content ? '重新生成' : '生成'), isBusy)
      + '</div>';
  }
  if (node.kind === 'module' && node.moduleKey !== 'socratic') {
    if (node.moduleKey === 'viz') {
      const messages = _getChatHistory();
      const message = messages[node.messageIndex];
      const vizContent = _nodeContent(message, node);
      const hasVisualization = typeof _hasVisualizationHtml === 'function' && _hasVisualizationHtml(vizContent);
      if (!hasVisualization) {
        // T58：可视化生成中置灰（_generatingVizNodes 在 graph-interact.js 顶层，
        // 经全局词法环境可见；typeof 守卫兜沙箱/加载序）
        const vizBusy = typeof _generatingVizNodes !== 'undefined' && _generatingVizNodes.has(node.id);
        return '<div class="graph-node-actions">'
          + _iconRegenButton('generateVizNode(\'' + node.id + '\')', vizBusy ? '生成中...' : '生成可视化', vizBusy)
          + '</div>';
      }
    }
    const label = node.moduleKey === 'graph' ? '重新生成' : '没看懂';
    // T58：主回答生成中「没看懂/重新生成」置灰（发送走排队，但按钮先给出可见状态）
    const regenBusy = typeof isStreaming !== 'undefined' && isStreaming;
    return '<div class="graph-node-actions">'
      + _iconRegenButton('graphOpenRegenerate(\'' + node.id + '\')', label, regenBusy)
      + '</div>';
  }
  return '';
}

function _shortLabel(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function _regenIconHtml() {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>';
}

function _iconRegenButton(onclick, title, disabled) {
  return '<button class="graph-regen-btn graph-icon-btn" onclick="' + onclick + '" title="' + escapeHtml(title) + '"' + (disabled ? ' disabled' : '') + '>' + _regenIconHtml() + '</button>';
}

function _parsePortQuestions(content, withLevel) {
  const items = [];
  const re = /(?:^|\n)\s*(?:[-*+]|\d+[.)])\s*(?:\[([^\]]+)\])?\s*([^\n]+)/g;
  let match;
  while ((match = re.exec(content || '')) && items.length < 12) {
    const rawLevel = (match[1] || '').trim();
    const question = (match[2] || '').trim();
    if (!question) continue;
    if (withLevel && !/^(基础|进阶|拓展)/.test(rawLevel)) continue;
    items.push({
      question,
      level: /^基础/.test(rawLevel) ? 'basic' : /^进阶/.test(rawLevel) ? 'advanced' : 'expand',
    });
  }
  return items;
}

function _moduleOutputPorts(node, message) {
  const content = _nodeContent(message, node) || '';
  // 节点配方（P1 静态＋P2 动态）：配方出口表优先；底座为 module 时不再走内置默认表。
  // 动态出口（ports.dynamic）按声明从正文解析编号行，解析失败按 fallback 兜底
  // （label_questions_from_text 模式下兜底端口带从正文截的问题文本，治 T56）。
  if (node.recipeId) {
    const recipePorts = typeof _recipeStaticPorts === 'function' ? _recipeStaticPorts(node) : [];
    const dynPorts = (typeof _recipeDynamicPorts === 'function' && node.recipe && node.recipe.ports && node.recipe.ports.dynamic)
      ? _recipeDynamicPorts(node, content)
      : [];
    if (recipePorts.length || dynPorts.length) return recipePorts.concat(dynPorts);
    if ((node.recipe && node.recipe.base && node.recipe.base.kind) === 'module') return [];
  }
  if (node.moduleKey === 'socratic') {
    const questions = _parsePortQuestions(content, true);
    if (!questions.length) {
      return ['问题1', '问题2', '问题3'].map((label, index) => ({
        label,
        type: 'socratic',
        branchType: 'socratic',
        attribute: 'socratic',
        question: '',
        level: index === 0 ? 'basic' : index === 1 ? 'advanced' : 'expand',
      }));
    }
    return questions.map((item, index) => ({
      label: '问题' + (index + 1),
      type: 'socratic',
      branchType: 'socratic',
      attribute: 'socratic',
      question: item.question,
      level: item.level || (index === 0 ? 'basic' : index === 1 ? 'advanced' : 'expand'),
    }));
  }
  if (node.moduleKey === 'learn') {
    const directions = _parsePortQuestions(content, false);
    if (!directions.length) {
      return ['进阶方向 1', '进阶方向 2', '进阶方向 3'].map(label => ({
        label,
        type: 'learn',
        branchType: 'learn',
        attribute: 'learn',
        question: '',
      }));
    }
    return directions.map(item => ({
      label: _shortLabel(item.question, 12),
      type: 'learn',
      branchType: 'learn',
      attribute: 'learn',
      question: item.question,
    }));
  }
  const defaults = GRAPH_MODULE_DEFAULT_OUTPUTS[node.moduleKey] || ['追问'];
  return defaults.map(label => ({
    label,
    type: 'branch',
    branchType: label === '没看懂' ? 'confused' : label === '直接问AI' ? 'continue' : 'followup',
    attribute: node.moduleKey,
    question: '',
  }));
}

function _draftPrefill(meta) {
  if (meta.type === 'custom' || !meta.sourceModule) return meta.question || '';
  if (meta.type === 'confused' && typeof _modulePrompt === 'function') {
    return _modulePrompt(meta.sourceModule, 'confused', meta.question || '当前问题');
  }
  if (meta.branchType === 'followup' && typeof _modulePrompt === 'function') {
    return _modulePrompt(meta.sourceModule, 'followup', meta.question || '当前问题');
  }
  return meta.question || '';
}

function _renderDraftNodeHtml(node) {
  const meta = node.portMeta || {};
  const attr = _nodeAttribute(node);
  const isSocratic = meta.type === 'socratic';
  const isLearn = meta.type === 'learn';
  let body = '';
  if (isSocratic) {
    body = '<div class="graph-draft-body socratic">'
      + '<div class="graph-draft-question">' + escapeHtml(meta.question || '') + '</div>'
      + '<div class="graph-draft-actions graph-socratic-actions">'
      + '<button class="graph-draft-btn graph-socratic-btn graph-socratic-answer" onclick="draftSocraticAnswer(\'' + node.id + '\')">我来回答</button>'
      + '<button class="graph-draft-btn graph-socratic-btn graph-socratic-ai" onclick="draftAskAi(\'' + node.id + '\')">直接问AI</button>'
      + '</div></div>';
  } else {
    // T152：草稿输入的真身在节点对象（draftInput，输入即写回、随重渲存活），
    // textarea 只是视图——有 draftInput 时（含用户主动清空的空串）不再回落
    // 端口预填，否则一次全量重渲就把已打的字顶回预填
    const prefill = typeof node.draftInput === 'string'
      ? node.draftInput
      : (isLearn
        ? '请详细讲解：' + (meta.question || '')
        : _draftPrefill(meta));
    body = '<div class="graph-draft-body">'
      + '<textarea class="graph-draft-input" rows="3" oninput="draftInputChanged(\'' + node.id + '\', this.value)">' + escapeHtml(prefill) + '</textarea>'
      + '<button class="graph-draft-btn graph-draft-send" onclick="submitDraftQuestion(\'' + node.id + '\')">发送提问</button>'
      + '</div>';
  }
  const label = isSocratic ? '苏格拉底问题' : isLearn ? '进阶学习' : '提问节点';
  return '<div class="graph-node graph-node-draft graph-node-branch graph-attr-' + attr.key + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';">'
    + _renderInputPorts(node)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span><span class="graph-node-badge">' + label + '</span>'
    + '<button class="graph-draft-close" onclick="removeDraftNode(\'' + node.id + '\')" title="取消">×</button></div>'
    + body
    + '</div></div>';
}

function _nodeInputLabel(node) {
  if (node.recipeId && node.recipe && node.recipe.name) return node.recipe.name;
  if (node.kind === 'human_note') return '任意输入';
  if (node.kind === 'answer') return node.manual ? '我的回答' : '问题分析';
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
  if (node.kind === 'blank') return '任意输入';
  if (node.kind === 'hub') return '汇聚输入';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'note') return '我的总结';
  if (node.kind === 'user') return '任意输入';
  if (node.kind === 'source') return '文件输入';
  if (node.kind === 'knowledge') return '知识点来源';
  if (node.kind === 'relation') return '联系输入';
  return '来源';
}

// T266：输入端口身份（label/type）的单一事实源——具名声明（配方 ports.inputs）
// 优先，模块节点第 2 个起的附加匿名口叫「人工内容输入」，其余回落节点品类标签。
// 渲染输入口与输出口「待命名」继承（_adoptedOutputPortMeta）共用它，保证端口上
// 显示的名字与连线继承来的名字永远同一个口径。
function _nodeInputPortMeta(node, portIndex) {
  const declared = (node && node.kind === 'module' && typeof _recipeInputPorts === 'function')
    ? _recipeInputPorts(node)
    : [];
  const named = declared[portIndex];
  if (named) return { label: named.label, type: named.type || '' };
  const label = (node && node.kind === 'module' && portIndex >= 1)
    ? '人工内容输入'
    : _nodeInputLabel(node);
  return { label, type: '' };
}

// 端口机制统一（2026-10-10）：每类节点的基础（身份）出口表——唯一事实源。
// _renderOutputPorts 渲染、_nodeOutputLabels 取名、_nodeOutputCount 计数、
// graph-interact 增删口的基数全部走这里；附加口（用户「＋」出的匿名口）不在
// 表内，由 portCounts 记账、渲染时接在表后（T266 待命名态）。改某类节点的
// 出口身份只改这里，别在渲染/守卫里另写分支。
function _nodeBaseOutputPorts(node, messages) {
  if (!node || node.kind === 'draft') return [];
  if (node.kind === 'user') {
    return [
      { label: '问题分析', type: 'answer', branchType: '', attribute: 'answer', group: 'ai', question: '' },
      { label: '我的回答', type: 'manual', branchType: 'manual', attribute: 'manual', group: 'manual', question: '' },
    ];
  }
  if (node.kind === 'blank') {
    return [{
      label: '追问',
      type: 'branch',
      branchType: 'followup',
      attribute: node.moduleKey || 'followup',
      question: '',
    }];
  }
  if (node.kind === 'human_note') {
    return [{
      label: '人工内容',
      type: 'custom',
      branchType: '',
      attribute: 'human_note',
      group: 'human',
      question: '',
    }];
  }
  if (node.kind === 'answer') {
    // 配方节点（manual 底座）：声明了静态出口就替代默认 6 出口
    const recipePorts = node.recipeId && typeof _recipeStaticPorts === 'function' ? _recipeStaticPorts(node) : [];
    return recipePorts.length ? recipePorts : _answerOutputPorts(node, messages);
  }
  if (node.kind === 'module') return _moduleOutputPorts(node, messages[node.messageIndex]);
  if (node.kind === 'source') {
    return (node.items || []).map((item, index) => ({
      label: item.title || '知识点 ' + (index + 1),
      type: 'knowledge',
      branchType: '',
      attribute: 'knowledge',
      group: 'knowledge',
      question: '',
      item: item,
    }));
  }
  if (node.kind === 'knowledge') return _knowledgeOutputPorts(node);
  if (node.kind === 'hub') {
    return [{
      label: 'AI 总结',
      type: 'branch',
      branchType: 'summary',
      attribute: 'summary',
      question: '',
    }, {
      label: '我的总结',
      type: 'branch',
      branchType: 'note',
      attribute: 'note',
      question: '',
    }, {
      label: '追问',
      type: 'branch',
      branchType: 'followup',
      attribute: 'question',
      question: '',
    }];
  }
  // summary/note/relation：基础出口 0（开放附加口后输出列只挂＋号）；其余
  // 未知 kind（ai_eval 等）回落单个「输出」口，与统一前的兜底逐字节一致
  if (node.kind === 'summary' || node.kind === 'note' || node.kind === 'relation') return [];
  return [{
    label: '输出',
    type: 'branch',
    branchType: 'followup',
    attribute: 'followup',
    question: '',
  }];
}

function _nodeOutputLabels(node, messages) {
  return _nodeBaseOutputPorts(node, messages).map(item => item.label);
}

function _answerOutputPorts(node, messages) {
  return ANSWER_OUTPUT_SCHEMA.map(key => ({
    label: (GRAPH_MODULE_META[key] || {}).label || key,
    type: 'branch',
    branchType: 'followup',
    attribute: key,
    question: '',
  }));
}

function _knowledgeOutputPorts(node) {
  return [
    { label: '问题分析', type: 'answer', branchType: '', attribute: 'answer', group: 'ai', question: '' },
    { label: '问题', type: 'branch', branchType: 'followup', attribute: 'question', group: 'question', question: '' },
  ];
}

function _nodeOutputCount(node, messages, state) {
  // 端口机制统一：总量＝max(基础口数, portCounts 存量)——portCounts 是绝对
  // 口径（存的是总口数，见 graph-interact 的加口公式），与 inputPortCounts
  // 的附加口径不同，别混
  if (node.kind === 'draft') return 0;
  const base = _nodeBaseOutputPorts(node, messages).length;
  const saved = (state && state.portCounts && state.portCounts[node.id]) || 0;
  return Math.max(base, saved);
}

function _renderInputPorts(node, state) {
  const attr = _nodeAttribute(node);
  if (node.kind === 'source') return '';
  const savedCount = state && state.inputPortCounts && state.inputPortCounts[node.id]
    ? state.inputPortCounts[node.id]
    : 0;
  // 端口机制统一（2026-10-10）：加输入口的权限走统一门（graph.js），常驻节点
  // 一律「基础口＋附加口」；附加口由 inputPortCounts 记账（附加数口径）。官方
  // 模块与配方模块同权——此前官方模块右键能加、卡上不出＋号的不一致就此对齐
  const canAddInput = _nodeCanAddInputPorts(node);
  // 具名输入端口（T263）：声明了就替换默认匿名口，顺序＝端口索引；旧快照无声明回落原样
  const declared = (node.kind === 'module' && typeof _recipeInputPorts === 'function')
    ? _recipeInputPorts(node)
    : [];
  const typeLabels = typeof RECIPE_PORT_TYPE_LABELS !== 'undefined' ? RECIPE_PORT_TYPE_LABELS : {};
  // isRoot 只标在根 answer 卡（graph.js 建图时落），其基础输入口为 0
  const baseCount = node.isRoot ? 0 : _nodeBaseInputPortCount(node);
  const count = canAddInput
    ? baseCount + savedCount
    : (node.isRoot ? 0 : 1);
  let html = '<div class="graph-port-col graph-input-col">';
  const isAnyInput = node.kind === 'user' || node.kind === 'human_note' || node.kind === 'blank' || node.kind === 'knowledge';
  for (let i = 0; i < count; i++) {
    const named = declared[i] || null;
    const inputMeta = _nodeInputPortMeta(node, i);
    const label = inputMeta.label;
    const typeKey = inputMeta.type;
    const typeLabel = typeKey ? (typeLabels[typeKey] || '') : '';
    const anyClass = isAnyInput ? ' graph-port-any-input' : '';
    const portAttr = (canAddInput || isAnyInput) ? 'any' : attr.key;
    const portColor = isAnyInput ? 'var(--node-any)' : attr.color;
    const canRemove = canAddInput && i >= baseCount;
    const portTitle = named
      ? '输入「' + label + '」' + (typeLabel ? '（' + typeLabel + '）' : '') + '：可连接任意来源（类型仅作标注）'
      : (node.kind === 'user' || node.kind === 'human_note' || node.kind === 'knowledge' ? '任意输入端口：可连接任意来源' : '输入端口：拖到右侧输出可重连来源');
    html += '<div class="graph-port graph-input-port' + anyClass + '" data-node-id="' + node.id + '" data-port-id="in-' + i + '" data-attribute="' + portAttr + '"'
      + (named ? ' data-port-label="' + encodeURIComponent(label) + '"' + (typeKey ? ' data-port-type="' + typeKey + '"' : '') : '')
      + ' style="--port-color:' + portColor + ';" title="' + escapeHtml(portTitle) + '">'
      + '<span class="graph-port-dot"></span><span class="graph-port-label">' + escapeHtml(label) + '</span>'
      + (typeLabel ? '<span class="graph-port-type" data-port-type="' + typeKey + '">' + escapeHtml(typeLabel) + '</span>' : '')
      + (canRemove
        ? '<button class="graph-port-remove" onclick="event.stopPropagation();graphRemoveInputPort(\'' + node.id + '\',' + i + ')" title="删除输入端口">×</button>'
        : '')
      + '</div>';
  }
  if (canAddInput) {
    html += '<button class="graph-add-port-btn graph-add-input-btn" onclick="event.stopPropagation();graphAddInputPort(\'' + node.id + '\')" title="添加输入端口">+</button>';
  }
  html += '</div>';
  return html;
}

// T266：输出端口「待命名」态。匿名附加输出口（＋手动加出来、由渲染兜底的那些）
// 未连线时保持空白；连上某个输入口后实时采用该输入口的 label/type。身份由连线
// 本身派生、不新增持久化字段——旧图、查看器快照、Φ add_edge、撤销重做全部零
// 迁移自动生效，断开即回空白。查的是 graphView.edges（已解析的自定义＋结构边），
// 与画布上真正画出来的线一致。基本口（内置身份口/配方声明口）不参与——它们的
// 身份在建点/拖拽时就由 portMeta 定死了（见 canvas 手册「端口身份本就在建点时定」）。
function _adoptedOutputPortMeta(node, portIndex) {
  if (!node || typeof graphView === 'undefined' || !graphView || !Array.isArray(graphView.edges)) return null;
  const portId = 'out-' + portIndex;
  const edge = graphView.edges.find(item =>
    String(item.from) === String(node.id) && String(item.fromPort || 'out-0') === portId);
  if (!edge) return null;
  const toNode = graphView.nodeById ? graphView.nodeById[String(edge.to)] : null;
  if (!toNode) return null;
  const meta = _nodeInputPortMeta(toNode, parseInt(String(edge.toPort || 'in-0').replace('in-', ''), 10) || 0);
  return { label: meta.label, type: meta.type, targetId: edge.to };
}

function _renderOutputPorts(node, messages, state) {
  if (node.kind === 'draft') return '';
  // 端口机制统一（2026-10-10）：基础口走 _nodeBaseOutputPorts 唯一事实源，
  // 加口权限走统一门（graph.js _nodeCanAddOutputPorts）。summary/note/relation
  // 基础口为 0 但已开放附加口——无附加口时输出列也渲染（只挂＋号），
  // 「数量为 0 且不可加」才整列免渲染
  const ports = _nodeBaseOutputPorts(node, messages);
  const canAddPort = _nodeCanAddOutputPorts(node);
  const savedCount = (state && state.portCounts && state.portCounts[node.id]) || 0;
  const count = Math.max(ports.length, savedCount);
  if (count <= 0 && !canAddPort) return '';
  let html = '<div class="graph-port-col graph-output-col">';
  const typeLabels = typeof RECIPE_PORT_TYPE_LABELS !== 'undefined' ? RECIPE_PORT_TYPE_LABELS : {};
  for (let i = 0; i < count; i++) {
    // T266：匿名附加输出口的「待命名」态——未连线空白，连线后采用目标输入口的
    // 名字与内容类型（_adoptedOutputPortMeta 从 graphView.edges 现算，断开即回空白）；
    // 基本口（ports[i] 有值）一律保持建点时定死的身份，不参与
    const adopted = ports[i] ? null : _adoptedOutputPortMeta(node, i);
    const meta = ports[i] || {
      label: adopted ? adopted.label : '',
      type: (adopted && adopted.type)
        ? adopted.type
        : node.kind === 'source' ? 'knowledge' : node.kind === 'knowledge' ? 'branch' : 'custom',
      branchType: 'followup',
      attribute: node.recipeId ? 'recipe' : node.kind === 'source' ? 'knowledge' : node.kind === 'knowledge' ? 'question' : 'followup',
      question: '',
      custom: true,
    };
    const label = meta.label || '未命名';
    const blankClass = meta.label ? '' : ' graph-port-label-blank';
    const attr = GRAPH_NODE_ATTRIBUTES[meta.attribute] || GRAPH_NODE_ATTRIBUTES.followup;
    // 类型徽标与输入口同源（RECIPE_PORT_TYPE_LABELS）：内置口的 branch/socratic 等
    // 内部类型不在表内不挂徽标，只有配方内容类型（文本/公式/图示/网页）才显示
    const typeKey = (meta.type && typeLabels[meta.type]) ? meta.type : '';
    const typeLabel = typeKey ? (typeLabels[typeKey] || '') : '';
    const portTitle = meta.custom
      ? (adopted
        ? '输出「' + label + '」：名字与类型来自所连输入端口；拖到空处创建提问节点，或拖到输入端口重连'
        : '未命名的输出端口：连到某个输入端口后，将采用该端口的名字与类型；拖到空处创建提问节点')
      : '输出端口：拖到空处创建提问节点，或拖到输入端口重连';
    html += '<div class="graph-port graph-output-port" data-node-id="' + node.id + '" data-port-id="out-' + i + '"'
      + ' data-port-type="' + (meta.type || 'branch') + '"'
      + ' data-port-branch="' + (meta.branchType || 'followup') + '"'
      + ' data-attribute="' + attr.key + '"'
      + ' data-port-question="' + encodeURIComponent(meta.question || '') + '"'
      + ' data-port-level="' + (meta.level || '') + '"'
      + ' data-port-label="' + encodeURIComponent(label) + '"'
      + ' data-port-group="' + (meta.group || '') + '"'
      + (meta.dragCreates ? ' data-port-drag="' + encodeURIComponent(meta.dragCreates) + '"' : '')
      + (meta.item ? ' data-port-item="' + encodeURIComponent(JSON.stringify(meta.item)) + '"' : '')
      + ' style="--port-color:' + attr.color + ';"'
      + ' title="' + escapeHtml(portTitle) + '">'
      // 圆点必须是行内首个子元素：输出列左对齐（点对齐、文字参差），删除键跟在文字后，
      // 否则 row-reverse 老顺序下带 × 的端口圆点会被顶偏，一列里两种点位
      + '<span class="graph-port-dot"></span>'
      + '<span class="graph-port-label' + blankClass + '">' + escapeHtml(label) + '</span>'
      + (typeLabel ? '<span class="graph-port-type" data-port-type="' + typeKey + '">' + escapeHtml(typeLabel) + '</span>' : '')
      + (meta.custom
        ? '<button class="graph-port-remove" onclick="event.stopPropagation();graphRemoveOutputPort(\'' + node.id + '\',' + i + ')" title="删除输出端口">×</button>'
        : '')
      + '</div>';
  }
  if (canAddPort) {
    html += '<button class="graph-add-port-btn" onclick="event.stopPropagation();graphAddOutputPort(\'' + node.id + '\')" title="添加输出端口">+</button>';
  }
  html += '</div>';
  return html;
}

function _renderBlankNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const meta = GRAPH_MODULE_META[node.moduleKey] || { label: node.moduleKey || 'AI 生成空白', color: attr.color };
  const attrClass = ' graph-attr-' + attr.key;
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const busyClass = node.busy ? ' graph-blank-busy' : '';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  const content = _cleanBlankNodeContent(node, node.content || '');
  // T69：折叠卡不建内容子树（renderMarkdown/KaTeX 全免），展开时整卡重建
  const contentHtml = node.minimized
    ? _minimizedBodyHtml()
    : (content
      ? '<div class="graph-blank-content">' + (typeof renderMarkdown === 'function' ? renderMarkdown(content, { parentId: String(node.timestamp || ''), sourceModule: node.moduleKey }) : escapeHtml(content)) + '</div>'
      : '');
  const generateLabel = content ? '重新生成' : '生成';
  const deleteBtn = '<button class="graph-node-delete-toggle" onclick="deleteBlankNode(\'' + node.id + '\')" title="删除空白节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  const pendingClass = _graphNodePending(node) ? ' graph-node-pending' : '';
  return '<div class="graph-node graph-node-blank graph-node-module graph-module-' + node.moduleKey + attrClass + selectedClass + busyClass + minimizedClass + pendingClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span><span class="graph-node-badge">AI 生成</span>' + _graphMinimizeToggleHtml(node) + deleteBtn + '</div>'
    + '<div class="graph-node-label">' + escapeHtml(meta.label) + '</div>'
    + contentHtml
    + (node.minimized ? '' : (content ? '' : '<div class="graph-blank-hint">连上游（可选）→ 写要求 → 点生成</div>')
    + '<div class="graph-blank-requirement">'
    + '<textarea class="graph-blank-input" rows="2" placeholder="写要求，例如：写一个反例 / 用比喻解释 / 整理时间线" ' + (node.busy ? 'disabled' : '') + '>' + escapeHtml(node.requirements || '') + '</textarea>'
    + _iconRegenButton('generateBlankNode(\'' + node.id + '\')', node.busy ? '生成中' : generateLabel, node.busy)
    + '</div>')
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _cleanBlankNodeContent(node, rawContent) {
  const text = String(rawContent || '');
  if (typeof parseXmlSections === 'function') {
    const sections = parseXmlSections(text);
    if (sections && sections[node.moduleKey]) return _stripModuleHeading(sections[node.moduleKey], node.moduleKey);
    if ((node.moduleKey === 'socratic' || node.moduleKey === 'learn') && sections && sections.extend) {
      const split = _splitExtendSections(sections.extend);
      if (split[node.moduleKey]) return _stripModuleHeading(split[node.moduleKey], node.moduleKey);
    }
  }
  return text;
}

function _renderCustomNodeContentHtml(node) {
  let text = String(node.kind === 'answer' && !node.manual ? (node.analysis || node.content || '') : (node.content || ''));
  // 问题分析末尾的「建议模块：…」是内部控制行（_parseSuggestedModules 的解析依据），
  // 不渲染给用户；渲染时剥，存量图的 analysis 同覆盖，node.analysis 原字段不动
  if (node.kind === 'answer' && !node.manual && typeof stripSuggestedModulesLine === 'function') {
    text = stripSuggestedModulesLine(text);
  }
  if (node.kind === 'module') text = _cleanBlankNodeContent(node, text);
  else if ((node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note') && typeof stripXmlTags === 'function') text = stripXmlTags(text);
  // 配方载体分派（P1 plain / P2 mermaid·html_iframe）：plain 不解析 Markdown、
  // 纯转义渲染（human_note 同口径）；mermaid / html_iframe 不在此分叉——生成侧
  // 已把内容归一成 ```mermaid / ```html 代码块，renderMarkdown 会分派到现成渲染器
  // （viz 卡走 _initVizIframes，mermaid 走 renderMermaidInElement）
  if (node.recipeId && node.recipe && node.recipe.content_kind === 'plain') {
    return '<div class="graph-custom-node-render">' + escapeHtml(text) + '</div>';
  }
  if (typeof renderMarkdown === 'function') {
    // 传 parentId：自定义节点内容里的苏格拉底“我来回答”按钮需要能解析回父节点，
    // 否则回答生成的新节点会成为无连线的孤儿（_findCustomBranchParent 按 timestamp 匹配）。
    return renderMarkdown(text, { parentId: String(node.timestamp || ''), sourceModule: node.moduleKey || '' });
  }
  return escapeHtml(text);
}

function _refreshWorkflowNodeUi(node) {
  if (!node || !graphInner) return;
  const currentEl = graphInner.querySelector('[data-node-id="' + node.id + '"]');
  if (!currentEl) return;
  const nextHtml = _renderNodeHtml(node, _getChatHistory(), _graphState());
  const temp = document.createElement('div');
  temp.innerHTML = nextHtml;
  const nextEl = temp.firstElementChild;
  if (nextEl) {
    currentEl.replaceWith(nextEl);
    if (typeof _initVizIframes === 'function') _initVizIframes(nextEl);
    if (typeof renderMath === 'function') renderMath(nextEl);
    // mermaid 渲染（官方知识图谱模块＋P2 配方 mermaid 载体）：正文代码块要先经
    // renderMarkdown 变成 .mermaid 占位，再异步解析成 SVG
    const isMermaidNode = node && node.kind === 'module'
      && (node.moduleKey === 'graph' || (node.recipeId && node.recipe && node.recipe.content_kind === 'mermaid'));
    if (isMermaidNode && typeof renderMermaidInElement === 'function') {
      setTimeout(() => { renderMermaidInElement(nextEl).catch(() => {}); }, 60);
    }
    _measureNodes();
    _updateNodeTransforms();
    _redrawEdges();
  }
}

function _customNodeStatusText(node) {
  if (node.kind === 'ai_eval') {
    return node.status === 'applied' ? '已采纳' : '待采纳';
  }
  if (node.kind === 'source') {
    if (node.busy || node.status === 'running') return '解析中';
    return node.items && node.items.length ? '已解析' : '待解析';
  }
  if (node.kind === 'knowledge') {
    if (node.busy || node.status === 'running') return '生成中';
    return (node.content || '').trim() ? '已填写' : '待填写';
  }
  if (node.kind === 'relation') {
    if (node.busy || node.status === 'running') return '生成联系中';
    return (node.content || '').trim() ? '已编辑' : '待编辑';
  }
  if (node.kind === 'hub') {
    const connected = (graphView.edges || []).some(edge => edge.to === node.id && !edge.draft);
    return connected ? '已汇聚' : '等待连接';
  }
  if (node.manual) return (node.content || '').trim() ? '完成' : '待填写';
  if (node.kind === 'answer' && !node.manual && node.messageIndex < 0) {
    if (node.busy || node.status === 'running') return '分析中';
    return '分发';
  }
  if (node.busy || node.status === 'running') return '生成中';
  if (node.status === 'blocked') return '上游缺失';
  if (node.status === 'waiting') return '等待输入';
  if (node.status === 'error') return '失败';
  if (node.status === 'done' || ((node.content || '').trim() && !node.status)) return '完成';
  return '待生成';
}

// 状态徽章。blocked 是任务列表带来的新状态（用户 2026-09-27 拍板 #10）：它上游的节点
// 被停掉或失败了，内容永远凑不齐——徽章只放得下四个字，完整说法挂在 title 上。
function _customNodeStatusHtml(node, force) {
  if (!node) return '';
  if (!force && node.messageIndex >= 0) return '';
  const statusText = _customNodeStatusText(node);
  if (!statusText) return '';
  const stateKey = node.busy ? 'running' : (node.status || 'empty');
  const title = stateKey === 'blocked' ? ' title="上游缺失，无法生成"' : '';
  return '<span class="graph-node-status status-' + stateKey + '"' + title + '>' + escapeHtml(statusText) + '</span>';
}

function _canMinimizeGraphNode(node) {
  if (!node) return false;
  if (node.kind === 'draft' || node.kind === 'ai_eval' || node.kind === 'relation') return false;
  if (node.kind === 'blank' || node.kind === 'source' || node.kind === 'knowledge' || node.kind === 'human_note') return true;
  return node.kind === 'module' || node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note' || node.kind === 'hub';
}

function _graphMinimizeToggleHtml(node) {
  if (!_canMinimizeGraphNode(node)) return '';
  return '<button class="graph-node-minimize-toggle" onclick="graphModuleAction(\'minimize\',\'' + node.id + '\')" title="' + (node.minimized ? '展开' : '最小化') + '">' + (node.minimized ? '+' : '−') + '</button>';
}

// 还没出内容的大卡（空白/模块/总结/汇聚）先按内容收缩，出内容后再撑回原尺寸。
// 与 graph-override.css「第 7 轮 7.2」配套；用户手动拖过尺寸的节点走内联样式，不受影响。
function _graphNodePending(node) {
  if (!node || node.messageIndex >= 0) return false;
  if (node.busy || node.status === 'running') return false;
  if (!['blank', 'module', 'summary', 'note', 'hub'].includes(node.kind)) return false;
  return !(String(node.content || '').trim() || String(node.analysis || '').trim() || String(node.summary || '').trim());
}

function _customNodeHeaderHtml(node, attr, extraButtons) {
  const sub = _nodeSub(node);
  const statusHtml = _customNodeStatusHtml(node);
  return '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span>'
    + (sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '')
    + statusHtml
    + _graphMinimizeToggleHtml(node)
    + (extraButtons || '')
    + '<button class="graph-node-delete-toggle" onclick="deleteCustomNode(\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>'
    + '</div>';
}

function _renderSourceNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : (node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '');
  const fileName = node.fileName ? '<div class="graph-source-filename">' + escapeHtml(node.fileName) + '</div>' : '';
  const itemCount = node.items && node.items.length ? '<div class="graph-source-count">' + node.items.length + ' 个知识点</div>' : '';
  // T69：折叠卡不建表单/内容子树，展开时整卡重建
  const body = node.minimized ? _minimizedBodyHtml() : (node.busy
    ? '<div class="graph-source-busy"><span class="graph-source-spinner"></span>正在解析文件...</div>'
    : '<div class="graph-source-body" ondragover="event.preventDefault();this.classList.add(\'graph-source-drag\')" ondragleave="this.classList.remove(\'graph-source-drag\')" ondrop="handleSourceNodeDrop(event,\'' + node.id + '\')">'
      + '<label class="graph-source-file-btn">选择/拖入文件<input type="file" class="graph-source-file-input" onchange="handleSourceNodeFile(this,\'' + node.id + '\')"></label>'
      + '<textarea class="graph-source-text-input" rows="2" placeholder="或直接粘贴文本/题目/讲义内容..."></textarea>'
      + '<button type="button" class="graph-source-paste-btn" onclick="pasteSourceNodeText(\'' + node.id + '\')">粘贴文本解析</button>'
      + '<div class="graph-source-controls"><label>最多 <input type="number" class="graph-source-max-input" min="1" max="50" value="' + (node.maxItems || 5) + '" onchange="updateSourceNodeMax(\'' + node.id + '\',this.value)"></label>'
      + (node.fileId ? _iconRegenButton('reparseSourceNode(\'' + node.id + '\')', '重新解析', false) : '')
      + (node.items && node.items.length ? '<button type="button" class="graph-source-organize-btn" onclick="openHarnessOrganizeRelations(\'' + node.id + '\')">🤖 AI 整理关系</button>' : '')
      + '</div>' + fileName + itemCount
      + '</div>');
  return '<div class="graph-node graph-node-source graph-attr-source' + selectedClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + _customNodeHeaderHtml(node, attr, '')
    + '<div class="graph-node-label">输入</div>'
    + (body ? '<div class="graph-node-full-content">' + body + '</div>' : '')
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _renderKnowledgeNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : (node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '');
  // T69：折叠卡跳公式 KaTeX 与表单（展开时整卡重建）
  const formulas = node.minimized ? '' : ((node.formulas || []).slice(0, 4).map(f => {
    const latex = String(f || '').replace(/^\$+|\$+$/g, '').trim();
    let latexHtml = escapeHtml(latex);
    try {
      if (window.katex) latexHtml = katex.renderToString(latex, { throwOnError: false, displayMode: false });
    } catch (e) {}
    return '<div class="graph-knowledge-formula">' + latexHtml + '</div>';
  }).join(''));
  const body = node.minimized ? _minimizedBodyHtml() : ('<div class="graph-knowledge-body">'
    + (formulas ? '<div class="graph-knowledge-formulas">' + formulas + '</div>' : '')
    + '<textarea class="graph-custom-node-content" rows="3" onchange="updateCustomNodeContent(\'' + node.id + '\',this.value)">' + escapeHtml(node.content || node.summary || '') + '</textarea>'
    + '<div class="graph-knowledge-actions">' + _iconRegenButton('generateKnowledgeNode(\'' + node.id + '\')', node.busy ? '生成中' : '重新生成', node.busy) + '</div>'
    + '</div>');
  return '<div class="graph-node graph-node-knowledge graph-attr-knowledge' + selectedClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + _customNodeHeaderHtml(node, attr, '')
    + '<div class="graph-node-label">' + escapeHtml(node.title || '知识点') + '</div>'
    + '<div class="graph-node-full-content">' + body + '</div>'
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _renderRelationNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const sizeStyle = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const statusHtml = _customNodeStatusHtml(node, true);
  const body = '<div class="graph-relation-body">'
    + '<textarea class="graph-custom-node-content" rows="2" onchange="updateCustomNodeContent(\'' + node.id + '\',this.value)" placeholder="联系说明">' + escapeHtml(node.content || '') + '</textarea>'
    + '<div class="graph-relation-actions">'
    + statusHtml
    + _iconRegenButton('generateRelationNode(\'' + node.id + '\')', node.busy ? '生成中' : '生成联系', node.busy)
    + '</div></div>';
  return '<div class="graph-node graph-node-relation graph-attr-relation graph-node-compact' + selectedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-full-content">' + body + '</div>'
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _renderHumanNoteNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const statusText = (node.content || '').trim() ? '已填写' : '待填写';
  // T69：折叠卡不建内容子树，展开时整卡重建
  const body = node.minimized ? _minimizedBodyHtml() : ((node.content || node.formula)
    ? '<div class="graph-custom-node-render">' + escapeHtml(node.content || '')
      + (node.formula ? '<div class="graph-human-note-formula">' + escapeHtml(node.formula) + '</div>' : '')
      + '</div>'
    : '<div class="graph-custom-node-empty">双击编辑</div>');
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  return '<div class="graph-node graph-node-human-note graph-attr-human_note' + selectedClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header">'
    + '<span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">我的理解</span>'
    + '<span class="graph-node-badge">人工</span>'
    // 三个按钮包一层：窄卡（260–340）里头部必然折行，整组一起折才不至于剩一个删除键孤零零挂在第二行
    + '<span class="graph-node-head-actions">'
    + _graphMinimizeToggleHtml(node)
    + '<button class="graph-node-edit-toggle" onclick="editHumanNoteNode(\'' + node.id + '\')" title="编辑我的理解"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
    + '<button class="graph-node-delete-toggle" onclick="deleteCustomNode(\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>'
    + '</span>'
    + '</div>'
    + '<div class="graph-node-label">' + escapeHtml(node.label || '我的理解') + '</div>'
    + '<div class="graph-node-sub">' + escapeHtml(statusText) + '</div>'
    + (body ? '<div class="graph-node-full-content">' + body + '</div>' : '')
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state)
    + '</div>';
}

function _renderAiEvalNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const targetLabel = node.target_label || node.label || '目标节点';
  const priorityMap = { high: '高优先级', medium: '中优先级', low: '低优先级' };
  const priorityLabel = priorityMap[node.priority] || '';
  const priorityHtml = priorityLabel
    ? '<span class="graph-ai-eval-priority priority-' + escapeHtml(node.priority || 'medium') + '">' + escapeHtml(priorityLabel) + '</span>'
    : '';
  const body = '<div class="graph-ai-eval-suggestion">' + escapeHtml(node.suggestion || node.content || '') + '</div>' + priorityHtml;
  const evalActions = '<button class="graph-ai-eval-accept" onclick="acceptAiEvalNode(\'' + node.id + '\')" title="采纳这条建议">采纳</button>'
    + '<button class="graph-ai-eval-ignore" onclick="ignoreAiEvalNode(\'' + node.id + '\')" title="忽略这条建议">忽略</button>';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const zigzag = '<svg class="graph-ai-eval-zigzag" width="100%" height="100%" aria-hidden="true">'
    + '<polygon class="graph-ai-eval-zigzag-shape" points="0 0"></polygon>'
    + '</svg>';
  return '<div class="graph-node graph-node-ai-eval graph-attr-ai_eval' + selectedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + customWidth + customHeight + '">'
    + zigzag
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + _customNodeHeaderHtml(node, attr, evalActions)
    + '<div class="graph-node-label">对「' + escapeHtml(targetLabel) + '」的建议</div>'
    + '<div class="graph-node-full-content">' + body + '</div>'
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

    // ====== 节点公式渲染记忆 ======
    // 全量重建（切会话/切回旧画布/撤销）会把每个节点 HTML 原样重建，然后 rAF 里对整图
    // 无条件跑 renderMath——切回看过的画布时，所有没变的节点都要重新铺一遍公式。
    // 按「节点 HTML 签名」缓存 KaTeX 铺完的 body 片段（_graphNodeHtmlSig 覆盖全部
    // HTML 相关输入：内容/标签/端口/尺寸/消息正文……内容一变键就变，天然失效，无需主动清）：
    // 命中直接铺定形 HTML（里面已无 $..$ 文本，后续整图 renderMath 对它是空扫描）；
    // 未命中走原路径并登记待回填，rAF 铺完公式后按签名回填缓存。
    // 三条硬边界：① body 含 <textarea / data-viz-id / <iframe 不缓存——用户可编辑态与
    // viz 槽位是有状态 DOM（viz 内容还在 _vizStore 里，会被 prune）；② KaTeX 未就绪
    // （window.renderMathInElement 缺失，app.js 先于 defer 厂商库执行的首帧）不缓存——
    // 防把未渲染中间态钉进缓存；③ 单条 >256KB 不缓存，LRU 上限 200 条防内存失控。
    const _NODE_BODY_CACHE_MAX = 200;
    const _nodeBodyKatexCache = new Map();
    let _katexPendingCaptures = []; // [{id, sig}] 本轮全量重建中「待回填」的节点
    function _nodeBodyKatexGet(sig) {
      if (!_nodeBodyKatexCache.has(sig)) return null;
      const v = _nodeBodyKatexCache.get(sig);
      _nodeBodyKatexCache.delete(sig);
      _nodeBodyKatexCache.set(sig, v); // Map 插入序即 LRU 序：命中挪到最新端
      return v;
    }
    function _nodeBodyKatexPut(sig, html) {
      if (!window.renderMathInElement || !html || html.length > 262144) return;
      if (/<textarea|data-viz-id|<iframe/i.test(html)) return;
      if (_nodeBodyKatexCache.has(sig)) _nodeBodyKatexCache.delete(sig);
      _nodeBodyKatexCache.set(sig, html);
      while (_nodeBodyKatexCache.size > _NODE_BODY_CACHE_MAX) {
        _nodeBodyKatexCache.delete(_nodeBodyKatexCache.keys().next().value);
      }
    }

    // ===== T69：KaTeX 可视性分档 + 折叠跳内容子树 =====
    // 实测（2026-10-01，32 节点简谐运动画布）：画布 36857 个 DOM 元素里 KaTeX
    // 公式标记占 33746（92%），恢复视口内外节点各 16 个；整图一次性铺公式是
    // 启动 1139ms 长任务的大头。两个动作：
    // ① 折叠节点 body 换占位符（CSS 本就 display:none，展开时整卡重建补水）；
    // ② 全量重建后只对视口内（±1200px 余量）节点铺公式，屏外节点留素文本，
    //    进视口再分批补铺——长任务从整图 1.1s 拆成每批几十 ms。
    function _minimizedBodyHtml() {
      return '<div class="graph-node-body-ph" data-body-ph="1"></div>';
    }

    // 对一批节点元素各自铺公式（renderMath 忽略 textarea/pre/code，卡内编辑态安全）。
    // 返回实际铺过的节点 id，供渲染记忆按签名回填缓存。
    function _graphKatexRenderNodes(nodeEls) {
      const rendered = [];
      for (const el of nodeEls) {
        if (typeof renderMath === 'function') renderMath(el);
        const id = el.dataset ? el.dataset.nodeId : el.getAttribute('data-node-id');
        if (id) rendered.push(id);
      }
      return rendered;
    }

    // 渲染记忆回填：只收本轮真正铺过公式的节点（屏外节点还是素文本，绝不能收——
    // 会把未渲染中间态钉进缓存）。签名与构建时不一致（内容已变）的照旧作废。
    function _graphKatexCaptureByIds(ids) {
      if (!_katexPendingCaptures.length || !ids || !ids.length) return;
      const want = new Set(ids);
      const caps = _katexPendingCaptures.filter(c => want.has(c.id));
      if (!caps.length) return;
      for (const c of caps) _katexPendingCaptures.splice(_katexPendingCaptures.indexOf(c), 1);
      const byIdLast = new Map();
      for (const c of caps) byIdLast.set(c.id, c);
      const messages = _getChatHistory();
      const state = _graphState();
      for (const c of byIdLast.values()) {
        const el = graphInner.querySelector('[data-node-id="' + c.id + '"] .graph-node-full-content');
        const n = graphView.nodeById[c.id];
        if (!el || !n) continue;
        if (_graphNodeHtmlSig(n, messages, state) !== c.sig) continue;
        _nodeBodyKatexPut(c.sig, el.innerHTML);
      }
    }

    let _katexIO = null;
    const KATEX_GATE_MARGIN = 1200; // px：平移/缩放「先铺后见」的余量

    function _graphKatexVisiblePass() {
      if (!graphInner) return;
      if (typeof renderMath !== 'function') return;
      const vh = window.innerHeight || 800;
      const vw = window.innerWidth || 1200;
      const nodeEls = Array.from(graphInner.querySelectorAll('.graph-node'));
      const deferred = [];
      const renderedNow = [];
      for (const el of nodeEls) {
        const r = el.getBoundingClientRect();
        const vis = r.bottom > -KATEX_GATE_MARGIN && r.top < vh + KATEX_GATE_MARGIN
          && r.right > -KATEX_GATE_MARGIN && r.left < vw + KATEX_GATE_MARGIN;
        if (vis) renderedNow.push(el);
        else deferred.push(el);
      }
      _graphKatexCaptureByIds(_graphKatexRenderNodes(renderedNow));
      if (!deferred.length) return;
      if (!('IntersectionObserver' in window)) {
        _graphKatexCaptureByIds(_graphKatexRenderNodes(deferred));
        return;
      }
      if (_katexIO) _katexIO.disconnect();
      let queue = [];
      let flushTimer = 0;
      // 一帧最多铺 3 个节点：IO 一次回调会把所有新入视口节点全塞进来，
      // 不限流的话一次缩放又把长任务堆回几百 ms（实测 963ms）
      const flush = () => {
        flushTimer = 0;
        if (!queue.length) return;
        const batch = queue.splice(0, 3);
        _graphKatexCaptureByIds(_graphKatexRenderNodes(batch));
        _measureNodes();
        _updateNodeTransforms();
        _redrawEdges();
        if (queue.length) flushTimer = requestAnimationFrame(flush);
      };
      _katexIO = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          _katexIO.unobserve(e.target);
          if (e.target.isConnected) queue.push(e.target);
        }
        if (queue.length && !flushTimer) flushTimer = requestAnimationFrame(flush);
      }, { root: null, rootMargin: KATEX_GATE_MARGIN + 'px 0px', threshold: 0 });
      deferred.forEach(el => _katexIO.observe(el));
    }

    // 派生追问节点的专用渲染器已退役（2026-10-03 用户拍板）：sq 节点改走 customNodes +
    // module 渲染路径，与手建的「苏格拉底追问」节点完全同款同链路。

function _renderNodeHtml(node, messages, state) {
  if (node.kind === 'blank') return _renderBlankNodeHtml(node, state);
  if (node.kind === 'draft') return _renderDraftNodeHtml(node);
  if (node.kind === 'source') return _renderSourceNodeHtml(node, state);
  if (node.kind === 'knowledge') return _renderKnowledgeNodeHtml(node, state);
  if (node.kind === 'relation') return _renderRelationNodeHtml(node, state);
  if (node.kind === 'human_note') return _renderHumanNoteNodeHtml(node, state);
  if (node.kind === 'ai_eval') return _renderAiEvalNodeHtml(node, state);
  const message = messages[node.messageIndex];
  const baseClass = 'graph-node graph-node-' + node.kind;
  const attr = _nodeAttribute(node);
  const attrClass = ' graph-attr-' + attr.key;
  const modClass = node.moduleKey ? ' graph-node-module graph-module-' + node.moduleKey : '';
  const rootClass = node.isRoot ? ' graph-node-root' : '';
  const branchClass = node.isBranch ? ' graph-node-branch' : '';
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const dimmedClass = node.hidden ? ' dimmed' : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const resizedClass = node.customHeight ? ' resized' : '';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const badge = node.isRoot ? '核心问题' : (node.isBranch ? '延伸追问' : (node.kind === 'answer' ? (node.manual ? '我的回答' : '问题分析') : ''));
  const badgeHtml = badge ? '<span class="graph-node-badge">' + escapeHtml(badge) + '</span>' : '';
  const label = node.recipeId && node.recipe && node.recipe.name
    ? node.recipe.name
    : node.kind === 'module'
    ? ((GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey)
    : node.kind === 'hub'
      ? '汇聚'
      : node.kind === 'summary'
        ? 'AI 总结'
        : node.kind === 'note'
          ? '我的总结'
          : (node.kind === 'answer' && node.messageIndex < 0
            ? (node.manual ? '我的回答' : '问题分析')
            : (node.label || _nodeContent(message, node)));
  const hasCustomContent = !!((node.content || '').trim() || (node.kind === 'answer' && !node.manual && (node.analysis || '').trim()));
  // T69：折叠卡不建内容子树（CSS 本就 display:none），展开时整卡重建补水
  const skipBody = !!node.minimized;
  const customFill = !skipBody && node.messageIndex < 0 && node.manual && !hasCustomContent
    ? '<textarea class="graph-custom-node-content" rows="5" onchange="updateCustomNodeContent(\'' + node.id + '\', this.value)">' + escapeHtml(_nodeContent(message, node)) + '</textarea>'
    : '';
  const customBody = skipBody ? '' : (node.messageIndex < 0
    ? (customFill
        || ((node.kind === 'module' || node.kind === 'summary')
          ? (hasCustomContent
              ? '<div class="graph-custom-node-render">' + _renderCustomNodeContentHtml(node) + '</div>'
              : (node.busy || node.status === 'running'
                  ? '<div class="graph-custom-node-render"></div>'
                  : '<div class="graph-custom-node-empty">等待生成</div>'))
          : (node.kind === 'answer' && !node.manual
              ? (hasCustomContent
                  ? '<div class="graph-custom-node-render">' + _renderCustomNodeContentHtml(node) + '</div>'
                  : (node.busy || node.status === 'running'
                      ? '<div class="graph-custom-node-render"></div>'
                      : '<div class="graph-custom-node-empty">等待分析</div>'))
              : ((node.kind === 'answer' || node.kind === 'note') && node.manual
              ? (hasCustomContent
                  ? '<div class="graph-custom-node-render">' + _renderCustomNodeContentHtml(node) + '</div>'
                  : '')
              : ''))))
    : '');
  let body = skipBody ? '' : (node.kind === 'module'
    ? (customBody || (typeof renderMarkdown === 'function' ? renderMarkdown(_nodeContent(message, node), { parentId: String(message.timestamp || ''), sourceModule: node.moduleKey }) : escapeHtml(_nodeContent(message, node))))
    : ((node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note') ? customBody : ''));
  // answer 展开：正文区换完整渲染管线（renderMarkdown 剥 socratic_meta、转公式定界）
  const expandable = _graphAnswerExpandable(node, message);
  const expanded = expandable && !!(((state || _graphState()).expandedAnswers || {})[node.id]);
  if (expanded && !skipBody) {
    const raw = _graphAnswerExpandRaw(node, message);
    body = (typeof renderMarkdown === 'function')
      ? renderMarkdown(raw, { parentId: String((message && message.timestamp) || ''), sourceModule: node.moduleKey })
      : escapeHtml(raw);
  }
  // 渲染记忆：命中直接铺上次定形的 body；未命中登记待回填（textarea/viz 有状态不登记）
  if (body) {
    const _bodySig = _graphNodeHtmlSig(node, messages, state);
    const _cachedBody = _nodeBodyKatexGet(_bodySig);
    if (_cachedBody != null) body = _cachedBody;
    else if (!/<textarea|data-viz-id|<iframe/i.test(body)) _katexPendingCaptures.push({ id: node.id, sig: _bodySig });
  }
  const sub = _nodeSub(node);
  const subHtml = sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '';
  const statusHtml = _customNodeStatusHtml(node);
  const minimizeToggle = _graphMinimizeToggleHtml(node);
  const editBtn = node.kind === 'module'
    ? '<button class="graph-node-edit-toggle" onclick="editModuleNode(\'' + node.id + '\')" title="人工编辑模块"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
    : (((node.kind === 'summary' || node.kind === 'note') && !(node.messageIndex >= 0))
      ? '<button class="graph-node-edit-toggle" onclick="editCustomNodeContent(\'' + node.id + '\')" title="编辑总结内容"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
      : '');
  const deleteAction = node.messageIndex < 0
    ? 'deleteCustomNode(\'' + node.id + '\')'
    : 'graphModuleAction(\'delete\',\'' + node.id + '\')';
  const deleteBtn = node.isRoot ? '' : '<button class="graph-node-delete-toggle" onclick="' + deleteAction + '" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  const quickConnectBtn = node.kind === 'hub'
    ? '<button class="graph-hub-connect-btn" onclick="event.stopPropagation();quickConnectToHub(\'' + node.id + '\')" title="一键接入选中节点输出"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path></svg></button>'
    : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  const pendingClass = _graphNodePending(node) ? ' graph-node-pending' : '';
  const graphState = state || _graphState();
  const inputHtml = _renderInputPorts(node, graphState);
  const outputHtml = _renderOutputPorts(node, messages, graphState);
  const labelHtml = (node.kind === 'user' && node.messageIndex < 0)
    ? '<textarea class="graph-custom-question-input" rows="2" placeholder="输入问题..." onchange="updateCustomNodeContent(\'' + node.id + '\', this.value)">' + escapeHtml(label) + '</textarea>'
    : (expanded ? '' : '<div class="graph-node-label">' + escapeHtml(node.kind === 'answer' && typeof _graphFormulaDelimit === 'function' ? _graphFormulaDelimit(label) : label) + '</div>');
  return '<div class="' + baseClass + modClass + attrClass + rootClass + branchClass + selectedClass + dimmedClass + minimizedClass + resizedClass + pendingClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + inputHtml
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span>' + badgeHtml + subHtml + statusHtml + minimizeToggle + editBtn + quickConnectBtn + deleteBtn + '</div>'
    + labelHtml
    + (skipBody ? _minimizedBodyHtml() : (body ? '<div class="graph-node-full-content">' + body + '</div>' : ''))
    + (expandable && !skipBody ? '<div class="graph-node-actions"><button class="graph-answer-expand-btn" onclick="toggleGraphNodeExpand(\'' + node.id + '\')" title="' + (expanded ? '收起，回到预览' : '查看完整内容') + '">' + (expanded ? '收起 ▴' : '展开全文 ▾') + '</button></div>' : '')
    + _nodeActions(node)
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + outputHtml
    + '</div>';
}

function _measureNodes() {
  if (!graphInner) return;
  // 一次 querySelectorAll 建 id->元素映射：旧实现对每个节点各做一次全子树
  // querySelector（O(n²) 次子树扫描）。同时读写分离——矩形读取（触发布局）全部
// 先做完，zigzag 等写操作挪到后面，不再每节点交替「写样式→读矩形」强制重排。
  const elById = new Map();
  graphInner.querySelectorAll('.graph-node[data-node-id]').forEach(el => {
    elById.set(el.dataset.nodeId, el);
  });
  const zigzagNodes = [];
  graphView.nodes.forEach(node => {
    const el = elById.get(String(node.id));
    if (!el) return;
    const r = el.getBoundingClientRect();
    node.w = r.width / (graphView.zoom || 1);
    node.h = r.height / (graphView.zoom || 1);
    if (node.kind === 'ai_eval') zigzagNodes.push(node);
  });
  for (const node of zigzagNodes) _updateAiEvalZigzag(node);
  _syncGroupMembersByContainment();
}

function _aiEvalZigzagPoints(w, h) {
  const step = 7;
  const depth = 6;
  const points = [];
  function edge(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const ux = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    const uy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
    const ox = uy;
    const oy = -ux;
    const length = Math.abs(dx) + Math.abs(dy);
    let t = 0;
    points.push([x1, y1]);
    while (t < length) {
      const t1 = Math.min(t + step / 2, length);
      const t2 = Math.min(t + step, length);
      points.push([Math.round(x1 + ux * t1 + ox * depth), Math.round(y1 + uy * t1 + oy * depth)]);
      if (t2 > t1) points.push([x1 + ux * t2, y1 + uy * t2]);
      t = t2;
    }
  }
  edge(0, 0, w, 0);
  edge(w, 0, w, h);
  edge(w, h, 0, h);
  edge(0, h, 0, 0);
  return points.map(point => point.join(',')).join(' ');
}

function _updateAiEvalZigzag(node) {
  if (!node || !graphInner) return;
  const shape = graphInner.querySelector('[data-node-id="' + node.id + '"] .graph-ai-eval-zigzag-shape');
  if (!shape) return;
  shape.setAttribute('points', _aiEvalZigzagPoints(node.w || 260, node.h || 140));
}

// ===== 拖拽流畅度：元素缓存与快速几何更新 =====
// 缓存按 graphInner 实例失效：全量重建（graphCanvas.innerHTML=''）会换掉
// graphInner，WeakMap 自动换新表；层内局部重建（_redrawEdges）只清 edges 表。
const _graphElCacheByInner = new WeakMap();

function _graphElCache() {
  if (!graphInner) return null;
  let cache = _graphElCacheByInner.get(graphInner);
  if (!cache) {
    cache = { nodes: new Map(), ports: new Map(), edges: new Map() };
    _graphElCacheByInner.set(graphInner, cache);
  }
  return cache;
}

function _graphNodeEl(id) {
  if (!graphInner) return null;
  const cache = _graphElCache();
  let el = cache.nodes.get(id);
  if (el && el.isConnected) return el;
  el = graphInner.querySelector('[data-node-id="' + id + '"]');
  if (el) cache.nodes.set(id, el); else cache.nodes.delete(id);
  return el || null;
}

function _graphPortEl(nodeId, portId) {
  if (!graphInner) return null;
  const cache = _graphElCache();
  const key = nodeId + ':' + portId;
  let el = cache.ports.get(key);
  if (el && el.isConnected) return el;
  el = graphInner.querySelector('[data-node-id="' + nodeId + '"][data-port-id="' + portId + '"]');
  if (el) cache.ports.set(key, el); else cache.ports.delete(key);
  return el || null;
}

function _updateNodeTransforms(onlyIds) {
  if (!graphInner) return;
  // onlyIds：拖拽时只写被拖节点的 transform（省掉全量 querySelector+写）；
  // 不传保持旧行为全量刷新（renderGraphCanvas、撤销等路径用）。
  const ids = (onlyIds && onlyIds.length) ? onlyIds : null;
  const list = ids || graphView.nodes.map(node => node.id);
  for (const id of list) {
    const node = graphView.nodeById[id];
    const el = _graphNodeEl(id);
    if (node && el) el.style.transform = 'translate(' + (node.x - (node.w || 0) / 2) + 'px, ' + (node.y - (node.h || 0) / 2) + 'px)';
  }
}

function _clientToGraphLocal(clientX, clientY) {
  if (!graphInner) return { x: 0, y: 0 };
  const rect = graphInner.getBoundingClientRect();
  const zoom = graphView.zoom || 1;
  return {
    x: (clientX - rect.left) / zoom,
    y: (clientY - rect.top) / zoom,
  };
}

function _portAnchor(node, portEl, isOutput, innerRect) {
  if (portEl && graphInner) {
    const rect = portEl.getBoundingClientRect();
    // innerRect 由调用方一次读取传入（一帧一次布局读），不再每条边重复读
    const box = innerRect || graphInner.getBoundingClientRect();
    const zoom = graphView.zoom || 1;
    return {
      x: (rect.left + rect.width / 2 - box.left) / zoom,
      y: (rect.top + rect.height / 2 - box.top) / zoom,
    };
  }
  const halfW = (node.w || 120) / 2;
  return {
    x: node.x + (isOutput ? halfW : -halfW),
    y: node.y,
  };
}

// 边路径 d 属性的唯一拼装（全量重建与拖拽快速路径共用，保证形状一致）
function _edgePathD(p1, p2, cp) {
  return 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
    + ' C' + cp.c1x.toFixed(1) + ' ' + cp.c1y.toFixed(1)
    + ', ' + cp.c2x.toFixed(1) + ' ' + cp.c2y.toFixed(1)
    + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
}

function _linkDragPathHtml(innerRect) {
  const drag = graphView.linkDrag;
  if (!drag || drag.currentX == null) return '';
  const sourceNode = graphView.nodeById[drag.nodeId];
  if (!sourceNode) return '';
  const sourceEl = _graphPortEl(drag.nodeId, drag.portId);
  const p1 = _portAnchor(sourceNode, sourceEl, drag.mode !== 'input', innerRect);
  const p2 = { x: drag.currentX, y: drag.currentY };
  const offset = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  const d = 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
    + ' C' + (p1.x + offset).toFixed(1) + ' ' + p1.y.toFixed(1)
    + ', ' + (p2.x - offset).toFixed(1) + ' ' + p2.y.toFixed(1)
    + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
  return '<path d="' + d + '" class="graph-edge graph-link-drag"></path>';
}

// 联系线控制点求解：优先用户自定义 curve（相对端点的偏移），否则默认横向贝塞尔
function _linkEdgeControlPoints(p1, p2, edge) {
  const curve = edge && edge.curve;
  if (curve && curve.shape === 'straight') {
    return {
      c1x: p1.x + (p2.x - p1.x) / 3,
      c1y: p1.y + (p2.y - p1.y) / 3,
      c2x: p1.x + (p2.x - p1.x) * 2 / 3,
      c2y: p1.y + (p2.y - p1.y) * 2 / 3,
    };
  }
  if (curve && Number.isFinite(curve.dx1) && Number.isFinite(curve.dy1)
    && Number.isFinite(curve.dx2) && Number.isFinite(curve.dy2)) {
    return {
      c1x: p1.x + curve.dx1,
      c1y: p1.y + curve.dy1,
      c2x: p2.x + curve.dx2,
      c2y: p2.y + curve.dy2,
    };
  }
  const o = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  return { c1x: p1.x + o, c1y: p1.y, c2x: p2.x - o, c2y: p2.y };
}

function _linkDefaultCurveOffsets(p1, p2) {
  const o = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  return { dx1: o, dy1: 0, dx2: -o, dy2: 0 };
}

function _redrawEdges() {
  if (!graphEdgeLayer) return;
  // 布局读一次（graphInner 的 rect），整批边共用——不再每条边读两次
  const innerRect = graphInner ? graphInner.getBoundingClientRect() : null;
  const defs = '<defs><marker id="graph-link-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="graph-edge-link-arrow"></path></marker></defs>';
  const html = graphView.edges.map(edge => {
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) return '';
    const sourceEl = _graphPortEl(edge.from, edge.fromPort);
    const targetEl = _graphPortEl(edge.to, edge.toPort);
    const p1 = _portAnchor(a, sourceEl, true, innerRect);
    const p2 = _portAnchor(b, targetEl, false, innerRect);
    const cp = _linkEdgeControlPoints(p1, p2, edge);
    const d = _edgePathD(p1, p2, cp);
    const isLink = !!edge.link;
    const cls = 'graph-edge' + (edge.custom ? ' graph-edge-custom' : '') + (isLink ? ' graph-edge-link' : '')
      + (isLink && graphView.edgeCurveEditKey === _edgeKey(edge) ? ' graph-edge-editing' : '');
    const arrow = isLink ? String(edge.arrow || 'right') : '';
    let markerStart = '';
    let markerEnd = '';
    if (isLink) {
      if (arrow === 'left' || arrow === 'both') markerStart = ' marker-start="url(#graph-link-arrow)"';
      if (arrow === 'right' || arrow === 'both') markerEnd = ' marker-end="url(#graph-link-arrow)"';
    }
    // 联系线的宽透明命中路径：细线难点，加一条便于点选/双击
    const hitHtml = isLink
      ? '<path class="graph-edge-hit" pointer-events="stroke" d="' + d + '"></path>'
      : '';
    let handlesHtml = '';
    if (isLink && graphView.edgeCurveEditKey === _edgeKey(edge)) {
      handlesHtml = '<line class="graph-edge-guide" x1="' + p1.x.toFixed(1) + '" y1="' + p1.y.toFixed(1) + '" x2="' + cp.c1x.toFixed(1) + '" y2="' + cp.c1y.toFixed(1) + '"></line>'
        + '<line class="graph-edge-guide" x1="' + p2.x.toFixed(1) + '" y1="' + p2.y.toFixed(1) + '" x2="' + cp.c2x.toFixed(1) + '" y2="' + cp.c2y.toFixed(1) + '"></line>'
        // 每个手柄配一个更大的隐形命中圆，缩放后也容易抓到
        + '<circle class="graph-curve-knob-hit" data-edge-key="' + _edgeKey(edge) + '" data-handle="c1" cx="' + cp.c1x.toFixed(1) + '" cy="' + cp.c1y.toFixed(1) + '" r="16" pointer-events="all"></circle>'
        + '<circle class="graph-curve-knob-hit" data-edge-key="' + _edgeKey(edge) + '" data-handle="c2" cx="' + cp.c2x.toFixed(1) + '" cy="' + cp.c2y.toFixed(1) + '" r="16" pointer-events="all"></circle>'
        + '<circle class="graph-edge-handle" data-edge-key="' + _edgeKey(edge) + '" data-handle="c1" cx="' + cp.c1x.toFixed(1) + '" cy="' + cp.c1y.toFixed(1) + '" r="9"></circle>'
        + '<circle class="graph-edge-handle" data-edge-key="' + _edgeKey(edge) + '" data-handle="c2" cx="' + cp.c2x.toFixed(1) + '" cy="' + cp.c2y.toFixed(1) + '" r="9"></circle>';
    }
    const label = (edge.relation || edge.label || '').toString().trim();
    let labelHtml = '';
    if (isLink && label) {
      const c1 = { x: cp.c1x, y: cp.c1y };
      const c2 = { x: cp.c2x, y: cp.c2y };
      const mx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8;
      const my = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8;
      const textW = Array.from(label).length * 12 + 16;
      labelHtml = '<g class="graph-edge-link-label-group" data-edge-key="' + _edgeKey(edge) + '">'
        + '<rect class="graph-edge-link-bg" x="' + (mx - textW / 2).toFixed(1) + '" y="' + (my - 15.5).toFixed(1) + '" width="' + textW.toFixed(1) + '" height="17" rx="8.5"></rect>'
        + '<text class="graph-edge-label graph-edge-link-label" x="' + mx.toFixed(1) + '" y="' + (my - 2.5).toFixed(1) + '" text-anchor="middle" data-edge-key="' + _edgeKey(edge) + '">' + escapeHtml(label) + '</text>'
        + '</g>';
    }
    const hintHtml = label && !isLink
      ? '<title>' + escapeHtml(label) + '</title>'
      : '';
    return '<g class="' + cls + '" data-edge-key="' + _edgeKey(edge) + '" title="双击删除连线">'
      + hitHtml
      + '<path d="' + d + '"' + markerStart + markerEnd + '></path>'
      + labelHtml
      + handlesHtml
      + hintHtml
      + '</g>';
  }).join('');
  graphEdgeLayer.innerHTML = defs + html + _linkDragPathHtml(innerRect);
  // 全量重建后旧边元素全部失效：清边缓存与联系线拖拽路径缓存
  const cache = _graphElCache();
  if (cache) cache.edges.clear();
  _linkDragPathEl = null;
}

// ===== 拖拽快速路径：只改被涉及边的 d/标签位置，不重建 SVG 子树 =====
// 返回 false 表示结构不在缓存里（新边/未渲染/曲线编辑中），调用方退回 _redrawEdges 全量。

let _linkDragPathEl = null;

function _refreshLinkDragPath() {
  const drag = graphView.linkDrag;
  if (!drag || drag.currentX == null || !graphEdgeLayer) return false;
  if (!_linkDragPathEl || !_linkDragPathEl.isConnected) {
    _linkDragPathEl = graphEdgeLayer.querySelector('.graph-link-drag');
    if (!_linkDragPathEl) return false;
  }
  const sourceNode = graphView.nodeById[drag.nodeId];
  if (!sourceNode) return false;
  const innerRect = graphInner ? graphInner.getBoundingClientRect() : null;
  const p1 = _portAnchor(sourceNode, _graphPortEl(drag.nodeId, drag.portId), drag.mode !== 'input', innerRect);
  const p2 = { x: drag.currentX, y: drag.currentY };
  const offset = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  _linkDragPathEl.setAttribute('d', 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
    + ' C' + (p1.x + offset).toFixed(1) + ' ' + p1.y.toFixed(1)
    + ', ' + (p2.x - offset).toFixed(1) + ' ' + p2.y.toFixed(1)
    + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1));
  return true;
}

function _edgesTouchingNodeIds(ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  return graphView.edges
    .filter(edge => set.has(edge.from) || set.has(edge.to))
    .map(edge => _edgeKey(edge));
}

function _refreshEdgeGeometry(edgeKeys) {
  if (!graphEdgeLayer || !graphInner) return false;
  const cache = _graphElCache();
  if (!cache) return false;
  const keySet = new Set(edgeKeys);
  // 曲线编辑手柄也依赖端点坐标，走全量保证 guides/knobs 一起更新
  if (graphView.edgeCurveEditKey && keySet.has(graphView.edgeCurveEditKey)) return false;
  const innerRect = graphInner.getBoundingClientRect();
  for (const edge of graphView.edges) {
    const key = _edgeKey(edge);
    if (!keySet.has(key)) continue;
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) continue;
    let entry = cache.edges.get(key);
    if (!entry || !entry.g || !entry.g.isConnected) {
      const g = graphEdgeLayer.querySelector('[data-edge-key="' + key + '"]');
      if (!g) return false;
      entry = {
        g,
        path: g.querySelector('path:not(.graph-edge-hit)'),
        hit: g.querySelector('.graph-edge-hit'),
        labelBg: g.querySelector('.graph-edge-link-label-group > .graph-edge-link-bg'),
        labelText: g.querySelector('.graph-edge-link-label-group > text'),
      };
      cache.edges.set(key, entry);
    }
    const p1 = _portAnchor(a, _graphPortEl(edge.from, edge.fromPort), true, innerRect);
    const p2 = _portAnchor(b, _graphPortEl(edge.to, edge.toPort), false, innerRect);
    const cp = _linkEdgeControlPoints(p1, p2, edge);
    const d = _edgePathD(p1, p2, cp);
    if (entry.path) entry.path.setAttribute('d', d);
    if (entry.hit) entry.hit.setAttribute('d', d);
    if (entry.labelBg && entry.labelText) {
      const label = (edge.relation || edge.label || '').toString().trim();
      const mx = (p1.x + 3 * cp.c1x + 3 * cp.c2x + p2.x) / 8;
      const my = (p1.y + 3 * cp.c1y + 3 * cp.c2y + p2.y) / 8;
      const textW = Array.from(label).length * 12 + 16;
      entry.labelBg.setAttribute('x', (mx - textW / 2).toFixed(1));
      entry.labelBg.setAttribute('y', (my - 15.5).toFixed(1));
      entry.labelText.setAttribute('x', mx.toFixed(1));
      entry.labelText.setAttribute('y', (my - 2.5).toFixed(1));
    }
  }
  return true;
}

// 高倍缩放降级阈值：超过后图层纹理面积随 zoom 平方膨胀，重型特效（边光晕/节点投影/过渡）
// 极易耗尽显存，产生灰白瓦片伪影与卡顿。此时画布挂 .graph-heavy-zoom，由 CSS 关闭重型特效。
const GRAPH_HEAVY_ZOOM_THRESHOLD = 2.2;

function _applyGraphTransform() {
  if (!graphInner) return;
  const state = _graphState();
  graphInner.style.transform = 'translate(' + state.pan.x + 'px, ' + state.pan.y + 'px) scale(' + state.zoom + ')';
  graphView.zoom = state.zoom;
  if (typeof graphCanvas !== 'undefined' && graphCanvas) {
    graphCanvas.classList.toggle('graph-heavy-zoom', (state.zoom || 1) > GRAPH_HEAVY_ZOOM_THRESHOLD);
  }
  // 预览渲染已归族至 harness-preview.js（T261 拆分）：主包必有该函数；viewer 子集
  // 不带 Φ、预览数组恒空，typeof 守卫免悬空引用（同 graph.js 对可选跨文件函数的惯例）
  if (graphView.previewNodes.length || graphView.previewEdges.length) {
    if (typeof _renderGraphHarnessPreview === 'function') _renderGraphHarnessPreview();
  }
}

// ===== 流式补丁的节点签名：内容没变的节点整体跳过 =====
// 旧行为每个补丁帧对每个节点都跑一次 _renderNodeHtml（内含完整 renderMarkdown）再逐段
// 字符串比对；流式期间通常只有一个节点在变，其余全是白算。签名覆盖渲染 HTML 会用到的
// 全部输入（节点字段 + 该节点引用的消息正文/分支标签 + 该节点的端口计数）。
// x/y/w/h 故意不进签名：位置由 _updateNodeTransforms 负责、尺寸由 _measureNodes 负责，
// 与旧补丁路径「保留旧几何」的语义一致。签名存在节点对象上，全量重建换新对象自动失效。
function _graphNodeHtmlSig(node, messages, state) {
  const message = node.messageIndex >= 0 ? (messages || [])[node.messageIndex] : null;
  const parts = [
    node.id, node.kind, node.moduleKey, node.messageIndex, node.isRoot, node.isBranch,
    node.minimized, node.hidden, node.manual, node.busy, node.status,
    node.customWidth, node.customHeight, node.content, node.analysis, node.label, node.items,
    message ? message.content : null,
    message ? message.branchLabel : null,
    state.portCounts ? state.portCounts[node.id] : null,
    state.inputPortCounts ? state.inputPortCounts[node.id] : null,
    state.expandedAnswers ? state.expandedAnswers[node.id] : null,
  ];
  let sigSrc = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    sigSrc += '\u0001' + (p == null ? '' : (typeof p === 'object' ? JSON.stringify(p) : String(p)));
  }
  return _vizHash(sigSrc);
}

function _patchGraphStreaming(messages, state) {
  if (!graphInner) return;
  const data = _buildGraphData(messages, state);
  const nextIds = new Set(data.nodes.map(n => n.id));
  const oldById = graphView.nodeById || {};

  graphInner.querySelectorAll('.graph-node').forEach(el => {
    if (!nextIds.has(el.dataset.nodeId)) el.remove();
  });

  const nextNodes = [];
  const nextById = {};
  for (const next of data.nodes) {
    const old = oldById[next.id];
    const existingEl = graphInner.querySelector('[data-node-id="' + next.id + '"]');
    if (old && existingEl) {
      const nextSig = _graphNodeHtmlSig(next, messages, state);
      if (old._patchSig === nextSig) {
        nextNodes.push(old);
        continue;
      }
      const oldX = old.x;
      const oldY = old.y;
      const oldW = old.w;
      const oldH = old.h;
      const oldFixedX = old.fixedX;
      const oldFixedY = old.fixedY;
      const oldPinned = old.pinned;
      const oldCustomWidth = old.customWidth;
      const oldCustomHeight = old.customHeight;
      Object.assign(old, next, {
        x: oldX,
        y: oldY,
        w: oldW,
        h: oldH,
        fixedX: oldFixedX,
        fixedY: oldFixedY,
        pinned: oldPinned,
        customWidth: oldCustomWidth,
        customHeight: oldCustomHeight,
      });

      const nextHtml = _renderNodeHtml(old, messages, state);
      const tmp = document.createElement('div');
      tmp.innerHTML = nextHtml;
      const nextEl = tmp.firstElementChild;
      const bodyChanged = (nextEl.querySelector('.graph-node-full-content')?.innerHTML || '')
        !== (existingEl.querySelector('.graph-node-full-content')?.innerHTML || '');
      const labelChanged = (nextEl.querySelector('.graph-node-label')?.innerHTML || '')
        !== (existingEl.querySelector('.graph-node-label')?.innerHTML || '');
      const subChanged = (nextEl.querySelector('.graph-node-sub')?.innerHTML || '')
        !== (existingEl.querySelector('.graph-node-sub')?.innerHTML || '');
      const nextInputHtml = nextEl.querySelector('.graph-input-col')?.outerHTML || '';
      const oldInputHtml = existingEl.querySelector('.graph-input-col')?.outerHTML || '';
      const nextOutputHtml = nextEl.querySelector('.graph-output-col')?.outerHTML || '';
      const oldOutputHtml = existingEl.querySelector('.graph-output-col')?.outerHTML || '';
      if (nextInputHtml !== oldInputHtml) {
        existingEl.querySelector('.graph-input-col')?.remove();
        if (nextInputHtml) existingEl.insertAdjacentHTML('afterbegin', nextInputHtml);
      }
      if (nextOutputHtml !== oldOutputHtml) {
        existingEl.querySelector('.graph-output-col')?.remove();
        if (nextOutputHtml) existingEl.insertAdjacentHTML('beforeend', nextOutputHtml);
      }
      if (labelChanged) {
        const labelEl = existingEl.querySelector('.graph-node-label');
        const nextLabelEl = nextEl.querySelector('.graph-node-label');
        if (labelEl && nextLabelEl) labelEl.innerHTML = nextLabelEl.innerHTML;
      }
      if (subChanged) {
        const subEl = existingEl.querySelector('.graph-node-sub');
        const nextSubEl = nextEl.querySelector('.graph-node-sub');
        if (subEl && nextSubEl) subEl.innerHTML = nextSubEl.innerHTML;
      }
      if (bodyChanged) {
        const bodyEl = existingEl.querySelector('.graph-node-full-content');
        const nextBodyEl = nextEl.querySelector('.graph-node-full-content');
        if (nextBodyEl) {
          if (bodyEl) bodyEl.innerHTML = nextBodyEl.innerHTML;
          else existingEl.insertAdjacentHTML('beforeend', nextBodyEl.outerHTML);
        } else if (bodyEl) {
          bodyEl.remove();
        }
      }
      const nextBlankContent = nextEl.querySelector('.graph-blank-content');
      const oldBlankContent = existingEl.querySelector('.graph-blank-content');
      if (nextBlankContent && oldBlankContent && nextBlankContent.innerHTML !== oldBlankContent.innerHTML) {
        oldBlankContent.innerHTML = nextBlankContent.innerHTML;
      } else if (nextBlankContent && !oldBlankContent) {
        existingEl.querySelector('.graph-blank-requirement')?.insertAdjacentHTML('beforebegin', nextBlankContent.outerHTML);
      } else if (!nextBlankContent && oldBlankContent) {
        oldBlankContent.remove();
      }
      const nextBlankInput = nextEl.querySelector('.graph-blank-input');
      const oldBlankInput = existingEl.querySelector('.graph-blank-input');
      if (nextBlankInput && oldBlankInput && nextBlankInput.value !== oldBlankInput.value) {
        oldBlankInput.value = nextBlankInput.value;
      }
      if (existingEl.className !== nextEl.className) {
        existingEl.className = nextEl.className;
      }
      old._patchSig = nextSig;
      nextNodes.push(old);
    } else {
      graphInner.insertAdjacentHTML('beforeend', _renderNodeHtml(next, messages, state));
      next._patchSig = _graphNodeHtmlSig(next, messages, state);
      nextNodes.push(next);
    }
  }

  nextNodes.forEach(n => { nextById[n.id] = n; });
  graphView.nodes = nextNodes;
  graphView.nodeById = nextById;
  graphView.defaultEdges = data.edges;
  graphView.edges = _resolveGraphEdges(state, data.edges, nextById);
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

