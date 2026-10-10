// ====== Φ 快照构建：图/会话/画像聚合与邻域裁剪（2026-10-10 自 harness.js 拆出，T261 纯搬家）=====
// 纯函数段：buildHarnessSnapshot 供 harness-run 运行期调用；邻域阈值与大陆缓存
// 两个模块级 const/let 随段迁移，加载期零调用。
  function _graphNodes() {
    return typeof window.getGraphViewNodes === 'function' ? window.getGraphViewNodes() : [];
  }

  function _graphEdges() {
    return typeof window.getGraphViewEdges === 'function' ? window.getGraphViewEdges() : [];
  }

  // _edgeKey 已上移到 utils.js（与 graph.js 共用一份）。这里直接用全局的，
  // 不再各算一遍——Φ 预览态与主画布态的连线键必须逐字一致，否则「预览里看得到、
  // 应用后没了」这类症状查不出根因。

  function _edgeParts(key) {
    const match = String(key || '').match(/^(.+?):(out-\d+)->(.+?):(in-\d+)$/);
    return match
      ? { from: match[1], fromPort: match[2], to: match[3], toPort: match[4] }
      : null;
  }

  function _moduleLabel(moduleKey) {
    const labels = {
      physics: '物理视角',
      math: '数学视角',
      graph: '知识图谱',
      viz: '交互可视化',
      socratic: '苏格拉底追问',
      learn: '进阶学习',
      manual: '我的回答',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '我的总结',
      source: '输入',
      knowledge: '知识点',
      relation: '联系',
    };
    return labels[moduleKey] || moduleKey || '节点';
  }

  function _nodeLabel(node) {
    if (!node) return '';
    if (node.label) return node.label;
    if (node.title) return node.title;
    if (node.kind === 'user') return node.isRoot ? '核心问题' : (node.branchLabel || '问题');
    if (node.kind === 'answer') return node.branchLabel || node.summary || _harnessNodeContent(node).slice(0, 40) || 'AI 回答';
    if (node.kind === 'module') return _moduleLabel(node.moduleKey);
    return node.summary || node.content || '节点';
  }

  function _harnessNodeContent(node) {
    if (!node) return '';
    if (node.content || node.summary) return node.content || node.summary || '';
    if (node.messageIndex >= 0) {
      const msgs = typeof window.getSessionMessages === 'function' ? (window.getSessionMessages(_sessionId()) || []) : [];
      const msg = msgs[node.messageIndex] || null;
      if (msg) {
        if (typeof _nodeContent === 'function') return _nodeContent(msg, node);
        return String(msg.content || '');
      }
    }
    return '';
  }
  function _estimateTokens(text) {
    const s = String(text || '');
    let cjk = 0;
    let ascii = 0;
    for (let i = 0; i < s.length; i++) {
      if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s[i])) cjk++;
      else ascii++;
    }
    return Math.ceil(cjk + ascii / 4);
  }

  function _detectHarnessPhase(instruction, evalNodes) {
    const text = String(instruction || '');
    const hasApply = /应用建议|采纳建议|按建议|执行建议/.test(text);
    const hasModify = /修改|改成|更正|纠正|重写|更新|删掉|删除|补充|新增|创建|连接|加上|加一个|补一个|改进|完善/.test(text);
    const hasExpand = /拓展|进阶|延伸学习|深入学习|深化/.test(text);
    const hasEval = /评价|建议|反馈|点评|指出|哪里需要改进|挑错|有问题吗|对不对|哪里不对|帮我看看/.test(text);
    if (hasApply && evalNodes.length) return 'apply';
    if (hasExpand) return 'expand';
    if (hasModify && !hasEval) return 'normal';
    if (hasEval) return 'evaluate';
    return 'normal';
  }

  function _detectFocusNodeIds(instruction, nodes) {
    const text = String(instruction || '');
    const matches = [];
    for (const node of nodes) {
      if (node.kind === 'ai_eval') continue;
      const label = String(_nodeLabel(node) || '').trim();
      if (!label || label.length < 2) continue;
      if (text.includes(label)) matches.push(node.id);
    }
    return Array.from(new Set(matches));
  }

  const HARNESS_NEIGHBORHOOD_THRESHOLD = 40;

  function _connectedNodeIds(nodes, edges, seedIds) {
    const seeds = new Set(seedIds || []);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const adjacency = new Map();
    nodes.forEach(node => adjacency.set(node.id, []));
    edges.forEach(edge => {
      if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
        adjacency.get(edge.from).push(edge.to);
        adjacency.get(edge.to).push(edge.from);
      }
    });
    const seen = new Set(seeds);
    const queue = Array.from(seeds);
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next) && nodeById.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return Array.from(seen);
  }

  function _neighborhoodNodeIds(nodes, edges, seedIds, maxDepth) {
    const seeds = new Set(seedIds || []);
    const adjacency = new Map();
    nodes.forEach(node => adjacency.set(node.id, []));
    edges.forEach(edge => {
      if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
        adjacency.get(edge.from).push(edge.to);
        adjacency.get(edge.to).push(edge.from);
      }
    });
    const seen = new Set(seeds);
    let frontier = Array.from(seeds);
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const id of frontier) {
        for (const nb of adjacency.get(id) || []) {
          if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
        }
      }
      frontier = next;
    }
    return Array.from(seen);
  }

  function _kindLabel(kind) {
    const labels = {
      blank: 'AI 生成空白',
      user: '问题',
      answer: 'AI 回答',
      module: '模块',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '我的总结',
      source: '输入',
      knowledge: '知识点',
      relation: '联系',
      human_note: '我的理解',
      ai_eval: 'AI 评价',
    };
    return labels[kind] || kind || '节点';
  }

  function buildHarnessSnapshot(excludeEval, focusIds, singleEvalId, continentData, opts) {
    const state = _harnessGraphState() || {};
    const rawCanvasCount = _graphNodes().length;
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const nodes = _graphNodes().filter(node => !deleted.has(node.id) && !(excludeEval && node.kind === 'ai_eval'));
    const selected = new Set(
      typeof window.getSelectedGraphNodeIds === 'function' ? window.getSelectedGraphNodeIds() : []
    );
    let scopeNodes = selected.size ? nodes.filter(node => selected.has(node.id)) : nodes;
    if (singleEvalId) {
      const evalNode = nodes.find(node => node.id === singleEvalId);
      if (evalNode) {
        const targetId = evalNode.target_node_id || '';
        const seedIds = [singleEvalId, targetId].filter(Boolean);
        const connected = _connectedNodeIds(nodes, _graphEdges(), seedIds);
        scopeNodes = nodes.filter(node => connected.includes(node.id));
      }
    } else if (focusIds && focusIds.length) {
      const connected = _connectedNodeIds(nodes, _graphEdges(), focusIds);
      scopeNodes = nodes.filter(node => connected.includes(node.id));
    }
    const nodeIds = new Set(scopeNodes.map(node => node.id));
    const edges = _graphEdges().filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    const focusSet = new Set(selected);
    (focusIds || []).forEach(id => focusSet.add(id));
    if (singleEvalId) focusSet.add(singleEvalId);

    // P2：大图且有焦点时，非 1-2 跳邻域节点降级为目录行（仅身份字段），
    // 模型仍可引用其 id/label，但不携带正文/公式以控制快照 token。
    // T94（2026-09-30）：调用方可用 opts.degrade 强制走这条收缩（即使不到 40 节点，
    // 用于 est_tokens 超预算时的自动降级重算）——降级版邻域半径收到 1 跳，比平时更紧；
    // focusSet 为空时不收缩（没有焦点就无从收缩，保持原样返回）。
    const degrade = !!(opts && opts.degrade);
    const largeGraph = nodes.length > HARNESS_NEIGHBORHOOD_THRESHOLD || degrade;
    const neighborSet = largeGraph && focusSet.size
      ? new Set(_neighborhoodNodeIds(nodes, _graphEdges(), Array.from(focusSet), degrade ? 1 : 2))
      : null;

    const snapshot = {
      version: 1,
      nodes: scopeNodes.map(node => {
        const isFocus = focusSet.has(node.id) || node.kind === 'ai_eval';
        if (neighborSet && !isFocus && !neighborSet.has(node.id)) {
          return { id: node.id, kind: node.kind, module_key: node.moduleKey || '', label: _nodeLabel(node).slice(0, 80), directory: true };
        }
        return {
          id: node.id,
          kind: node.kind,
          module_key: node.moduleKey || '',
          manual: !!node.manual,
          read_only: node.kind === 'user' && node.isRoot,
          label: _nodeLabel(node).slice(0, 80),
          content: (isFocus ? _harnessNodeContent(node) : _harnessNodeContent(node).slice(0, 80)).slice(0, 600),
          formula: isFocus ? String(node.formula || '').slice(0, 200) : '',
          items: node.kind === 'source' && Array.isArray(node.items)
            ? node.items.slice(0, 20).map(function (it) {
              return {
                title: String(it.title || it.label || '').slice(0, 80),
                summary: String(it.summary || '').slice(0, 200),
                formulas: Array.isArray(it.formulas) ? it.formulas.slice(0, 4).map(function (f) { return String(f); }) : [],
              };
            })
            : undefined,
          target_node_id: node.target_node_id || '',
          target_label: node.target_label || '',
          suggestion: node.suggestion || '',
          priority: node.priority || '',
        };
      }),
      edges: edges.map(edge => ({
        key: _edgeKey(edge),
        from: edge.from,
        to: edge.to,
        relation: String(edge.relation || ''),
        label: String(edge.label || ''),
        custom: !!edge.custom,
      })),
      scope_node_ids: Array.from(selected),
    };
    // 创造模式（P3）：用户配方清单摘要随快照注入（仿 quiz_weak 范式——结构化通道，
    // 绝不拼进 instruction 文本）。Φ 据此查重/更新/删除；preset 提示词有行为规则。
    // T244：按最近修改倒序注入。后端清单上限 32 条且按序截断——按存储顺序时，
    // 第 33 个之后创建的配方静默跌出 Φ 视野（在创造模式里改/删它们会报
    // 「配方不存在」并触发莫名重试）。最近动过的优先进视野。
    const userRecipes = typeof getUserRecipes === 'function'
      ? getUserRecipes().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      : [];
    if (userRecipes.length) {
      snapshot.user_recipes = userRecipes.map(recipe => {
        const entry = {
          id: String(recipe.id || ''),
          name: String(recipe.name || ''),
          base_kind: (recipe.base && recipe.base.kind) || '',
          content_kind: String(recipe.content_kind || ''),
        };
        if (recipe.desc) entry.desc = String(recipe.desc);
        const staticCount = (recipe.ports && Array.isArray(recipe.ports.static)) ? recipe.ports.static.length : 0;
        const inputCount = (recipe.ports && Array.isArray(recipe.ports.inputs)) ? recipe.ports.inputs.length : 0;
        const hasDynamic = !!(recipe.ports && recipe.ports.dynamic);
        entry.ports = '入 ' + inputCount + ' / 出 ' + staticCount + (hasDynamic ? ' ＋ 动态解析' : '');
        return entry;
      });
    }
    // M2（P0-A 检测闭环）：检测侧薄弱点随快照注入（当前会话 Top3，每条一行）。
    // 只作口头提示依据——提示词明文禁止据此创建任何状态类图元素；无薄弱点时不带该字段。
    const weakPoints = _harnessQuizWeak();
    if (weakPoints.length) snapshot.quiz_weak = weakPoints;
    // 大陆计划 v3（Φ 摆渡）：当前画布概念与其他画布的共享点随快照注入。Φ 只能
    // 【口头】建议去大陆连接——跨画布连线不是本画布图操作，落笔在大陆弹层里用户确认。
    const continentShared = continentData ? _harnessContinentShared(continentData) : [];
    if (continentShared.length) snapshot.continent_shared = continentShared;
    if (_harnessResolveRequestMode(opts) === 'preset') {
      _attachHarnessRecipeContext(snapshot, _harnessResolveRecipeTargetId(opts));
    }
    const serialized = JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges, quiz_weak: snapshot.quiz_weak, continent_shared: snapshot.continent_shared, recipe_detail: snapshot.recipe_detail });
    snapshot.snapshot_meta = {
      total_nodes: nodes.length,
      directory_nodes: snapshot.nodes.filter(n => n.directory).length,
      sent_nodes: snapshot.nodes.length,
      truncated: snapshot.nodes.length < nodes.length,
      deleted_filtered: Math.max(0, rawCanvasCount - nodes.length),
      est_tokens: _estimateTokens(serialized),
    };
    return snapshot;
  }

  // 未绑定/绑定了别的画布时的占位快照：纯问答不需要图内容（chat 相位与 pure_chat
  // 在后端都放行空快照），构造与 buildHarnessSnapshot 同构的空体——绝不能把当前
  // 打开的画布内容塞进一段与它无关的对话里。opts 与 buildHarnessSnapshot 同口径
  // （recipeTargetId/mode 显式传入，undefined 时回落到面板当前值）。
  function _emptyHarnessSnapshot(opts) {
    const snapshot = {
      version: 1,
      nodes: [],
      edges: [],
      scope_node_ids: [],
    };
    snapshot.snapshot_meta = {
      total_nodes: 0,
      directory_nodes: 0,
      sent_nodes: 0,
      truncated: false,
      deleted_filtered: 0,
      est_tokens: 0,
    };
    if (_harnessResolveRequestMode(opts) === 'preset') {
      _attachHarnessRecipeContext(snapshot, _harnessResolveRecipeTargetId(opts));
    }
    return snapshot;
  }

  // 当前会话的薄弱知识点（复用检测侧同一口径 _quizStatSummary('session').weak，取 Top3）
  function _harnessQuizWeak() {
    if (typeof _quizStatSummary !== 'function') return [];
    let summary = null;
    try {
      summary = _quizStatSummary('session');
    } catch (e) {
      return [];
    }
    return ((summary && summary.weak) || []).slice(0, 3).map(item => ({
      title: String(item.title || '').slice(0, 40),
      wrong: Number(item.wrong) || 0,
      mastery: Number(item.mastery) || 0,
      sessionId: String(item.sessionId || ''),
    })).filter(item => item.title);
  }

  // ===== 大陆计划 v3（Φ 摆渡）：跨画布共享点随快照注入 =====
  // /api/continent 是纯本地现算（无模型调用），但也不必每次审阅都拉——60s 缓存，
  // 失败静默返回 null（大陆查空是正常路径，不阻断 Φ）。
  let _harnessContinentCache = null;
  async function _harnessFetchContinent() {
    const now = Date.now();
    if (_harnessContinentCache && now - _harnessContinentCache.at < 60000) {
      return _harnessContinentCache.data;
    }
    try {
      const resp = await fetch('/api/continent', { cache: 'no-cache' });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data || !Array.isArray(data.clusters)) return null;
      _harnessContinentCache = { at: now, data };
      return data;
    } catch (e) {
      return null;
    }
  }

  // 从大陆投影里挑出**涉及绑定画布**的共享概念：每条给「我这边的概念名、
  // 对面的概念名、对面画布名、共享词」。Φ 拿到后只口头建议，不落任何图操作。
  function _harnessContinentShared(data) {
    const mySid = String(_harnessBoundSid() || '');
    if (!mySid || !data) return [];
    const itemTitle = {}, clusterTitle = {};
    (data.clusters || []).forEach(c => {
      clusterTitle[c.sessionId] = c.title || '未命名画布';
      (c.items || []).forEach(it => { itemTitle[it.itemId] = it.title || ''; });
    });
    const out = [], seen = new Set();
    (data.shared || []).forEach(s => {
      if (seen.has(s.label)) return;
      // v4：弱证据（2 字共享串「表达」「坐标」级）不喂给 Φ——它是语法碎片不是共享点，
      // 让模型据此建议「去大陆连起来」只会把用户引向噪声（地图侧同样折叠它们）
      if (s.strength === 'weak') return;
      // v5.5：被更具体标签覆盖的条目（服务端 covered）地图上不单独成城，同样不喂 Φ
      if (s.covered) return;
      (s.links || []).some(l => {
        const mineIsFrom = l.fromSession === mySid;
        const mineIsTo = l.toSession === mySid;
        if (!mineIsFrom && !mineIsTo) return false;
        const myItem = mineIsFrom ? l.from : l.to;
        const peerItem = mineIsFrom ? l.to : l.from;
        const peerSid = mineIsFrom ? l.toSession : l.fromSession;
        const myTitle = itemTitle[myItem], peerTitle = itemTitle[peerItem];
        if (!myTitle || !peerTitle) return false;
        seen.add(s.label);
        out.push({
          label: String(s.label || '').slice(0, 40),
          kind: s.kind === 'formula' ? 'formula' : (s.kind === 'family' ? 'family' : 'title'),
          my_title: myTitle.slice(0, 40),
          peer_title: peerTitle.slice(0, 40),
          peer_session: String(clusterTitle[peerSid] || '').slice(0, 40),
        });
        return true;
      });
    });
    return out.slice(0, 4);
  }
