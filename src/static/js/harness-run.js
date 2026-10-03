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
    // T94：条数从 20 放宽到 60（后端做统一预算与摘要压缩，前端多发条数）；单条截断不动。
    return (Array.isArray(harnessHistory) ? harnessHistory : []).slice(-60).map(entry => {
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

  // T95 前端半边：失败自动换备用模型（用户开关，默认关）。从已配置模型列表里取
  // 当前模型之外的前 2 个有模型名的条目；归一化直接复用 _harnessModelForRequest
  // （hy3 端点纠正等口径与主模型完全一致），只挑出后端认的四个字段。
  function _harnessFallbackModels(currentModel) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('phymathia_user_models') || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) return [];
    const currentId = currentModel && currentModel.id ? String(currentModel.id) : '';
    const currentName = String((currentModel && currentModel.model) || '');
    const out = [];
    for (const item of list) {
      if (!item || !item.model) continue;
      // 排除当前模型：优先按 id（模型槽位取的就是条目 id）；无 id 的旧条目按模型名兜
      if (currentId && String(item.id || '') === currentId) continue;
      if (!currentId && currentName && String(item.model) === currentName) continue;
      const normalized = _harnessModelForRequest(item);
      if (!normalized || !normalized.model) continue;
      out.push({
        provider: normalized.provider || '',
        api_key: normalized.api_key || '',
        model: normalized.model || '',
        base_url: normalized.base_url || '',
      });
      if (out.length >= 2) break;
    }
    return out;
  }

  // T82 收敛（前端半边）：相位识别权归后端 _detect_phase。payload.phase 只直通
  // 「模式锁」（chat/preset，三模式切换器显式选定）与「显式入口」（apply/expand，
  // 应用评价节点与进阶支线按钮）——前端本地猜出的 normal/evaluate 一律降级为
  // normal（即后端 auto 口径），由后端按指令与快照重判，避免两份关键词表互相漂。
  function _harnessPayloadPhase(harnessPhase) {
    const phase = String(harnessPhase || '');
    return ['chat', 'preset', 'apply', 'expand'].includes(phase) ? phase : 'normal';
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
      return '模型密钥无效或已失效（401）。请到「模型配置」检查该模型的 API Key；hy3 系模型的密钥由服务端 .env 提供';
    }
    if (/timeout|Timed out|timed out|timedout/i.test(raw)) {
      return '请求超时：hy3 是推理模型、响应较慢，请重试或稍等片刻';
    }
    return raw;
  }

  // T95 前端半边：401 一类「配置问题」重试救不回来——除对话流的重试气泡外，
  // 再留一张醒目卡片（.graph-harness-error 已有样式），操作路径不随流滚动丢失。
  // T122：过去写独立结果区（#graphHarnessResult），该容器已随本轮重构取消，改成
  // 对话流里的一条系统气泡——与 _showHarnessRetry 同一生命周期。
  function _showHarnessErrorCard(text) {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    const bubble = document.createElement('div');
    bubble.className = 'graph-harness-message graph-harness-message-system';
    bubble.innerHTML = '<div class="graph-harness-error">⛔ ' + _escapeHtml(text) + '</div>';
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
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

  // T101（第五步）：composer「↩ 撤销上一条」语义对齐。本页应用过 → 原有确定性
  // 逆操作（后端 _detect_undo_intent 命中撤销词且带 previous_ops 时不调模型，只
  // 一次轻往返）；本页没应用过但事件日志里有更早批次（如刷新页面后）→ 指去
  // 「🕘 撤销历史」逐批回滚，绝不硬造 previous_*——拿整图前态冒充逆操作素材，
  // 会把批次之后的手工编辑一并卷走。
  function undoLastHarnessEdit() {
    if (Array.isArray(harnessLastAppliedOps) && harnessLastAppliedOps.length) {
      runGraphHarnessWithText('撤销刚才的修改，恢复原样');
      return;
    }
    if (typeof _harnessEffectiveAppliedBatches === 'function') {
      _harnessEffectiveAppliedBatches().then(batches => {
        if (batches && batches.length) {
          _setHarnessStatus('本页没有刚应用的修改可智能撤销；更早的 ' + batches.length + ' 个批次请用「🕘 撤销历史」逐批回滚', 'ok');
        } else {
          _setHarnessStatus('没有可撤销的已应用修改', 'error');
        }
      }).catch(() => _setHarnessStatus('没有可撤销的已应用修改', 'error'));
      return;
    }
    _setHarnessStatus('没有可撤销的已应用修改', 'error');
  }

  // T99：停止后续接。中断时的半截回答已存成带「已中断」标记的助手条目（见
  // runGraphHarness 的 AbortError 分支），这里发一句续接指令——历史里有半截
  // 内容，模型接得上。不重发原指令：那会跟半截回答在历史里重复一遍。
  function continueHarnessInterrupted() {
    if (harnessBusy) { _setHarnessStatus('当前正在生成，请稍候', 'error'); return; }
    runGraphHarnessWithText('继续刚才中断的回答，从中断处接着说');
  }

  // T102：生成期间聊天区不再静止。流式正文同步进一条「实时气泡」——直插 DOM、
  // 不入 harnessHistory；结束时真实助手条目入历史触发整块重渲染，它随之消失，
  // finally 与失败路径再兜底删一次防残留。
  function _harnessLiveBubble() {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return null;
    let bubble = chat.querySelector('.graph-harness-message-live');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'graph-harness-message graph-harness-message-assistant graph-harness-message-live';
      bubble.innerHTML = '<span class="graph-harness-avatar" aria-hidden="true">Φ</span>'
        + '<div class="graph-harness-message-main"><div class="graph-harness-message-content"></div></div>';
      chat.appendChild(bubble);
    }
    return bubble;
  }

  function _harnessRemoveLiveBubble() {
    const chat = document.getElementById('graphHarnessChat');
    if (chat && typeof chat.querySelectorAll === 'function') {
      chat.querySelectorAll('.graph-harness-message-live').forEach(el => el.remove());
    }
  }

  // T90 排队中的消息先以一条临时气泡出现在对话流里：它不入 harnessHistory，本轮结束
  // 重渲染时自然消失，随后真实发送会再出现一次——可接受的时序，不做特殊处理。
  function _appendQueuedHarnessMessage(text) {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    const bubble = document.createElement('div');
    bubble.className = 'graph-harness-message graph-harness-message-user graph-harness-message-queued';
    bubble.innerHTML = '<span class="graph-harness-avatar graph-harness-avatar-user" aria-hidden="true">我</span>'
      + '<div class="graph-harness-message-main">'
      + '<div class="graph-harness-message-content">' + _escapeHtml(text) + '</div>'
      + '<span class="graph-harness-queued-tag">排队中</span>'
      + '</div>';
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
  }

  async function runGraphHarness(phase = 'normal', opts) {
    // T90 生成中发消息排队：过去这里是裸 `if (harnessBusy) return;`——字留在输入框里、
    // 点了毫无反应（免费模型一轮能跑 2-8 分钟，撞上的概率很高，用户以为按钮坏了）。
    // 现在把指令收下：先清空输入框（消息已被接走），再交给主聊天的发送队列，
    // 本轮结束（下方 finally 放行）后自动原样再发一次。
    // 忙判定对齐 _isSendBusy（含 _sendQueueFlushing 空窗与主聊天的 isStreaming）：
    // 队列放行窗口内手动再发会与排队条目并发，主聊天生成期间发 Φ 也一样排队——
    // 双向互斥，语义与 send-queue 认识 harnessBusy 那侧对称。force 是队列回放的豁免。
    if ((harnessBusy || (typeof _isSendBusy === 'function' && _isSendBusy())) && !(opts && opts.force)) {
      const queuedInput = document.getElementById('graphHarnessInstruction');
      const queuedText = String((queuedInput && queuedInput.value) || '').trim();
      if (!queuedText) return; // 空文本维持原静默 return：没东西可排
      if (queuedInput) queuedInput.value = '';
      _appendQueuedHarnessMessage(queuedText);
      if (typeof _enqueueSend === 'function') {
        _enqueueSend('Φ 消息', function () {
          // 轮到时回填输入框再走主路径（与 runGraphHarnessWithFocus 同一惯例：文本经
          // 输入框回填而非旁路传参）。force 只用于越过忙守卫——队列放行前已确认空闲。
          const back = document.getElementById('graphHarnessInstruction');
          if (back) back.value = queuedText;
          return runGraphHarness(phase, Object.assign({}, opts, { force: true }));
        }, { text: queuedText });
        _setHarnessStatus('已加入排队，本轮结束后自动发送', 'running');
      } else {
        // 队列模块缺失（理论到不了：send-queue.js 先于本文件打包）——退回旧行为，
        // 至少把字还给用户，别静默吞掉。
        if (queuedInput) queuedInput.value = queuedText;
        _setHarnessStatus('正在生成中，请稍候再发', 'running');
      }
      return;
    }
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
    // T103：换模型重试＝一次性覆盖（重试按钮设置 harnessModelOverride，取用即清，
    // 不改用户的模型槽位；缺省回落原有 graph→agent 槽位链）
    const model = harnessModelOverride
      || (typeof window.getActiveModelForRole === 'function'
        ? (window.getActiveModelForRole('graph') || window.getActiveModelForRole('agent'))
        : null);
    harnessModelOverride = null;
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
    // T103：降级/换模型说明入历史——以前只写状态行，下一条 status 就把它盖掉，
    // 事后回看不知当时发生过什么。攒在这里，成功后以引用块并进助手条目正文。
    const degradeNotes = [];
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
          degradeNotes.push('目标解析失败，已按当前图继续：' + err.message);
          _setHarnessStatus('目标解析失败，已按当前图继续：' + err.message, 'running');
        }
        if (resolved && resolved.status === 'error') {
          focusIds = [];
          const reason = resolved.errors?.[0]?.reason || resolved.question || '目标解析失败';
          degradeNotes.push('目标解析失败，已按当前图继续：' + reason);
          _setHarnessStatus('目标解析失败，已按当前图继续：' + reason, 'running');
        } else if (resolved && resolved.question && !(resolved.candidates || []).length) {
          focusIds = [];
          degradeNotes.push('模型未能确定目标，已按当前图继续：' + resolved.question);
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
    let snapshot = canvasReady
      ? buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId,
          harnessPhase === 'normal' ? continentData : null)
      : _emptyHarnessSnapshot();
    harnessSnapshot = snapshot;
    const _snapshotMeta = snapshot.snapshot_meta || {};
    if (_snapshotMeta.est_tokens > 30000) {
      // T94 前端半边（2026-09-30）：超预算不再硬拦，先把同一份图按 opts.degrade 重算
      // （邻域半径收到 1 跳）。① 有焦点可缩且降级后回到预算内 → 采用降级快照并继续；
      // ② 降级后仍超预算 → 原报错文案＋「聚焦后仍过大」；③ 无焦点可缩 → 原报错文案不动。
      const canvasSelectedIds = typeof window.getSelectedGraphNodeIds === 'function'
        ? Array.from(window.getSelectedGraphNodeIds())
        : [];
      const hasFocus = canvasReady && (focusIds.length > 0 || canvasSelectedIds.length > 0);
      const degraded = hasFocus
        ? buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId,
            harnessPhase === 'normal' ? continentData : null, { degrade: true })
        : null;
      const degradedMeta = degraded ? (degraded.snapshot_meta || {}) : null;
      if (degraded && degradedMeta.est_tokens <= 30000) {
        snapshot = degraded;
        harnessSnapshot = degraded;
        degradeNotes.push('图较大，已自动聚焦到目标附近区域');
        _setHarnessStatus('图较大，已自动聚焦到目标附近区域（可在画布选中节点缩小范围）', 'running');
      } else {
        const shownMeta = degradedMeta || _snapshotMeta;
        const tail = degradedMeta ? '（聚焦后仍过大）' : '';
        _setHarnessStatus('图太大（约 ' + Math.round(shownMeta.est_tokens / 1000) + 'k tokens），请先选中局部节点或缩小范围后再让 AI 修改' + tail, 'error');
        restoreInstruction();
        return;
      }
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
    // T122：过去这里清空独立结果区、隐藏固定的应用按钮行。两者都已并入对话流
    // （_harnessOpsCardHtml 随最新一批待处理条目渲染），本轮开跑不需要再动 DOM。
    // T88：上一轮的结果不再代表当前视图，「结果已应用」标志同步归位
    // （顶层变量由 harness.js 声明，与 harnessBusy/harnessSnapshot 同一种跨文件引用）。
    harnessResultApplied = false;
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessBusy(true);
    // T106：进度感——本轮起跑记时，状态行每秒叠「· Ns」，结束追加耗时/调用数/token
    if (typeof _harnessStartProgressTick === 'function') _harnessStartProgressTick();

    harnessAbortController = new AbortController();
    // 流式预览：收到的正文增量先在结果区打字机式显示（<think> 思考块实时剥除；
    // JSON 结构化输出不直接展示原文，换成占位文案）。最终结果到达后整块替换。
    let streamText = '';
    let streamTimer = null;
    const renderStreamPreview = () => {
      streamTimer = null;
      if (!stillCurrent()) return;
      let text = typeof _stripThinkText === 'function' ? _stripThinkText(streamText) : streamText;
      // JSON 开头直接占位；正文里任何位置出现 ```json 围栏也占位（思考在前、
      // 结构化输出在后的模型，否则会先把思考散文打出来再出现 JSON）。
      // 只认带 json 语言标记的围栏，避免误伤正文里合法的代码块。
      if (/^\s*(\{|```)/.test(text) || text.includes('```json')) text = '正在生成结构化操作方案…';
      if (!text) return;
      // T102：流式期间也走 Markdown 渲染，与结束后的气泡同口径（公式/加粗边生成
      // 边成形，不再结束时「突然变好看」）；renderMarkdown 缺席的异常环境退回纯转义。
      // T122：正文只写进聊天区的实时气泡一处——过去同一段文字还在结果区再打一次
      // 印（真机读成「出现了两个面板，两块里是同一段输出」）。
      const html = (typeof renderMarkdown === 'function' ? renderMarkdown(text) : _escapeHtml(text))
        + '<span class="graph-harness-stream-cursor" aria-hidden="true">▍</span>';
      const bubble = _harnessLiveBubble();
      if (bubble) {
        const content = bubble.querySelector('.graph-harness-message-content');
        if (content) content.innerHTML = html;
        const chatBox = document.getElementById('graphHarnessChat');
        if (chatBox && chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80) {
          chatBox.scrollTop = chatBox.scrollHeight;
        }
      }
    };
    const onStreamEvent = (evt) => {
      if (!stillCurrent()) return;
      if (evt.type === 'status' && evt.message) {
        // 重试轮次（T87）＋多步循环每步（T93）：后端每轮/每步都重新挂 on_delta，而
        // streamText 只追加从不重置，残文会接在前一轮/前一步后面。attempt>0 或 step>0
        // 都表示新的一段开始，当场丢弃已收到的正文与已渲染的预览——与「从头再来」的
        // 视觉一致（step 由多步循环的每步查询携带重发 stage='model'）。
        if (evt.stage === 'model' && (Number(evt.attempt) > 0 || Number(evt.step) > 0)) {
          streamText = '';
          if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
          // T122：清空实时气泡的正文即可（正文现在只显示在这一处）。清空后 streamText
          // 为空串，renderStreamPreview 的 `if (!text) return;` 守卫兜得住。
          const bubble = _harnessLiveBubble();
          const content = bubble ? bubble.querySelector('.graph-harness-message-content') : null;
          if (content) content.innerHTML = '';
        }
        // T103：换模型兜底的切换说明进历史（以前只是状态行一闪而过的 ⚠ 文案）
        if (evt.stage === 'fallback') {
          degradeNotes.push(String(evt.message).replace(/^[⚠⚠️\s]+/, ''));
        }
        _setHarnessStatus(String(evt.message), 'running');
        return;
      }
      if (evt.type === 'delta' && evt.text) {
        streamText += String(evt.text);
        if (!streamTimer) streamTimer = setTimeout(renderStreamPreview, 120);
      }
    };
    // T95 前端半边：失败自动换备用模型（用户开关，默认关）。开关关、或列表里没有
    // 别的模型时整个字段不上送（后端走无兜底行为）。
    const fallbackModels = _harnessFallbackEnabled() ? _harnessFallbackModels(model) : [];
    let resultData = null;
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
          // T82 收敛（前端半边）：payload 只直通模式锁（chat/preset）与显式入口
          // （apply/expand）；normal/evaluate 的本地猜测交后端 _detect_phase 重判。
          phase: _harnessPayloadPhase(harnessPhase),
          // T97：深度思考档位（''/low/high/max）；参数映射归后端按供应商族做。
          thinking: _harnessThinkingLevel(),
          // T95：备用模型兜底列表（开关开且非空才带，字段形状 {provider,api_key,model,base_url}）
          ...(fallbackModels.length ? { fallback_models: fallbackModels } : {}),
          // T96 会话事件日志：带上 Φ 会话 id，后端把整次往返（含最终 result）写进
          // logs/harness_events/<phiId>.jsonl，并在响应里回一个 event_id；前端把
          // 它存进历史条目，反馈与应用批次据此归因（缺 id 时后端静默跳过不落盘）。
          session_id: (typeof _phiId === 'function' ? _phiId() : '') || '',
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
      resultData = data;
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
      // T122：这里原本还跟一段「结果区长高把对话区挤矮 → 下一帧补贴底」的 rAF 补偿，
      // 随独立结果区一起取消——对话区现在是面板里唯一的滚动区，长的是自己的内容，
      // 贴底由 _renderHarnessChat 的「用户本来在底部」守卫负责。
      renderHarnessResult(data);
      if (data.status === 'undo' && (data.operations || []).length) {
        if (typeof _applyOps === 'function' && _harnessCanApply(requestBinding)) {
          // 第三参 null：这里应用的是对话式撤销的 inverse 操作，是回滚动作，
          // 不得上报成新的 applied 批次（否则时间线会多出一条「假应用」）
          _applyOps(data.operations, false, null);
          harnessLastAppliedOps = [];
          harnessLastAppliedBeforeSnapshot = null;
          _setHarnessStatus('已撤销上一条修改', 'ok');
          // T96：撤销上报接线（无 seq 时函数内部自行跳过——被回滚的是哪个服务端
          // 批次由 GET events 折算，见 harness-apply.js 的 _reportHarnessUndo）
          if (typeof _reportHarnessUndo === 'function') _reportHarnessUndo();
        }
      }
      // T103：本轮攒下的降级/换模型说明以引用块并进助手条目正文——状态行会被
      // 下一条消息盖掉，历史才是「事后回看」的唯一载体
      const degradeNoteBlock = degradeNotes.length
        ? degradeNotes.map(n => '> ⚠️ ' + n).join('\n') + '\n\n'
        : '';
      _appendHarnessHistory({
        id: _historyId(),
        role: 'assistant',
        content: degradeNoteBlock + _harnessAssistantContent(data),
        instruction,
        summary: data.summary || '',
        operations: data.operations || [],
        // T122：以下四项供 _harnessOpsCardHtml 渲染气泡内的可勾选清单（过去写在
        // 独立结果区里，随结果区取消一并搬进条目）。随条目存盘 → 切 Φ 会话能回来、
        // 不被整块重渲染吃掉、T96 事件日志也能归因。
        errors: (data.errors || []).map(item => item.reason || '').filter(Boolean),
        warnings: (data.warnings || []).map(item => item.reason || '').filter(Boolean),
        selfCheckOk: (data.self_check && data.self_check.critic)
          ? (data.self_check.critic.ok === true ? true : (data.self_check.critic.ok === false ? false : null))
          : null,
        selfCheckIssues: (() => {
          const c = (data.self_check && data.self_check.critic) || {};
          return (c.issues || []).concat((c.missing || []).map(item => '缺少：' + item));
        })(),
        // 澄清分支：选项按钮渲染在气泡里（旧版写结果区）
        clarifyOptions: (data.clarify && Array.isArray(data.clarify.options)) ? data.clarify.options : [],
        // T96：本条回复对应的服务端 review 事件 id（反馈归因用；旧数据留空）
        eventId: data.event_id || '',
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
      if (err && err.name === 'AbortError') {
        // T99：用户主动停止——半截回答不白生成。有可读正文（非 JSON 方案占位）就
        // 存成一条带「已中断」标记的助手条目（渲染时带「▶ 从中断处继续」出口），
        // 指令不回填输入框（续接走按钮；正文与指令都在历史里）；没收到正文的
        // 停止维持旧行为：指令回填，状态「已停止」。
        const partial = typeof _stripThinkText === 'function' ? _stripThinkText(streamText) : streamText;
        const readable = partial && !/^\s*(\{|```)/.test(partial) && !partial.includes('```json')
          ? partial.trim() : '';
        if (readable) {
          const abortNoteBlock = degradeNotes.length
            ? degradeNotes.map(n => '> ⚠️ ' + n).join('\n') + '\n\n'
            : '';
          _appendHarnessHistory({
            id: _historyId(),
            role: 'assistant',
            content: abortNoteBlock + readable + '\n\n*（生成被手动停止——可点「▶ 从中断处继续」接续）*',
            instruction,
            summary: '',
            operations: [],
            eventId: '',
            _binding: requestBinding,
            phase: harnessPhase,
            decision: 'pending',
            interrupted: true,
            timestamp: Date.now(),
          });
          _setHarnessStatus('已停止：半截回答已保留在对话里', 'ok');
        } else {
          restoreInstruction();
          _setHarnessStatus('已停止', 'ok');
        }
        // T122：打字机预览已并入实时气泡、且随本条中断条目落进历史，撤气泡即可
        _harnessRemoveLiveBubble();
      } else {
        restoreInstruction();
        // T103：错误详情存档（「复制错误详情」按钮的原料）
        const human = _harnessErrorToHuman(err && err.message ? err.message : String(err));
        harnessLastError = {
          ts: Date.now(),
          model: (model && model.model) || '',
          phase: harnessPhase,
          instruction,
          raw: (err && err.message) || String(err),
          message: human,
        };
        _setHarnessStatus('审阅失败：' + human, 'error');
        _showHarnessRetry('审阅失败：' + human);
        // T95 前端半边：401/密钥这类配置问题在结果区额外留一张醒目卡片——重试气泡
        // 会随对话流滚走，而「去模型配置检查 Key」的路径不该丢失。
        if (/401|密钥/.test(human)) _showHarnessErrorCard(human);
        if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
        if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
        _harnessRemoveLiveBubble();
      }
    } finally {
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
      _harnessRemoveLiveBubble();
      // T106：先停表再复位 busy（间隔回调自查 harnessBusy，顺序反了会在同一秒
      // 边界上先跑一次「无数据停表」，丢掉调用数/token 摘要）
      if (typeof _harnessStopProgressTick === 'function') _harnessStopProgressTick(resultData);
      if (!stillCurrent()) return;
      _setHarnessBusy(false);
      harnessSingleEvalId = null;
      harnessAbortController = null;
      // T90：本轮结束放行排队消息（排队时收下的 Φ 指令）。放在 busy 归位与状态清理
      // 之后——不 await，与主聊天外层 finally 的用法一致；排队那条在本调用栈返回后的
      // 微任务里才真正开跑，不会撞上上面这两行清理。会话已切换时上面的早退已经挡住：
      // 那是刻意的，新会话的视图不该被旧指令继续刷。
      if (typeof _flushSendQueue === 'function') { try { _flushSendQueue(); } catch (e) {} }
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
    // T86：过去这里是 chat.innerHTML = …，整块覆盖聊天区，历史凭空消失。改为在对话流
    // 末尾追加一条助手气泡——历史永不丢失，澄清卡片只是多出来的一屏。重复触发/重跑前
    // 先清掉此前遗留的澄清气泡（逐个 remove，容错），避免叠两张卡。
    chat.querySelectorAll('.graph-harness-message-clarify').forEach(el => el.remove());
    const bubble = document.createElement('div');
    bubble.className = 'graph-harness-message graph-harness-message-assistant graph-harness-message-clarify';
    // 头像/主体结构与 _historyMessageHtml（harness.js）一致，只是不写 harnessHistory、
    // 不带时间与操作行——这条气泡是临时 UI，下一次重渲染自然消失。
    bubble.innerHTML = '<span class="graph-harness-avatar" aria-hidden="true">Φ</span>'
      + '<div class="graph-harness-message-main">'
      + '<div class="graph-harness-message-content">发现多个匹配节点，请选择目标：</div>'
      + '<div class="graph-harness-clarify">'
      + list.map(candidate => '<div class="graph-harness-clarify-item"><button type="button" onclick="chooseHarnessClarifyNode(\'' + candidate.id + '\')">'
        + _escapeHtml(candidate.label) + '</button>'
        + (candidate.hint ? '<span class="graph-harness-clarify-hint">' + _escapeHtml(candidate.hint) + '</span>' : '')
        + '</div>').join('')
      + '<div class="graph-harness-clarify-input"><input id="graphHarnessClarifyInput" placeholder="输入节点名称或ID">'
      + '<button type="button" onclick="confirmHarnessClarifyInput()">确认</button></div>'
      + '<div class="graph-harness-clarify-cancel-row"><button type="button" class="graph-harness-clarify-cancel" onclick="cancelHarnessClarify()">取消</button></div>'
      + '</div>'
      + '</div>';
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
    _setHarnessStatus('请选择目标节点', 'running');
  }

  // 取消澄清：不发任何请求，只把待决状态与气泡撤掉，对话可以继续。
  function cancelHarnessClarify() {
    harnessPendingClarify = null;
    const chat = document.getElementById('graphHarnessChat');
    if (chat) chat.querySelectorAll('.graph-harness-message-clarify').forEach(el => el.remove());
    _setHarnessStatus('已取消选择，可继续对话', 'ok');
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
    // T117（2026-10-03 销账）：失配不再提前清掉 harnessPendingClarify——此前先置空
    // 再匹配，输错一次名称候选按钮就全部失效、澄清卡滞留成死卡。改为只在命中时
    // 置空：失配时保留待决状态与卡片，提示后聚焦输入框让用户改了再试（「取消」出口照旧）。
    if (node) {
      harnessPendingClarify = null;
      runGraphHarnessWithFocus(pending.phase, [node.id], pending.instruction);
    } else {
      _setHarnessStatus('未找到该节点：' + text + '（可从上方列表点选，或检查名称后重试）', 'error');
      input.focus();
      input.select();
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

  // T100：操作分组的唯一真源——聊天报告（_buildHumanReadableReport）与结果区
  // 可操作清单（harness-preview.js 的 _harnessOpRowHtml）共用这张表，两边分组
  // 口径永不漂移（此前结果区是裸平铺，同一份 ops 两种呈现）。
  function _harnessOpGroupDefs() {
    return [
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
  }

  // 按分组表把 ops 切成 [{key,title,items:[{op,index}]}]（index＝在原 ops 数组里
  // 的下标，结果区勾选框的 data-op-index 依赖它，绝不许重排后错位）
  function _harnessGroupedOps(ops) {
    const list = Array.isArray(ops) ? ops : [];
    const out = [];
    for (const def of _harnessOpGroupDefs()) {
      const items = [];
      list.forEach((op, index) => {
        if ((op.op || op.type) === def.key) items.push({ op, index });
      });
      if (items.length) out.push({ key: def.key, title: def.title, items });
    }
    return out;
  }

  // 「共 N 处调整：新增 6 个节点、6 条连线」——计数概览一行。
  // T122：逐条清单从正文里拿掉了，改为渲染在正文下方那张可勾选卡里（带勾选框、
  // 理由与「原文 → 建议文」对比）。两处都写的话，12 条改动会把正文撑成一屏墙，
  // 卡片被顶到折线以下——正是 2026-09-30 真机「只看到一段文字、一张卡都没有」的成因。
  function _buildHumanReadableReportHead(ops) {
    const list = Array.isArray(ops) ? ops : [];
    if (!list.length) return '';
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
    return countParts.length ? '**共 ' + list.length + ' 处调整**：' + countParts.join('、') + '。' : '';
  }

  function _harnessAssistantContent(data) {
    const ops = Array.isArray(data.operations) ? data.operations : [];
    // 前端兜底：剥离推理模型可能残留的 <think> 思考块
    const rawSummary = typeof _stripThinkText === 'function' ? _stripThinkText(String(data.summary || '')) : String(data.summary || '').trim();
    const summary = rawSummary
      || (ops.length ? '已生成 ' + ops.length + ' 条图修改建议' : '模型没有提出可执行修改');
    const parts = [summary];
    // T122：正文只留计数概览一行，逐条清单由气泡内的可勾选卡承担
    const head = _buildHumanReadableReportHead(ops);
    if (head) parts.push(head);
    if ((data.warnings || []).length) parts.push('⚠️ ' + data.warnings.map(w => w.reason || '').join('；'));
    if (data.status === 'undo' && ops.length) {
      parts.push('已自动应用 ' + ops.length + ' 条撤销操作，可继续对助手说话。');
    } else if (ops.length) {
      parts.push('下方清单可逐条勾选后「应用所选」，或直接「应用全部」；不满意可「不保留修改」或撤销重跑。');
    }
    return parts.join('\n\n');
  }

