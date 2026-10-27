// ===== 图数据构建（2026-10-24 自 graph.js 拆出，T397 纯搬家）=====
// _buildGraphData 主链、边解析与端口分配、节点内容取材，含分组框渲染 _renderGroupHtml 一族
// （分组的增删改名等操作在 graph-events.js）与搜索纯文本工具 _graphSearchPlainText。
function _getChatHistory() {
  const base = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];
  const live = typeof window.getStreamingAssistant === 'function' ? window.getStreamingAssistant() : null;
  if (!live) return base;
  // 在写的这条回答自带来处（2026-10-11）：生成中允许切画布了，它只属于它自己那张。
  // 不按会话过滤的话，切到别的画布会把这条半截回答画成人家画布上的幽灵节点。
  const sid = typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : '';
  if (live.sessionId && sid && live.sessionId !== sid) return base;
  return base.concat([live]);
}

function _graphNodeId(kind, timestamp, moduleKey) {
  const ts = String(timestamp || '').replace(/[^0-9]/g, '') || Math.random().toString(36).slice(2, 8);
  return kind + '-' + ts + (moduleKey ? '-' + moduleKey : '');
}

function _graphGroupById(groupId) {
  return graphView.groups.find(group => group.id === groupId) || null;
}

function _graphGroupBounds(nodeIds) {
  const nodes = (nodeIds || []).map(id => _findGraphNode(id)).filter(Boolean);
  if (!nodes.length) return { x: 120, y: 120, width: 320, height: 180 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const w = node.w || 120;
    const h = node.h || 60;
    minX = Math.min(minX, node.x - w / 2);
    minY = Math.min(minY, node.y - h / 2);
    maxX = Math.max(maxX, node.x + w / 2);
    maxY = Math.max(maxY, node.y + h / 2);
  }
  const pad = 34;
  return {
    x: Math.round(minX - pad),
    y: Math.round(minY - pad),
    width: Math.round(maxX - minX + pad * 2),
    height: Math.round(maxY - minY + pad * 2),
  };
}

function _renderGroupHtml(group) {
  const color = group.color || 'var(--graph-group-default)';
  // input[type=color] 只认 #rrggbb：令牌引用解析成计算值（T166），用户选过的真值原样
  const colorHex = resolveCssColor(color);
  return '<div class="graph-group" data-group-id="' + group.id + '" style="left:' + group.x + 'px;top:' + group.y + 'px;width:' + group.width + 'px;height:' + group.height + 'px;--group-color:' + color + ';">'
    + '<div class="graph-group-header">'
    + '<input class="graph-group-name-input" value="' + escapeHtml(group.name || '分组') + '" title="重命名分组" onchange="graphRenameGroup(\'' + group.id + '\', this.value)">'
    + '<input class="graph-group-color-input" type="color" value="' + escapeHtml(colorHex) + '" title="调整分组颜色" onchange="graphSetGroupColor(\'' + group.id + '\', this.value)">'
    + '<button class="graph-group-add-btn" title="将选中节点加入此组" onclick="graphAddSelectedToGroup(\'' + group.id + '\')">+</button>'
    + '<button class="graph-group-delete-btn" title="删除分组" onclick="graphDeleteGroup(\'' + group.id + '\')">×</button>'
    + '</div>'
    + '<span class="graph-group-resize-handle" title="调整分组尺寸"></span>'
    + '</div>';
}

function _updateGroupElement(group) {
  const el = graphInner?.querySelector('[data-group-id="' + group.id + '"]');
  if (!el) return;
  el.style.left = group.x + 'px';
  el.style.top = group.y + 'px';
  el.style.width = group.width + 'px';
  el.style.height = group.height + 'px';
  el.style.setProperty('--group-color', group.color || 'var(--graph-group-default)');
}

function _fitGroupToMembers(group) {
  if (!group || !group.nodeIds || !group.nodeIds.length) return;
  const bounds = _graphGroupBounds(group.nodeIds);
  Object.assign(group, bounds);
  _updateGroupElement(group);
}

function _fitAllGroupsToMembers() {
  (graphView.groups || []).forEach(group => _fitGroupToMembers(group));
}

function _isNodeFullyInsideGroup(node, group) {
  if (!node || !group) return false;
  const w = Number(node.w) || 0;
  const h = Number(node.h) || 0;
  if (!w || !h) return false;
  const gx = Number(group.x) || 0;
  const gy = Number(group.y) || 0;
  const gw = Number(group.width) || 0;
  const gh = Number(group.height) || 0;
  const epsilon = 0.01;
  return node.x - w / 2 >= gx - epsilon
    && node.y - h / 2 >= gy - epsilon
    && node.x + w / 2 <= gx + gw + epsilon
    && node.y + h / 2 <= gy + gh + epsilon;
}

function _syncGroupMembers() {
  const validIds = new Set(graphView.nodes.map(node => node.id));
  let changed = false;
  graphView.groups = (graphView.groups || []).map(group => {
    const nextIds = (group.nodeIds || []).filter(id => validIds.has(id));
    if (nextIds.length !== (group.nodeIds || []).length) changed = true;
    const normalized = { ...group, nodeIds: nextIds };
    if (normalized.x == null || normalized.y == null || !normalized.width || !normalized.height) {
      _fitGroupToMembers(normalized);
      changed = true;
    }
    return normalized;
  });
  if (changed) {
    const state = _graphState();
    state.groups = graphView.groups.map(group => ({ ...group }));
    _saveGraphState(state);
  }
}

