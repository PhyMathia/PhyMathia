// ===== PhyMathia 知识网络画布：画布渲染、交互动作、选择与拖拽 =====

// T68：mermaid 节点级可见性门控——恢复画布此前对整图 .mermaid 全量即时解析
// （首屏长任务大头之一）。改 IntersectionObserver：含 mermaid 块的节点进视口
// （含 800px 余量，平移先解析后可见）才逐节点解析，长任务拆小；renderMermaidInElement
// 按 data-processed 跳已解析块、SVG 结果另有缓存，二次进入近免费。观察器在每次
// 全量重建后重挂（graphInner 会换实例）。
let _mermaidIO = null;
function _scheduleGraphMermaidRender() {
  clearTimeout(_graphMermaidTimer);
  _graphMermaidTimer = setTimeout(() => {
    _graphMermaidTimer = null;
    if (typeof renderMermaidInElement !== 'function' || !graphInner) return;
    if (!('IntersectionObserver' in window)) { renderMermaidInElement(graphInner).catch(() => {}); return; }
    const pendingNodes = Array.from(graphInner.querySelectorAll('.graph-node'))
      .filter(n => n.querySelector('.mermaid:not([data-processed="true"])'));
    if (!pendingNodes.length) return;
    if (_mermaidIO) _mermaidIO.disconnect();
    _mermaidIO = new IntersectionObserver(entries => {
      const hits = entries.filter(e => e.isIntersecting).map(e => e.target);
      if (!hits.length) return;
      hits.forEach(el => _mermaidIO.unobserve(el));
      // 节点可能在等待期被重建移除——已不在文档里的跳过
      for (const el of hits) {
        if (el.isConnected) renderMermaidInElement(el).catch(() => {});
      }
    }, { root: null, rootMargin: '800px 0px', threshold: 0 });
    pendingNodes.forEach(n => _mermaidIO.observe(n));
  }, 500);
}

function renderGraphCanvas(streaming) {
  graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;
  if (streaming) {
    clearTimeout(_graphMermaidTimer);
    _graphMermaidTimer = null;
  }
  const state = _graphState();
  const messages = _getChatHistory();
  graphView.selectedNodeIds = new Set();
  graphView.boxSelect = null;
  if (streaming && graphInner && graphView.nodes.length && messages.length) {
    _patchGraphStreaming(messages, state);
    return;
  }
  const appContainer = document.querySelector('.app-container');

  // T152：草稿卡是纯内存节点（不入 state），这里的全量清空会连卡带字一起冲掉
  // （发送开始/流结束/Φ 改图都走全量重建）——清空前先收集现存草稿，重建后带回
  const draftCarry = _collectDraftCarry();
  _removeSelectionBox();
  graphCanvas.innerHTML = '';
  graphView.nodes = [];
  graphView.edges = [];
  graphView.nodeById = {};
  if (!messages.length) {
    if (!(state.customNodes || []).length) {
      appContainer?.classList.add('graph-empty-active');
      graphView.selectMode = false;
      graphCanvas.innerHTML = `
        <div class="graph-new-session-wrap">
          <div class="graph-node graph-node-root graph-new-session-node">
            <div class="graph-node-header"><span class="graph-node-badge">新问题</span></div>
            <div class="graph-node-label">PhyMathia 探索网</div>
            <textarea class="graph-new-session-input" placeholder="问一个物理或数学问题..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.sendGraphNewSession(this)}"></textarea>
            <div class="graph-new-session-actions">
              <button class="graph-new-session-btn" onclick="sendGraphNewSession(this)">提问</button>
            </div>
          </div>
        </div>`;
      _applyGraphTextSelectionMode();
      return;
    }
    appContainer?.classList.remove('graph-empty-active');
  }
  appContainer?.classList.remove('graph-empty-active');

  // 裸图标浮层（2026-09-24 拍板：玻璃胶囊与右上角同质化）——容器只留布局不带磨砂，
  // 按钮静息透明、hover/激活才出小片；别给逐个按钮套 backdrop-filter，十来个 blur 层白烧性能。
  // 同日二拍：12 键一长条拆两簇——右下「看图 + 助手 + 产出」，左下「改图与审查」
  // （--left 变体，graph-override.css 第 4 段）；图体检/历史面板的锚定也随触发钮挪到左下。
  const toolbar = document.createElement('div');
  toolbar.className = 'graph-canvas-toolbar';
  toolbar.innerHTML = '<button class="graph-tool-btn graph-search-btn" onclick="toggleGraphSearchPanel()" title="搜索节点" aria-label="搜索节点" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-tool-glyph-lg" onclick="zoomGraph(1.2)" title="放大">+</button>'
    + '<button class="graph-tool-btn graph-tool-glyph-lg" onclick="zoomGraph(0.85)" title="缩小">−</button>'
    + '<button class="graph-tool-btn graph-tool-glyph-lg graph-tool-fit-btn" onclick="fitGraph()" title="适配画布">⌂</button>'
    + '<button class="graph-tool-btn" onclick="autoArrangeGraph()" title="自动整理">⌗</button>'
    + '<button class="graph-tool-btn graph-harness-btn" onclick="toggleGraphPet()" title="Φ 网络助手" aria-label="Φ 网络助手" aria-pressed="true">'
    + '<span class="graph-harness-btn-phi">Φ</span></button>'
    + '<button class="graph-tool-btn graph-export-btn" onclick="toggleGraphExportMenu()" title="导出" aria-label="导出">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>'
    + '</svg></button>';
  graphCanvas.appendChild(toolbar);
  const toolbarEdit = document.createElement('div');
  toolbarEdit.className = 'graph-canvas-toolbar graph-canvas-toolbar--left';
  toolbarEdit.innerHTML = '<button class="graph-tool-btn" onclick="toggleGraphConsistencyPanel()" title="图体检（孤儿/断链/重复标签）">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"></path><polyline points="9 12 11 14 15 10"></polyline>'
    + '</svg></button>'
    + '<button class="graph-tool-btn" onclick="toggleGraphHistoryPanel()" title="修改历史（撤销/重做/回到任意版本）">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-select-btn" onclick="graphToggleTextSelection()" title="选择文字" aria-label="选择文字" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M8 4v16"></path><path d="M16 4v16"></path><path d="M12 2v20"></path>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-link-btn" onclick="toggleGraphLinkMode()" title="联系模式（点两个节点添加联系箭头）" aria-label="联系模式" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M9 12h6"></path><path d="M9 12a3 3 0 1 1-3-3"></path><path d="M15 12a3 3 0 1 0 3-3"></path><line x1="12" y1="5" x2="12" y2="19"></line>'
    + '</svg></button>'
    + '<button class="graph-tool-btn" onclick="graphCreateGroup()" title="将选中节点创建为分组" aria-label="将选中节点创建为分组">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>'
    + '<line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line>'
    + '</svg></button>';
  graphCanvas.appendChild(toolbarEdit);
  _applyGraphTextSelectionMode();
  _applyGraphLinkMode();
  if (typeof window.syncGraphPetToggleButton === 'function') window.syncGraphPetToggleButton();
  _syncGraphSearchButtonState();
  if (graphSearchOpen) requestAnimationFrame(_performGraphSearch);

  graphInner = document.createElement('div');
  graphInner.className = 'graph-canvas-inner';
  graphCanvas.appendChild(graphInner);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-edge-layer');
  svg.setAttribute('width', 1);
  svg.setAttribute('height', 1);
  graphEdgeLayer = svg;
  graphInner.appendChild(svg);

  const savedPositions = state.layoutVersion === LAYOUT_VERSION ? (state.positions || {}) : {};
  const needsFit = state.layoutVersion !== LAYOUT_VERSION || Object.keys(savedPositions).length === 0;

  const data = _buildGraphData(messages, state);
  graphView.defaultEdges = data.edges;
  graphView.nodes = data.nodes;
  graphView.nodeById = data.nodeById;
  graphView.edges = _resolveGraphEdges(state, data.edges, data.nodeById);
  graphView.groups = Array.isArray(state.groups) ? state.groups.map(group => ({ ...group })) : [];
  _syncGroupMembers();
  _reapplyDraftCarry(draftCarry); // T152：带回要赶在节点 html 拼接之前，草稿卡才会随重建重新渲染出来

  _katexPendingCaptures = []; // 只收本轮全量重建的节点（流式补丁期间的残留作废，重建会重新登记）
  const html = graphView.groups.map(group => _renderGroupHtml(group)).join('')
    + graphView.nodes.map(n => _renderNodeHtml(n, messages, state)).join('');
  graphInner.insertAdjacentHTML('beforeend', html);

  _applyGraphTransform();

  requestAnimationFrame(() => {
    // T69：KaTeX 可视性分档——只铺视口内节点，屏外的进视口再分批补铺；
    // 渲染记忆回填也只收实际铺过的节点（helper 内部处理）
    if (typeof _graphKatexVisiblePass === 'function') _graphKatexVisiblePass();
    else if (typeof renderMath === 'function') renderMath(graphInner);
    if (typeof _initVizIframes === 'function') _initVizIframes(graphInner);
    _measureNodes();
    if (needsFit) _runLayout(true);
    else _updateNodeTransforms();
    _redrawEdges();
    // 预览渲染归族至 harness-preview.js（T261 拆分）：viewer 子集无该文件，守卫调用
    if (typeof _renderGraphHarnessPreview === 'function') _renderGraphHarnessPreview();
    _scheduleGraphMermaidRender();
  });

  if (state.layoutVersion !== LAYOUT_VERSION) {
    state.layoutVersion = LAYOUT_VERSION;
    _saveGraphState(state);
  }
}

function sendGraphNewSession(el) {
  const node = el && el.closest ? el.closest('.graph-new-session-node') : null;
  const input = node && node.querySelector('.graph-new-session-input');
  const text = input ? input.value.trim() : '';
  if (text && typeof window.startQuestionWorkflow === 'function') window.startQuestionWorkflow(text);
}

function graphModuleAction(action, nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node) return;
  // 最小化对消息派生节点与自定义节点统一处理（自定义节点没有 messageIndex）
  if (action === 'minimize') {
    _toggleGraphNodeMinimize(node);
    return;
  }
  const messages = _getChatHistory();
  const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  const parentId = String((message && message.timestamp) || node.timestamp || '');
  // T361：追问/没看懂一律落工作流链路（宿主节点现场解析），消息簇链路退役——
  // 自定义节点（messageIndex<0）过去在这里直接 return，两条链路语义不一致（T363）。
  if (action === 'followup') {
    if (typeof followUpModule === 'function') followUpModule(node.moduleKey || 'extend', parentId, undefined, node.id);
  } else if (action === 'confused') {
    if (typeof dontUnderstandModule === 'function') dontUnderstandModule(node.moduleKey || 'extend', parentId, undefined, node.id);
  } else if (action === 'delete') {
    _deleteSingleGraphNode(node);
  }
}

// ===== T361：分支入口的宿主节点解析（消息派生节点与自定义节点同口径）=====
// 画布上的「追问/没看懂/方向钮/苏格拉底作答」过去各自按消息锚点走消息链；退役后一律
// 先解析出宿主节点 id（自定义节点按 timestamp+moduleKey 匹配，消息派生节点按
// m-<ts>-<module> 复原，都落空再退回同 timestamp 的模块/回答节点），再交工作流建点。
function _resolveBranchHostNode(parentTs, sourceModule) {
  const ts = String(parentTs || '');
  if (!ts) return null;
  const state = (typeof _graphState === 'function') ? _graphState() : {};
  const custom = (typeof _findCustomBranchParent === 'function')
    ? _findCustomBranchParent(state.customNodes || [], ts, sourceModule || '')
    : null;
  if (custom) {
    const live = _findGraphNode(custom.id);
    if (live) return live;
  }
  const candidates = [];
  if (sourceModule) candidates.push(_graphNodeId('m', ts, sourceModule));
  if (sourceModule === 'extend') {
    candidates.push(_graphNodeId('m', ts, 'socratic'));
    candidates.push(_graphNodeId('m', ts, 'learn'));
  }
  candidates.push(_graphNodeId('a', ts));
  for (const id of candidates) {
    const node = _findGraphNode(id);
    if (node) return node;
  }
  // 兜底：同 timestamp 的模块/回答节点（自定义节点 timestamp 可能与消息不同）
  const byTs = (graphView.nodes || []).find(n => String(n.timestamp || '') === ts
    && (n.kind === 'module' || n.kind === 'answer')
    && (!sourceModule || !n.moduleKey || n.moduleKey === sourceModule));
  return byTs || null;
}

