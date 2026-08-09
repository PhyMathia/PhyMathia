// ===== PhyMathia 图编辑 harness：评审运行与澄清 =====


  function _buildStructuredHarnessHistory() {
    return (Array.isArray(harnessHistory) ? harnessHistory : []).slice(-20).map(entry => {
      if (entry.role === 'user') {
        return { role: 'user', instruction: String(entry.instruction || entry.content || '').slice(0, 400) };
      }
      return {
        role: 'assistant',
        summary: String(entry.summary || entry.content || '').slice(0, 400),
        operations: Array.isArray(entry.operations) ? entry.operations.slice(0, 20).map(op => ({
          op: op.op || op.type || '',
          id: op.id || '',
          temp_id: op.temp_id || '',
          assigned_id: op.assigned_id || '',
          from: op.from || '',
          to: op.to || '',
          edge_key: op.edge_key || op.key || '',
          label: op.label || '',
          kind: op.kind || '',
          patch: op.patch || undefined,
        })) : [],
      };
    });
  }

  function _isHarnessCasualInstruction(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 40) return false;
    const casual = /^(你好|您好|嗨|哈喽|hello|hi|hey|谢谢|感谢|哈哈|嘿嘿|在吗|在不在|随便聊聊|聊聊|没事|好的|嗯|再见|拜拜|晚安|早安|辛苦了|厉害|不错|666|嗯嗯|ok|好的吧|可以|没问题|了解|明白|你是谁|你叫什么|你会什么|能干什么)[!！。.~～\s]*$/i;
    if (casual.test(t)) return true;
    const learning = /什么是|为什么|怎么|如何|解释|讲|公式|导数|积分|物理|数学|题目|作业|求|帮我|区别|证明|推导|求解|请问|写|做|整理|新增|删除|修改|连线|节点|扩展|评价|进阶|建议|审阅/;
    if (learning.test(t)) return false;
    return /(你好|您好|嗨|谢谢|感谢|哈哈|嘿嘿|在吗|随便聊聊|聊聊|辛苦|不错|再见|拜拜|晚安|早安|你是谁|你叫什么|你会什么|能干什么)/.test(t) && t.length <= 25;
  }

  function _harnessCasualReply(text) {
    const t = String(text || '').trim();
    if (/谢谢|感谢/.test(t)) return '不客气～需要我帮你整理知识点、连线或拓展进阶链，随时说一声！';
    if (/你是谁|你叫什么/.test(t)) return '我是你的 AI 网络助手（Φ），专门帮你打理知识网络：梳理知识点、建立连线、生成进阶学习链，也可以陪你聊聊天～';
    if (/你会什么|能干什么/.test(t)) return '我可以帮你：① 提取和整理知识点 ② 建立/修正知识点之间的连线 ③ 生成物理/数学视角与进阶学习链 ④ 评价你的理解并给出改进建议。想先试哪个？';
    if (/在吗|在不在/.test(t)) return '在的～想整理知识网络、补个视角，还是随便聊聊？';
    if (/再见|拜拜|晚安/.test(t)) return '再见～有想梳理的概念随时来找我！';
    if (/早安/.test(t)) return '早上好！今天想先整理哪个知识点？';
    if (/哈哈|嘿嘿|666|厉害|不错/.test(t)) return '哈哈，过奖啦～需要我做点什么吗？';
    return '你好呀！我是你的 AI 网络助手，随时可以帮你整理知识点、连线或拓展学习链，也可以随便聊聊～';
  }

  function runGraphHarnessWithText(text) {
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.value = String(text || '');
    runGraphHarness();
  }

  function undoLastHarnessEdit() {
    if (!(Array.isArray(harnessLastAppliedOps) && harnessLastAppliedOps.length)) {
      _setHarnessStatus('没有可撤销的已应用修改', 'error');
      return;
    }
    runGraphHarnessWithText('撤销刚才的修改，恢复原样');
  }

  async function runGraphHarness(phase = 'normal') {
    const instruction = String(document.getElementById('graphHarnessInstruction')?.value || '').trim();
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.value = '';
    if (_isHarnessCasualInstruction(instruction)) {
      const reply = _harnessCasualReply(instruction);
      _appendHarnessHistory({
        id: _historyId(), role: 'assistant', content: reply, instruction,
        summary: reply, operations: [], phase: 'normal', timestamp: Date.now(),
      });
      _setHarnessStatus('已回复', 'ok');
      return;
    }
    const model = typeof window.getActiveModelForRole === 'function'
      ? (window.getActiveModelForRole('graph') || window.getActiveModelForRole('agent'))
      : null;
    if (!model) {
      _setHarnessStatus('请先配置主模型', 'error');
      return;
    }
    const state = _graphState() || {};
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const evalNodes = _graphNodes().filter(node => node.kind === 'ai_eval' && !deleted.has(node.id));
    const requestedPhase = phase || 'normal';
    harnessPhase = requestedPhase === 'normal'
      ? _detectHarnessPhase(instruction, evalNodes)
      : requestedPhase;
    harnessLastInstruction = instruction;
    harnessLastPhase = harnessPhase;
    _appendHarnessHistory({
      id: _historyId(),
      role: 'user',
      content: instruction,
      phase: harnessPhase,
      timestamp: Date.now(),
    });
    if (harnessPhase === 'evaluate' && evalNodes.length) {
      _setHarnessStatus('请先应用或删除现有 AI 评价节点', 'error');
      return;
    }
    if (harnessPhase === 'apply' && !evalNodes.length) {
      _setHarnessStatus('当前没有 AI 评价节点', 'error');
      return;
    }
    let focusIds = [];
    if (!harnessSingleEvalId) {
      const candidateFocusIds = _detectFocusNodeIds(instruction, _graphNodes().filter(node => !deleted.has(node.id)));
      if (candidateFocusIds.length !== 1) {
        _setHarnessBusy(true);
        _setHarnessStatus('正在理解目标...', 'running');
        let resolved = null;
        try {
          resolved = await _resolveHarnessFocus(candidateFocusIds, instruction);
        } catch (err) {
          resolved = null;
          focusIds = [];
          _setHarnessStatus('目标解析失败，已按当前图继续：' + err.message, 'running');
        }
        if (resolved && resolved.status === 'error') {
          focusIds = [];
          const reason = resolved.errors?.[0]?.reason || resolved.question || '目标解析失败';
          _setHarnessStatus('目标解析失败，已按当前图继续：' + reason, 'running');
        } else if (resolved && resolved.question && !(resolved.candidates || []).length) {
          focusIds = [];
          _setHarnessStatus('模型未能确定目标，已按当前图继续：' + resolved.question, 'running');
        } else if (resolved && resolved.ambiguous && (resolved.candidates || []).length) {
          _setHarnessBusy(false);
          _startHarnessClarify(resolved.candidates, instruction, harnessPhase);
          return;
        } else if (resolved) {
          focusIds = resolved.focus_node_ids || [];
        }
      } else if (candidateFocusIds.length === 1) {
        focusIds = candidateFocusIds;
      }
    }
    if (harnessPhase === 'expand' && !focusIds.length) {
      focusIds = typeof window.getSelectedGraphNodeIds === 'function'
        ? Array.from(window.getSelectedGraphNodeIds())
        : [];
    }
    const snapshot = buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId);
    harnessSnapshot = snapshot;
    const _snapshotMeta = snapshot.snapshot_meta || {};
    if (_snapshotMeta.est_tokens > 30000) {
      _setHarnessStatus('图太大（约 ' + Math.round(_snapshotMeta.est_tokens / 1000) + 'k tokens），请先选中局部节点或缩小范围后再让 AI 修改', 'error');
      return;
    }
    if (!snapshot.nodes.length) {
      _setHarnessStatus('当前没有可审阅节点', 'error');
      return;
    }
    harnessResult = null;
    _setHarnessStatus(
      harnessPhase === 'evaluate' ? '生成评价节点中...' : harnessPhase === 'apply' ? '应用建议中...' : '审阅中...',
      'running'
    );
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '';
    document.getElementById('graphHarnessApplyActions')?.setAttribute('hidden', '');
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessBusy(true);

    harnessAbortController = new AbortController();
    try {
      const resp = await fetch(HARNESS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshot,
          instruction,
          model: {
            provider: model.provider,
            api_key: model.apiKey,
            model: model.model,
            base_url: model.baseUrl,
          },
          max_tokens: 6000,
          phase: harnessPhase,
          level: localStorage.getItem('phymathia_level') || 'university',
          focus_node_ids: focusIds,
          conversation_context: _buildConversationContext(),
          harness_history: _buildStructuredHarnessHistory(),
          previous_ops: Array.isArray(harnessLastAppliedOps) ? harnessLastAppliedOps : [],
          previous_snapshot: harnessLastAppliedBeforeSnapshot || null,
          retries: 2,
        }),
          signal: harnessAbortController.signal,
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.errors?.[0]?.reason || 'harness 请求失败');
      }
      harnessResult = data;
      renderHarnessResult(data);
      if (data.status === 'undo' && (data.operations || []).length) {
        if (typeof _applyOps === 'function') {
          _applyOps(data.operations, false);
          harnessLastAppliedOps = [];
          harnessLastAppliedBeforeSnapshot = null;
          _setHarnessStatus('已撤销上一条修改', 'ok');
        }
      }
      _appendHarnessHistory({
        id: _historyId(),
        role: 'assistant',
        content: _harnessAssistantContent(data),
        instruction,
        summary: data.summary || '',
        operations: data.operations || [],
        phase: harnessPhase,
        decision: 'pending',
        timestamp: Date.now(),
      });
      if (typeof window.applyGraphDiffHighlights === 'function') {
        setTimeout(() => window.applyGraphDiffHighlights(data.operations || []), 0);
      }
      if (typeof window.showGraphHarnessPreview === 'function') {
        const preview = _buildHarnessPreview(data.operations || []);
        window.__lastHarnessPreview = preview;
        const _previewSwitched = window.showGraphHarnessPreview(preview.nodes, preview.edges);
        if (preview.nodes.length || preview.edges.length) {
          _setHarnessStatus('已生成 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线' + (_previewSwitched ? '（已切换到画布视图）' : ''), 'ok');
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        _setHarnessStatus('已取消', 'ok');
      } else {
        _setHarnessStatus('审阅失败：' + err.message, 'error');
        _showHarnessRetry('审阅失败：' + err.message);
        if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
        if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
      }
    } finally {
      _setHarnessBusy(false);
      harnessSingleEvalId = null;
      harnessAbortController = null;
    }
  }


  function _startHarnessClarify(focusIds, instruction, phase) {
    const list = (focusIds || []).map(item => {
      if (typeof item === 'string') {
        const node = _graphNodes().find(n => n.id === item);
        return { id: item, label: node ? (_nodeLabel(node) || item) : item, hint: '' };
      }
      return { id: item.id, label: item.label || item.id, hint: item.hint || '' };
    });
    harnessPendingClarify = { candidates: list, instruction, phase };
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    chat.innerHTML = '<div class="graph-harness-clarify"><div>发现多个匹配节点，请选择：</div>'
      + list.map(candidate => '<div class="graph-harness-clarify-item"><button type="button" onclick="chooseHarnessClarifyNode(\'' + candidate.id + '\')">'
        + _escapeHtml(candidate.label) + '</button>'
        + (candidate.hint ? '<span class="graph-harness-clarify-hint">' + _escapeHtml(candidate.hint) + '</span>' : '')
        + '</div>').join('')
      + '<div class="graph-harness-clarify-input"><input id="graphHarnessClarifyInput" placeholder="输入节点名称或ID">'
      + '<button type="button" onclick="confirmHarnessClarifyInput()">确认</button></div>'
      + '</div>';
    chat.scrollTop = chat.scrollHeight;
    _setHarnessStatus('请选择目标节点', 'running');
  }

  function chooseHarnessClarifyNode(nodeId) {
    const pending = harnessPendingClarify;
    if (!pending) return;
    harnessPendingClarify = null;
    const instructionEl = document.getElementById('graphHarnessInstruction');
    if (instructionEl) instructionEl.value = pending.instruction;
    runGraphHarnessWithFocus(pending.phase, [nodeId]);
  }

  function confirmHarnessClarifyInput() {
    const input = document.getElementById('graphHarnessClarifyInput');
    const pending = harnessPendingClarify;
    if (!pending || !input) return;
    const text = input.value.trim();
    if (!text) return;
    const nodes = _graphNodes();
    const node = nodes.find(item => item.id === text || _nodeLabel(item) === text);
    harnessPendingClarify = null;
    if (node) {
      runGraphHarnessWithFocus(pending.phase, [node.id]);
    } else {
      _setHarnessStatus('未找到该节点，请选择列表中的节点或检查名称', 'error');
    }
  }

  async function runGraphHarnessWithFocus(phase, focusIds) {
    const instruction = String(document.getElementById('graphHarnessInstruction')?.value || '').trim();
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.value = '';
    const model = typeof window.getActiveModelForRole === 'function'
      ? window.getActiveModelForRole('agent')
      : null;
    if (!model) {
      _setHarnessStatus('请先配置主模型', 'error');
      return;
    }
    const state = _graphState() || {};
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const evalNodes = _graphNodes().filter(node => node.kind === 'ai_eval' && !deleted.has(node.id));
    harnessPhase = phase || 'normal';
    harnessLastInstruction = instruction;
    harnessLastPhase = harnessPhase;
    _appendHarnessHistory({
      id: _historyId(),
      role: 'user',
      content: instruction,
      phase: harnessPhase,
      timestamp: Date.now(),
    });
    const snapshot = buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId);
    harnessSnapshot = snapshot;
    if (!snapshot.nodes.length) {
      _setHarnessStatus('当前没有可审阅节点', 'error');
      return;
    }
    harnessResult = null;
    _setHarnessStatus(harnessPhase === 'evaluate' ? '生成评价节点中...' : '应用建议中...', 'running');
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '';
    document.getElementById('graphHarnessApplyActions')?.setAttribute('hidden', '');
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessBusy(true);
    try {
      const resp = await fetch(HARNESS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshot,
          instruction,
          model: {
            provider: model.provider,
            api_key: model.apiKey,
            model: model.model,
            base_url: model.baseUrl,
          },
          max_tokens: 6000,
          phase: harnessPhase,
          level: localStorage.getItem('phymathia_level') || 'university',
          focus_node_ids: focusIds,
          conversation_context: _buildConversationContext(),
          harness_history: _buildStructuredHarnessHistory(),
          previous_ops: Array.isArray(harnessLastAppliedOps) ? harnessLastAppliedOps : [],
          previous_snapshot: harnessLastAppliedBeforeSnapshot || null,
          retries: 2,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.errors?.[0]?.reason || 'harness 请求失败');
      }
      harnessResult = data;
      renderHarnessResult(data);
      _appendHarnessHistory({
        id: _historyId(),
        role: 'assistant',
        content: _harnessAssistantContent(data),
        instruction,
        summary: data.summary || '',
        operations: data.operations || [],
        phase: harnessPhase,
        decision: 'pending',
        timestamp: Date.now(),
      });
      if (typeof window.applyGraphDiffHighlights === 'function') {
        setTimeout(() => window.applyGraphDiffHighlights(data.operations || []), 0);
      }
      if (typeof window.showGraphHarnessPreview === 'function') {
        const preview = _buildHarnessPreview(data.operations || []);
        window.__lastHarnessPreview = preview;
        const _previewSwitched = window.showGraphHarnessPreview(preview.nodes, preview.edges);
        if (preview.nodes.length || preview.edges.length) {
          _setHarnessStatus('已生成 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线' + (_previewSwitched ? '（已切换到画布视图）' : ''), 'ok');
        }
      }
    } catch (err) {
      _setHarnessStatus('审阅失败：' + err.message, 'error');
      _showHarnessRetry('审阅失败：' + err.message);
      if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
      if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    } finally {
      _setHarnessBusy(false);
    }
  }

  function _nodeLabelById(id, allOps) {
    const raw = String(id || '');
    if (!raw) return '';
    const opsList = Array.isArray(allOps) ? allOps : [];
    const byId = {};
    opsList.forEach(op => {
      if ((op.op || op.type) === 'create_node') {
        const label = op.label || op.title || '';
        const aid = op.assigned_id || op.id || op.temp_id;
        const tid = op.temp_id;
        if (aid) byId[String(aid)] = label;
        if (tid) byId[String(tid)] = label;
      }
    });
    if (byId[raw]) return byId[raw];
    if (typeof window.getGraphViewNodes === 'function') {
      const node = window.getGraphViewNodes().find(item => String(item.id) === raw);
      if (node) return node.label || node.title || _moduleLabel(node.moduleKey || node.module_key) || '';
    }
    if (typeof harnessSnapshot !== 'undefined' && harnessSnapshot && Array.isArray(harnessSnapshot.nodes)) {
      const sn = harnessSnapshot.nodes.find(item => String(item.id) === raw);
      if (sn) return sn.label || sn.title || '';
    }
    return raw;
  }

  function _edgeEndpointsOf(key) {
    const parts = typeof _edgeParts === 'function' ? _edgeParts(key) : null;
    if (parts) return parts;
    const m = String(key || '').match(/^([^:]+):[^>]*->([^:]+):/);
    return m ? { from: m[1], to: m[2] } : null;
  }

  function _opDescription(op, allOps) {
    const name = op.op || op.type || '';
    if (name === 'create_node') {
      const moduleKey = op.module_key || op.moduleKey || '';
      const nodeName = op.label || op.title || (moduleKey ? _moduleLabel(moduleKey) : '') || op.temp_id || '';
      return '新增' + (moduleKey ? _moduleLabel(moduleKey) : _kindLabel(op.kind)) + '「' + nodeName + '」';
    }
    if (name === 'create_eval_node') {
      const target = op.target_label || op.target_node_id || op.target || '目标节点';
      return '为「' + target + '」生成 AI 评价节点';
    }
    if (name === 'update_node') {
      return '修改节点「' + _nodeLabelById(op.label || op.id, allOps) + '」';
    }
    if (name === 'delete_node') {
      return '删除节点「' + _nodeLabelById(op.label || op.id, allOps) + '」';
    }
    if (name === 'add_edge') {
      const from = op.from_label || _nodeLabelById(op.from, allOps);
      const to = op.to_label || _nodeLabelById(op.to, allOps);
      return '新增连线：「' + (from || '上游') + '」→「' + (to || '下游') + '」' + (op.relation ? '（' + op.relation + '）' : '');
    }
    if (name === 'remove_edge') {
      const ends = _edgeEndpointsOf(op.edge_key || op.key || '');
      const from = op.from_label || (ends ? _nodeLabelById(ends.from, allOps) : '');
      const to = op.to_label || (ends ? _nodeLabelById(ends.to, allOps) : '');
      return '删除连线：「' + (from || '上游') + '」→「' + (to || '下游') + '」';
    }
    if (name === 'update_edge') {
      const ends = _edgeEndpointsOf(op.edge_key || op.key || '');
      const from = op.from_label || (ends ? _nodeLabelById(ends.from, allOps) : '');
      const to = op.to_label || (ends ? _nodeLabelById(ends.to, allOps) : '');
      return '调整连线：「' + (from || '上游') + '」→「' + (to || '下游') + '」';
    }
    return name || '未知操作';
  }

  function _buildHumanReadableReport(ops) {
    const list = Array.isArray(ops) ? ops : [];
    if (!list.length) return '';
    const MAX_PER_GROUP = 6;
    const groups = [
      { key: 'create_node', title: '新增' },
      { key: 'add_edge', title: '新增连线' },
      { key: 'update_node', title: '修改节点' },
      { key: 'update_edge', title: '调整连线' },
      { key: 'delete_node', title: '删除节点' },
      { key: 'remove_edge', title: '删除连线' },
      { key: 'create_eval_node', title: 'AI 评价' },
    ];
    const counts = {};
    list.forEach(op => { const k = op.op || op.type || ''; counts[k] = (counts[k] || 0) + 1; });
    const countParts = [];
    if (counts.create_node) countParts.push('新增 ' + counts.create_node + ' 个节点');
    if (counts.add_edge) countParts.push(counts.add_edge + ' 条连线');
    if (counts.update_node) countParts.push('修改 ' + counts.update_node + ' 处');
    if (counts.update_edge) countParts.push('调整 ' + counts.update_edge + ' 条连线');
    if (counts.delete_node) countParts.push('删除 ' + counts.delete_node + ' 个节点');
    if (counts.remove_edge) countParts.push('移除 ' + counts.remove_edge + ' 条连线');
    if (counts.create_eval_node) countParts.push(counts.create_eval_node + ' 条评价建议');
    const sections = [];
    for (const group of groups) {
      const items = list.filter(op => (op.op || op.type) === group.key);
      if (!items.length) continue;
      const lines = items.slice(0, MAX_PER_GROUP).map(op => '• ' + _opDescription(op, list));
      let block = '**' + group.title + '（' + items.length + '）**\n' + lines.join('\n');
      if (items.length > MAX_PER_GROUP) block += '\n… 等 ' + items.length + ' 项';
      sections.push(block);
    }
    const head = countParts.length ? '**共 ' + list.length + ' 处调整**：' + countParts.join('、') + '。' : '';
    return (head ? head + '\n\n' : '') + sections.join('\n\n');
  }

  function _harnessAssistantContent(data) {
    const ops = Array.isArray(data.operations) ? data.operations : [];
    const summary = String((data.summary || '').trim())
      || (ops.length ? '已生成 ' + ops.length + ' 条图修改建议' : '模型没有提出可执行修改');
    const parts = [summary];
    const report = _buildHumanReadableReport(ops);
    if (report) parts.push(report);
    if ((data.warnings || []).length) parts.push('⚠️ ' + data.warnings.map(w => w.reason || '').join('；'));
    if (ops.length && data.status !== 'undo') parts.push('可点「查看预览」确认效果，满意后点击保留；不满意可随时撤销或重跑。');
    return parts.join('\n\n');
  }

  function runHarnessExpandQuick() {
    const selected = typeof window.getSelectedGraphNodeIds === 'function'
      ? window.getSelectedGraphNodeIds()
      : [];
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) {
      inputEl.value = selected.length
        ? '为选中的 ' + selected.length + ' 个知识点生成进阶学习链'
        : '为当前知识点生成进阶学习链';
    }
    runGraphHarness();
  }