function _syncGroupMembersByContainment() {
  const validIds = new Set(graphView.nodes.map(node => node.id));
  let changed = false;
  graphView.groups = (graphView.groups || []).map(group => {
    const originalIds = group.nodeIds || [];
    const nextIds = originalIds.filter(id => validIds.has(id));
    if (nextIds.length !== originalIds.length) changed = true;
    const normalized = { ...group, nodeIds: nextIds };
    if (normalized.x == null || normalized.y == null || !normalized.width || !normalized.height) {
      _fitGroupToMembers(normalized);
      changed = true;
    }
    // 只按包含关系「减」成员，绝不「加」：组框是成员包围盒＋内边距，同列兄弟节点
    // 天生落在框内（追问是一列竖排的），按包含关系加人会把用户没框选的节点静默吞进组，
    // 下一次自动整理就跟着整组一起被搬走——实测「点几次整理后节点莫名进组」就是这么来的。
    // 入组只认显式操作：新建分组、组框上的「＋」、拖拽落点（graph-interact.js _endPointerDrag）。
    const containedIds = nextIds.filter(id => {
      const node = validIds.has(id) ? graphView.nodes.find(item => item.id === id) : null;
      return !!node && _isNodeFullyInsideGroup(node, normalized);
    });
    if (containedIds.length !== nextIds.length) changed = true;
    normalized.nodeIds = containedIds;
    return normalized;
  });
  if (changed) {
    const state = _graphState();
    state.groups = graphView.groups.map(group => ({ ...group }));
    _saveGraphState(state);
  }
  return changed;
}

function _graphSummary(content) {
  const match = String(content || '').match(/<summary>([\s\S]*?)<\/summary>/i);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// answer 节点的正文/标签走纯文本路径（escapeHtml 直出，不经 renderMarkdown），
// <formula> 标签须在此转成 $..$ 定界，画布重建后的 _graphKatexVisiblePass 才能铺成 KaTeX
function _graphFormulaDelimit(text) {
  let s = String(text || '');
  s = s.replace(/\${1,2}\s*<formula>([\s\S]*?)<\/formula>\s*\${1,2}/gi, (m, latex) => '$' + latex.trim() + '$');
  s = s.replace(/<formula>([\s\S]*?)<\/formula>/gi, (m, latex) => '$' + latex.trim() + '$');
  s = s.replace(/<formula>[\s\S]*$/i, '').replace(/<\/formula>/gi, '');
  return s;
}

// answer 卡预览：转定界 → 剥区块标签 → 压空白 → 截 240 字；截断落在公式半截时回退到上一个 $ 前
function _graphAnswerPreview(text) {
  let s = _graphFormulaDelimit(text);
  if (typeof stripXmlTags === 'function') s = stripXmlTags(s);
  const p = s.replace(/\s+/g, ' ').trim();
  if (p.length <= 240) return p;
  let cut = p.slice(0, 240);
  if ((cut.match(/\$/g) || []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('$'));
  return cut.trim() + '...';
}

// socratic 反馈在 answer 卡上的展示口径：尾部建议追问（1. [基础]… 三连）已由 _buildGraphData
// 派生成独立「苏格拉底追问」节点（2026-10-06 用户拍板：追问只保留在派生节点，卡上不再重复），
// 预览＋展开正文都剥——**只剥展示，msg.content 原文不动**（_parseSuggestedFollowupQuestions
// 派生、_matchSuggestedFollowupNode 答题链匹配仍吃原文）。非 socratic 反馈原样返回。
function _graphSocraticDisplayContent(raw, message) {
  const s = String(raw || '');
  if (!((message && message.branchType === 'socratic') || /<socratic_meta\b/i.test(s))) return s;
  return _graphStripSuggestedFollowups(s);
}

// 剥建议追问块：从「其后到结尾只剩 [等级] 问题行/空行/socratic_meta」的最早一行起整段截掉
//（含尾部 meta）；问题块其后还有正文时不动（防误伤散文）；纯问题无正文（cut=0）不剥防空卡；
// 紧邻块上方 ≤30 字的追问类小节标题一并剥（### 苏格拉底追问／**下一步建议追问** 之类）
function _graphStripSuggestedFollowups(text) {
  const lines = String(text || '').split('\n');
  const isQ = t => /^[[(【](?:基础|进阶|拓展)(?:题|层)?[\])】]/.test(
    t.replace(/^\s*(?:\d+[.、)]\s*|[-*+]\s*)?/, '').replace(/\*/g, ''));
  const isTailNoise = t => t.trim() === '' || /^<socratic_meta\b/i.test(t.trim());
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isQ(lines[i]) && lines.slice(i + 1).every(t => isQ(t) || isTailNoise(t))) { cut = i; break; }
  }
  if (cut <= 0) return String(text || '');
  const head = lines[cut - 1] || '';
  if (head.trim().length <= 30 && /(苏格拉底)?追问|延伸思考/.test(head)) cut--;
  return lines.slice(0, cut).join('\n').replace(/\s+$/, '');
}

// answer 卡（T172 首拍根卡、T192 扩到全部 answer 卡）的展示口径：<extend> 整段（### 苏格拉底追问＋
// ### 进阶学习方向）已由 _buildGraphData 拆成画布上独立的模块节点（_splitExtendSections），
// 卡上再整段渲染属同构重复，展示时整段剥掉——口径同 2026-10-06 socratic 反馈卡：
// **只剥展示，msg.content 原文一个字不动**（模块派生、答题链匹配、导出仍吃原文）。
// 容忍大小写与未闭合尾块；剥后收尾空白。
function _graphStripExtendDisplay(text) {
  let s = String(text || '');
  s = s.replace(/<extend\b[^>]*>[\s\S]*?<\/extend>/gi, '');
  s = s.replace(/<extend\b[\s\S]*$/i, '');
  return s.replace(/\s+$/, '');
}

// answer 卡展示文本总口径：先剥 <extend> 整段，再走 socratic 反馈剥口。两条互不
// 干扰：extend 剥走后残余正文里若还有 socratic_meta/建议追问，_graphSocraticDisplayContent
// 照旧处理。T192 扩面（2026-10-08 用户拍板）：T172 只剥根卡，剥除扩到全部 answer 卡——
// 每个 answer 都派生自己的模块节点，卡上整段渲染同构重复；kind 判定保证非 answer 卡
// （问题卡/我的回答卡等）不经过本口径，不受影响。
function _graphAnswerDisplayContent(raw, message, node) {
  let s = String(raw || '');
  if (node && node.kind === 'answer') s = _graphStripExtendDisplay(s);
  return _graphSocraticDisplayContent(s, message);
}

