// ===== PhyMathia 图编辑 harness：评审运行与澄清 =====


  function _capOpPatch(patch) {
    if (patch === undefined || patch === null) return undefined;
    if (typeof patch === 'object') {
      const out = {};
      for (const k of Object.keys(patch)) out[k] = String(patch[k] ?? '').slice(0, 200);
      return out;
    }
    return String(patch).slice(0, 200);
  }

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
          patch: _capOpPatch(op.patch),
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

  // 纯问答：用户只是在提问（物理/数学/讲解），没有改图意图。
  // 这类请求不依赖画布节点，空画布也能直接回答，且不走图的焦点解析/快照压缩。
  function _isHarnessPureQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const editIntent = /新增|创建|删除|删掉|去掉|连线|连接|加上|加一|补一|整理|梳理|扩展|评价|审阅|修改|改成|重写|更新|合并|拆分|视角|模块|建议|改进|完善|链接|撤销|回退/.test(t);
    if (editIntent) return false;
    return /什么是|是什么|为什么|怎么|如何|解释|讲讲|讲一下|介绍一下|说明|公式|区别|证明|推导|求解|请问|求导|积分|作业|题目|会不会|对吗|对不对|讲讲/.test(t);
  }

  function _harnessCasualReply(text) {
    const t = String(text || '').trim();
    if (/谢谢|感谢/.test(t)) return '不客气～需要我帮你整理知识点、连线或拓展进阶链，随时说一声！';
    if (/你是谁|你叫什么/.test(t)) return '我是 Φ，PhyMathia 的网络助手，专门帮你打理知识网络：梳理知识点、建立连线、生成进阶学习链，也可以陪你聊聊天～';
    if (/你会什么|能干什么/.test(t)) return '我可以帮你：① 提取和整理知识点 ② 建立/修正知识点之间的连线 ③ 生成物理/数学视角与进阶学习链 ④ 评价你的理解并给出改进建议。想先试哪个？';
    if (/在吗|在不在/.test(t)) return '在的～想整理知识网络、补个视角，还是随便聊聊？';
    if (/再见|拜拜|晚安/.test(t)) return '再见～有想梳理的概念随时来找我！';
    if (/早安/.test(t)) return '早上好！今天想先整理哪个知识点？';
    if (/哈哈|嘿嘿|666|厉害|不错/.test(t)) return '哈哈，过奖啦～需要我做点什么吗？';
    return '你好呀！我是 Φ，PhyMathia 的网络助手，随时可以帮你整理知识点、连线或拓展学习链，也可以随便聊聊～';
  }

  // hy3 系模型统一修正到 OpenCode Go 端点（zen/go），密钥交给服务端 OPENCODE_GO_API_KEY 兜底。
  // 兼容旧的本地缓存误配（provider=opencode / base_url=zen/v1 会把 hy3 发到免费端点，
  // 上游会报 "Model hy3 is not supported"），这里在发请求前强制纠正，保证 Φ 能用。
  function _harnessModelForRequest(model) {
    if (!model) return null;
    const out = {
      provider: model.provider,
      api_key: model.apiKey,
      model: model.model,
      base_url: model.baseUrl,
    };
    if (/^(hy3|hy3-preview)$/i.test(String(out.model || '').trim())) {
      out.provider = 'opencode-go';
      out.base_url = 'https://opencode.ai/zen/go/v1';
      out.api_key = '';
    }
    return out;
  }

  // 把上游/后端报错翻译成用户可读的提示
  function _harnessErrorToHuman(text) {
    const raw = String(text || '');
    if (/FreeUsageLimit|Rate limit|429|限流/i.test(raw)) {
      return '免费模型被限流（429）。请稍后再试，或在“模型设置”里切换到 hy3 模型';
    }
    if (/Model hy3 is not supported/i.test(raw)) {
      return 'hy3 被发往了错误的端点（现已自动改用 OpenCode Go 端点），请重试；若仍失败，请在“模型设置”里选用 OpenCode Go · hy3';
    }
    if (/Invalid API key|AuthError|Unauthorized|401/i.test(raw)) {
      return '模型密钥无效或缺失（401）。hy3 的密钥由服务端 .env 的 OPENCODE_GO_API_KEY 提供，请检查服务端配置';
    }
    if (/timeout|Timed out|timed out|timedout/i.test(raw)) {
      return '请求超时：hy3 是推理模型、响应较慢，请重试或稍等片刻';
    }
    return raw;
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
      _appendHarnessHistory({
        id: _historyId(), role: 'user', content: instruction, phase: 'normal', timestamp: Date.now(),
      });
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
    const pureQuestion = _isHarnessPureQuestion(instruction);
    if (!harnessSingleEvalId && !pureQuestion) {
      const candidateFocusIds = _detectFocusNodeIds(instruction, _graphNodes().filter(node => !deleted.has(node.id)));
      if (candidateFocusIds.length === 1) {
        focusIds = candidateFocusIds;
      } else if (harnessPhase === 'evaluate' && candidateFocusIds.length === 0) {
        // 整体评价：没有引用具体节点，无需解析目标，直接整图评价
        focusIds = [];
      } else {
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
      }
    }
    if (harnessPhase === 'expand' && !focusIds.length) {
      focusIds = typeof window.getSelectedGraphNodeIds === 'function'
        ? Array.from(window.getSelectedGraphNodeIds())
        : [];
    }
    // 快照一律用真实画布内容：有图发真图，空画布自然为空。
    // 此前纯问答故意发空快照，一旦意图误判就会让模型看到"空图"而答非所问
    // （真实事故：用户拒绝建议后所有请求 nodes=0，模型回答"没有任何节点"）。
    const snapshot = buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId);
    harnessSnapshot = snapshot;
    const _snapshotMeta = snapshot.snapshot_meta || {};
    if (_snapshotMeta.est_tokens > 30000) {
      _setHarnessStatus('图太大（约 ' + Math.round(_snapshotMeta.est_tokens / 1000) + 'k tokens），请先选中局部节点或缩小范围后再让 AI 修改', 'error');
      return;
    }
    if (!snapshot.nodes.length && !pureQuestion) {
      const canvasCount = typeof _graphNodes === 'function' ? _graphNodes().length : 0;
      const wiped = (_snapshotMeta && _snapshotMeta.deleted_filtered) || 0;
      if (canvasCount > 0 && wiped > 0) {
        _setHarnessStatus('画布上有 ' + canvasCount + ' 个节点，但其中 ' + wiped + ' 个被此前的撤销/拒绝标记为已删除。在控制台执行 restoreHarnessDeletedNodes() 可一键恢复', 'error');
      } else {
        _setHarnessStatus('当前画布上没有节点：可直接向我提问，或先在主聊天生成内容后再让我整理', 'error');
      }
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
          pure_chat: !!pureQuestion,
          instruction,
          model: _harnessModelForRequest(model),
          max_tokens: 6000,
          phase: harnessPhase,
          level: localStorage.getItem('phymathia_level') || 'university',
          focus_node_ids: focusIds,
          harness_history: _buildStructuredHarnessHistory(),
          previous_ops: Array.isArray(harnessLastAppliedOps) ? harnessLastAppliedOps : [],
          previous_snapshot: harnessLastAppliedBeforeSnapshot || null,
          retries: 2,
        }),
          signal: harnessAbortController.signal,
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error((data.errors && data.errors[0] && data.errors[0].reason) || 'harness 请求失败');
      }
      // 后端把模型失败也返回 HTTP 200 + status:"error"（如 401/429），这里必须显式抛错，
      // 否则会静默走“无操作”分支、状态永远卡在“审阅中...”。
      if (data.status === 'error' || (data.errors && data.errors.length)) {
        throw new Error((data.errors || []).map(item => (item && (item.reason || item.message)) || '未知错误').filter(Boolean).join('；') || '未知错误');
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
        window.showGraphHarnessPreview(preview.nodes, preview.edges);
        if (preview.nodes.length || preview.edges.length) {
          _setHarnessStatus('已生成 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线', 'ok');
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        _setHarnessStatus('已取消', 'ok');
      } else {
        const human = _harnessErrorToHuman(err && err.message ? err.message : String(err));
        _setHarnessStatus('审阅失败：' + human, 'error');
        _showHarnessRetry('审阅失败：' + human);
        if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
        if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
      }
    } finally {
      _setHarnessBusy(false);
      harnessSingleEvalId = null;
      harnessAbortController = null;
      // 兜底：任何“进行中”状态都必须落定，避免一直显示“审阅中...”
      const _statusEl = document.getElementById('graphHarnessStatus');
      if (_statusEl && _statusEl.classList && _statusEl.classList.contains('graph-harness-status-running')) {
        _setHarnessStatus('已完成', 'ok');
      }
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
          pure_chat: !!pureQuestion,
          instruction,
          model: _harnessModelForRequest(model),
          max_tokens: 6000,
          phase: harnessPhase,
          level: localStorage.getItem('phymathia_level') || 'university',
          focus_node_ids: focusIds,
          harness_history: _buildStructuredHarnessHistory(),
          previous_ops: Array.isArray(harnessLastAppliedOps) ? harnessLastAppliedOps : [],
          previous_snapshot: harnessLastAppliedBeforeSnapshot || null,
          retries: 2,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error((data.errors && data.errors[0] && data.errors[0].reason) || 'harness 请求失败');
      }
      if (data.status === 'error' || (data.errors && data.errors.length)) {
        throw new Error((data.errors || []).map(item => (item && (item.reason || item.message)) || '未知错误').filter(Boolean).join('；') || '未知错误');
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
        window.showGraphHarnessPreview(preview.nodes, preview.edges);
        if (preview.nodes.length || preview.edges.length) {
          _setHarnessStatus('已生成 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线', 'ok');
        }
      }
    } catch (err) {
      const human = _harnessErrorToHuman(err && err.message ? err.message : String(err));
      _setHarnessStatus('审阅失败：' + human, 'error');
      _showHarnessRetry('审阅失败：' + human);
      if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
      if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    } finally {
      _setHarnessBusy(false);
      // 兜底：任何“进行中”状态都必须落定，避免一直显示“审阅中...”
      const _statusEl = document.getElementById('graphHarnessStatus');
      if (_statusEl && _statusEl.classList && _statusEl.classList.contains('graph-harness-status-running')) {
        _setHarnessStatus('已完成', 'ok');
      }
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