// 分支从宿主节点的哪个输出口长出去：按端口标签（追问/进阶学习/回答练习）在已渲染的
// 输出口里找，找不到退回 out-0（各模块基础出口表的第一口正好就是它）。
function _branchSourcePort(node, branchType) {
  if (!node) return 'out-0';
  const want = branchType === 'learn' ? ['进阶学习', '进阶方向']
    : branchType === 'socratic' ? ['回答练习', '问题1']
      : ['追问'];
  try {
    const el = (typeof graphInner !== 'undefined' && graphInner && graphInner.querySelector)
      ? graphInner.querySelector('[data-node-id="' + node.id + '"]') : null;
    if (el) {
      const raw = el.querySelectorAll ? el.querySelectorAll('.graph-output-port') : null;
      const ports = (raw && typeof raw.length === 'number') ? Array.prototype.slice.call(raw) : [];
      const decode = (v) => { try { return v ? decodeURIComponent(v) : ''; } catch (e) { return v || ''; } };
      for (const port of ports) {
        const label = decode(port.dataset && port.dataset.portLabel);
        if (want.includes(label)) return (port.dataset && port.dataset.portId) || 'out-0';
      }
      if (ports.length) return (ports[0].dataset && ports[0].dataset.portId) || 'out-0';
    }
  } catch (e) { /* 沙箱/半渲染态取不到 DOM 时按基础第一口 */ }
  return 'out-0';
}

function _toggleGraphNodeMinimize(node) {
  const nextMinimized = !node.minimized;
  node.minimized = nextMinimized;
  const state = _graphState();
  if (node.messageIndex >= 0 && (node.kind === 'module' || node.kind === 'answer')) {
    // 消息派生模块/回答簇：沿用 collapsed 映射持久化
    const messages = _getChatHistory();
    const message = messages[node.messageIndex];
    const parentId = message ? String(message.timestamp || '') : '';
    const moduleKey = node.kind === 'module' ? node.moduleKey : 'answer';
    if (typeof window.setModuleVisibility === 'function') {
      window.setModuleVisibility(parentId, moduleKey, 'collapsed', nextMinimized);
    }
  } else if (state && Array.isArray(state.customNodes)) {
    // 自定义节点：minimized 状态直接写入 customNodes 并保存
    const idx = state.customNodes.findIndex(function (cn) { return String(cn.id) === String(node.id); });
    if (idx >= 0) {
      state.customNodes[idx].minimized = nextMinimized;
      _saveGraphState(state);
    }
  }
  const el = graphInner && graphInner.querySelector ? graphInner.querySelector('[data-node-id="' + node.id + '"]') : null;
  // T69：折叠卡当初没建内容子树（占位符），首次展开走整卡重建
  // （_refreshWorkflowNodeUi 自带 KaTeX/mermaid/测量/重画），不只是切类
  if (el && !nextMinimized && el.querySelector('[data-body-ph]')) {
    if (typeof _refreshWorkflowNodeUi === 'function') {
      _refreshWorkflowNodeUi(node);
      return;
    }
  }
  if (el) {
    el.classList.toggle('minimized', nextMinimized);
    if (nextMinimized) {
      el.style.removeProperty('width');
      el.style.removeProperty('min-width');
      el.style.removeProperty('max-width');
      el.style.removeProperty('height');
      el.style.removeProperty('min-height');
    } else {
      if (node.customWidth) {
        el.style.setProperty('width', node.customWidth + 'px', 'important');
        el.style.setProperty('min-width', node.customWidth + 'px', 'important');
        el.style.setProperty('max-width', node.customWidth + 'px', 'important');
      }
      if (node.customHeight) {
        el.style.setProperty('height', node.customHeight + 'px', 'important');
        el.style.setProperty('min-height', node.customHeight + 'px', 'important');
      }
    }
    const toggle = el.querySelector('.graph-node-minimize-toggle');
    if (toggle) {
      toggle.textContent = nextMinimized ? '+' : '−';
      toggle.title = nextMinimized ? '展开' : '最小化';
    }
    _measureNodes();
    _updateNodeTransforms();
    _redrawEdges();
  }
}

function _startLinkDrag(event, portEl) {
  event.preventDefault();
  event.stopPropagation();
  const nodeEl = portEl.closest('.graph-node');
  const node = nodeEl ? _findGraphNode(nodeEl.dataset.nodeId) : null;
  if (!node) return;
  const isInput = portEl.classList.contains('graph-input-port');
  const decodeAttr = (value) => {
    try { return value ? decodeURIComponent(value) : ''; } catch (e) { return value || ''; }
  };
  let itemMeta = null;
  if (portEl.dataset.portItem) {
    try { itemMeta = JSON.parse(decodeAttr(portEl.dataset.portItem)); } catch (e) { itemMeta = null; }
  }
  graphView.linkDrag = {
    mode: isInput ? 'input' : 'output',
    nodeId: node.id,
    portId: portEl.dataset.portId,
    portMeta: {
      type: portEl.dataset.portType || (isInput ? 'input' : 'branch'),
      branchType: portEl.dataset.portBranch || (isInput ? '' : 'followup'),
      attribute: portEl.dataset.attribute || '',
      question: decodeAttr(portEl.dataset.portQuestion),
      level: portEl.dataset.portLevel || '',
      label: decodeAttr(portEl.dataset.portLabel),
      item: itemMeta,
      dragCreates: portEl.dataset.portDrag ? decodeAttr(portEl.dataset.portDrag) : '',
      // T264 内容类型管线：输出口 DOM 的 data-port-content-type（配方口有值）透传给
      // 拖拽对象，将来「输入口按内容类型点亮」等按类型的功能从这里取源数据
      contentType: portEl.dataset.portContentType || '',
    },
    pointerId: event.pointerId,
    currentX: null,
    currentY: null,
  };
  graphView.pointerId = event.pointerId;
  graphView.moved = false;
  graphCanvas?.classList.add('linking');
  _redrawEdges();
}

// 拖线松手/悬停共用的「落点在哪个节点身上」：只认 .graph-node 祖先，落在端口上时
// 上层分支已先行处理，这里兜底返回同一节点（端口也在节点内）。
function _linkDragNodeEl(event) {
  if (!event.target || typeof event.target.closest !== 'function') return null;
  return event.target.closest('.graph-node');
}

// 拖线悬停高亮（2026-10-10 统一吸附）：指针下方是「松手即可吸附」的节点时打高亮，
// 让用户松手前就知道会连上。输出口拖拽认「能加输入口」的目标；输入口拖拽认「至少有
// 一个输出口」的目标；自己永远不高亮（自连禁）。指针捕获会让 event.target 恒为起点
// 端口，所以用 elementFromPoint 做真实命中测试。
function _updateLinkDragHover(clientX, clientY) {
  _clearLinkDragHover();
  const drag = graphView.linkDrag;
  if (!drag) return;
  const hit = (typeof document !== 'undefined' && document.elementFromPoint)
    ? document.elementFromPoint(clientX, clientY)
    : null;
  const nodeEl = hit && typeof hit.closest === 'function' ? hit.closest('.graph-node') : null;
  if (!nodeEl || !graphInner || !graphInner.contains(nodeEl)) return;
  if (nodeEl.dataset.nodeId === drag.nodeId) return;
  if (drag.mode === 'output') {
    const target = _findGraphNode(nodeEl.dataset.nodeId);
    // junction（2026-10-11）固定单进口（不加口门里关着），但它就是合法的汇入
    // 落点——悬停高亮放行，松手走 _connectPorts 的 in-0 扇入
    const targetOk = target && (target.kind === 'junction'
      || (typeof _nodeCanAddInputPorts === 'function' && _nodeCanAddInputPorts(target)));
    if (targetOk) {
      nodeEl.classList.add('graph-link-drop-target');
    }
  } else if (nodeEl.querySelector('.graph-output-port')) {
    nodeEl.classList.add('graph-link-drop-target');
  }
}

function _clearLinkDragHover() {
  graphInner?.querySelectorAll('.graph-node.graph-link-drop-target').forEach(el => el.classList.remove('graph-link-drop-target'));
}

function _connectPorts(fromNodeId, fromPort, toNodeId, toPort) {
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
  const fromNode = _findGraphNode(fromNodeId);
  const toNode = _findGraphNode(toNodeId);
  if (!_canConnect(fromNode, fromPort, toNode)) {
    _flashInvalidConnection();
    return;
  }
  _pushGraphUndo();
  const state = _graphState();
  state.connections = state.connections || [];
  state.removedEdges = state.removedEdges || [];
  state.connections = state.connections.filter(c => {
    const sameSource = c.from === fromNodeId && (c.fromPort || 'out-0') === fromPort;
    const sameInput = c.to === toNodeId && (c.toPort || 'in-0') === toPort;
    // junction（2026-10-11）扇出口子：源是中转节点时同源边不顶掉——out-0 一源
    // 可带多目标（1→多/多→多都靠这条）。hub 的同口互顶（汇聚口按"替换来源"语义）
    // 与 junction 的单口多线 fan-in 不互斥，各自原样。
    if (sameSource && fromNode.kind === 'junction') return true;
    return !sameSource && (toNode.kind !== 'hub' || !sameInput);
  });
  let resolvedToPort = toPort || 'in-0';
  // 统一吸附/自动长口（2026-10-10）：凡是过加口门的节点，连线一律「瞄准的口空着就用
  // 它、占用就顺延到下一个空口、口不够就长一个」——此前只有配方模块享有（T263），
  // hub 退役后多路汇拢全靠这条路径。isRoot 根卡基础口数与渲染口径一致取 0。
  if (typeof _nodeCanAddInputPorts === 'function' && _nodeCanAddInputPorts(toNode)) {
    const free = _freeModuleInputPort(state, toNodeId, resolvedToPort);
    resolvedToPort = free.port;
    const baseCount = toNode.isRoot ? 0 : _nodeBaseInputPortCount(toNode);
    state.inputPortCounts = state.inputPortCounts || {};
    state.inputPortCounts[toNodeId] = Math.max(
      state.inputPortCounts[toNodeId] || 0,
      Math.max(0, free.index - baseCount + 1)
    );
  }
  const edge = {
    from: fromNodeId,
    fromPort: fromPort || 'out-0',
    to: toNodeId,
    toPort: resolvedToPort,
    type: 'custom',
    custom: true,
  };
  state.removedEdges = state.removedEdges.filter(key => key !== _edgeKey(edge));
  state.connections.push(edge);
  _saveGraphState(state);
  // 建边会改输出口「待命名」继承身份（T266 是渲染时从 graphView.edges 现算的）——
  // 必须全量重渲染（内部自会重解析边），只重画线层不更新端口文字
  renderGraphCanvas();
}