// answer 卡「展开全文」取原文（override 优先，与 _nodeContent 同口径）；
// 展示口径统一走 _graphAnswerDisplayContent（根卡剥 extend ＋ socratic 反馈剥建议追问），
// <socratic_meta> 是结构标注，残余时交给 renderMarkdown 剥
function _graphAnswerExpandRaw(node, message) {
  const state = typeof _graphState === 'function' ? _graphState() : {};
  const ov = ((state && state.harnessNodeOverrides) || {})[node.id];
  if (ov && ov.content != null) return _graphAnswerDisplayContent(String(ov.content), message, node);
  return message ? _graphAnswerDisplayContent(String(message.content || ''), message, node) : '';
}

// 有 <summary> 的回答整段直出（_nodeContent 不截断），无需展开；剥掉建议追问后仍 >240 字
// 的回答才给展开开关（socratic 反馈的建议追问已派生独立节点、卡上剥除，见 _graphSocraticDisplayContent）
function _graphAnswerExpandable(node, message) {
  if (!node || node.kind !== 'answer' || node.manual || !(node.messageIndex >= 0)) return false;
  const raw = _graphAnswerExpandRaw(node, message);
  if (!raw || /<summary>[\s\S]*?<\/summary>/i.test(raw)) return false;
  let plain = raw
    .replace(/<socratic_meta\b[^>]*>[\s\S]*?<\/socratic_meta>/gi, '')
    .replace(/<socratic_meta\b[^>]*\/?>/gi, '');
  if (typeof stripXmlTags === 'function') plain = stripXmlTags(plain);
  return plain.replace(/\s+/g, ' ').trim().length > 240;
}

// 展开/收起状态持久化在 graphState.expandedAnswers（与 portCounts 同一套存取），切换走整图重建
function toggleGraphNodeExpand(nodeId) {
  const state = _graphState();
  state.expandedAnswers = state.expandedAnswers || {};
  const expanding = !state.expandedAnswers[nodeId];
  if (expanding) state.expandedAnswers[nodeId] = true;
  else delete state.expandedAnswers[nodeId];
  // 隐式画像：展开答案 = 形式/推导侧偏好信号（只记展开，不记收起）
  if (expanding && typeof window.reportProfileEvent === 'function') window.reportProfileEvent('expand');
  _saveGraphState(state, { layout: true }); // T219：展开/收起是显示态写，投影差异不跟踪它
  if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
}

// socratic 反馈尾部的建议追问（[基础]/[进阶]/[拓展] 行）→ 派生「苏格拉底追问」节点的数据源。
// 比render.js convertSocraticQuestions 收得更紧：必须有中/英方括号等级标签，防正文散文误匹配
function _parseSuggestedFollowupQuestions(content) {
  const text = String(content || '').replace(/<socratic_meta\b[^>]*>[\s\S]*?<\/socratic_meta>/gi, '');
  const out = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/<[^>]+>/g, ' ').replace(/\*\*/g, '').replace(/^\s*(?:\d+[.、)]\s*|[-*]\s*)?/, '');
    const m = line.match(/^[[(【](基础|进阶|拓展)(?:题|层)?[\])】]\s*[:：]?\s*(.+?)\s*$/);
    if (!m) continue;
    const question = m[2].trim();
    if (!question) continue;
    out.push({
      levelName: m[1],
      level: m[1] === '基础' ? 'basic' : m[1] === '进阶' ? 'advanced' : 'expand',
      question,
    });
  }
  return out;
}

function _graphModuleKeys(sections) {
  const keys = [];
  if (sections.physics) keys.push('physics');
  if (sections.math) keys.push('math');
  if (sections.graph) keys.push('graph');
  if (sections.viz) keys.push('viz');
  if (sections.socratic) keys.push('socratic');
  if (sections.learn) keys.push('learn');
  return keys;
}

