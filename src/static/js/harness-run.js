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

  // 纯问答：用户只是在提问（物理/数学/讲解），没有改图意图。
  // 这类请求不依赖画布节点，空画布也能直接回答，且不走图的焦点解析/快照压缩。
  // （答疑模式 phase=chat 是同一语义的显式版，见 runGraphHarness 内的 pureQuestion 合成）
  function _isHarnessPureQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const editIntent = /新增|创建|删除|删掉|去掉|连线|连接|加上|加一|补一|整理|梳理|扩展|评价|审阅|修改|改成|重写|更新|合并|拆分|视角|模块|建议|改进|完善|链接|撤销|回退/.test(t);
    if (editIntent) return false;
    return /什么是|是什么|为什么|怎么|如何|解释|讲讲|讲一下|介绍一下|说明|公式|区别|证明|推导|求解|请问|求导|积分|作业|题目|会不会|对吗|对不对|讲讲/.test(t);
  }

  // hy3 系模型统一修正到 OpenCode Go 端点（zen/go）。端点纠正后：条目自带密钥（分组密钥
  // 同步/手填）原样携带；留空才交给服务端 OPENCODE_GO_API_KEY 兜底。兼容旧的本地缓存误配
  // （provider=opencode / base_url=zen/v1 会把 hy3 发到免费端点，上游报 "Model hy3 is not
  //  supported"），这里在发请求前强制纠正，保证 Φ 能用。
  function _harnessModelForRequest(model) {
    if (!model) return null;
    const out = {
      provider: model.provider,
      api_key: model.apiKey,
      model: model.model,
      base_url: model.baseUrl,
    };
    if (/^(hy3|hy3-preview|hy4-preview)$/i.test(String(out.model || '').trim())) {
      out.provider = 'opencode-go';
      out.base_url = 'https://opencode.ai/zen/go/v1';
      if (!out.api_key) out.api_key = '';
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

  // 流式响应读取：SSE（data: {...}\n\n）逐事件回调 onEvent，最终返回 result 事件的 data。
  // 非流式响应（旧协议/空快照防御等直接回 JSON 的情况）原样 json() 返回，调用方无感。
  async function _readHarnessStreamResponse(resp, onEvent) {
    const ctype = String(resp.headers.get('content-type') || '');
    if (ctype.indexOf('text/event-stream') < 0) return resp.json();
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result = null;
    const handleLine = (raw) => {
      const line = raw.split('\n').find(item => item.startsWith('data:'));
      if (!line) return;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'result') result = evt.data;
      else if (typeof onEvent === 'function') onEvent(evt);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleLine(raw);
      }
    }
    if (buf.trim()) handleLine(buf);
    if (result === null) throw new Error('流式连接中断，未收到最终结果');
    return result;
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

  async function runGraphHarness(phase = 'normal', opts) {
    if (harnessBusy) return;
    const requestBinding = _harnessBinding();
    // 并发守卫（解耦后 2026-09-30）：phiId/epoch 只在 Φ 会话切换/清空时变，切画布
    // 不再打断纯问答；改图类请求仍要求「生成时绑定的画布」始终是当前打开的画布
    // （预览与应用都落在实时视图与撤销栈上，跨画布落笔是事故）。
    let requestIsPureChat = false;
    const stillCurrent = () => requestBinding.phiId === _phiId()
      && requestBinding.epoch === harnessSessionEpoch
      && (!requestBinding.sessionId || requestIsPureChat || requestBinding.sessionId === _sessionId());
    const instruction = String(document.getElementById('graphHarnessInstruction')?.value || '').trim();
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.value = '';
    // 失败路径统一回填输入框：指令没执行成不该让用户重新打一遍
    const restoreInstruction = () => {
      if (inputEl && instruction) inputEl.value = instruction;
    };
    // 澄清重跑路径（runGraphHarnessWithFocus 委托进来）：目标节点已由用户点选解析好，不再走焦点解析
    const presetFocusIds = opts && Array.isArray(opts.focusIds) ? opts.focusIds : null;
    // 三模式切换器（2026-09-30）：显式锁定 chat/preset 时，重试按钮（harnessLastPhase）、
    // 重新执行历史建议（entry.phase）、聚焦澄清重跑（pending.phase）携带的旧相位一律让位；
    // 唯一例外是内部 apply 流程（应用 AI 评价节点建议）。编辑模式 = 不锁定，走原有自动路由。
    // 撤销不需要例外：后端确定性撤销（_detect_undo_intent）在相位分派之前、不看相位。
    const lockedMode = ((typeof window._harnessMode === 'function' && window._harnessMode()) || 'edit');
    if (lockedMode !== 'edit' && phase !== 'apply') phase = lockedMode;
    const model = typeof window.getActiveModelForRole === 'function'
      ? (window.getActiveModelForRole('graph') || window.getActiveModelForRole('agent'))
      : null;
    if (!model) {
      _setHarnessStatus('请先配置主模型', 'error');
      restoreInstruction();
      return;
    }
    // 解耦后（2026-09-30）：改图只在「Φ 会话绑定的画布 = 当前打开画布」时可用。
    // 未绑定/绑了别的画布时，快照、焦点解析、评价节点全部跳过，只放行纯问答，
    // 改图类指令拦下并给出去向——绝不能把 A 画布的结果画到 B 画布上。
    const boundSid = _harnessBoundSid();
    const canvasReady = !!(boundSid && boundSid === _sessionId());
    const state = canvasReady ? (_harnessGraphState() || {}) : {};
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const evalNodes = canvasReady
      ? _graphNodes().filter(node => node.kind === 'ai_eval' && !deleted.has(node.id))
      : [];
    const requestedPhase = phase || 'normal';
    harnessPhase = requestedPhase === 'normal'
      ? _detectHarnessPhase(instruction, evalNodes)
      : requestedPhase;
    harnessLastInstruction = instruction;
    harnessLastPhase = harnessPhase;
    // 改图门槛（解耦后）：会话未绑定画布、或绑定的不是当前打开的画布时，
    // 除答疑/纯提问外一律拦下。此时不改历史——消息没发出去，不该留孤气泡。
    if (!canvasReady && harnessPhase !== 'chat' && !_isHarnessPureQuestion(instruction)) {
      const boundInfo = _currentPhiSession();
      const mismatchTitle = boundInfo && boundInfo.boundSid
        ? ((typeof window.getSessionById === 'function' && window.getSessionById(boundInfo.boundSid) || {}).title || '已删除画布')
        : '';
      _setHarnessStatus(boundSid
        ? '该 Φ 会话绑定的是画布《' + mismatchTitle + '》：请切换到该画布再改图（会话菜单可换绑/解绑）'
        : '该 Φ 会话未绑定画布，只能问答。可在会话菜单把它绑定到当前画布', 'error');
      restoreInstruction();
      return;
    }
    // 澄清重跑：首轮已记过这条 user 消息（随后被澄清面板打断、没有 assistant 回复跟随），
    // 再记一条会出现连续两条一模一样的用户气泡
    const lastEntry = harnessHistory.length ? harnessHistory[harnessHistory.length - 1] : null;
    const duplicateUserTurn = !!(lastEntry && lastEntry.role === 'user' && String(lastEntry.content || '') === instruction);
    if (!duplicateUserTurn) {
      _appendHarnessHistory({
        id: _historyId(),
        role: 'user',
        content: instruction,
        phase: harnessPhase,
        timestamp: Date.now(),
      });
    }
    if (harnessPhase === 'evaluate' && evalNodes.length) {
      _setHarnessStatus('请先应用或删除现有 AI 评价节点', 'error');
      restoreInstruction();
      return;
    }
    if (harnessPhase === 'apply' && !evalNodes.length) {
      _setHarnessStatus('当前没有 AI 评价节点', 'error');
      restoreInstruction();
      return;
    }
    let focusIds = [];
    // 答疑模式是纯问答的显式版：跳过焦点解析、空画布放行、pure_chat 置位全部随 pureQuestion 走。
    // 解耦后：未绑定/绑了别的画布的会话一律按纯问答走（空快照），不碰当前画布。
    const pureQuestion = harnessPhase === 'chat' || !canvasReady || _isHarnessPureQuestion(instruction);
    requestIsPureChat = pureQuestion;
    if (presetFocusIds) {
      focusIds = presetFocusIds;
    } else if (harnessPhase !== 'preset' && !harnessSingleEvalId && !pureQuestion) {
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
          if (!stillCurrent()) return;
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
    // 大陆 v3（Φ 摆渡）：审阅快照顺带当前画布的跨画布共享点（60s 缓存、失败
    // 静默——大陆查空是正常路径）；evaluate/apply 提示词不消费它，不注入。
    _setHarnessBusy(true);
    // 大陆共享点只对「绑定且打开中」的画布有意义；纯问答不拉（60s 缓存、失败静默）
    const continentData = canvasReady ? await _harnessFetchContinent() : null;
    if (!stillCurrent()) return;
    _setHarnessBusy(false);
    const snapshot = canvasReady
      ? buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId,
          harnessPhase === 'normal' ? continentData : null)
      : _emptyHarnessSnapshot();
    harnessSnapshot = snapshot;
    const _snapshotMeta = snapshot.snapshot_meta || {};
    if (_snapshotMeta.est_tokens > 30000) {
      _setHarnessStatus('图太大（约 ' + Math.round(_snapshotMeta.est_tokens / 1000) + 'k tokens），请先选中局部节点或缩小范围后再让 AI 修改', 'error');
      restoreInstruction();
      return;
    }
    if (!snapshot.nodes.length && !pureQuestion && harnessPhase !== 'preset') {
      const canvasCount = typeof _graphNodes === 'function' ? _graphNodes().length : 0;
      const wiped = (_snapshotMeta && _snapshotMeta.deleted_filtered) || 0;
      if (canvasCount > 0 && wiped > 0) {
        _setHarnessStatus('画布上有 ' + canvasCount + ' 个节点，但其中 ' + wiped + ' 个被此前的撤销/拒绝标记为已删除。在控制台执行 restoreHarnessDeletedNodes() 可一键恢复', 'error');
      } else {
        _setHarnessStatus('当前画布上没有节点：可直接向我提问，或先在画布上生成内容后再让我整理', 'error');
      }
      restoreInstruction();
      return;
    }
    harnessResult = null;
    _setHarnessStatus(
      harnessPhase === 'evaluate' ? '生成评价节点中...'
        : harnessPhase === 'apply' ? '应用建议中...'
        : harnessPhase === 'preset' ? '创造模式创作中...'
        : harnessPhase === 'chat' ? '答疑中...'
        : '审阅中...',
      'running'
    );
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '';
    document.getElementById('graphHarnessApplyActions')?.setAttribute('hidden', '');
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessBusy(true);

    harnessAbortController = new AbortController();
    // 流式预览：收到的正文增量先在结果区打字机式显示（<think> 思考块实时剥除；
    // JSON 结构化输出不直接展示原文，换成占位文案）。最终结果到达后整块替换。
    let streamText = '';
    let streamTimer = null;
    const renderStreamPreview = () => {
      streamTimer = null;
      if (!stillCurrent()) return;
      const box = document.getElementById('graphHarnessResult');
      if (!box || !streamText) return;
      let text = typeof _stripThinkText === 'function' ? _stripThinkText(streamText) : streamText;
      // JSON 开头直接占位；正文里任何位置出现 ```json 围栏也占位（思考在前、
      // 结构化输出在后的模型，否则会先把思考散文打出来再出现 JSON）。
      // 只认带 json 语言标记的围栏，避免误伤正文里合法的代码块。
      if (/^\s*(\{|```)/.test(text) || text.includes('```json')) text = '正在生成结构化操作方案…';
      if (!text) return;
      box.innerHTML = '<div class="graph-harness-summary">' + _escapeHtml(text) + ' ▍</div>';
    };
    const onStreamEvent = (evt) => {
      if (!stillCurrent()) return;
      if (evt.type === 'status' && evt.message) {
        _setHarnessStatus(String(evt.message), 'running');
        return;
      }
      if (evt.type === 'delta' && evt.text) {
        streamText += String(evt.text);
        if (!streamTimer) streamTimer = setTimeout(renderStreamPreview, 120);
      }
    };
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
          // 记忆第二步「用起来」：带设备标识，服务端据此注入画像一行摘要
          // （user_profile，服务端算，前端不缓存不重算）；缺失时后端静默跳过。
          device_id: (typeof getDeviceId === 'function' ? getDeviceId() : ''),
          harness_history: _buildStructuredHarnessHistory(),
          previous_ops: Array.isArray(harnessLastAppliedOps) ? harnessLastAppliedOps : [],
          previous_snapshot: harnessLastAppliedBeforeSnapshot || null,
          retries: 2,
          stream: true,
        }),
          signal: harnessAbortController.signal,
      });
      const data = await _readHarnessStreamResponse(resp, onStreamEvent);
      if (!stillCurrent()) return;
      data._binding = requestBinding;
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
        if (typeof _applyOps === 'function' && _harnessCanApply(requestBinding)) {
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
        _binding: requestBinding,
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
      if (!stillCurrent()) return;
      restoreInstruction();
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
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
      if (!stillCurrent()) return;
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
    runGraphHarnessWithFocus(pending.phase, [nodeId], pending.instruction);
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
      runGraphHarnessWithFocus(pending.phase, [node.id], pending.instruction);
    } else {
      _setHarnessStatus('未找到该节点，请选择列表中的节点或检查名称', 'error');
    }
  }

  // 澄清重跑：把指令回填后委托主路径 runGraphHarness（焦点已解析）。
  // 旧实现是主路径的手抄删减版，长期缺功能漂移：引用了未定义的 pureQuestion（点选即
  // ReferenceError）、模型槽位只认主模型、无 token 预检、无停止按钮、无流式预览——统一走
  // 主路径后这些自动对齐，澄清链路与主链路行为一致。
  function runGraphHarnessWithFocus(phase, focusIds, instruction) {
    if (typeof instruction === 'string' && instruction) {
      const instructionEl = document.getElementById('graphHarnessInstruction');
      if (instructionEl) instructionEl.value = instruction;
    }
    runGraphHarness(phase || 'normal', { focusIds: Array.isArray(focusIds) ? focusIds : [] });
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

  // 配方字段级人话摘要（P3 创造模式预览行）：给不懂编程的用户读
  function _recipeDigest(recipe) {
    const parts = [];
    const baseKind = (recipe.base && recipe.base.kind) || '';
    const kindLabels = { module: 'AI 模块', summary: 'AI 总结', knowledge: '知识点', relation: '联系', note: '手填总结', human_note: '手填笔记', manual: '手填回答', question: '问题' };
    if (baseKind) parts.push(kindLabels[baseKind] || baseKind);
    const ck = String(recipe.content_kind || '');
    if (ck === 'html_iframe') parts.push('交互页面');
    else if (ck === 'mermaid') parts.push('知识图谱');
    else if (ck === 'plain') parts.push('纯文本');
    const g = recipe.generate || {};
    if (g.model_role && g.model_role !== 'agent') parts.push(g.model_role.toUpperCase() + ' 槽');
    const staticCount = (recipe.ports && Array.isArray(recipe.ports.static)) ? recipe.ports.static.length : 0;
    const hasDynamic = !!(recipe.ports && recipe.ports.dynamic);
    const portBits = [];
    if (staticCount) portBits.push('静态 ' + staticCount);
    if (hasDynamic) portBits.push('动态解析出口');
    if (portBits.length) parts.push(portBits.join('＋'));
    return parts.length ? '（' + parts.join(' · ') + '）' : '';
  }

  function _opDescription(op, allOps) {
    const name = op.op || op.type || '';
    if (name === 'create_node') {
      const moduleKey = op.module_key || op.moduleKey || '';
      const nodeName = op.label || op.title || (moduleKey ? _moduleLabel(moduleKey) : '') || op.temp_id || '';
      const recipeId = op.recipe_id || op.recipeId || '';
      if (recipeId) {
        return '在画布上放一个配方节点「' + (nodeName || recipeId) + '」';
      }
      return '新增' + (moduleKey ? _moduleLabel(moduleKey) : _kindLabel(op.kind)) + '「' + nodeName + '」';
    }
    if (name === 'create_recipe') {
      const recipe = op.recipe || {};
      return '新建配方「' + (recipe.name || op.recipe_id || '') + '」'
        + _recipeDigest(recipe);
    }
    if (name === 'update_recipe') {
      const recipe = op.recipe || {};
      return '修改配方「' + (recipe.name || op.recipe_id || '') + '」';
    }
    if (name === 'delete_recipe') {
      return '删除配方「' + (op.recipe_name || op.recipe_id || '') + '」';
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
      { key: 'create_recipe', title: '新建配方' },
      { key: 'update_recipe', title: '修改配方' },
      { key: 'delete_recipe', title: '删除配方' },
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
    if (counts.create_recipe) countParts.push('新建 ' + counts.create_recipe + ' 个配方');
    if (counts.update_recipe) countParts.push('修改 ' + counts.update_recipe + ' 个配方');
    if (counts.delete_recipe) countParts.push('删除 ' + counts.delete_recipe + ' 个配方');
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
    // 前端兜底：剥离推理模型可能残留的 <think> 思考块
    const rawSummary = typeof _stripThinkText === 'function' ? _stripThinkText(String(data.summary || '')) : String(data.summary || '').trim();
    const summary = rawSummary
      || (ops.length ? '已生成 ' + ops.length + ' 条图修改建议' : '模型没有提出可执行修改');
    const parts = [summary];
    const report = _buildHumanReadableReport(ops);
    if (report) parts.push(report);
    if ((data.warnings || []).length) parts.push('⚠️ ' + data.warnings.map(w => w.reason || '').join('；'));
    if (ops.length && data.status !== 'undo') parts.push('可点「查看预览」确认效果，满意后点击保留；不满意可随时撤销或重跑。');
    return parts.join('\n\n');
  }