function _createKnowledgeNodeFromPort(sourceNode, sourcePortId, portMeta, x, y) {
  const item = portMeta.item || {};
  const state = _graphState();
  _pushGraphUndo();
  const nodeId = 'knowledge-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: nodeId,
    kind: 'knowledge',
    moduleKey: 'knowledge',
    manual: true,
    content: item.summary || item.title || '',
    status: 'done',
    summary: item.summary || '',
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
    fileId: sourceNode.fileId || '',
    fileName: sourceNode.fileName || '',
    generatedNodeIds: [],
    title: item.title || '知识点',
    category: item.category || 'other',
    tags: item.tags || [],
    formulas: item.formulas || [],
    knowledgeKey: item.id || item.title || nodeId,
    sourceNodeId: sourceNode.id,
    x,
    y,
    depth: 3,
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: 260,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  state.connections = state.connections || [];
  state.connections.push({
    from: sourceNode.id,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphState(state);
  renderGraphCanvas();
}

function _createQuestionNodeFromPort(sourceNode, sourcePortId, portMeta, x, y) {
  const state = _graphState();
  _pushGraphUndo();
  const nodeId = 'question-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const sourceText = sourceNode.title || sourceNode.summary || _nodeStoredContent(sourceNode) || '该知识点';
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: nodeId,
    kind: 'user',
    moduleKey: '',
    manual: true,
    content: '请讲解：' + sourceText,
    status: 'done',
    summary: '',
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
    fileId: sourceNode.fileId || '',
    fileName: sourceNode.fileName || '',
    generatedNodeIds: [],
    category: sourceNode.category || 'other',
    formulas: sourceNode.formulas || [],
    knowledgeKey: sourceNode.knowledgeKey || '',
    sourceNodeId: sourceNode.id,
    x,
    y,
    depth: 2,
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: 300,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  state.connections = state.connections || [];
  state.connections.push({
    from: sourceNode.id,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphState(state);
  renderGraphCanvas();
}

function _createBranchNodeFromOutput(sourceNodeId, sourcePortId, portMeta, x, y) {
  if (phyIsReadonly()) { phyReadonlyBlock('创建分支'); return; }
  const sourceNode = graphView.nodeById[sourceNodeId];
  if (!sourceNode || !portMeta) return;

  const label = String(portMeta.label || '');
  const type = String(portMeta.type || '');
  const branchType = String(portMeta.branchType || '');
  // 节点配方（P1）：出口声明的拖出目标（drag_creates）优先于内置启发式。
  // draft 不拦（落回下面的默认草稿路径）；user 建预填问题节点；connected:<key>
  // 建已连线的官方入口节点。未声明或非配方端口走原逻辑，内置节点行为零变化。
  const dragForm = String(portMeta.dragCreates || '');
  if (dragForm === 'user') {
    _createQuestionNodeFromPort(sourceNode, sourcePortId, portMeta, x, y);
    return;
  }
  if (/^connected:[a-z_]+$/.test(dragForm)) {
    _createConnectedManualNode(dragForm.slice('connected:'.length), x, y, sourceNodeId, sourcePortId);
    return;
  }
  const option = _findManualOptionByPort(portMeta);
  // 待命名附加输出口（＋手动加出、未连线继承名字）：身份未定，拖到空处不再预设
  // 「提问」（source 的 knowledge fallback 也让位）——打开添加节点面板（与双击空白
  // 同款）由用户自己选；选中后经挂起连线（addBlankNodePendingLink →
  // _consumePendingPortLink）建点即自动连回本口，关闭面板则什么都不建。
  // 具名口不进此分支（身份已定，沿用各自拖出目标：问题/追问口→提问卡、
  // 知识点口→知识点节点、配方口→drag_creates 声明）。
  // 269：显示名可能是「连线采纳来的」（匿名附加口连上输入口后继承下游身份——名字
  // 是下游类型不是提问语义），不能只认「待命名」三个字。身份现场按基础出口表重算
  // （与渲染 adopted 判定同一事实源）：序数落在表外＝附加口，已采纳名也走面板分支；
  // 不信拖拽 dataset 的显示名（采纳名渲染时已写进 dataset，手里那份 portMeta 已被污染）。
  const portIndex = parseInt(String(sourcePortId || 'out-0').replace('out-', ''), 10) || 0;
  const basePorts = typeof _nodeBaseOutputPorts === 'function' && typeof _getChatHistory === 'function'
    ? _nodeBaseOutputPorts(sourceNode, _getChatHistory())
    : null;
  const isAdditionalPort = Array.isArray(basePorts) && portIndex >= basePorts.length;
  // T272：junction 的单出口是基础口（恒在出口表内，附加口判定够不着），但它没有
  // 自己的拖出目标——拖空同样开添加节点面板（挂起连线同款），选中后自动接回本口；
  // 过去落到默认草稿路径建 draft 提问卡，从中继往外再接一个中转凭空多两步。
  if (label === '待命名' || isAdditionalPort || sourceNode.kind === 'junction') {
    openAddBlankNodeModal(x, y);
    addBlankNodePendingLink = { sourceNodeId, sourcePortId: sourcePortId || 'out-0' };
    return;
  }
  if (type === 'knowledge') {
    _createKnowledgeNodeFromPort(sourceNode, sourcePortId, portMeta, x, y);
    return;
  }
  if (sourceNode.kind === 'knowledge' && (label === '问题' || portMeta.attribute === 'question')) {
    _createQuestionNodeFromPort(sourceNode, sourcePortId, portMeta, x, y);
    return;
  }
  const questionLike = label === '追问' || label === '直接问AI' || label === '没看懂' || label === '回答练习'
    || /^追问/.test(label)
    || type === 'socratic'
    || type === 'learn'
    || branchType === 'confused'
    || branchType === 'continue'
    || branchType === 'learn';

  if (option && !questionLike) {
    _createConnectedManualNode(option.key, x, y, sourceNodeId, sourcePortId);
    return;
  }

  const messages = _getChatHistory();
  const sourceMessage = sourceNode.messageIndex >= 0 ? messages[sourceNode.messageIndex] : null;
  const sourceModule = sourceNode.moduleKey || '';
  const meta = {
    ...portMeta,
    sourceModule,
    parentId: String(sourceMessage?.timestamp || sourceNode.timestamp || ''),
    fromPort: sourcePortId || '',
  };
  const nodeId = 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const draftNode = {
    id: nodeId,
    kind: 'draft',
    x,
    y,
    w: 340,
    h: 180,
    vx: 0,
    vy: 0,
    isRoot: false,
    isBranch: true,
    messageIndex: -1,
    timestamp: Date.now(),
    moduleKey: sourceModule,
    // T152：标记所属会话——全量重渲带回草稿时只带本会话的，防切会话串场
    sessionId: _currentSessionId(),
    branchType: meta.branchType || 'followup',
    portMeta: meta,
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: 340,
    customHeight: null,
    minimized: false,
  };
  graphView.nodes.push(draftNode);
  graphView.nodeById[nodeId] = draftNode;
  graphView.edges.push({
    from: sourceNodeId,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'draft',
    custom: true,
    draft: true,
  });
  graphInner.insertAdjacentHTML('beforeend', _renderDraftNodeHtml(draftNode));
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

function _findManualOptionByPort(portMeta) {
  const candidates = [portMeta?.label, portMeta?.attribute, portMeta?.type].filter(Boolean);
  return MANUAL_NODE_OPTIONS.find(option =>
    candidates.some(candidate => candidate === option.key || candidate === option.label)
  ) || null;
}

function _createConnectedManualNode(optionKey, x, y, sourceNodeId, sourcePortId) {
  const option = MANUAL_NODE_OPTIONS.find(item => item.key === optionKey);
  if (!option) return;
  _pushGraphUndo();
  const state = _graphState();
  state.customNodes = state.customNodes || [];
  const nodeId = option.key + '-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  state.customNodes.push({
    id: nodeId,
    kind: option.kind,
    moduleKey: option.kind === 'module' || option.kind === 'hub' || option.kind === 'summary' || option.kind === 'note' ? option.key : '',
    manual: option.key === 'manual' || option.key === 'human_note' || option.key === 'note' || option.key === 'relation' || option.key === 'source' || option.key === 'knowledge',
    nodeType: option.key === 'human_note' ? 'understanding' : '',
    label: option.key === 'human_note' ? option.label : '',
    formula: '',
    source: option.key === 'manual' || option.key === 'human_note' || option.key === 'note' ? 'human' : 'ai',
    content: '',
    status: 'empty',
    summary: '',
    analysis: '',
    analysisHash: '',
    inputHash: '',
    generatedAt: 0,
    requirements: '',
    busy: false,
    generated: false,
    maxItems: option.key === 'source' ? 5 : 0,
    items: [],
    edges: [],
    fileId: '',
    fileName: '',
    generatedNodeIds: [],
    category: '',
    formulas: [],
    knowledgeKey: '',
    x,
    y,
    depth: option.kind === 'user' ? 1 : option.kind === 'answer' ? 2 : (option.key === 'summary' || option.key === 'note' ? 4 : 3),
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: option.key === 'human_note' ? 280 : null,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  state.connections = state.connections || [];
  state.connections.push({
    from: sourceNodeId,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphState(state);
  renderGraphCanvas();
}

function _findDraftNode(nodeId) {
  return graphView.nodeById[nodeId] || null;
}

function buildGraphPathForAnchor(anchor) {
  const parentId = String(anchor?.parentId || '');
  if (!parentId) return [];
  const sourceModule = anchor?.sourceModule || '';
  let current = null;
  const candidates = [];
  // 复用分支父模块解析（含 extend → socratic/learn 别名），再回退答案节点
  const modId = (typeof _resolveBranchModuleId === 'function')
    ? _resolveBranchModuleId(graphView.nodeById || {}, { parentId, sourceModule, branchType: anchor?.branchType || '' })
    : null;
  if (modId) candidates.push(modId);
  candidates.push(_graphNodeId('a', parentId));
  for (const id of candidates) {
    current = _findGraphNode(id);
    if (current) break;
  }
  if (!current) {
    return [{ kind: 'answer', timestamp: parentId, module: sourceModule || '' }];
  }
  const ordered = [];
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    ordered.push(current);
    const incoming = (graphView.edges || []).find(edge => String(edge.to) === current.id);
    current = incoming ? _findGraphNode(incoming.from) : null;
  }
  ordered.reverse();
  return ordered.map(node => ({
    kind: node.kind,
    timestamp: node.timestamp || '',
    module: node.moduleKey || '',
    branchType: node.branchType || '',
  }));
}

function _findDraftSourceNodeId(nodeId) {
  const edge = (graphView.edges || []).find(e => String(e.to) === String(nodeId) && e.draft);
  return edge ? edge.from : '';
}

// T152：草稿输入的持久位在节点对象——textarea 的值只活在本帧 DOM，任何一次
// 全量重渲都会整卡重建；输入即写回，重建的卡从对象取值（见 _renderDraftNodeHtml）
function draftInputChanged(nodeId, value) {
  const node = _findDraftNode(nodeId);
  if (node && node.kind === 'draft') node.draftInput = String(value == null ? '' : value);
}

// T152：全量重建前收集现存草稿（只收本会话的，切会话不跟人）；
// 草稿边一并收集，草稿卡才会带着来源连线一起回来
function _collectDraftCarry() {
  const sid = String(_currentSessionId() || '');
  return {
    nodes: (graphView.nodes || []).filter(n => n && n.kind === 'draft' && String(n.sessionId || '') === sid),
    edges: (graphView.edges || []).filter(e => e && e.draft),
  };
}

// T152：重建后把收集到的草稿带回 graphView（同 id 已被重建出来的跳过；
// 边两端都还在才带）——须在 _renderNodeHtml 拼接前调用，卡才会重新渲染出来
function _reapplyDraftCarry(carry) {
  if (!carry || !carry.nodes.length) return;
  const existIds = new Set(graphView.nodes.map(n => String(n.id)));
  const readd = carry.nodes.filter(n => !existIds.has(String(n.id)));
  if (!readd.length) return;
  graphView.nodes.push(...readd);
  readd.forEach(n => { graphView.nodeById[String(n.id)] = n; });
  graphView.edges.push(...carry.edges.filter(e => graphView.nodeById[String(e.from)] && graphView.nodeById[String(e.to)]));
}

function submitDraftQuestion(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const input = graphInner?.querySelector('[data-node-id="' + nodeId + '"] .graph-draft-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  const meta = node.portMeta || {};
  const sourceNodeId = _findDraftSourceNodeId(nodeId);
  if (typeof window.startQuestionWorkflow === 'function') {
    window.startQuestionWorkflow(text, { sourceNodeId: sourceNodeId || '', sourcePort: meta.fromPort || '', draftNodeId: nodeId });
  }
}

function draftSocraticAnswer(nodeId) {
  if (phyIsReadonly()) { phyReadonlyBlock('作答追问'); return; }
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const meta = node.portMeta || {};
  if (typeof window.startSocraticAnswer === 'function') {
    // 第 7 参传来源端口：回答完成后新节点连回被拖出的那个问题端口；
    // 第 8 参（T361）：草稿知道自己从哪颗节点拖出来，直接带给工作流落点，
    // 不靠 timestamp 反查（草稿端口是「问题1/2/3」，反查要落到 socratic 模块节点上）
    window.startSocraticAnswer(meta.question || '', meta.level || 'basic', meta.parentId || '', meta.sourceModule || 'extend', node.x, node.y, meta.fromPort || '',
      { sourceNodeId: _findDraftSourceNodeId(nodeId) || '', sourcePort: meta.fromPort || '' });
  }
}

function draftAskAi(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const meta = node.portMeta || {};
  const question = meta.question || '';
  // 空问题不再静默退出（T56②）：兜底端口没解析出问题文本时给出去向，而不是点了
  // 没反应；配方侧的根治是 fallback.mode: label_questions_from_text（P2 落地）
  if (!question) {
    toastMsg('这个出口没有解析出可用的问题文本，请直接在草稿里输入后发送');
    return;
  }
  const sourceNodeId = _findDraftSourceNodeId(nodeId);
  if (typeof window.startQuestionWorkflow === 'function') {
    window.startQuestionWorkflow(question, { sourceNodeId: sourceNodeId || '', sourcePort: meta.fromPort || '', draftNodeId: nodeId });
  }
}

function removeDraftNode(nodeId) {
  const node = graphView.nodeById[nodeId];
  if (!node || node.kind !== 'draft') return;
  graphView.nodes = graphView.nodes.filter(item => item.id !== nodeId);
  delete graphView.nodeById[nodeId];
  graphView.edges = graphView.edges.filter(edge => edge.to !== nodeId && edge.from !== nodeId);
  graphInner?.querySelector('[data-node-id="' + nodeId + '"]')?.remove();
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

function _extractRawModuleSection(content, moduleKey) {
  const text = String(content || '');
  if (moduleKey === 'socratic' || moduleKey === 'learn') {
    const extendMatch = text.match(/<extend>([\s\S]*?)<\/extend>/i);
    return extendMatch ? _stripModuleHeading(extendMatch[1], moduleKey) : '';
  }
  const re = new RegExp('<' + moduleKey + '>([\\s\\S]*?)</' + moduleKey + '>', 'i');
  const match = text.match(re);
  return match ? match[1].trim() : '';
}

function _replaceExtendSubsection(extendContent, moduleKey, newSection) {
  const header = moduleKey === 'socratic' ? '苏格拉底追问' : '进阶学习方向';
  const re = new RegExp('(^|\\n)(#{1,6}\\s*[^\\n]*' + header + '[^\\n]*\\n?)([\\s\\S]*?)(?=\\n#{1,6}\\s*[^\\n]*(?:苏格拉底追问|进阶学习方向)[^\\n]*|$)', 'i');
  if (re.test(String(extendContent || ''))) {
    return String(extendContent || '').replace(re, (match, pre, heading, oldContent) => {
      return pre + heading + String(newSection || '').trim();
    });
  }
  return String(extendContent || '') + '\n\n## ' + header + '\n' + String(newSection || '').trim();
}

function _replaceModuleContent(content, moduleKey, reply) {
  const text = String(content || '');
  let newSection = String(reply || '').trim();
  const tagRe = new RegExp('<' + moduleKey + '>([\\s\\S]*?)</' + moduleKey + '>', 'i');
  const tagMatch = newSection.match(tagRe);
  if (tagMatch) newSection = tagMatch[1].trim();

  if (moduleKey === 'socratic' || moduleKey === 'learn') {
    const innerExtend = newSection.match(/<extend>([\s\S]*?)<\/extend>/i);
    if (innerExtend) newSection = _stripModuleHeading(innerExtend[1], moduleKey);
    else newSection = _stripModuleHeading(newSection, moduleKey);
    const extendMatch = text.match(/<extend>([\s\S]*?)<\/extend>/i);
    if (extendMatch) {
      const updated = _replaceExtendSubsection(extendMatch[1], moduleKey, newSection);
      return text.replace(/<extend>[\s\S]*?<\/extend>/i, '<extend>\n' + updated.trim() + '\n</extend>');
    }
  }

  const escaped = String(moduleKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<' + escaped + '>[\\s\\S]*?</' + escaped + '>', 'i');
  if (re.test(text)) {
    return text.replace(re, () => '<' + moduleKey + '>\n' + newSection.trim() + '\n</' + moduleKey + '>');
  }
  return text + '\n<' + moduleKey + '>\n' + newSection.trim() + '\n</' + moduleKey + '>';
}

async function _regenerateModuleContent(message, moduleKey, confusion) {
  if (moduleKey === 'viz') {
    // 可视化模块必须返回完整 HTML 页面，优先使用专门的 HTML 模型，失败时回退主模型。
    if (typeof _requestVisualizationHtml !== 'function') throw new Error('可视化生成模块未加载，请刷新页面后重试');
    const html = await _requestVisualizationHtml(
      message?.content || '',
      new AbortController().signal,
      '用户对当前版本有反馈/新要求：' + (confusion || '整体重新生成一版，换一种讲法')
    );
    return _replaceModuleContent(message?.content || '', moduleKey, '## 交互探索\n\n```html\n' + html + '\n```');
  }

  const moduleLabel = (GRAPH_MODULE_META[moduleKey] || {}).label || moduleKey;
  const original = _extractRawModuleSection(message?.content || '', moduleKey) || '（没有原内容）';
  // 2026-10-13 泛化：从「没看懂→一律简讲」扩成「按用户反馈/要求定向修订」——写了具体
  // 问题只改该问题，提出新要求按要求调，留空（可留空直发）才整体换讲法。
  const prompt = '用户对下面「' + moduleLabel + '」模块的当前版本不满意，或对它有新的要求。'
    + '请只重新生成这个模块，不改变其他模块。'
    + '规则：用户指出了具体问题时，只针对该问题修改，没提到的部分尽量原样保留；'
    + '用户提出了新要求时，按要求调整；用户没有说明具体问题时，换一种更清楚、更生活化的讲法整体重讲。'
    + '保留公式和 Markdown；如果是苏格拉底追问或进阶学习，只输出该小节内容，格式不变。\n\n'
    + '当前版本：\n' + original + '\n\n用户的反馈或要求：\n'
    + (confusion || '（用户没有具体说明，请换一种讲法重讲）');
  let reply = '';

  if (typeof getActiveModelForRole === 'function') {
    let agentModel = getActiveModelForRole('agent');
    if ((moduleKey === 'socratic' || moduleKey === 'learn') && typeof getActiveModelForRole === 'function') {
      const branchModel = getActiveModelForRole('branch');
      if (branchModel) agentModel = branchModel;
    }
    if (agentModel && typeof proxyChatWithModel === 'function' && typeof collectStreamText === 'function') {
      const resp = await proxyChatWithModel(agentModel, {
        messages: [
          { role: 'system', content: getLevelPrompt() },
          { role: 'user', content: prompt }
        ],
        stream: true,
        session_bucket: 'phymathia-module',
        // 槽位思考（2026-10-11）：苏格拉底/进阶学习重生成走 branch 槽，其余跟主模型槽
        thinking: getSlotThinkingForRole(moduleKey === 'socratic' || moduleKey === 'learn' ? 'branch' : 'agent'),
      });
      reply = await collectStreamText(resp);
      if (reply.trim()) return _replaceModuleContent(message?.content || '', moduleKey, reply);
    }
  }

  if (typeof showToast === 'function') showToast('未配置 AI 模型，请在模型设置中配置');
  throw new Error('未配置 AI 模型，请在模型设置中配置');
}

const _generatingVizNodes = new Set();

// 生成交互可视化。忙时排队（2026-10-11）：过去这里直接挡回去（「正在生成回答，稍候再
// 生成可视化」）——用户点了只得到一句拒绝。现在收进队列，轮到它时队列把视图切回这张画布。
// 它自己那颗 AbortController 也接上了任务账：面板上的「停」掐得掉这条流（过去是一颗
// 谁都不认领的 controller）。
async function generateVizNode(nodeId, fromQueue = false, handoffTaskId = null) {
  if (_generatingVizNodes.has(nodeId)) return;
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    _enqueueNodeJob('生成可视化', function(taskId) {
      if (typeof _queuedJobNodeGuard === 'function' && !_queuedJobNodeGuard(taskId, nodeId)) return;
      return generateVizNode(nodeId, true, taskId);
    }, {
      kind: 'node',
      replay: { nodeJob: { id: nodeId, kind: 'viz' } },
    });
    return;
  }
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'module' || node.moduleKey !== 'viz') return;
  const messages = _getChatHistory();
  const message = messages[node.messageIndex];
  if (!message) return;

  const jobAbort = new AbortController();
  const taskId = (typeof _taskBeginNodeJob === 'function')
    ? _taskBeginNodeJob({ title: '生成可视化', nodeId: nodeId, nodeKind: 'viz' })
    : null;
  if (handoffTaskId && typeof _taskFinish === 'function') _taskFinish(handoffTaskId, 'done', '已交给生成');
  if (taskId && typeof _taskBindCancel === 'function') _taskBindCancel(taskId, () => jobAbort.abort());

  _generatingVizNodes.add(nodeId);
  try {
    const nextContent = await ensureVisualization(message.content || '', jobAbort.signal);
    if (nextContent === message.content) {
      throw new Error('模型未返回完整 HTML 页面，请检查模型配置后重试');
    }
    const updated = typeof window.updateChatHistoryMessage === 'function'
      ? window.updateChatHistoryMessage(message.timestamp, item => ({ ...item, content: nextContent }))
      : false;
    if (!updated) throw new Error('未找到对应的回答消息');
    if (typeof saveCurrentSession === 'function') await saveCurrentSession();
    if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
    if (typeof renderCurrentChat === 'function') await renderCurrentChat();
    else if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof hideProgress === 'function') hideProgress();
    if (typeof window.setProgressTerminal === 'function') window.setProgressTerminal('可视化已生成');
    if (typeof showToast === 'function') showToast('交互可视化已生成');
    if (taskId && typeof _taskFinish === 'function') _taskFinish(taskId, 'done');
  } catch (err) {
    const aborted = jobAbort.signal.aborted || (err && err.name === 'AbortError');
    console.warn('Generate visualization node failed:', err);
    if (typeof hideProgress === 'function') hideProgress();
    if (!aborted && typeof showToast === 'function') showToast('生成可视化失败：' + (err.message || err));
    if (taskId && typeof _taskFinish === 'function') {
      _taskFinish(taskId, aborted ? 'stopped' : 'error', aborted ? '已停止' : ((err && err.message) || '生成失败'));
    }
  } finally {
    _generatingVizNodes.delete(nodeId);
  }
}

// 「没看懂」重生成的内核出口：任务列表的「重试」要按当初那句要求原样重跑（tasks.js 的
// replay.nodeJob.kind==='regen'），而那时候面板早就没了——所以留一个不经 UI 的入口。
// 2026-10-13 起按节点分流量：消息模块节点走 _applyNodeRegenerate（写回 message），
// 工作流节点（含知识点）走 _applyWorkflowNodeRegenerate（写回 node.content）。
window.regenNodeWith = function(nodeId, confusion) {
  const node = _findGraphNode(nodeId);
  if (node && !(node.messageIndex >= 0)) return _applyWorkflowNodeRegenerate(nodeId, confusion || '');
  return _applyNodeRegenerate(nodeId, confusion || '');
};

// ===== 重新生成预警（T303，方案 A：只提示不拦链）=====
// 数下游：沿已保存连线 BFS（穿过中转/汇聚的直通都算），返回不含自己的可达节点数。
function _countDownstreamNodes(nodeId) {
  const state = _graphState();
  const connections = (state && state.connections) || [];
  const start = String(nodeId);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    connections.forEach(c => {
      if (!c) return;
      const to = String(c.to || '');
      if (String(c.from) === cur && to && !seen.has(to)) { seen.add(to); queue.push(to); }
    });
  }
  return seen.size - 1;
}

// 下游里人工定稿（T355 humanDone）的颗数：重生成上游不会覆盖这些节点的内容，
// 预警里单独点名，用户才知道哪些下游受保护、哪些才是真的可能失效
function _countDownstreamHumanDone(nodeId) {
  const state = _graphState();
  const connections = (state && state.connections) || [];
  const start = String(nodeId);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    connections.forEach(c => {
      if (!c) return;
      const to = String(c.to || '');
      if (String(c.from) === cur && to && !seen.has(to)) { seen.add(to); queue.push(to); }
    });
  }
  let count = 0;
  seen.forEach(id => {
    if (id === start) return;
    const node = typeof _findGraphNode === 'function' ? _findGraphNode(id) : null;
    if (node && node.humanDone) count += 1;
  });
  return count;
}

// 用户拍板口径：说「可能失效」不说「会失效」——下游是按旧内容生成的，对不对得
// 上要看新旧内容差多少，系统不替用户断言。面板路（没看懂/重新生成）提示写在面板
// 里、点发送即确认；直接按钮路（工作流/空白/知识点）走 confirm。无下游一律不打扰。
// 返回 false＝用户取消，调用方就此打住。
function _warnDownstreamBeforeRegenerate(node) {
  if (!node) return true;
  const n = _countDownstreamNodes(node.id);
  if (!n) return true;
  const humanCount = _countDownstreamHumanDone(node.id);
  const humanNote = humanCount ? '\n其中 ' + humanCount + ' 颗是你人工定稿的内容，重新生成不会覆盖它们。' : '';
  return confirm('该节点重新生成后，下游 ' + n + ' 颗节点可能失效。' + humanNote + '\n仍要重新生成吗？');
}

function graphOpenRegenerate(nodeId) {
  const node = _findGraphNode(nodeId);
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  if (!node || !el) return;
  const existing = el.querySelector('.graph-regenerate-panel');
  if (existing) {
    existing.remove();
    el.classList.remove('graph-regen-open');
    _measureNodes();
    _updateNodeTransforms();
    return;
  }
  const main = el.querySelector('.graph-node-main');
  if (!main) return;
  const downstreamCount = _countDownstreamNodes(nodeId);
  const humanCount = typeof _countDownstreamHumanDone === 'function' ? _countDownstreamHumanDone(nodeId) : 0;
  const warnHtml = downstreamCount
    ? '<div class="graph-regenerate-warn">该节点重新生成后，下游 ' + downstreamCount + ' 颗节点可能失效'
      + (humanCount ? '；其中 ' + humanCount + ' 颗人工定稿内容不会被覆盖' : '') + '</div>'
    : '';
  // 面板开着的宿主节点抬到兄弟节点之上：画布按 DOM 顺序叠放，下游节点常压住面板
  // 按钮排（真机实证：物理视角的面板被正下方的数学视角整卡盖住，按钮点不到——
  // T336 遮挡同族）。面板收起/节点重绘时随重建自然回落
  el.classList.add('graph-regen-open');
  main.insertAdjacentHTML('beforeend',
    '<div class="graph-regenerate-panel">'
    + '<textarea class="graph-regenerate-input" rows="3" placeholder="哪里不满意，或想加点什么？可留空。例如：第三步跳步了 / 太啰嗦 / 换个比喻"></textarea>'
    + warnHtml
    + '<div class="graph-regenerate-actions">'
    + '<button class="graph-draft-btn" onclick="closeRegeneratePanel(\'' + nodeId + '\')">取消</button>'
    + '<button class="graph-draft-btn graph-draft-send graph-icon-btn" onclick="submitRegenerateNode(\'' + nodeId + '\')" title="重新生成此节点">' + _sendPlaneIconHtml() + '</button>'
    + '</div></div>'
  );
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

function closeRegeneratePanel(nodeId) {
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  el?.querySelector('.graph-regenerate-panel')?.remove();
  el?.classList.remove('graph-regen-open');
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

// 「没看懂 / 重新生成」的内核：只干这一件事，失败**抛出去**（调用方各自决定怎么
// 提示、怎么记账）。从面板点的那条路在上面包一层错误显示；排队那条路由队列接住异常，
// 面板上那条任务会自动标「失败」。
// _regeneratingNodes 是这颗节点自己的忙态（T58「防并发重入」的正确口径）：
// 过去画布把 `isStreaming`（别处的回答在生成）当成它的忙态、直接置灰按钮，等于把
// 排队入口自己封了（2026-10-11 改：别处忙 → 排队；这颗自己忙 → 才置灰）。
const _regeneratingNodes = new Set();

async function _applyNodeRegenerate(nodeId, confusion) {
  if (_regeneratingNodes.has(nodeId)) return;
  _regeneratingNodes.add(nodeId);
  try {
    const node = _findGraphNode(nodeId);
    if (!node || !(node.messageIndex >= 0)) throw new Error('节点已不在画布上');
    const messages = _getChatHistory();
    const message = messages[node.messageIndex];
    if (!message) throw new Error('节点已不在画布上');
    const newContent = await _regenerateModuleContent(message, node.moduleKey, confusion);
    const updated = typeof window.updateChatHistoryMessage === 'function'
      ? window.updateChatHistoryMessage(message.timestamp, item => ({ ...item, content: newContent }))
      : false;
    if (!updated) throw new Error('未找到对应的回答消息');
    if (typeof saveCurrentSession === 'function') await saveCurrentSession();
    else if (typeof saveSessionMessages === 'function') {
      await saveSessionMessages(currentSessionId, typeof chatHistory !== 'undefined' ? chatHistory : _getChatHistory());
    }
    if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
    if (typeof renderCurrentChat === 'function') await renderCurrentChat();
  } finally {
    _regeneratingNodes.delete(nodeId);
  }
}

// ===== 工作流节点（含知识点）的「带要求重生成」（2026-10-13）=====
// 主流程画布上只有工作流节点，「重新生成」过去点了直跑、没处写字。现在按钮也弹
// graphOpenRegenerate 面板：留空直发＝回 runWorkflowNode 原管线整体重跑（现状行为）；
// 写了字＝修订式——旧内容+用户反馈一起喂模型，只改用户指出的点，其余尽量保留。
function _regenNodeActionLabel(node) {
  if (!node) return '重新生成';
  if (node.kind === 'knowledge') return '重新生成知识点' + (node.title ? '：' + node.title : '');
  const metaLabel = (GRAPH_MODULE_META[node.moduleKey] || {}).label;
  return '重新生成' + (metaLabel || node.title || '节点');
}

async function _regenWorkflowNodeContent(node, text, signal, oldContent) {
  const label = node.kind === 'knowledge' ? (node.title || '知识点')
    : ((GRAPH_MODULE_META[node.moduleKey] || {}).label || node.title || '节点');
  // 修订底稿由调用方显式传入（T339：开跑前 content 已被版本账清空，不能再从节点上读）
  const old = String(oldContent != null ? oldContent : node.content || '').trim();
  if (!old) throw new Error('节点还没有内容，直接用「生成」即可');
  const prompt = '用户对下面「' + label + '」节点的当前内容不满意，或对它有新的要求。请重写整份内容。\n'
    + '规则：用户指出了具体问题时，只针对该问题修改，没提到的部分尽量原样保留；'
    + '用户提出了新要求时，按要求调整；用户没有说明具体问题时，换一种讲法整体重写，不要原样照抄。'
    + '保留公式与 Markdown 结构，公式仍按 <formula> 规范标注。\n\n'
    + '当前内容：\n' + old + '\n\n用户的反馈或要求：\n' + text;
  let model = null;
  let role = 'agent';
  // 模型槽跟这颗节点生成时同槽（配方/苏格拉底·进阶/可视化的专用槽照旧生效），回退主模型
  if (typeof _slotCallForWorkflowNode === 'function') {
    const slot = _slotCallForWorkflowNode(node);
    if (slot) { model = slot.model; role = slot.role || 'agent'; }
  }
  if (!model && typeof getActiveModelForRole === 'function') model = getActiveModelForRole('agent');
  if (!model || typeof proxyChatWithModel !== 'function' || typeof collectStreamText !== 'function') {
    if (typeof showToast === 'function') showToast('未配置 AI 模型，请在模型设置中配置');
    throw new Error('未配置 AI 模型，请在模型设置中配置');
  }
  const resp = await proxyChatWithModel(model, {
    messages: [
      { role: 'system', content: getLevelPrompt() },
      { role: 'user', content: prompt },
    ],
    stream: true,
    session_bucket: 'phymathia-module',
    thinking: getSlotThinkingForRole(role),
  }, signal);
  const reply = await collectStreamText(resp);
  if (!(reply || '').trim()) throw new Error('模型返回了空内容');
  return reply;
}

async function _applyWorkflowNodeRegenerate(nodeId, text) {
  if (_regeneratingNodes.has(nodeId)) return;
  const node = _findGraphNode(nodeId);
  if (!node) throw new Error('节点已不在画布上');
  if (!(text || '').trim()) {
    // 留空直发＝现状重跑。confirmed=true：下游提醒已写在面板里，发送即确认，不再二弹。
    return runWorkflowNode(nodeId, true, false, null, true);
  }
  _regeneratingNodes.add(nodeId);
  // 修订式也要进工作流忙态（2026-10-15 用户实证：徽标全程钉在「完成」，看不出在跑）：
  // 置 busy 后重绘，徽标「完成→生成中」、按钮区「生成中...」，与留空直发同观感。
  // 顺序照 _generateCustomNode 的老套路：先改账→快照→重绘（重绘从快照重建节点对象，
  // 之后的账一律 _findGraphNode 重取）。重绘会把面板收走，用户写的要求已随 text 带走。
  // 版本账（T339）：旧内容先抓出来当修订底稿（清空后 _regenWorkflowNodeContent 读不到
  // node.content 了），再收进账本、清空——修订期间节点从空白等待新版落地
  const revisionBase = String(node.content || '');
  if (typeof _beginWorkflowNodeVersionCycle === 'function') _beginWorkflowNodeVersionCycle(node);
  node.busy = true;
  node.status = 'running';
  if (typeof _saveCustomNodes === 'function') _saveCustomNodes();
  if (typeof _refreshWorkflowNodeStatusUi === 'function') _refreshWorkflowNodeStatusUi(node);
  else if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
  const jobAbort = new AbortController();
  const taskId = (typeof _taskBeginNodeJob === 'function')
    ? _taskBeginNodeJob({ title: _regenNodeActionLabel(node), nodeId: nodeId, nodeKind: node.kind })
    : null;
  if (taskId && typeof _taskBindCancel === 'function') _taskBindCancel(taskId, () => jobAbort.abort());
  let done = false;
  try {
    const reply = await _regenWorkflowNodeContent(node, text, jobAbort.signal, revisionBase);
    // 生成链里画布可能整体重建、节点对象被换成新对象：账必须读画布上活着的那个
    const live = _findGraphNode(nodeId);
    if (!live) throw new Error('节点已不在画布上');
    live.content = reply;
    live.summary = typeof _graphSummary === 'function' ? _graphSummary(reply) : reply.slice(0, 120);
    live.busy = false;
    live.generated = true;
    live.status = 'done';
    // 版本账（T339）：修订成品收作新版本
    if (typeof _commitWorkflowNodeVersion === 'function') _commitWorkflowNodeVersion(live);
    if (typeof _saveCustomNodes === 'function') _saveCustomNodes();
    if (taskId && typeof _taskFinish === 'function') _taskFinish(taskId, 'done');
    done = true;
  } catch (err) {
    const aborted = jobAbort.signal.aborted || (err && err.name === 'AbortError');
    // 忙账就地结清（与 _generateCustomNode 的 catch 同口径）：失败→「失败」徽标可重试；
    // 中止→旧内容一字未动，回「完成」。重绘从快照重建，账必须读画布上活着的那个
    const liveErr = _findGraphNode(nodeId);
    if (liveErr) {
      liveErr.busy = false;
      liveErr.status = aborted ? 'done' : 'error';
      // 版本账（T339）：生成前旧内容已收账、content 已清空，中止/失败兜回上一版
      // ——「中止→旧内容一字未动」的口径由版本账续上
      if (typeof _restoreWorkflowNodeVersion === 'function') _restoreWorkflowNodeVersion(liveErr);
    }
    if (typeof _saveCustomNodes === 'function') _saveCustomNodes();
    if (typeof _refreshWorkflowNodeStatusUi === 'function') _refreshWorkflowNodeStatusUi(liveErr);
    if (taskId && typeof _taskFinish === 'function') {
      _taskFinish(taskId, aborted ? 'stopped' : 'error', aborted ? '已停止' : ((err && err.message) || '重新生成失败'));
    }
    throw err;
  } finally {
    _regeneratingNodes.delete(nodeId);
  }
  // 渲染必须放在摘掉忙账之后：按钮的置灰态读 _regeneratingNodes，先渲染会把
  // 「重新生成」钉死在「生成中...」（真机实证：mock 验证 B 通道当场抓到）
  if (done) {
    if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
    if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
  }
}

async function submitRegenerateNode(nodeId) {
  const node = _findGraphNode(nodeId);
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  const panel = el?.querySelector('.graph-regenerate-panel');
  const input = panel?.querySelector('.graph-regenerate-input');
  if (!node || !el || !panel || !input) return;
  const text = input.value.trim();
  // 消息模块节点走 _applyNodeRegenerate（写回 message），工作流节点/知识点走
  // _applyWorkflowNodeRegenerate（写回 node.content；留空＝原管线整体重跑）。
  const isMessageModule = node.messageIndex >= 0;
  // 忙时排队（2026-10-11）：过去这条只在 isStreaming 时被按钮置灰挡住（工作流跑着反而
  // 能并发写同一颗节点）。现在统一收进队列，轮到它时切回这张画布再跑。面板先收起来——
  // 等待期间画布会重建好几次，那个 textarea 留不住；用户写的要求随队列带走。
  if (typeof _isSendBusy === 'function' && _isSendBusy()) {
    closeRegeneratePanel(nodeId);
    const label = isMessageModule
      ? '重新生成' + ((GRAPH_MODULE_META[node.moduleKey] || {}).label || '节点')
      : _regenNodeActionLabel(node);
    _enqueueNodeJob(label, function() {
      return isMessageModule ? _applyNodeRegenerate(nodeId, text) : _applyWorkflowNodeRegenerate(nodeId, text);
    }, {
      kind: 'node',
      replay: { nodeJob: { id: nodeId, kind: 'regen', text: text } },
    });
    return;
  }
  if (isMessageModule) {
    const messages = _getChatHistory();
    if (!messages[node.messageIndex]) return;
  }

  const buttons = panel.querySelectorAll('button');
  buttons.forEach(btn => { btn.disabled = true; });
  input.disabled = true;
  panel.classList.add('busy');
  try {
    if (isMessageModule) await _applyNodeRegenerate(nodeId, text);
    else {
      await _applyWorkflowNodeRegenerate(nodeId, text);
      // 成功路径画布会整体重建、面板随节点重绘消失；若面板还挂着（如直跑被静默拒绝），
      // 恢复按钮让用户能再试，别留一颗永久置灰的发送键
      const livePanel = graphInner?.querySelector('[data-node-id="' + nodeId + '"] .graph-regenerate-panel');
      const liveNode = _findGraphNode(nodeId);
      if (livePanel && liveNode && !liveNode.busy) {
        livePanel.querySelectorAll('button').forEach(btn => { btn.disabled = false; });
        const liveInput = livePanel.querySelector('.graph-regenerate-input');
        if (liveInput) liveInput.disabled = false;
        livePanel.classList.remove('busy');
      }
    }
  } catch (err) {
    console.warn('Regenerate module failed:', err);
    // 修订式（工作流节点）一开工就把节点刷进「生成中」忙态、面板随重绘收走——
    // 此刻错误只剩 toast＋任务面板两条路；消息模块路不重绘，面板还挂着，照旧写回面板
    if (panel.isConnected) {
      const errorEl = panel.querySelector('.graph-regenerate-error');
      if (errorEl) errorEl.textContent = '重新生成失败：' + (err.message || err);
      else panel.insertAdjacentHTML('beforeend', '<div class="graph-regenerate-error">重新生成失败：' + escapeHtml(err.message || String(err)) + '</div>');
      buttons.forEach(btn => { btn.disabled = false; });
      input.disabled = false;
      panel.classList.remove('busy');
    } else if (typeof showToast === 'function') {
      const aborted = err && err.name === 'AbortError';
      showToast(aborted ? '已停止重新生成' : '重新生成失败：' + (err.message || String(err)));
    }
  }
}

function _disconnectInputPort(toNodeId, toPort) {
  if (!toNodeId) return;
  _pushGraphUndo();
  const state = _graphState();
  state.connections = state.connections || [];
  state.removedEdges = state.removedEdges || [];
  state.connections = state.connections.filter(c => !(c.to === toNodeId && (c.toPort || 'in-0') === toPort));
  const removed = new Set(state.removedEdges);
  for (const edge of (graphView.defaultEdges || [])) {
    if (edge.to === toNodeId && (edge.toPort || 'in-0') === toPort) removed.add(_edgeKey(edge));
  }
  state.removedEdges = Array.from(removed);
  _saveGraphState(state);
  // 同 _connectPorts：断边让继承口回「待命名」，须全量重渲染才看得到
  renderGraphCanvas();
}

function _removeGraphEdge(edgeKey) {
  const edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
  if (!edge) return;
  if (graphView.edgeCurveEditKey === edgeKey) graphView.edgeCurveEditKey = null;
  _pushGraphUndo();
  const state = _graphState();
  state.connections = state.connections || [];
  state.removedEdges = state.removedEdges || [];
  state.connections = state.connections.filter(item => _edgeKey(item) !== edgeKey);
  if (!edge.custom) {
    state.removedEdges.push(edgeKey);
    state.removedEdges = Array.from(new Set(state.removedEdges));
  }
  _saveGraphState(state);
  // 同 _connectPorts：删边让继承口回「待命名」，须全量重渲染才看得到
  renderGraphCanvas();
}

function graphAddOutputPort(nodeId) {
  const node = _findGraphNode(nodeId);
  // 端口机制统一（2026-10-10）：权限走统一门（graph.js _nodeCanAddOutputPorts）；
  // 计数统一为绝对口径一条公式 max(存量, 基础口数)+1——官方模块旧的「存量+1」
  // 在基础口因内容重解析变多时会让加口不可见（存量追不上基数），配方侧的
  // 公式才是对的，全类统一到它
  if (!node || !_nodeCanAddOutputPorts(node)) return;
  _pushGraphUndo();
  const state = _graphState();
  state.portCounts = state.portCounts || {};
  const base = _nodeBaseOutputPorts(node, _getChatHistory()).length;
  state.portCounts[nodeId] = Math.max(state.portCounts[nodeId] || 0, base) + 1;
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphAddInputPort(nodeId) {
  const node = _findGraphNode(nodeId);
  // 端口机制统一：权限走统一门；inputPortCounts 保持附加数口径（基础口之外加几个）
  if (!node || !_nodeCanAddInputPorts(node)) return;
  _pushGraphUndo();
  const state = _graphState();
  state.inputPortCounts = state.inputPortCounts || {};
  state.inputPortCounts[nodeId] = (state.inputPortCounts[nodeId] || 0) + 1;
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphRemoveInputPort(nodeId, portIndex) {
  const node = _findGraphNode(nodeId);
  // 端口机制统一：权限走统一门；可删下限与渲染同基（isRoot 根 answer 卡基础口为 0）
  if (!node || !_nodeCanAddInputPorts(node)) return;
  // T263：基础口数配方感知（具名声明替换默认匿名口，声明口不可删，只删附加口）
  const minPort = node.isRoot ? 0 : _nodeBaseInputPortCount(node);
  if (portIndex < minPort) return;
  _pushGraphUndo();
  const state = _graphState();
  state.inputPortCounts = state.inputPortCounts || {};
  state.connections = state.connections || [];
  state.inputPortCounts[nodeId] = Math.max(0, (state.inputPortCounts[nodeId] || 0) - 1);
  state.connections = state.connections
    .map(c => {
      if (c.to !== nodeId || !/^in-\d+$/.test(String(c.toPort || ''))) return c;
      const idx = parseInt(String(c.toPort).replace('in-', ''), 10);
      if (idx === portIndex) return null;
      if (idx > portIndex) return { ...c, toPort: 'in-' + (idx - 1) };
      return c;
    })
    .filter(Boolean);
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphRemoveOutputPort(nodeId, portIndex) {
  const node = _findGraphNode(nodeId);
  // 端口机制统一（2026-10-10）：权限与基数同源——门（graph.js）判能不能删，
  // 基础口数取 _nodeBaseOutputPorts 唯一事实源，替代旧的 _baseOutputPortCount
  // 镜像链与配方快照两条分路（旧链对 hub 的基数 1 是错值，从前被门挡住没爆）。
  // 基础口不可删，删的只能是附加口；动态出口配方在门里整体锁死
  if (!node || !_nodeCanAddOutputPorts(node)) return;
  const baseCount = _nodeBaseOutputPorts(node, _getChatHistory()).length;
  if (portIndex < baseCount) return;
  const state = _graphState();
  state.portCounts = state.portCounts || {};
  const current = state.portCounts[nodeId] || 0;
  if (current <= baseCount) return;

  _pushGraphUndo();
  const portKey = 'out-' + portIndex;
  const removedDrafts = [];
  state.connections = (state.connections || [])
    .map(connection => {
      if (connection.from !== nodeId) return connection;
      const idx = parseInt(String(connection.fromPort || 'out-0').replace('out-', ''), 10);
      if (String(connection.fromPort || 'out-0') === portKey) return null;
      if (idx > portIndex) return { ...connection, fromPort: 'out-' + (idx - 1) };
      return connection;
    })
    .filter(Boolean);

  graphView.edges = (graphView.edges || [])
    .map(edge => {
      if (edge.from !== nodeId) return edge;
      const idx = parseInt(String(edge.fromPort || 'out-0').replace('out-', ''), 10);
      if (String(edge.fromPort || 'out-0') === portKey) {
        if (edge.draft && edge.to) removedDrafts.push(edge.to);
        return null;
      }
      if (idx > portIndex) return { ...edge, fromPort: 'out-' + (idx - 1) };
      return edge;
    })
    .filter(Boolean);

  removedDrafts.forEach(id => removeDraftNode(id));
  state.portCounts[nodeId] = Math.max(baseCount, current - 1);
  _saveGraphState(state);
  renderGraphCanvas();
}

// 恢复默认连线按钮已从工具栏移除；函数保留，后续如需恢复 UI 入口可直接调用。

function resetGraphConnections() {
  if (!confirm('恢复默认连线？新增的输出端口也会一并重置。')) return;
  _pushGraphUndo();
  const state = _graphState();
  delete state.connections;
  delete state.removedEdges;
  delete state.portCounts;
  _saveGraphState(state);
  renderGraphCanvas();
}

// 画布缩放限度：0.10 ~ 4.00（旧值 0.25 ~ 2.50 偏窄，放大不够细、缩小看不全大图）
const GRAPH_MIN_ZOOM = 0.1;
const GRAPH_MAX_ZOOM = 4;

function zoomGraph(factor, centerX, centerY) {
  const state = _graphState();
  const oldZoom = state.zoom || 0.9;
  const newZoom = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, oldZoom * factor));
  if (!graphCanvas) return;
  const rect = graphCanvas.getBoundingClientRect();
  const cx = (centerX != null ? centerX : rect.left + rect.width / 2) - rect.left;
  const cy = (centerY != null ? centerY : rect.top + rect.height / 2) - rect.top;
  const wx = (cx - state.pan.x) / oldZoom;
  const wy = (cy - state.pan.y) / oldZoom;
  state.pan.x = cx - wx * newZoom;
  state.pan.y = cy - wy * newZoom;
  state.zoom = newZoom;
  // 滚轮一格一次 save：本地落盘走防抖（缓存即时更新，localStorage 150ms 后合并落盘），
  // 其余 save 调用方保持同步写不变
  _saveGraphState(state, { deferLocalWrite: true });
  _applyGraphTransform();
}

function fitGraph() {
  if (!graphView.nodes.length || !graphCanvas) return;
  // T39→T259：容器残留 scrollTop/scrollLeft 会把 fit 的世界坐标整体带偏、节点顶出
  // 屏外（实测 scrollTop=409 时 6 节点 2 个在屏外）。归零已收进 _applyGraphTransform
  // 公共入口（所有写 pan/zoom 的路径统一免疫），fit 收尾必经该入口，此处不再单独清。
  const state = _graphState();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of graphView.nodes) {
    minX = Math.min(minX, n.x - (n.w || 120) / 2);
    minY = Math.min(minY, n.y - (n.h || 60) / 2);
    maxX = Math.max(maxX, n.x + (n.w || 120) / 2);
    maxY = Math.max(maxY, n.y + (n.h || 60) / 2);
  }
  const width = maxX - minX + 200;
  const height = maxY - minY + 200;
  const rect = graphCanvas.getBoundingClientRect();
  const zoom = Math.min((rect.width - 120) / width, (rect.height - 160) / height, 1.1);
  state.zoom = Math.max(GRAPH_MIN_ZOOM, zoom);
  state.pan.x = (rect.width - width * state.zoom) / 2 - minX * state.zoom;
  state.pan.y = (rect.height - height * state.zoom) / 2 - minY * state.zoom;
  _saveGraphState(state);
  _applyGraphTransform();
}

function _isGraphModifier(event) {
  return !!(event && (event.ctrlKey || event.metaKey));
}

function _syncGraphSelectionClasses() {
  if (!graphInner) return;
  graphInner.querySelectorAll('.graph-node.selected').forEach(el => el.classList.remove('selected'));
  graphInner.querySelectorAll('.graph-group.selected').forEach(el => el.classList.remove('selected'));
  graphView.selectedNodeIds.forEach(id => {
    const el = graphInner.querySelector('[data-node-id="' + id + '"]');
    if (el) el.classList.add('selected');
  });
  graphView.selectedGroupIds.forEach(id => {
    const el = graphInner.querySelector('[data-group-id="' + id + '"]');
    if (el) el.classList.add('selected');
  });
}

function _clearGraphSelection() {
  graphView.selectedNodeIds = new Set();
  graphView.selectedGroupIds = new Set();
  _syncGraphSelectionClasses();
}

function _setGraphSelection(ids, additive) {
  const next = additive ? new Set(graphView.selectedNodeIds) : new Set();
  ids.forEach(id => next.add(id));
  graphView.selectedNodeIds = next;
  if (!additive) graphView.selectedGroupIds = new Set();
  _syncGraphSelectionClasses();
}

function _toggleGraphSelection(id) {
  const next = new Set(graphView.selectedNodeIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  graphView.selectedNodeIds = next;
  _syncGraphSelectionClasses();
}

function _setGraphGroupSelection(ids, additive) {
  const next = additive ? new Set(graphView.selectedGroupIds) : new Set();
  ids.forEach(id => next.add(id));
  graphView.selectedGroupIds = next;
  if (!additive) graphView.selectedNodeIds = new Set();
  _syncGraphSelectionClasses();
}

function _toggleGraphGroupSelection(id) {
  const next = new Set(graphView.selectedGroupIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  graphView.selectedGroupIds = next;
  _syncGraphSelectionClasses();
}

function _getSelectionRect() {
  const box = graphView.boxSelect;
  if (!box) return null;
  return {
    left: Math.min(box.startX, box.currentX),
    top: Math.min(box.startY, box.currentY),
    right: Math.max(box.startX, box.currentX),
    bottom: Math.max(box.startY, box.currentY),
    width: Math.abs(box.currentX - box.startX),
    height: Math.abs(box.currentY - box.startY),
  };
}

function _renderSelectionBox() {
  if (!graphInner) return;
  let box = graphInner.querySelector('.graph-selection-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'graph-selection-box';
    graphInner.appendChild(box);
  }
  const rect = _getSelectionRect();
  if (!rect) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  box.style.left = rect.left + 'px';
  box.style.top = rect.top + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';
}

function _removeSelectionBox() {
  graphInner?.querySelector('.graph-selection-box')?.remove();
}

function _nodesInSelectionRect(rect) {
  const result = [];
  for (const node of graphView.nodes) {
    const w = node.w || 120;
    const h = node.h || 60;
    const left = node.x - w / 2;
    const top = node.y - h / 2;
    const right = left + w;
    const bottom = top + h;
    if (right >= rect.left && left <= rect.right && bottom >= rect.top && top <= rect.bottom) {
      result.push(node.id);
    }
  }
  return result;
}

function _startNodeResize(event, nodeEl) {
  const node = _findGraphNode(nodeEl.dataset.nodeId);
  if (!node) return;
  event.preventDefault();
  event.stopPropagation();
  graphView.resizeNodeId = node.id;
  graphView.pointerId = event.pointerId;
  graphView.resizeStartX = event.clientX;
  graphView.resizeStartY = event.clientY;
  graphView.resizeStartW = node.customWidth || node.w || 320;
  graphView.resizeStartH = node.customHeight || node.h || 120;
  graphView.moved = false;
}

function _startNodeDrag(event, nodeEl) {
  const node = _findGraphNode(nodeEl.dataset.nodeId);
  if (!node) return;
  event.preventDefault();
  event.stopPropagation();
  const isSelected = graphView.selectedNodeIds.has(node.id);
  const modifier = _isGraphModifier(event);
  const moveIds = new Set();
  if (isSelected) {
    graphView.selectedNodeIds.forEach(id => moveIds.add(id));
  } else if (modifier) {
    graphView.selectedNodeIds.forEach(id => moveIds.add(id));
    moveIds.add(node.id);
  } else {
    moveIds.add(node.id);
  }
  graphView.dragNodeId = node.id;
  graphView.dragWasSelected = isSelected;
  graphView.dragModifier = modifier;
  graphView.dragStartPositions = {};
  moveIds.forEach(id => {
    const n = _findGraphNode(id);
    if (n) graphView.dragStartPositions[id] = { x: n.x, y: n.y };
    const el = graphInner?.querySelector('[data-node-id="' + id + '"]');
    el?.classList.add('dragging');
  });
  graphView.pointerId = event.pointerId;
  graphView.startX = event.clientX;
  graphView.startY = event.clientY;
  graphView.moved = false;
}

function _startGroupDrag(event, groupEl) {
  const group = _graphGroupById(groupEl.dataset.groupId);
  if (!group) return;
  event.preventDefault();
  event.stopPropagation();
  graphView.dragGroupId = group.id;
  graphView.dragGroupStartX = group.x;
  graphView.dragGroupStartY = group.y;
  graphView.dragGroupNodeStartPositions = {};
  (group.nodeIds || []).forEach(id => {
    const node = _findGraphNode(id);
    if (node) graphView.dragGroupNodeStartPositions[id] = { x: node.x, y: node.y };
  });
  graphView.pointerId = event.pointerId;
  graphView.startX = event.clientX;
  graphView.startY = event.clientY;
  graphView.moved = false;
  graphInner?.querySelectorAll('.graph-group').forEach(el => el.classList.remove('dragging'));
  groupEl.classList.add('dragging');
}

function _startGroupResize(event, groupEl) {
  const group = _graphGroupById(groupEl.dataset.groupId);
  if (!group) return;
  event.preventDefault();
  event.stopPropagation();
  graphView.resizeGroupId = group.id;
  graphView.resizeGroupStartX = group.x;
  graphView.resizeGroupStartY = group.y;
  graphView.resizeGroupStartW = group.width || 320;
  graphView.resizeGroupStartH = group.height || 180;
  graphView.resizeGroupStartClientX = event.clientX;
  graphView.resizeGroupStartClientY = event.clientY;
  graphView.pointerId = event.pointerId;
  graphView.moved = false;
}

function _startCanvasPan(event) {
  event.preventDefault();
  _clearGraphTextSelection();
  if (_isGraphModifier(event)) {
    const point = _clientToGraphLocal(event.clientX, event.clientY);
    graphView.boxSelect = {
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      additive: true,
    };
    graphView.pointerId = event.pointerId;
    graphView.moved = false;
    graphCanvas?.classList.add('box-selecting');
    _renderSelectionBox();
    return;
  }
  const state = _graphState();
  graphView.panning = true;
  graphView.pointerId = event.pointerId;
  graphView.startX = event.clientX;
  graphView.startY = event.clientY;
  graphView.panStartX = state.pan.x;
  graphView.panStartY = state.pan.y;
  graphView.moved = false;
  graphCanvas?.classList.add('panning');
}

function _clearGraphTextSelection() {
  const selection = document.getSelection();
  if (selection && typeof selection.removeAllRanges === 'function') {
    selection.removeAllRanges();
  }
}

function _handlePointerMove(event) {
  if (graphView.pointerId !== event.pointerId) return;
  // 高回报率鼠标一次显示帧内会触发多次 pointermove——这里只记录最新坐标，
  // 用 requestAnimationFrame 合成每帧最多一次绘制（否则一次 move 就是
  // 「全节点 transform 写 + 每边多次强制回流 + SVG 整层重建」×N 次）。
  graphView.lastPointerX = event.clientX;
  graphView.lastPointerY = event.clientY;
  if (graphView.paintPending) return;
  graphView.paintPending = true;
  graphView.paintRaf = requestAnimationFrame(() => {
    graphView.paintPending = false;
    graphView.paintRaf = 0;
    if (graphView.pointerId == null) return;
    _applyPointerDrag(graphView.lastPointerX, graphView.lastPointerY);
  });
}

function _applyPointerDrag(clientX, clientY) {
  // 拖拽期间暂停装饰粒子（纯装饰却在每帧写 33 次 transform/opacity，
  // 压缩交互帧的 16ms 预算）；_endPointerDrag 统一恢复
  if (!graphView.symbolsPausedForDrag) {
    graphView.symbolsPausedForDrag = true;
    if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(true);
  }
  const dx = clientX - graphView.startX;
  const dy = clientY - graphView.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    graphView.moved = true;
    _clearGraphTextSelection();
  }
  const state = _graphState();
  if (graphView.linkDrag) {
    const point = _clientToGraphLocal(clientX, clientY);
    graphView.linkDrag.currentX = point.x;
    graphView.linkDrag.currentY = point.y;
    // 只更新拖拽线本身的 d；结构不在（缓存被清）时退回全量重建
    if (!_refreshLinkDragPath()) _redrawEdges();
    if (graphView.moved) _updateLinkDragHover(clientX, clientY);
    return;
  }
  if (graphView.boxSelect) {
    const point = _clientToGraphLocal(clientX, clientY);
    graphView.boxSelect.currentX = point.x;
    graphView.boxSelect.currentY = point.y;
    _renderSelectionBox();
    return;
  }
  if (graphView.resizeNodeId) {
    const node = _findGraphNode(graphView.resizeNodeId);
    const el = graphInner?.querySelector('[data-node-id="' + graphView.resizeNodeId + '"]');
    if (node && el) {
      const resizeDx = (clientX - graphView.resizeStartX) / (graphView.zoom || 1);
      const resizeDy = (clientY - graphView.resizeStartY) / (graphView.zoom || 1);
      const nextW = Math.max(260, graphView.resizeStartW + resizeDx);
      const nextH = Math.max(90, graphView.resizeStartH + resizeDy);
      node.customWidth = Math.round(nextW);
      node.customHeight = Math.round(nextH);
      node.userResized = true;
      el.style.setProperty('width', node.customWidth + 'px', 'important');
      el.style.setProperty('min-width', node.customWidth + 'px', 'important');
      el.style.setProperty('max-width', node.customWidth + 'px', 'important');
      el.style.setProperty('min-height', node.customHeight + 'px', 'important');
      el.style.setProperty('height', node.customHeight + 'px', 'important');
      el.classList.add('resized');
      node.w = node.customWidth;
      node.h = el.getBoundingClientRect().height / (graphView.zoom || 1);
      if (node.kind === 'ai_eval') _updateAiEvalZigzag(node);
      // resize 帧走边的增量快速路径（只改涉及边的 d/标签），整层重建退居后备
      if (!_refreshEdgeGeometry(_edgesTouchingNodeIds([node.id]))) _redrawEdges();
    }
    return;
  }
  if (graphView.resizeGroupId) {
    const group = _graphGroupById(graphView.resizeGroupId);
    if (group) {
      const resizeDx = (clientX - graphView.resizeGroupStartClientX) / (graphView.zoom || 1);
      const resizeDy = (clientY - graphView.resizeGroupStartClientY) / (graphView.zoom || 1);
      group.width = Math.max(220, graphView.resizeGroupStartW + resizeDx);
      group.height = Math.max(140, graphView.resizeGroupStartH + resizeDy);
      _updateGroupElement(group);
      graphView.moved = true;
    }
    return;
  }
  if (graphView.dragGroupId) {
    const group = _graphGroupById(graphView.dragGroupId);
    if (group) {
      const offsetX = dx / (graphView.zoom || 1);
      const offsetY = dy / (graphView.zoom || 1);
      group.x = graphView.dragGroupStartX + offsetX;
      group.y = graphView.dragGroupStartY + offsetY;
      _updateGroupElement(group);
      const ids = Object.keys(graphView.dragGroupNodeStartPositions || {});
      for (const id of ids) {
        const node = _findGraphNode(id);
        const start = graphView.dragGroupNodeStartPositions[id];
        if (node && start) {
          node.x = start.x + offsetX;
          node.y = start.y + offsetY;
        }
      }
      _updateNodeTransforms(ids);
      if (!_refreshEdgeGeometry(_edgesTouchingNodeIds(ids))) _redrawEdges();
    }
    return;
  }
  if (graphView.dragNodeId) {
    const ids = Object.keys(graphView.dragStartPositions || {});
    const offsetX = dx / (graphView.zoom || 1);
    const offsetY = dy / (graphView.zoom || 1);
    for (const id of ids) {
      const n = _findGraphNode(id);
      const start = graphView.dragStartPositions[id];
      if (n && start) {
        n.x = start.x + offsetX;
        n.y = start.y + offsetY;
      }
    }
    _updateNodeTransforms(ids);
    if (!_refreshEdgeGeometry(_edgesTouchingNodeIds(ids))) _redrawEdges();
  } else if (graphView.panning) {
    // 平移不再每帧把整个图状态序列化写 localStorage——pointerup 统一保存
    state.pan.x = graphView.panStartX + dx;
    state.pan.y = graphView.panStartY + dy;
    _applyGraphTransform();
  }
}

function _endPointerDrag(event) {
  if (graphView.pointerId !== event.pointerId) return;
  // 冲刷还没画出去的那一帧：松手前最后一次 move 必须先落到节点坐标上，
  // 否则落点判定（拖入分组/连线放置）用的是滞后一帧的位置
  if (graphView.paintRaf) {
    cancelAnimationFrame(graphView.paintRaf);
    graphView.paintRaf = 0;
  }
  if (graphView.paintPending) {
    graphView.paintPending = false;
    _applyPointerDrag(graphView.lastPointerX, graphView.lastPointerY);
  }
  if (graphView.symbolsPausedForDrag) {
    graphView.symbolsPausedForDrag = false;
    if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(false);
  }
  if (graphView.moved) graphView.suppressClick = true;
  setTimeout(() => { graphView.suppressClick = false; }, 0);
  if (graphView.linkDrag) {
    const drag = graphView.linkDrag;
    const dropPort = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.graph-port')
      : null;
    if (drag.mode === 'output' && dropPort && dropPort.classList.contains('graph-input-port')) {
      const targetNodeId = dropPort.closest('.graph-node')?.dataset.nodeId;
      _connectPorts(drag.nodeId, drag.portId, targetNodeId, dropPort.dataset.portId);
    } else if (drag.mode === 'input' && dropPort && dropPort.classList.contains('graph-output-port')) {
      const sourceNodeId = dropPort.closest('.graph-node')?.dataset.nodeId;
      _connectPorts(sourceNodeId, dropPort.dataset.portId, drag.nodeId, drag.portId);
    } else if (drag.mode === 'input' && graphView.moved) {
      // 拖输入口的线落到节点身上（非具体输出口）：吸附该节点第一个输出口；没有输出口
      // 或落回自己，维持原「拖走即断开」语义。不自动长输出口——出口有身份语义
      // （追问/知识点/配方出口各自拖出不同的东西），匿名长出来没有明确指向。
      const hoverEl = _linkDragNodeEl(event);
      const outPort = hoverEl && hoverEl.dataset.nodeId !== drag.nodeId
        ? hoverEl.querySelector('.graph-output-port')
        : null;
      if (outPort) {
        _connectPorts(hoverEl.dataset.nodeId, outPort.dataset.portId, drag.nodeId, drag.portId);
      } else {
        _disconnectInputPort(drag.nodeId, drag.portId);
      }
    } else if (drag.mode === 'output' && graphView.moved) {
      // 拖输出口的线落到节点身上（非具体输入口）：目标能加输入口就吸附到下一个空口
      // （口满了自动长一个，与瞄准具体口同一条路径）；落在不能加口的节点（草稿卡）上
      // 是无操作。只有落到纯空白处才走「拖空建点/开面板」分支。
      const hoverEl = _linkDragNodeEl(event);
      if (hoverEl) {
        const targetId = hoverEl.dataset.nodeId;
        const target = targetId && targetId !== drag.nodeId ? _findGraphNode(targetId) : null;
        if (target && typeof _nodeCanAddInputPorts === 'function' && _nodeCanAddInputPorts(target)) {
          _connectPorts(drag.nodeId, drag.portId, targetId, '');
        }
      } else {
        const point = _clientToGraphLocal(event.clientX, event.clientY);
        _createBranchNodeFromOutput(drag.nodeId, drag.portId, drag.portMeta, point.x, point.y);
      }
    }
    _clearLinkDragHover();
    graphView.linkDrag = null;
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('linking');
    _redrawEdges();
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    return;
  }
  if (graphView.resizeNodeId) {
    const node = _findGraphNode(graphView.resizeNodeId);
    if (node && graphView.moved) {
      _pushGraphUndo(false, { layout: true });
      _syncGroupMembersByContainment();
      _savePositions();
    }
    graphView.resizeNodeId = null;
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    return;
  }
  if (graphView.resizeGroupId) {
    const group = _graphGroupById(graphView.resizeGroupId);
    if (group && graphView.moved) {
      _pushGraphUndo(false, { layout: true });
      _syncGroupMembersByContainment();
      const state = _graphState();
      state.groups = graphView.groups.map(item => ({ ...item }));
      _saveGraphState(state);
    }
    graphView.resizeGroupId = null;
    graphView.resizeGroupStartX = 0;
    graphView.resizeGroupStartY = 0;
    graphView.resizeGroupStartW = 0;
    graphView.resizeGroupStartH = 0;
    graphView.resizeGroupStartClientX = 0;
    graphView.resizeGroupStartClientY = 0;
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    return;
  }
  if (graphView.dragGroupId) {
    const group = _graphGroupById(graphView.dragGroupId);
    if (group && graphView.moved) {
      _pushGraphUndo(false, { layout: true });
      _syncGroupMembersByContainment();
      const state = _graphState();
      state.groups = graphView.groups.map(item => ({ ...item }));
      state.positions = state.positions || {};
      state.pinned = state.pinned || {};
      for (const [id, start] of Object.entries(graphView.dragGroupNodeStartPositions || {})) {
        const node = _findGraphNode(id);
        if (!node) continue;
        node.pinned = true;
        node.fixedX = node.x;
        node.fixedY = node.y;
        state.positions[id] = { x: node.x, y: node.y };
        state.pinned[id] = true;
      }
      _saveGraphState(state);
      _syncGroupMembersByContainment();
      _savePositions();
    }
    graphInner?.querySelectorAll('.graph-group.dragging').forEach(el => el.classList.remove('dragging'));
    graphView.dragGroupId = null;
    graphView.dragGroupStartX = 0;
    graphView.dragGroupStartY = 0;
    graphView.dragGroupNodeStartPositions = {};
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    return;
  }
  if (graphView.boxSelect) {
    const rect = _getSelectionRect();
    if (rect && graphView.moved) {
      _setGraphSelection(_nodesInSelectionRect(rect), !!graphView.boxSelect.additive);
    } else if (!graphView.moved) {
      _clearGraphSelection();
    }
    graphView.boxSelect = null;
    _removeSelectionBox();
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('box-selecting', 'panning');
    return;
  }
  if (graphView.dragNodeId) {
    const node = _findGraphNode(graphView.dragNodeId);
    if (node && graphView.moved) {
      if (!graphView.dragWasSelected) {
        if (graphView.dragModifier) {
          graphView.selectedNodeIds.add(node.id);
        } else {
          graphView.selectedNodeIds = new Set([node.id]);
        }
        _syncGraphSelectionClasses();
      }
      _pushGraphUndo(false, { layout: true });
      const state = _graphState();
      state.positions = state.positions || {};
      state.pinned = state.pinned || {};
      for (const id of Object.keys(graphView.dragStartPositions || {})) {
        const n = _findGraphNode(id);
        if (!n) continue;
        n.pinned = true;
        n.fixedX = n.x;
        n.fixedY = n.y;
        state.positions[id] = { x: n.x, y: n.y };
        state.pinned[id] = true;
      }
      _saveGraphState(state);
      _syncGroupMembersByContainment();
      _savePositions();
    }
    let droppedIntoGroup = false;
    const dropGroupEl = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.graph-group')
      : null;
    if (dropGroupEl && !event.target.closest('.graph-group input, .graph-group button')) {
      droppedIntoGroup = _addNodeIdsToGroup(dropGroupEl.dataset.groupId, Object.keys(graphView.dragStartPositions || {}));
    }
    if (!droppedIntoGroup) {
      // 组框画在节点 DOM 之下，落在组框内的节点身上时 event.target 是那颗节点而不是组框，
      // 上面那条 closest('.graph-group') 抓不到。按落点节点是否完整落进组框矩形补一次
      // 显式加入——只认拖拽松手这一下，不按包含关系自动改成员（见 _syncGroupMembersByContainment）。
      const draggedIds = Object.keys(graphView.dragStartPositions || {});
      const hitGroup = (graphView.groups || []).find(group => draggedIds.some(id => {
        const node = _findGraphNode(id);
        return !!node && _isNodeFullyInsideGroup(node, group);
      }));
      if (hitGroup) droppedIntoGroup = _addNodeIdsToGroup(hitGroup.id, draggedIds);
    }
    graphInner?.querySelectorAll('.graph-node.dragging').forEach(el => el.classList.remove('dragging'));
    graphView.dragNodeId = null;
    graphView.dragStartPositions = {};
    graphView.dragWasSelected = false;
    graphView.dragModifier = false;
    graphView.panning = false;
    graphView.pointerId = null;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    if (droppedIntoGroup) renderGraphCanvas();
    return;
  }
  // 纯平移的收尾（其余拖拽分支各自保存）：move 期间不再逐帧写存储，
  // 在这里补一次统一保存
  if (graphView.panning && graphView.moved) {
    _saveGraphState(_graphState());
  }
  graphView.panning = false;
  graphView.pointerId = null;
  graphView.moved = false;
  graphCanvas?.classList.remove('panning');
}

// ===== T362：删除范围真值（确认文案与计数按「真正会消失的节点」报）=====
// 消息派生节点是整条回答消息的切片：删一颗＝删整条消息＝同簇并列模块连坐，再沿
// parentId 级联删光该卡下的下游拓展。这里把「将删的消息集合」与「将消失的画布节点」
// 算成真值，确认文案如实报全，不再拿去重消息数冒充节点数、也不再让未选中者静默陪葬。
function _deletionScopeForTimestamps(timestamps) {
  const messages = _getChatHistory();
  const removed = new Set(Array.from(timestamps || []).map(String).filter(Boolean));
  // 与 _performDeleteMessages 同口径之一：user 消息连带其后连续 assistant 消息
  for (const target of Array.from(removed)) {
    const idx = messages.findIndex(m => String(m.timestamp || '') === target);
    if (idx >= 0 && messages[idx].role === 'user') {
      for (let i = idx + 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant') removed.add(String(messages[i].timestamp || ''));
        else break;
      }
    }
  }
  // 与 _performDeleteMessages 同口径之二：沿 parentId 传递级联（循环到不动点）
  let changed = true;
  while (changed) {
    changed = false;
    for (const msg of messages) {
      const ts = String(msg.timestamp || '');
      if (removed.has(ts)) continue;
      if (removed.has(String(msg.parentId || ''))) {
        removed.add(ts);
        changed = true;
      }
    }
  }
  const nodes = (graphView.nodes || []).filter(n => n.messageIndex >= 0
    && messages[n.messageIndex]
    && removed.has(String(messages[n.messageIndex].timestamp || '')));
  return { messages: removed, nodes: nodes };
}

// 单颗节点删除（节点头上的删除钮 / 右键菜单）：自定义节点逐颗删；消息派生节点按
// 整条消息删，但把同簇与级联的真实颗数写进确认文案（T362）。
function _deleteSingleGraphNode(node) {
  if (!node) return;
  if (node.messageIndex < 0) {
    if (node.kind === 'blank') { deleteBlankNode(node.id, true); return; }
    if (node.kind === 'draft') { removeDraftNode(node.id); return; }
    if (GRAPH_CUSTOM_NODE_KINDS.includes(node.kind)) { deleteCustomNode(node.id, true); return; }
    return;
  }
  const message = _getChatHistory()[node.messageIndex];
  if (!message) return;
  const scope = _deletionScopeForTimestamps([String(message.timestamp || '')]);
  const others = scope.nodes.filter(n => String(n.id) !== String(node.id)).length;
  const text = others > 0
    ? '确定删除这个节点吗？它属于同一轮回答的 ' + scope.nodes.length + ' 颗并列节点，'
      + '删除会连同未点名的另外 ' + others + ' 颗一起移除（消息簇按整条回答删除，不能只删其中一颗）。'
    : '确定删除这个节点及其子分支吗？';
  if (!confirm(text)) return;
  _pushGraphUndo(true);
  if (typeof window.deleteGraphMessageByTimestamp === 'function') {
    window.deleteGraphMessageByTimestamp(message.timestamp);
  }
}

async function _deleteSelectedGraphNodes(ids) {
  const selected = Array.from(ids || []);
  const drafts = [];
  const blanks = [];
  const customs = [];
  const messageNodes = [];
  for (const id of selected) {
    const node = _findGraphNode(id);
    if (!node) continue;
    if (node.kind === 'blank') {
      blanks.push(id);
      continue;
    }
    if (node.kind === 'draft') {
      drafts.push(id);
      continue;
    }
    if (node.messageIndex < 0 && GRAPH_CUSTOM_NODE_KINDS.includes(node.kind)) {
      customs.push(id);
      continue;
    }
    messageNodes.push(node);
  }
  const selectedTs = new Set();
  for (const node of messageNodes) {
    const message = _getChatHistory()[node.messageIndex];
    if (message) selectedTs.add(String(message.timestamp || ''));
  }
  if (!selectedTs.size) {
    // 纯自定义/草稿/空白：逐颗删除（工作流链路的终态语义），不弹确认
    _pushGraphUndo();
    drafts.forEach(id => removeDraftNode(id));
    blanks.forEach(id => deleteBlankNode(id, false));
    customs.forEach(id => deleteCustomNode(id, false));
    graphView.selectedNodeIds = new Set();
    _syncGraphSelectionClasses();
    return;
  }
  const scope = _deletionScopeForTimestamps(selectedTs);
  const selectedIds = new Set(selected.map(String));
  const unselectedCluster = scope.nodes.filter(n => !selectedIds.has(String(n.id))).length;
  const totalNodes = scope.nodes.length + drafts.length + blanks.length + customs.length;
  // T362：计数按真实将删节点数报（旧文案按去重消息数报：同簇选 3 颗报「1 个节点」），
  // 同簇未点名的并列模块与级联下游如实写出来，不再静默陪葬
  let confirmText;
  if (unselectedCluster > 0) {
    confirmText = '确定删除吗？选中的 ' + messageNodes.length + ' 颗节点属于 ' + selectedTs.size
      + ' 轮回答，删除会连同该消息簇里未点名的 ' + unselectedCluster
      + ' 颗并列/下游节点一起移除（共 ' + totalNodes + ' 个节点）。';
  } else {
    confirmText = '确定删除选中的 ' + totalNodes + ' 个节点及其子分支吗？';
  }
  if (!confirm(confirmText)) return;
  _pushGraphUndo(true);
  drafts.forEach(id => removeDraftNode(id));
  blanks.forEach(id => deleteBlankNode(id, false));
  customs.forEach(id => deleteCustomNode(id, false));
  if (typeof window.deleteGraphMessagesByTimestamps === 'function') {
    await window.deleteGraphMessagesByTimestamps(Array.from(selectedTs));
  } else if (typeof window.deleteGraphMessageByTimestamp === 'function') {
    for (const ts of selectedTs) await window.deleteGraphMessageByTimestamp(ts);
  }
}

function quickConnectToHub(hubId) {
  const hub = _findGraphNode(hubId);
  if (!hub || hub.kind !== 'hub') return;
  const selectedIds = Array.from(graphView.selectedNodeIds || []);
  if (!selectedIds.length) {
    if (typeof showToast === 'function') showToast('请先选中要接入的节点');
    return;
  }

  const messages = _getChatHistory();
  const state = _graphState();
  const existingExtraPorts = (state.inputPortCounts && state.inputPortCounts[hubId]) || 0;
  const usedHubPorts = new Set(
    (state.connections || [])
      .filter(c => c.to === hubId)
      .map(c => String(c.toPort || 'in-0'))
  );
  let totalHubPorts = 1 + existingExtraPorts;
  const newConnections = [];

  for (const id of selectedIds) {
    const source = _findGraphNode(id);
    if (!source || source.kind === 'hub' || source.kind === 'draft') continue;
    const outputCount = _nodeOutputCount(source, messages, state);
    for (let i = 0; i < outputCount; i++) {
      const fromPort = 'out-' + i;
      const alreadyConnected = (state.connections || []).some(c =>
        c.from === id
        && (c.fromPort || 'out-0') === fromPort
        && c.to === hubId
      );
      if (alreadyConnected) continue;
      newConnections.push({
        from: id,
        fromPort,
        to: hubId,
        toPort: '',
        type: 'custom',
        custom: true,
      });
    }
  }

  if (!newConnections.length) {
    const hasOutput = selectedIds.some(id => {
      const source = _findGraphNode(id);
      return source && _nodeOutputCount(source, messages, state) > 0;
    });
    if (typeof showToast === 'function') {
      showToast(hasOutput ? '选中的输出已全部接入' : '选中的节点没有可连接的输出端口');
    }
    return;
  }

  for (const connection of newConnections) {
    let portIndex = 0;
    while (usedHubPorts.has('in-' + portIndex)) portIndex++;
    if (portIndex >= totalHubPorts) totalHubPorts = portIndex + 1;
    connection.toPort = 'in-' + portIndex;
    usedHubPorts.add('in-' + portIndex);
  }

  _pushGraphUndo();
  state.connections = state.connections || [];
  state.connections.push(...newConnections);
  state.inputPortCounts = state.inputPortCounts || {};
  state.inputPortCounts[hubId] = Math.max(existingExtraPorts, totalHubPorts - 1);
  _saveGraphState(state);
  renderGraphCanvas();
  if (typeof showToast === 'function') showToast('已接入 ' + newConnections.length + ' 个输出，并按需补齐输入端口');
}