function _splitExtendSections(content) {
  const text = String(content || '').trim();
  if (!text) return {};
  const markers = [
    { key: 'socratic', pattern: /^#{1,6}\s*[^\n]*苏格拉底追问[^\n]*\n?/im },
    { key: 'learn', pattern: /^#{1,6}\s*[^\n]*进阶学习方向[^\n]*\n?/im },
  ];
  const found = [];
  for (const marker of markers) {
    const match = text.match(marker.pattern);
    if (match) found.push({ key: marker.key, index: match.index });
  }
  if (!found.length) return {};
  found.sort((a, b) => a.index - b.index);
  const out = {};
  for (let i = 0; i < found.length; i++) {
    const start = found[i].index;
    const end = i + 1 < found.length ? found[i + 1].index : text.length;
    out[found[i].key] = text.slice(start, end).trim();
  }
  return out;
}

function _splitGraphSections(sections) {
  const out = { ...(sections || {}) };
  if (out.graph && typeof _splitVizFromGraph === 'function') {
    const split = _splitVizFromGraph(out.graph);
    out.graph = split.graphContent;
    if (!out.viz || !out.viz.trim()) out.viz = split.vizContent;
  }
  const extendSplit = _splitExtendSections(out.extend || '');
  if (extendSplit.socratic || extendSplit.learn) {
    if (extendSplit.socratic) out.socratic = extendSplit.socratic;
    if (extendSplit.learn) out.learn = extendSplit.learn;
    delete out.extend;
  }
  return out;
}

function _findGraphNode(nodeId) {
  // 任务列表：工作流任务跑动期间优先看任务自己那批节点（任务自带来处，见 tasks.js）。
  // 用户切到别的画布之后，任务不再改画布上这批人，而是改自己那份工作副本。
  if (typeof _taskNodeOverride === 'function') {
    const owned = _taskNodeOverride(nodeId);
    if (owned) return owned;
  }
  return graphView.nodeById[nodeId] || null;
}

function _pushEdge(edges, from, to, type, fromPort, toPort) {
  if (!from || !to || from === to) return;
  if (edges.some(e =>
    e.from === from
    && e.to === to
    && (e.fromPort || 'out-0') === (fromPort || 'out-0')
    && (e.toPort || 'in-0') === (toPort || 'in-0')
  )) return;
  edges.push({ from, to, type: type || 'primary', fromPort, toPort });
}

function _assignDefaultPorts(edges) {
  const outCounts = {};
  const inCounts = {};
  return edges.map(edge => {
    if (!edge.fromPort) {
      const idx = outCounts[edge.from] || 0;
      edge.fromPort = 'out-' + idx;
      outCounts[edge.from] = idx + 1;
    }
    if (!edge.toPort) {
      const idx = inCounts[edge.to] || 0;
      edge.toPort = 'in-' + idx;
      inCounts[edge.to] = idx + 1;
    }
    return edge;
  });
}

function _mapAnswerDefaultPorts(edges, nodeById) {
  return edges.map(edge => {
    const from = nodeById[edge.from];
    const to = nodeById[edge.to];
    if (from && from.kind === 'answer' && to && to.kind === 'module') {
      const key = to.moduleKey;
      if (key === 'learn') edge.fromPort = 'out-4';
      if (Object.prototype.hasOwnProperty.call(ANSWER_OUTPUT_INDEX, key)) edge.fromPort = 'out-' + ANSWER_OUTPUT_INDEX[key];
    }
    return edge;
  });
}

function _findCustomBranchParent(customNodes, parentTs, sourceModule) {
  const list = (customNodes || []).filter(cn => String(cn.timestamp || '') === String(parentTs || ''));
  let match = null;
  if (sourceModule) {
    match = list.find(cn =>
      (cn.kind === 'module' || cn.kind === 'blank' || cn.kind === 'hub') &&
      String(cn.moduleKey || '') === String(sourceModule || '')
    ) || null;
  }
  if (!match) match = list.find(cn => cn.kind === 'answer') || null;
  if (!match) match = list.find(cn => cn.kind === 'user' || cn.kind === 'module' || cn.kind === 'blank' || cn.kind === 'hub') || null;
  return match;
}

// 分支消息的父模块解析：sourceModule 可能是旧版伪模块键 'extend'（画布上已拆分为
// socratic/learn 两个模块，永远查不到），也可能与 branchType 同名。按候选顺序解析，
// 全部未命中返回 null（由调用方回退答案节点/自定义节点）。
function _resolveBranchModuleId(nodeById, msg) {
  const parentTs = String(msg.parentId || '');
  if (!parentTs) return null;
  const seen = new Set();
  const candidates = [];
  const push = modKey => {
    if (!modKey) return;
    const id = _graphNodeId('m', parentTs, modKey);
    if (!seen.has(id)) { seen.add(id); candidates.push(id); }
  };
  const srcMod = String(msg.sourceModule || '');
  if (srcMod && srcMod !== 'extend') push(srcMod);
  if (msg.branchType === 'socratic' || msg.branchType === 'learn') push(msg.branchType);
  if (srcMod === 'extend') { push('socratic'); push('learn'); }
  for (const id of candidates) {
    if (nodeById[id]) return id;
  }
  return null;
}

// 无显式 fromPort 时，用消息里的“追问问题：…”（或进阶方向按钮文案）匹配
// 苏格拉底/进阶学习模块的问题端口，得到 'out-K'；匹配不上返回 ''。
function _inferBranchFromPort(parentNode, msg, messages) {
  if (!parentNode || parentNode.kind !== 'module') return '';
  if (parentNode.moduleKey !== 'socratic' && parentNode.moduleKey !== 'learn') return '';
  const message = parentNode.messageIndex >= 0 ? messages[parentNode.messageIndex] : null;
  const content = _nodeContent(message, parentNode) || '';
  const ports = _parsePortQuestions(content, parentNode.moduleKey === 'socratic');
  if (!ports.length) return '';
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let question = '';
  const qMatch = String(msg.content || '').match(/追问问题[：:]\s*([^\n]+)/);
  if (qMatch) question = norm(qMatch[1]);
  if (question) {
    const exact = ports.findIndex(item => item.question && norm(item.question) === question);
    if (exact >= 0) return 'out-' + exact;
    const loose = ports.findIndex(item => item.question
      && (norm(item.question).includes(question) || question.includes(norm(item.question))));
    if (loose >= 0) return 'out-' + loose;
  }
  // 进阶学习等没有“追问问题”行的消息：看端口问题是否出现在消息正文里
  const body = norm(msg.content);
  const byBody = ports.findIndex(item => item.question && body.includes(norm(item.question)));
  return byBody >= 0 ? 'out-' + byBody : '';
}

function _applyHarnessOverrides(node, state) {
  const overrides = (state && state.harnessNodeOverrides) || {};
  const ov = overrides[node.id];
  if (!ov) return node;
  if (ov.label != null && node.kind !== 'module' && node.kind !== 'hub' && node.kind !== 'summary' && node.kind !== 'note') {
    node.label = String(ov.label);
  }
  if (ov.content != null) node.content = String(ov.content);
  if (ov.formula != null) node.formula = String(ov.formula);
  return node;
}

// socratic 作答消息（正文带「追问问题：…」行）对应哪张派生追问节点：按问题文本匹配 items。
// 消息的 parentId 实际指回锚点而非上一条反馈（真机数据取证），文本匹配才是可靠对应
function _matchSuggestedFollowupNode(nodeById, msg) {
  const qm = String(msg.content || '').match(/追问问题[：:]\s*([^\n]+)/);
  if (!qm) return null;
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const q = norm(qm[1]);
  if (!q) return null;
  for (const id in nodeById) {
    const n = nodeById[id];
    if (!n || !n.sqAuto || !Array.isArray(n.items) || !n.items.length) continue;
    for (const item of n.items) {
      const iq = norm(item.question);
      if (iq && (iq === q || iq.includes(q) || q.includes(iq))) return n;
    }
  }
  return null;
}

// 2026-10-23 知识点节点退役（backlog T367/T383/T384 收口）：老画布里的知识点卡片
// 就地转成「我的理解」便签——标题、正文、公式、位置、连线都留着，只是不再是知识点
// 节点。materializeCustom 每次建图都会过一遍，kind 改掉即幂等；改完的 cn 随下一次
// 存盘落库，所以老数据会自然收敛，不需要单独的迁移脚本。
function _retireLegacyKnowledgeNode(cn) {
  cn.kind = 'human_note';
  cn.label = cn.label || cn.title || '我的理解';
  cn.title = cn.title || cn.label;
  cn.content = String(cn.content || cn.summary || '');
  const formulas = Array.isArray(cn.formulas) ? cn.formulas.map(f => String(f || '').trim()).filter(Boolean) : [];
  if (!cn.formula && formulas.length) cn.formula = formulas.join('；');
  cn.manual = true;
  cn.nodeType = cn.nodeType || 'understanding';
  delete cn.knowledgeKey;
}

function _buildGraphData(messages, state) {
  const nodes = [];
  const edges = [];
  const nodeById = {};
  const hiddenMap = state.hidden || {};
  const harnessDeleted = state.harnessDeleted || {};
  const collapsedMap = state.collapsed || {};
  const savedPositions = state.layoutVersion === LAYOUT_VERSION ? (state.positions || {}) : {};
  const pinnedMap = state.pinned || {};
  const savedSizes = state.sizes || {};
  let addedSqCustom = false;

  let rootQuestionId = null;
  let rootAnswerId = null; // 首个主回答＝根 answer 卡（isRootAnswer 标记；T192 起展示剥 <extend> 扩到全部 answer 卡，不再以此判定）
  let lastMainAnswerId = null;
  let lastUserNode = null;
  const answerParentQuestion = {};
  const branchCounter = {};

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const isBranch = msg.branchType && msg.branchType !== 'main';
      const isRoot = !isBranch && !rootQuestionId;
      const id = _graphNodeId('q', msg.timestamp);
      if (harnessDeleted[id]) continue;
      let depth = 0;
      let targetAngle = 0;
      let parentQuestionId = null;
      let branchParentNode = null;
      let branchCount = 0;

      if (isRoot) {
        rootQuestionId = id;
      } else if (!isBranch) {
        const prevAnswer = lastMainAnswerId ? nodeById[lastMainAnswerId] : null;
        depth = prevAnswer ? prevAnswer.depth + 1 : 1;
        targetAngle = prevAnswer ? prevAnswer.targetAngle + 0.04 : -Math.PI / 2;
      } else {
        const parentTs = String(msg.parentId || '');
        let parentId = _resolveBranchModuleId(nodeById, msg);
        let parentNode = parentId ? nodeById[parentId] : null;
        if (!parentNode) {
          const answerId = _graphNodeId('a', parentTs);
          parentNode = nodeById[answerId] || null;
          parentId = answerId;
        }
        // 答题链视觉（与连边同一口径）：作答命中追问节点则定位跟随它
        const matchedSqPos = _matchSuggestedFollowupNode(nodeById, msg);
        if (matchedSqPos) {
          parentNode = matchedSqPos;
          parentId = matchedSqPos.id;
        } else if (parentNode) {
          const sqId = _graphNodeId('sq', parentTs);
          if (nodeById[sqId]) {
            parentNode = nodeById[sqId];
            parentId = sqId;
          }
        }
        if (!parentNode) {
          const customParent = _findCustomBranchParent(state.customNodes, parentTs, msg.sourceModule);
          if (customParent) {
            parentNode = customParent;
            parentId = customParent.id;
          }
        }
        depth = parentNode ? parentNode.depth + 1 : 2;
        const count = branchCounter[parentId] || 0;
        branchCounter[parentId] = count + 1;
        targetAngle = parentNode ? parentNode.targetAngle + ((count % 7) - 3) * 0.18 : (i % 8) * Math.PI / 4;
        branchParentNode = parentNode;
        branchCount = count;
        const parentAnswerId = _graphNodeId('a', parentTs);
        parentQuestionId = answerParentQuestion[parentAnswerId] || null;
      }

      const saved = savedPositions[id];
      const radialX = (TARGET_R[depth] || 400) * Math.cos(targetAngle);
      const radialY = (TARGET_R[depth] || 400) * Math.sin(targetAngle);
      const positioned = isBranch && msg.position && Number.isFinite(msg.position.x) && Number.isFinite(msg.position.y);
      const branchX = positioned
        ? msg.position.x
        : (branchParentNode && branchParentNode.x != null ? branchParentNode.x + 420 : radialX);
      const branchY = positioned
        ? msg.position.y
        : (branchParentNode && branchParentNode.y != null ? branchParentNode.y + ((branchCount % 7) - 3) * 130 : radialY);
      let node = {
        id,
        kind: 'user',
        x: saved ? saved.x : (isRoot ? 0 : branchX),
        y: saved ? saved.y : (isRoot ? 0 : branchY),
        depth,
        targetAngle,
        isRoot,
        isBranch,
        messageIndex: i,
        timestamp: msg.timestamp,
        moduleKey: msg.sourceModule || '',
        attribute: msg.attribute || '',
        branchType: msg.branchType || 'main',
        branchLabel: msg.branchLabel || '',
        parentId: msg.parentId || '',
        minimized: !!collapsedMap[String(msg.timestamp) + ':answer'],
        pinned: !!(saved && pinnedMap[id]),
        fixedX: saved ? saved.x : null,
        fixedY: saved ? saved.y : null,
        customWidth: savedSizes[id] && savedSizes[id].u ? savedSizes[id].w : null,
        customHeight: savedSizes[id] && savedSizes[id].u ? savedSizes[id].h : null,
        userResized: !!(savedSizes[id] && savedSizes[id].u),
        w: 0, h: 0, vx: 0, vy: 0,
      };
      node = _applyHarnessOverrides(node, state);
      nodes.push(node);
      nodeById[id] = node;
      lastUserNode = node;

      if (isRoot) {
        // 锚点
      } else if (isBranch) {
        const parentTs = String(msg.parentId || '');
        let parentId = _resolveBranchModuleId(nodeById, msg);
        if (!parentId) {
          const answerId = _graphNodeId('a', parentTs);
          if (nodeById[answerId]) parentId = answerId;
        }
        // 答题链视觉：作答的问题命中某张派生「苏格拉底追问」节点时，回答节点挂到它下面
        const matchedSq = _matchSuggestedFollowupNode(nodeById, msg);
        if (matchedSq) {
          parentId = matchedSq.id;
        } else if (parentId) {
          const sqId = _graphNodeId('sq', parentTs);
          if (nodeById[sqId]) parentId = sqId;
        }
        if (!parentId) {
          const customParent = _findCustomBranchParent(state.customNodes, parentTs, msg.sourceModule);
          if (customParent) parentId = customParent.id;
        }
        if (parentId) {
          const parentNode = nodeById[parentId];
          // 端口优先级：消息显式 fromPort（新数据）> 按问题文本推断（旧数据）> 顺延分配
          let fromPort = String(msg.fromPort || '');
          if (!fromPort) fromPort = _inferBranchFromPort(parentNode, msg, messages);
          _pushEdge(edges, parentId, id, 'primary', fromPort);
        }
      } else {
        if (lastMainAnswerId) _pushEdge(edges, lastMainAnswerId, id, 'primary');
      }
    } else {
      const parentQuestionId = lastUserNode ? lastUserNode.id : (rootQuestionId || null);
      const parentQuestion = parentQuestionId ? nodeById[parentQuestionId] : null;
      const id = _graphNodeId('a', msg.timestamp);
      if (harnessDeleted[id]) continue;
      const isBranchAnswer = !!(msg.branchType && msg.branchType !== 'main');
      const isRootAnswer = !rootAnswerId && !isBranchAnswer;
      const depth = parentQuestion ? parentQuestion.depth + 1 : 1;
      const targetAngle = parentQuestion ? parentQuestion.targetAngle + 0.04 : -Math.PI / 2;
      const saved = savedPositions[id];
      const radialX = (TARGET_R[depth] || 400) * Math.cos(targetAngle);
      const radialY = (TARGET_R[depth] || 400) * Math.sin(targetAngle);
      const positionedAnswer = isBranchAnswer && msg.position && Number.isFinite(msg.position.x) && Number.isFinite(msg.position.y);
      const branchX = positionedAnswer
        ? msg.position.x
        : (isBranchAnswer && parentQuestion && parentQuestion.x != null ? parentQuestion.x + 360 : radialX);
      const branchY = positionedAnswer
        ? msg.position.y + 170
        : (isBranchAnswer && parentQuestion && parentQuestion.y != null ? parentQuestion.y + 150 : radialY);
      let node = {
        id,
        kind: 'answer',
        x: saved ? saved.x : branchX,
        y: saved ? saved.y : branchY,
        depth,
        targetAngle,
        isRoot: false,
        isRootAnswer,
        isBranch: isBranchAnswer,
        messageIndex: i,
        timestamp: msg.timestamp,
        moduleKey: '',
        branchType: msg.branchType || 'main',
        branchLabel: msg.branchLabel || '',
        parentId: msg.parentId || '',
        pinned: !!(saved && pinnedMap[id]),
        fixedX: saved ? saved.x : null,
        fixedY: saved ? saved.y : null,
        customWidth: savedSizes[id] && savedSizes[id].u ? savedSizes[id].w : null,
        customHeight: savedSizes[id] && savedSizes[id].u ? savedSizes[id].h : null,
        userResized: !!(savedSizes[id] && savedSizes[id].u),
        w: 0, h: 0, vx: 0, vy: 0,
      };
      node = _applyHarnessOverrides(node, state);
      nodes.push(node);
      nodeById[id] = node;
      answerParentQuestion[id] = parentQuestionId;
      if (parentQuestionId) _pushEdge(edges, parentQuestionId, id, 'primary');
      if (!isBranchAnswer) {
        lastMainAnswerId = id;
        if (!rootAnswerId) rootAnswerId = id;
      }

      const sections = _splitGraphSections((typeof parseXmlSections === 'function') ? parseXmlSections(msg.content || '') : {});
      const keys = _graphModuleKeys(sections);
      if (keys.length && !keys.includes('viz')) keys.push('viz');
      const spread = Math.max(0.28, 0.36 * keys.length / 5);
      keys.forEach((key, idx) => {
        const moduleId = _graphNodeId('m', msg.timestamp, key);
        if (harnessDeleted[moduleId]) return;
        const mDepth = depth + 1;
        const mAngle = targetAngle + (idx - (keys.length - 1) / 2) * spread;
        const savedM = savedPositions[moduleId];
        const mRadialX = (TARGET_R[mDepth] || 400) * Math.cos(mAngle);
        const mRadialY = (TARGET_R[mDepth] || 400) * Math.sin(mAngle);
        const mBranchX = node.isBranch && node.x != null
          ? node.x + (idx - (keys.length - 1) / 2) * 160
          : mRadialX;
        const mBranchY = node.isBranch && node.y != null
          ? node.y + 250
          : mRadialY;
        let mNode = {
          id: moduleId,
          kind: 'module',
          x: savedM ? savedM.x : mBranchX,
          y: savedM ? savedM.y : mBranchY,
          depth: mDepth,
          targetAngle: mAngle,
          isRoot: false,
          isBranch: node.isBranch,
          messageIndex: i,
          timestamp: msg.timestamp,
          moduleKey: key,
          branchType: msg.branchType || 'main',
          branchLabel: msg.branchLabel || '',
          parentId: msg.parentId || '',
          hidden: !!hiddenMap[String(msg.timestamp) + ':' + key],
          minimized: !!collapsedMap[String(msg.timestamp) + ':' + key],
          pinned: !!(savedM && pinnedMap[moduleId]),
          fixedX: savedM ? savedM.x : null,
          fixedY: savedM ? savedM.y : null,
          customWidth: savedSizes[moduleId] && savedSizes[moduleId].u ? savedSizes[moduleId].w : null,
          customHeight: savedSizes[moduleId] && savedSizes[moduleId].u ? savedSizes[moduleId].h : null,
          userResized: !!(savedSizes[moduleId] && savedSizes[moduleId].u),
          w: 0, h: 0, vx: 0, vy: 0,
        };
        mNode = _applyHarnessOverrides(mNode, state);
        nodes.push(mNode);
        nodeById[moduleId] = mNode;
        _pushEdge(edges, id, moduleId, 'primary');
      });

      // 苏格拉底反馈的建议追问：直接复用自定义「苏格拉底追问」模块节点（用户拍板：与
      // 手建的追问节点同款同渲染，不再另做卡片）——首次遇到该反馈时在 customNodes 落一个
      // 永久条目（id 稳定 = sq-反馈ts），此后渲染/编辑/删除/折叠全走既有自定义节点链路；
      // 删除经 deleteCustomNode 的 harnessDeleted 墓碑防止下次构建复活。
      if (msg.branchType === 'socratic' || /<socratic_meta\b/i.test(String(msg.content || ''))) {
        const suggested = _parseSuggestedFollowupQuestions(msg.content);
        if (suggested.length) {
          const sqId = _graphNodeId('sq', msg.timestamp);
          let cn = (state.customNodes || []).find(item => item.id === sqId);
          if (!cn && !harnessDeleted[sqId]) {
            const savedSq = savedPositions[sqId];
            const sqX = savedSq ? savedSq.x : (node.isBranch && node.x != null ? node.x + (keys.length ? 190 * keys.length : 0) : radialX);
            const sqY = savedSq ? savedSq.y : (node.isBranch && node.y != null ? node.y + (keys.length ? 430 : 250) : radialY);
            state.customNodes = state.customNodes || [];
            cn = {
              id: sqId,
              kind: 'module',
              moduleKey: 'socratic',
              sqAuto: true,
              manual: false,
              content: '### 苏格拉底追问\n\n' + suggested.map(q => '- [' + q.levelName + '] ' + q.question).join('\n'),
              status: 'done',
              summary: suggested.map(q => q.question).join('；').slice(0, 120),
              items: suggested,
              parentId: id,
              timestamp: msg.timestamp,
              createdAt: msg.timestamp,
              x: sqX,
              y: sqY,
              depth: depth + 1,
              targetAngle,
              isRoot: false,
              busy: false,
              generated: true,
            };
            state.customNodes.push(cn);
            state.connections = state.connections || [];
            if (!state.connections.some(e => String(e.from) === String(id) && String(e.to) === String(sqId))) {
              state.connections.push({ from: id, fromPort: 'out-' + ANSWER_OUTPUT_INDEX.socratic, to: sqId, toPort: 'in-0', type: 'custom', custom: true });
            }
            addedSqCustom = true;
          }
          if (cn && !nodeById[sqId]) materializeCustom(cn);
        }
      }
    }
  }

  // 自定义节点实体化（函数声明提升：派生追问块在消息循环内也会调用）；
  // nodeById 已有同 id 时跳过（sq 块已在循环内实体化，避免双份）
  function materializeCustom(cn) {
    if (cn.kind === 'knowledge') _retireLegacyKnowledgeNode(cn);
    const saved = savedPositions[cn.id] || {};
    const size = savedSizes[cn.id] || {};
    const kind = GRAPH_CUSTOM_NODE_KINDS.includes(cn.kind) ? cn.kind : 'blank';
    let node = {
      ...cn,
      id: cn.id,
      kind,
      x: saved.x != null ? saved.x : (cn.x || 0),
      y: saved.y != null ? saved.y : (cn.y || 0),
      // junction（2026-10-11）进 depth 3 组：走线锚点多落在源与目标之间，
      // 放顶层（depth 1）会被自动整理扔到画布最上一行
      depth: cn.depth != null ? cn.depth : ((kind === 'blank' || kind === 'module' || kind === 'hub' || kind === 'junction') ? 3 : (kind === 'answer' || kind === 'direct') ? 2 : (kind === 'summary' || kind === 'note' ? 4 : 1)),
      targetAngle: cn.targetAngle != null ? cn.targetAngle : 0,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
      isRoot: !!cn.isRoot,
      isBranch: false,
      messageIndex: -1,
      timestamp: cn.timestamp || 0,
      moduleKey: cn.moduleKey || '',
      content: cn.content || '',
      branchType: cn.branchType || '',
      pinned: !!(saved && pinnedMap[cn.id]),
      fixedX: saved && pinnedMap[cn.id] ? saved.x : (cn.fixedX || null),
      fixedY: saved && pinnedMap[cn.id] ? saved.y : (cn.fixedY || null),
      // u=1 才允许把保存的测量尺寸兜底成 custom 尺寸（同消息节点口径）：
      // 否则首次保存的即时测量值会在下次重建时冻结住，内容一变就空余/内滚
      customWidth: cn.customWidth || (size.u ? size.w : null) || null,
      customHeight: cn.customHeight || (size.u ? size.h : null) || null,
      userResized: !!(cn.userResized || size.u),
      minimized: !!cn.minimized,
      hidden: !!cn.hidden,
    };
    nodes.push(node);
    nodeById[node.id] = node;
  }
  (state.customNodes || []).forEach(cn => {
    if (harnessDeleted[cn.id] || cn.hidden || nodeById[cn.id]) return;
    materializeCustom(cn);
  });

  if (addedSqCustom && typeof _saveGraphState === 'function') {
    try { _saveGraphState(state); } catch (e) { /* 持久化失败不影响本次渲染 */ }
  }

  // T393：首帧 w/h 先用持久化 sizes 垫底。T376 的 content-visibility 让屏外卡只报
  // 占位盒，_measureNodes 会跳过这类读数（见 graph-render.js 那一节）；没有初值，
  // 这些节点会以 0 尺寸参与自动排版与分组包含。customWidth/Height 永远优先——那是
  // 用户手动拖过的尺寸，sizes 里的测量值只作兜底。
  for (const node of nodes) {
    const size = savedSizes[node.id];
    if (node.customWidth > 0) node.w = node.customWidth;
    else if (size && size.w > 0) node.w = size.w;
    if (node.customHeight > 0) node.h = node.customHeight;
    else if (size && size.h > 0) node.h = size.h;
  }

  return { nodes, edges: _mapAnswerDefaultPorts(_assignDefaultPorts(edges), nodeById), nodeById };
}

