// ===== PhyMathia 图编辑 harness：结果渲染与图预览 =====

  // T122：Φ 面板取消独立「结果区」——模型说明、可勾选操作清单、批准按钮全部并进
  // 对话流，面板只剩一条滚动区。
  //
  // 旧结构（.graph-harness-result）是 conversation 之下的固定区块：它一有内容就
  // 长到 max-height 228px，把对话区挤到 min-height 96px 的窄条里，上一条消息只剩
  // 操作行、正文被横切——真机读成「出现了两个面板，下面的把上面挡住了」（2026-09-30）。
  // 更糟的是清单顺序是「摘要 → 自检 → 分组头 → 操作卡」，228px 折线以下一张卡都
  // 看不到，而结果区渲染后不滚到底。加上流式期间同一段正文在对话气泡与结果区各打
  // 印一次，这块独立区域只有坏处没有收益（主流 agent 界面都是单一对话流）。
  //
  // 现在本函数只做「状态行 + 开关类副作用」；可见内容由 harness.js 的
  // _historyMessageHtml 从 harnessHistory 渲染（清单随条目存盘，切 Φ 会话能回来，
  // 不会被整块重渲染吃掉，T96 事件日志也能归因）。
  function renderHarnessResult(data) {
    const ops = Array.isArray(data.operations) ? data.operations : [];
    if (data.status === 'clarify' || data.clarify) {
      // 澄清问题与选项进历史条目的正文与 clarifyOptions（由 harness.js 渲染）——
      // 过去写结果区，现已随本轮重构取消该容器
      _setHarnessStatus('需要你确认后再继续', 'ok');
      return;
    }
    if (data.status === 'undo') {
      _setHarnessStatus('已撤销上一条修改', 'ok');
      return;
    }
    if (data.status === 'error' || data.status === 'parse_error' || data.status === 'invalid') {
      const errors = (data.errors || []).map(item => item.reason || '未知错误').join('<br>');
      _setHarnessStatus('未执行任何图修改', 'error');
      _showHarnessRetry(errors || data.status);
      return;
    }

    if (!ops.length) {
      _setHarnessStatus('已回复（未改图）', 'ok');
    } else {
      const statusLabel = harnessPhase === 'evaluate'
        ? '评价节点生成候选'
        : harnessPhase === 'apply'
          ? '建议应用候选'
          : '审阅完成';
      _setHarnessStatus(statusLabel + '：' + ops.length + ' 条操作', 'ok');
    }
    // T88 复位：新结果渲染＝上一批的「已应用」状态作废，防重入标志清掉并放开
    // 两个应用按钮（按钮组现在由 _harnessOpsCardHtml 随最新一批待处理条目渲染，
    // 显隐不再需要单独 toggle）
    harnessResultApplied = false;
    const applySelectedBtn = document.getElementById('graphHarnessApplySelectedBtn');
    if (applySelectedBtn) applySelectedBtn.disabled = false;
    const applyAllBtn = document.getElementById('graphHarnessApplyAllBtn');
    if (applyAllBtn) applyAllBtn.disabled = false;
  }

  // T122：可勾选操作清单（旧「结果区」搬进对话流，渲染在助手气泡内）。
  // entry 是 harnessHistory 里的助手条目，operations 早已随条目存盘。
  // isCurrent=true 仅限「最新一条待处理且有操作」——应用路径读全局 harnessResult，
  // 给更早的批次挂勾选框/应用按钮会让「应用所选」作用到错的那一批。
  // T124：更早批次整卡灰化（.graph-harness-opcard-stale）并在按钮位放「仅最新一批
  // 可勾选应用」标注，不再只靠静态字形 ☑/☐ 暗示不可用。
  function _harnessOpsCardHtml(entry, isCurrent) {
    const ops = Array.isArray(entry.operations) ? entry.operations : [];
    if (!ops.length) return '';
    const errors = (entry.errors || []).filter(Boolean);
    const warnings = (entry.warnings || []).filter(Boolean);
    const issues = (entry.selfCheckIssues || []).filter(Boolean);
    // selectedOps 为 null ＝「还没人动过勾选」，按全选渲染（旧数据没有这个字段）
    const picked = Array.isArray(entry.selectedOps) ? entry.selectedOps : null;
    let html = '';
    if (warnings.length) {
      html += '<div class="graph-harness-warnings"><strong>⚠️ 注意</strong>'
        + warnings.map(item => '<div>' + _escapeHtml(item) + '</div>').join('') + '</div>';
    }
    if (entry.selfCheckOk === true) {
      html += '<div class="graph-harness-selfcheck graph-harness-selfcheck-ok"><strong>🔍 自检通过</strong></div>';
    } else if (entry.selfCheckOk === false && issues.length) {
      html += '<div class="graph-harness-selfcheck"><strong>🔍 自检未通过</strong>'
        + issues.map(item => '<div>' + _escapeHtml(item) + '</div>').join('') + '</div>';
    }
    if (errors.length) {
      html += '<div class="graph-harness-errors"><strong>跳过的操作</strong>'
        + errors.map(item => '<div>' + _escapeHtml(item) + '</div>').join('') + '</div>';
    }
    // T100：清单按类型分组（与聊天报告共用 _harnessGroupedOps）；勾选框 data-op-index
    // 仍是原 ops 下标，分组绝不许重排后错位
    const groups = typeof _harnessGroupedOps === 'function'
      ? _harnessGroupedOps(ops)
      : [{ key: '', title: '操作', items: ops.map((op, index) => ({ op, index })) }];
    // T242 配套：配方操作已真的落到库里才挂「微调/放上画布」入口——
    // 「保留修改」落库走 decision==='keep'，「应用全部」落库走 T88 的
    // harnessResultApplied 标志；待处理批次不挂（配方还不存在/改的还是旧版，
    // 入口会和应用动作打架）。
    const recipeActionsLive = entry.decision === 'keep' || (isCurrent && harnessResultApplied);
    html += '<div class="graph-harness-oplist">'
      + groups.map(group => ''
        + '<div class="graph-harness-op-group"><span class="graph-harness-op-group-title">'
        + _escapeHtml(group.title) + '（' + group.items.length + '）</span></div>'
        + group.items.map(({ op, index }) => _harnessOpRowHtml(op, index, ops, isCurrent, picked, recipeActionsLive)).join('')
      ).join('')
      + '</div>';
    if (isCurrent && entry.decision === 'pending') {
      html += '<div class="graph-harness-apply-actions" id="graphHarnessApplyActions">'
        + '<button type="button" id="graphHarnessApplySelectedBtn" onclick="applySelectedGraphHarness()" title="应用勾选的操作">应用所选</button>'
        + '<button type="button" id="graphHarnessApplyAllBtn" onclick="applyGraphHarness()" title="应用全部操作">应用全部</button>'
        + '<button type="button" id="graphHarnessUndoBtn" onclick="undoGraphHarness()" title="撤销本次全部修改">撤销本次</button>'
        + '</div>';
    } else if (!isCurrent) {
      // T124：标注放「应用所选」在当前批次的位置——两相对照，为何这批没有按钮一目了然
      html += '<div class="graph-harness-opcard-note">仅最新一批可勾选应用，此批为历史记录</div>';
    }
    return '<div class="graph-harness-opcard' + (isCurrent ? '' : ' graph-harness-opcard-stale') + '">' + html + '</div>';
  }

  // T100：单条操作的内容级 diff（T122 起收在 <details> 里，点开才渲染）：
  // - update_node：「原文 → 建议文」逐字段对照（原文取自当前画布 state——评审
  //   阶段应用还没发生，节点正文还是旧文；本批新建再修改的节点取不到原文，
  //   只显示「→ 建议文」）
  // - delete_node：被删正文的摘录，删什么让用户看着决定
  function _harnessOpDiffHtml(op) {
    const name = op.op || op.type || '';
    if (name !== 'update_node' && name !== 'delete_node') return '';
    const nodes = typeof _graphNodes === 'function' ? _graphNodes() : [];
    const rawId = String(op.id || op.label || '');
    const node = nodes.find(n => String(n.id) === rawId) || null;
    const clip = (t, n) => {
      const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '…' : s;
    };
    if (name === 'delete_node') {
      if (!node) return '';
      const parts = [];
      if (node.content) parts.push(clip(node.content, 60));
      if (node.formula) parts.push('公式 ' + clip(node.formula, 40));
      if (!parts.length) return '';
      return '<span class="graph-harness-op-diff"><span class="graph-harness-op-diff-del">将删除：'
        + _escapeHtml(parts.join(' · ')) + '</span></span>';
    }
    const patch = (op.patch && typeof op.patch === 'object') ? op.patch : {};
    const lines = [];
    const fields = [['label', '标题'], ['content', '正文'], ['formula', '公式']];
    for (const pair of fields) {
      const k = pair[0];
      const label = pair[1];
      const next = patch[k];
      if (next === undefined || next === null || next === '') continue;
      const prev = node
        ? (k === 'label' ? (node.label || node.title || '') : (node[k] || ''))
        : '';
      if (String(prev) === String(next)) continue;
      lines.push('<span class="graph-harness-op-diff-old">' + label + '：' + _escapeHtml(clip(prev, 50)) + '</span>'
        + '<span class="graph-harness-op-diff-new">' + label + ' → ' + _escapeHtml(clip(next, 50)) + '</span>');
    }
    if (!lines.length) return '';
    return '<span class="graph-harness-op-diff">' + lines.join('') + '</span>';
  }

  // T242 配套：已落库的配方操作行内联「✎ 微调」「＋ 放上画布」直达入口——
  // 「AI 起草＋人工微调」是常态路径（本机模型常漏深层参数），此前要从 Φ 面板
  // 走 添加节点→我的配方→管理→编辑 四步。按钮与描述同行（内联在 main 里），
  // 不占新行、不动 grid 布局；create 未落库时行内不出现（下方 exists 判据）。
  function _harnessRecipeActionsHtml(op) {
    const name = op.op || op.type || '';
    if (name !== 'create_recipe' && name !== 'update_recipe') return '';
    const rid = String(op.recipe_id || op.recipeId || '');
    if (!rid || typeof getUserRecipes !== 'function') return '';
    if (!getUserRecipes().some(item => item.id === rid)) return '';
    const ridAttr = _escapeHtml(rid);
    let html = '<span class="graph-harness-op-recipe-actions">';
    if (typeof openRecipeFormById === 'function') {
      html += '<button type="button" class="graph-harness-op-recipe-btn"'
        + ' onclick="openRecipeFormById(\'' + ridAttr + '\')"'
        + ' title="在配方编辑器里打开这份配方：补齐模型漏掉的字段（如三档标签）">✎ 微调</button>';
    }
    if (typeof createRecipeNode === 'function') {
      html += '<button type="button" class="graph-harness-op-recipe-btn"'
        + ' onclick="createRecipeNode(\'' + ridAttr + '\')"'
        + ' title="按这份配方在画布上放一个节点，试试生成效果">＋ 放上画布</button>';
    }
    return html + '</span>';
  }

  // T122：单条操作行压成一条细横条（约 30px），理由与「原文 → 建议文」对比收进
  // <details>，点「理由与对比」才展开——旧版是一块带边框的方块、一张约 50px，
  // 6 张就 300px，在 228px 的结果区里一张都露不出来。结构上从 <label> 改成 <div>：
  // label 会把 summary 的点击当成勾选，两处点击区互相打架。
  // data-op-index 仍是 _selectedOps 回查 operations 的唯一依据，绝不重排。
  function _harnessOpRowHtml(op, index, ops, editable, picked, recipeActionsLive) {
    const on = picked === null || picked.indexOf(index) >= 0;
    const reason = String(op.reason || '');
    const diff = _harnessOpDiffHtml(op);
    return '<div class="graph-harness-op graph-harness-op-' + _escapeHtml(op.op || op.type || '') + '">'
      + (editable
        ? '<input type="checkbox"' + (on ? ' checked' : '') + ' data-op-index="' + index
          + '" onchange="toggleHarnessOpSelected(this)" title="勾选/取消这条改动">'
        : '<span class="graph-harness-op-tick" aria-hidden="true">' + (on ? '☑' : '☐') + '</span>')
      + '<span class="graph-harness-op-main">' + _escapeHtml(_opDescription(op, ops))
      + (recipeActionsLive ? _harnessRecipeActionsHtml(op) : '')
      + (editable && op.recipe && ['create_recipe', 'update_recipe'].includes(op.op || op.type)
        ? '<button type="button" class="graph-harness-op-recipe-btn" onclick="trialHarnessRecipe(' + index + ')"'
          + ' title="仅在画布放置草稿，不保存配方；手动生成可能触发多次模型调用并产生相应费用">放置草稿试用</button>' : '')
      + '</span>'
      + ((reason || diff)
        ? '<details class="graph-harness-op-detail"><summary>理由与对比</summary>'
          + (reason ? '<span class="graph-harness-op-reason">' + _escapeHtml(reason) + '</span>' : '')
          + diff
          + '</details>'
        : '')
      + '</div>';
  }

  function trialHarnessRecipe(index) {
    if (phyIsReadonly()) { phyReadonlyBlock('试用配方草稿'); return; }
    if (harnessBusy) { _setHarnessStatus('请等当前生成结束后再试用草稿。', 'ok'); return; }
    const entry = _harnessCurrentOpsEntry();
    const op = entry && (entry.operations || [])[index];
    if (!op || !op.recipe || !['create_recipe', 'update_recipe'].includes(op.op || op.type)) return;
    const recipe = typeof normalizeRecipeInput === 'function' ? normalizeRecipeInput(op.recipe) : null;
    const verdict = recipe && typeof validateRecipe === 'function' ? validateRecipe(recipe, []) : null;
    if (!verdict || !verdict.ok) {
      _setHarnessStatus('草稿配置未通过校验，无法试用。', 'error');
      return;
    }
    if (!_harnessBoundSid() || _harnessBoundSid() !== _sessionId()) {
      _setHarnessStatus('请先打开 Φ 绑定的画布，再放置草稿试用。', 'error');
      return;
    }
    if (!_harnessCanApply(entry._binding)) return;
    const before = _harnessVersionSource(_harnessGraphState());
    const draft = Object.assign({}, recipe, { id: 'recipe-trial-' + Date.now(), name: recipe.name + '·草稿试用' });
    const nodeId = createRecipeNode(draft.id, draft);
    if (!nodeId) return;
    // 只认领本次新增的试用节点，原版本仍保留；任何其他内容变化继续由应用守卫拒绝。
    const original = JSON.parse(before);
    const after = JSON.parse(_harnessVersionSource(_harnessGraphState()));
    const trialNodes = after[0] || [];
    const withoutTrial = trialNodes.filter(node => node.id !== nodeId);
    after[0] = original[0] === null && !withoutTrial.length ? null : withoutTrial;
    if (trialNodes.filter(node => node.id === nodeId).length === 1 && JSON.stringify(after) === before) {
      entry._binding.trialGraphVersion = _harnessGraphVersion();
      entry._binding.trialNodeIds = [...(entry._binding.trialNodeIds || []), nodeId];
      if (harnessResult) harnessResult._binding = entry._binding;
      if (typeof _saveHarnessHistory === 'function') _saveHarnessHistory();
    }
    _setHarnessStatus('草稿已放上画布，正式配方库未改变。接入一个样例问题后手动生成；可能触发多次模型调用并产生相应费用。生成后画布内容变化，保存前需重新生成建议；不需要的试用节点可直接删除。', 'ok');
  }

  // 勾选写回历史条目（而不是留在 DOM 里）：_renderHarnessChat 是整块 innerHTML 重写，
  // 勾选状态只存 DOM 的话，任何一次后台落盘（提交反馈、保留/删除建议）都会把用户
  // 精心取消的条目重新勾回全选。同时也顺带修掉多批次共存时 data-op-index 跨卡串味。
  function toggleHarnessOpSelected(box) {
    const entry = _harnessCurrentOpsEntry();
    if (!entry || !box) return;
    const ops = Array.isArray(entry.operations) ? entry.operations : [];
    const picked = [];
    ops.forEach((op, index) => {
      const node = document.querySelector('.graph-harness-oplist input[data-op-index="' + index + '"]');
      if (node && node.checked) picked.push(index);
    });
    entry.selectedOps = picked;
    if (typeof _saveHarnessHistory === 'function') _saveHarnessHistory();
  }

  // 最新一条「待处理且带操作」的助手条目——勾选与应用都锚在它身上
  function _harnessCurrentOpsEntry() {
    const list = Array.isArray(harnessHistory) ? harnessHistory : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e && e.role === 'assistant' && (e.operations || []).length && (!e.decision || e.decision === 'pending')) return e;
    }
    return null;
  }

  function _selectedOps() {
    const entry = _harnessCurrentOpsEntry();
    const ops = entry && Array.isArray(entry.operations) ? entry.operations : [];
    if (!ops.length) return [];
    const picked = Array.isArray(entry.selectedOps) ? entry.selectedOps : null;
    // selectedOps 为 null ＝还没人动过勾选，按全选
    const selected = picked === null ? ops.slice() : picked.map(i => ops[i]).filter(Boolean);
    const availableRecipes = new Set(typeof getUserRecipes === 'function' ? getUserRecipes().map(recipe => recipe.id) : []);
    for (const op of selected) {
      if ((op.op || op.type) === 'create_recipe') availableRecipes.add(op.recipe_id || (op.recipe && op.recipe.id));
      if ((op.op || op.type) === 'create_node' && op.recipe_id && !availableRecipes.has(op.recipe_id)) {
        _setHarnessStatus('请同时勾选这个节点依赖的新建配方，或先保存配方后再放置节点。', 'error');
        return null;
      }
    }
    // 全部取消勾选＝什么都不选，不再回退成“应用全部”——旧回退会把用户特意
    // 排除的删除类操作整包应用。是否放行由调用方提示用户决定。
    return selected;
  }

  function _nextNodePosition(count) {
    const angle = count * 2.399963;
    const ring = 220 + Math.floor(count / 8) * 150;
    return {
      x: Math.round(Math.cos(angle) * ring),
      y: Math.round(Math.sin(angle) * ring),
    };
  }

  function _previewNodePosition(id) {
    if (typeof window.getGraphPreviewNodes !== 'function') return null;
    const node = window.getGraphPreviewNodes().find(item => item.id === id);
    return node && Number.isFinite(node.x) && Number.isFinite(node.y)
      ? { x: node.x, y: node.y }
      : null;
  }

  function _newHarnessNode(id, op, pos) {
    let kind = op.kind || 'knowledge';
    const label = String(op.label || op.title || '节点');
    const content = String(op.content || '');
    const formula = String(op.formula || '');
    // 配方实例节点（P3 创造模式「在画布上放一个试试」）：内嵌创建时刻的配方快照
    // （与 createRecipeNode 同款覆盖层口径——删配方不毁旧节点）
    const recipeRef = String(op.recipe_id || op.recipeId || '');
    let recipeEmbed = null;
    if (recipeRef && typeof getUserRecipes === 'function' && typeof recipeEmbedSnapshot === 'function') {
      const found = getUserRecipes().find(item => item.id === recipeRef);
      recipeEmbed = found ? recipeEmbedSnapshot(found) : null;
    }
    if (recipeEmbed) {
      const kindMap = { manual: 'answer', question: 'user' };
      kind = kindMap[recipeEmbed.base.kind] || recipeEmbed.base.kind;
    }
    const isManual = ['knowledge', 'relation', 'human_note', 'note', 'source', 'blank'].includes(kind);
    return {
      id,
      kind,
      recipeId: recipeEmbed ? recipeRef : '',
      recipe: recipeEmbed,
      moduleKey: kind === 'module'
        ? String(op.module_key || op.moduleKey || '')
        : (kind === 'hub' || kind === 'summary' || kind === 'note' ? (op.module_key || op.moduleKey || '') : ''),
      manual: kind === 'answer' ? (recipeEmbed ? recipeEmbed.base.kind === 'manual' : !!op.manual) : (kind === 'user' ? false : isManual),
      content,
      status: 'done',
      summary: content.slice(0, 120),
      analysis: '',
      analysisHash: '',
      inputHash: '',
      generatedAt: 0,
      requirements: '',
      busy: false,
      generated: false,
      maxItems: kind === 'source' ? 5 : 0,
      items: [],
      edges: [],
      fileId: '',
      fileName: '',
      generatedNodeIds: [],
      category: '',
      formulas: formula ? [formula] : [],
      knowledgeKey: '',
      label,
      title: kind === 'knowledge' ? label : '',
      formula,
      x: pos.x,
      y: pos.y,
      depth: kind === 'summary' || kind === 'note' ? 4 : (kind === 'blank' || kind === 'hub' ? 3 : 2),
      targetAngle: 0,
      isRoot: false,
      timestamp: Date.now(),
      pinned: false,
      fixedX: null,
      fixedY: null,
      customWidth: kind === 'human_note' || kind === 'knowledge' ? 260 : null,
      customHeight: null,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
    };
  }

  function _newAiEvalNode(id, op, pos) {
    const parts = _edgeParts(op.edge_key || op.key);
    const targetId = parts ? parts.from : (op.target_node_id || op.target || '');
    const targetLabel = op.target_label || targetId || '目标节点';
    const suggestion = String(op.suggestion || op.content || '');
    const priority = ['high', 'medium', 'low'].includes(op.priority) ? op.priority : 'medium';
    return {
      id,
      kind: 'ai_eval',
      moduleKey: '',
      manual: false,
      content: suggestion,
      status: 'pending',
      summary: suggestion.slice(0, 120),
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
      label: op.label || ('对「' + targetLabel + '」的建议'),
      title: '',
      formula: '',
      target_node_id: targetId,
      target_label: targetLabel,
      suggestion,
      priority,
      x: pos.x,
      y: pos.y,
      depth: 4,
      targetAngle: 0,
      isRoot: false,
      timestamp: Date.now(),
      pinned: false,
      fixedX: null,
      fixedY: null,
      customWidth: 280,
      customHeight: null,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
    };
  }

  function _buildHarnessPreview(ops) {
    const state = _harnessGraphState() || {};
    const existingNodes = _graphNodes();
    const existingById = new Map(existingNodes.map(node => [node.id, node]));
    const existingIds = new Set(existingById.keys());
    const canvas = document.getElementById('graphCanvas');
    const canvasRect = canvas?.getBoundingClientRect();
    const pan = state.pan || { x: 80, y: 80 };
    const zoom = state.zoom || 0.9;
    const centerX = canvasRect && canvasRect.width ? (canvasRect.width / 2 - pan.x) / zoom : 0;
    const centerY = canvasRect && canvasRect.height ? (canvasRect.height / 2 - pan.y) / zoom : 0;
    const center = { x: centerX, y: centerY };
    const newAnchorById = new Map();

    (ops || []).forEach(op => {
      const name = op.op || op.type || '';
      if (name === 'create_eval_node') {
        const newId = op.assigned_id || op.id || op.temp_id;
        const parts = _edgeParts(op.edge_key || op.key);
        const targetId = parts ? parts.from : (op.target_node_id || op.target || '');
        if (newId && targetId && existingById.has(targetId)) newAnchorById.set(newId, existingById.get(targetId));
      } else if (name === 'add_edge') {
        const parts = _edgeParts(op.edge_key || op.key);
        const from = parts ? parts.from : op.from;
        const to = parts ? parts.to : op.to;
        const anchorId = existingById.has(from) ? from : (existingById.has(to) ? to : '');
        const newEndpoint = !existingById.has(from) ? from : (!existingById.has(to) ? to : '');
        if (newEndpoint && anchorId) newAnchorById.set(newEndpoint, existingById.get(anchorId));
      }
    });

    const previewById = new Map();
    const previews = [];
    const edges = [];
    const seenEdgeKeys = new Set();

    function addPreview(id, op, kind) {
      if (!id || existingIds.has(id) || previewById.has(id)) return;
      const anchor = newAnchorById.get(id) || center;
      const angle = previews.length * 2.399963;
      const pos = {
        x: Math.round(anchor.x + Math.cos(angle) * 180),
        y: Math.round(anchor.y + Math.sin(angle) * 140),
      };
      const moduleKey = op.module_key || op.moduleKey || '';
      const fallbackLabel = kind === 'module' ? _moduleLabel(moduleKey) : _kindLabel(kind);
      previewById.set(id, {
        id,
        kind,
        label: String(op.label || op.title || fallbackLabel || '新节点'),
        x: pos.x,
        y: pos.y,
        w: 220,
        h: kind === 'ai_eval' ? 112 : 78,
      });
      previews.push(previewById.get(id));
    }

    function addEdge(from, to, fromPort, toPort, relation, label) {
      if (!from || !to) return;
      const key = _edgeKey({ from, fromPort, to, toPort });
      if (seenEdgeKeys.has(key)) return;
      seenEdgeKeys.add(key);
      edges.push({ from, to, fromPort, toPort, relation: String(relation || ''), label: String(label || '') });
    }

    (ops || []).forEach(op => {
      const name = op.op || op.type || '';
      if (name === 'create_node' || name === 'create_eval_node') {
        const kind = name === 'create_eval_node' ? 'ai_eval' : (op.kind || 'knowledge');
        addPreview(op.assigned_id || op.id || op.temp_id, op, kind);
      }
    });

    (ops || []).forEach(op => {
      const name = op.op || op.type || '';
      if (name === 'create_eval_node') {
        const id = op.assigned_id || op.id || op.temp_id;
        const parts = _edgeParts(op.edge_key || op.key);
        const from = parts ? parts.from : (op.target_node_id || op.target || op.from);
        const to = parts ? parts.to : id;
        const fromPort = (parts ? parts.fromPort : op.fromPort) || 'out-0';
        const toPort = (parts ? parts.toPort : op.toPort) || 'in-0';
        addEdge(from, to, fromPort, toPort, '评价', '评价');
      } else if (name === 'add_edge') {
        const parts = _edgeParts(op.edge_key || op.key);
        const from = parts ? parts.from : op.from;
        const to = parts ? parts.to : op.to;
        const fromPort = (parts ? parts.fromPort : op.fromPort) || 'out-0';
        const toPort = (parts ? parts.toPort : op.toPort) || 'in-0';
        addEdge(from, to, fromPort, toPort, op.relation, op.label);
      }
    });

    return { nodes: previews, edges };
  }

  function _prepareHarnessNodeReuse(id, state) {
    if (!id) return false;
    state.harnessDeleted = state.harnessDeleted || {};
    const existing = state.customNodes.find(node => node.id === id);
    if (existing && !state.harnessDeleted[id]) return false;
    if (existing) state.customNodes = state.customNodes.filter(node => node.id !== id);
    delete state.harnessDeleted[id];
    delete state.positions[id];
    delete state.sizes[id];
    delete state.pinned[id];
    delete state.inputPortCounts[id];
    state.connections = state.connections.filter(edge => edge.from !== id && edge.to !== id);
    return true;
  }