// _edgeKey 已上移到 utils.js（与 harness.js 共用一份，见那里的说明）

function _normalizeGraphEdge(edge) {
  return {
    ...edge,
    fromPort: edge.fromPort || 'out-0',
    toPort: edge.toPort || 'in-0',
  };
}

// T263：配方节点的具名输入口数与基础输入口数。声明了 ports.inputs 就替换默认的
// 1 个匿名口（顺序＝端口索引 in-0..k），附加匿名口始终排在具名口之后；无声明回落 1。
function _nodeDeclaredInputCount(node) {
  if (node && node.kind === 'module' && node.recipeId && typeof _recipeInputPorts === 'function') {
    return _recipeInputPorts(node).length;
  }
  return 0;
}

function _nodeBaseInputPortCount(node) {
  if (node && node.kind === 'module') return Math.max(1, _nodeDeclaredInputCount(node));
  return (node && node.kind === 'relation') ? 2 : 1;
}

function _freeModuleInputPort(state, toNodeId, preferredPort) {
  const used = new Set([
    ...(state.connections || []),
    ...(graphView.defaultEdges || []),
  ]
    .filter(edge => String(edge.to) === String(toNodeId))
    .map(edge => edge.toPort || 'in-0'));
  let index = parseInt(String(preferredPort || 'in-0').replace('in-', ''), 10) || 0;
  while (used.has('in-' + index)) index += 1;
  return { port: 'in-' + index, index };
}

function _resolveGraphEdges(state, defaults, nodeById) {
  const removed = new Set(state.removedEdges || []);
  const custom = (state.connections || [])
    .map(_normalizeGraphEdge)
    .filter(edge => nodeById[edge.from] && nodeById[edge.to] && edge.from !== edge.to);
  const edges = [];
  const occupiedInputs = new Set();
  const occupiedOutputs = new Set();

  for (const customEdge of custom) {
    const inputKey = customEdge.to + ':' + customEdge.toPort;
    const toNode = nodeById[customEdge.to];
    // hub 与 junction 的输入允许多路汇入：多条连线可指向同一输入端口。
    // junction（2026-10-11 中转节点）同入此列——它的 in-0 就是单口多线 fan-in 口。
    const isFanInInput = toNode && (toNode.kind === 'hub' || toNode.kind === 'junction');
    if (!isFanInInput && occupiedInputs.has(inputKey)) continue;
    edges.push({ ...customEdge, type: customEdge.type || 'custom', custom: true });
    if (!isFanInInput) occupiedInputs.add(inputKey);
    occupiedOutputs.add(customEdge.from + ':' + customEdge.fromPort);
  }

  for (const defaultEdge of (defaults || [])) {
    const edge = _normalizeGraphEdge(defaultEdge);
    if (!nodeById[edge.from] || !nodeById[edge.to] || edge.from === edge.to) continue;
    if (removed.has(_edgeKey(edge))) continue;
    if (occupiedInputs.has(edge.to + ':' + edge.toPort)) continue;
    const fromNode = nodeById[edge.from];
    // 苏格拉底/进阶学习模块的问题端口允许一对多（同一问题可被多次回答），
    // 不参与输出端口占用去重。
    const multiOutFrom = fromNode.kind === 'module'
      && (fromNode.moduleKey === 'socratic' || fromNode.moduleKey === 'learn');
    if (!multiOutFrom && occupiedOutputs.has(edge.from + ':' + edge.fromPort)) continue;
    edges.push(edge);
    occupiedOutputs.add(edge.from + ':' + edge.fromPort);
  }

  return edges;
}

function _stripModuleHeading(content, moduleKey) {
  let text = String(content || '').trim();
  text = text.replace(/^#{1,6}\s*[^\n]*PhyMathia\s*学习卡片\s*[:：]?\s*[^\n]*\n?/i, '').trim();
  const patterns = {
    physics: /^#{1,6}\s*[^\n]*(物理直觉|物理视角)[^\n]*\n?/i,
    math: /^#{1,6}\s*[^\n]*(数学本质|数学视角)[^\n]*\n?/i,
    graph: /^#{1,6}\s*[^\n]*知识图谱[^\n]*\n?/i,
    viz: /^#{1,6}\s*[^\n]*(交互探索|交互式可视化)[^\n]*\n?/i,
    extend: /^#{1,6}\s*[^\n]*延伸思考[^\n]*\n?/i,
    socratic: /^#{1,6}\s*[^\n]*(苏格拉底追问|延伸思考)[^\n]*\n?/i,
    learn: /^#{1,6}\s*[^\n]*(进阶学习方向|进阶学习)[^\n]*\n?/i,
  };
  const pattern = patterns[moduleKey];
  return pattern ? text.replace(pattern, '').trim() : text;
}

// stateArg（2026-10-24）：历史对比要按"那个版本自己的覆盖表"取正文，不能读当前画布的
// _graphState()——否则旧版本会被当前覆盖污染，比出来的差异是假的。不传＝原行为。
function _nodeContent(message, node, stateArg) {
  if (!message) return node.content || '';
    const _state = (stateArg && typeof stateArg === 'object')
      ? stateArg
      : (typeof _graphState === 'function' ? _graphState() : {});
    const _ov = ((_state && _state.harnessNodeOverrides) || {})[node.id];
    if (_ov && _ov.content != null) {
      const _text = String(_ov.content);
      if (node.kind === 'answer') return _graphAnswerPreview(_graphAnswerDisplayContent(_text, message, node));
      return _text;
    }
  if (node.kind === 'user') return message.content || '';
  if (node.kind === 'answer') {
    const summary = _graphSummary(_graphFormulaDelimit(message.content));
    if (summary) return summary;
    return _graphAnswerPreview(_graphAnswerDisplayContent(message.content, message, node));
  }
  if (node.kind === 'module') {
    const sections = _splitGraphSections((typeof parseXmlSections === 'function') ? parseXmlSections(message.content || '') : {});
    if (node.moduleKey === 'viz') {
      const section = sections.viz ? _stripModuleHeading(sections.viz, 'viz') : '';
      if (section && (typeof _hasVisualizationHtml === 'function' ? _hasVisualizationHtml(section) : /```html[\s\S]*?```/i.test(section))) {
        return section;
      }
      // 兼容旧消息：主模型生成/补齐的 HTML 可能不在 <viz> 内，画布节点回退显示完整 HTML 块。
      const fallback = typeof _findCompleteHtmlBlock === 'function' ? _findCompleteHtmlBlock(message.content || '') : '';
      if (fallback) return fallback;
      if (section) return section;
      return '暂未生成交互式可视化内容';
    }
    return _stripModuleHeading(sections[node.moduleKey] || '', node.moduleKey);
  }
  return '';
}

function _graphSearchPlainText(text) {
  let out = String(text || '');
  if (typeof stripXmlTags === 'function') out = stripXmlTags(out);
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  out = out.replace(/\$\$?/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

