// ===== 工作流：流式渲染节流与 SSE 读取（2026-10-24 自 graph-workflow.js 拆出，T397 纯搬家）=====
// 三处流式通道共用的 _readStreamChunk 与渲染节流（T218 在案）；生成链在 graph-workflow-generate.js。

// 流式渲染节流：多路并行流式时，把“全图 measure + 节点 transform + 边重绘”合并为
// 最长 ~150ms 一次，避免每个流式块都全图强刷（原实现每帧对全部节点/全部边做同步布局
// 与整层 SVG 重建，图越大越闪烁）。流式内容本身仍即时局部更新。
// 流式卡片渲染节流（T218）：三处流式 scheduleRender 共用。旧实现每 rAF 帧
// （≈16ms）整卡 innerHTML 重建＋KaTeX 全量重跑，长文本整流 O(n²)（对照 chat.js
// 同路径 250ms 节流）。流式中的卡是「生长中」视觉反馈，250ms 一跳足够顺；流结束
// 各自的收尾渲染一次性铺最终全文，终态不受节流影响。
const GRAPH_STREAM_RENDER_MS = 250;

let _graphSyncTimer = null;
function _scheduleGraphSync() {
  if (_graphSyncTimer) return;
  _graphSyncTimer = setTimeout(() => {
    _graphSyncTimer = null;
    if (typeof _measureNodes === 'function') _measureNodes();
    // 谁真的动了：写同一个 transform 字符串的节点不算（绝大多数节点每拍都是白写）
    const moved = (typeof _updateNodeTransforms === 'function') ? _updateNodeTransforms() : null;
    // 2026-10-16：这一拍原先无条件 `_redrawEdges()`——把整层 <path> 拆掉重铺。真流式
    // 期间实测每秒 2~3 次（SVG 子树每秒 30+ 次增删、每秒重建 13 个边元素），正是
    // 「重新生成节点时边框与连线快速闪动」的机器侧来源：整层失效 + 边光晕滤镜重新
    // 光栅化，机器越快越看不出来，Windows/Edge 上就是可见的闪。
    // 现在走拖拽/缩放同款的增量路径：只有真动了的节点所连的边改 d。
    // 两道闸保证不丢结构：①层签名对不上（新边/删边/换画布）→ 整层重建；②快速路径
    // 自己返回 false（边元素缺失/曲线编辑中）→ 整层重建。
    const layerStale = (typeof _edgeLayerSigOk === 'function') && !_edgeLayerSigOk();
    if (layerStale) {
      if (typeof _redrawEdges === 'function') _redrawEdges();
      return;
    }
    if (!moved || !moved.length) return;
    const keys = (typeof _edgesTouchingNodeIds === 'function') ? _edgesTouchingNodeIds(moved) : null;
    if (!keys || !keys.length) return;
    if (typeof _refreshEdgeGeometry !== 'function' || !_refreshEdgeGeometry(keys)) {
      if (typeof _redrawEdges === 'function') _redrawEdges();
    }
  }, 150);
}

// （chat.js / chat-features.js / quiz-ui.js / harness-run.js，后者是变体），
// 本轮只合并了本文件这 3 份。那 4 处的合并见 docs/backlog.md，同样卡在硬规则 6
// 的真发验证上（要动发送链路，没有可用凭证时不能合）。
//
// **只吐正文增量，绝不碰 reasoning_content。** 思维链与正文必须分两条通道攒；
// `delta.content || delta.reasoning_content` 那种写法会把思维链灌进正文，
// 那是 2026-09-15「旋度那座岛全程静默消失」的根因（docs/dev/knowledge-pipeline.md）。
// 将来真要思维链，在这里显式加第二个 yield，不许改回或的那个。
//
// 读帧静默看门狗（T359，2026-10-17）：上游把字出完却不断连（没有 [DONE]、也不再发帧）
// 时，reader.read() 永远挂着、for-await 永不结束——屏幕上是全文，收尾落盘那一行却永远
// 执行不到，换设备/刷新后就是空卡。这里给每次读帧配一个静默上限：超时即取消读流并抛出，
// 落到各调用方的 catch（复位忙账＋版本账兜回上一版＋落盘）——坏连接从「静默丢内容」变成
// 一次可见的生成失败。名字用 TimeoutError 不用 AbortError：中止是用户动作（回等待态），
// 超时是失败（该报错、该可重试）。上限取 2 分钟：思考型模型两次增量之间偶有长静默，
// 别把正常慢流误判成挂死。
const GRAPH_STREAM_IDLE_TIMEOUT_MS = 120000;
function _readStreamChunk(reader) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      // 取消读流＝放弃这条响应体（上游连接随之断开），免得挂死的连接一直占着
      try { reader.cancel(); } catch (e) { /* 已结束/已取消：忽略 */ }
      const err = new Error('AI 流式响应超时：' + Math.round(GRAPH_STREAM_IDLE_TIMEOUT_MS / 1000) + ' 秒没有收到新内容，已断开');
      err.name = 'TimeoutError';
      reject(err);
    }, GRAPH_STREAM_IDLE_TIMEOUT_MS);
    reader.read().then(
      (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); },
    );
  });
}

// 每 4 帧让出一次事件循环：流式期间合成 DOM 渲染有帧预算，别让读流饿死它。
// （让出的时机从「渲染前」挪到了「渲染后」——两者都是每 4 帧喘一次，语义等价。）
async function* _sseContentFrames(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frameCount = 0;
  while (true) {
    const { done, value } = await _readStreamChunk(reader);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();   // 最后一段可能不完整，留到下一轮再拼
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        let data = null;
        try { data = JSON.parse(dataStr); } catch (e) {}
        if (data && data.error) {
          const message = data.detail || data.error.detail || data.error.message || JSON.stringify(data.error);
          throw new Error('AI 流式返回错误：' + message);
        }
        const delta = data && data.choices && data.choices[0] && data.choices[0].delta;
        if (delta && delta.content) {
          yield delta.content;
          frameCount++;
          if (frameCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
  }
}

async function _streamCustomNodeResponse(resp, node) {
  let content = '';
  let renderPending = false;
  let saveTimer = null;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
      // 可视化卡片一旦挂载就不再每帧重建 iframe（巨型可视化反复重载 = “全屏节点不停闪”的直接来源），
      // 流式中只更新源码文本框；内容完成时由统一渲染一次性重新挂载。
      const vizMounted = renderBox && (renderBox.querySelector('.viz-card') || renderBox.querySelector('.viz-iframe'));
      if (renderBox && live && !vizMounted) {
        renderBox.innerHTML = _renderCustomNodeContentHtml(live);
        if (typeof renderMath === 'function') renderMath(renderBox);
        if (typeof _initVizIframes === 'function') _initVizIframes(renderBox);
      }
      const textarea = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-content');
      if (textarea) textarea.value = content;
      if (node.kind === 'blank') _renderBlankNodeLive(node, content);
      _scheduleGraphSync();
    }, GRAPH_STREAM_RENDER_MS);
  }

  // 流式周期落盘（T359，对齐 blank 路的 scheduleSave）：这一路原先只在 for-await 收尾
  // 保存一次——中途关页/刷新/断流（含 T359 看门狗掐断前的所有帧）屏幕上明明已有全文，
  // 盘上却还是空的（用户 2026-10-17 报「屏幕已见全文、换设备回空」的正主）。400ms 一拍
  // 与 blank 路同档：够便宜，又保证「看到过的字」最多丢半秒。
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      _saveCustomNodes();
    }, 400);
  }

  try {
    for await (const piece of _sseContentFrames(resp)) {
      content += piece;
      _scheduleWorkflowStreamProgress(content.length);
      scheduleRender();
      scheduleSave();
    }
  } catch (err) {
    // 半成品随错误一起交出去（T359）：连接断在半路时，字只攒在这个局部变量里，抛出去
    // 调用方就再也看不到「屏幕上已经出现过的内容」了——挂在 err 上让它能兜住。
    if (err && typeof err === 'object') err.streamPartial = content;
    throw err;
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  let cleaned = node.kind === 'module' ? _cleanBlankNodeContent(node, content) : content;
  if (!cleaned.trim()) cleaned = content;
  const live = _findGraphNode(node.id);
  if (live) {
    live.content = cleaned;
    live.summary = _graphSummary(cleaned);
    live.status = 'done';
    live.generatedAt = Date.now();
    live.inputHash = _nodeInputHash(live);
    live.busy = false;
  }
  _saveCustomNodes();
  if (node.kind === 'blank') _renderBlankNodeLive(node, cleaned);
  _refreshWorkflowNodeStatusUi(live);
}

async function _streamAnalysisResponse(resp, node, question) {
  let analysis = '';
  let renderPending = false;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (!live) return;
      live.analysis = analysis;
      const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
      if (renderBox) {
        renderBox.innerHTML = _renderCustomNodeContentHtml(live);
        if (typeof renderMath === 'function') renderMath(renderBox);
      }
      _scheduleGraphSync();
    }, GRAPH_STREAM_RENDER_MS);
  }

  for await (const piece of _sseContentFrames(resp)) {
    analysis += piece;
    _scheduleWorkflowStreamProgress(analysis.length);
    scheduleRender();
  }

  let cleaned = analysis.trim();
  if (typeof stripXmlTags === 'function') cleaned = stripXmlTags(cleaned).trim();
  if (!cleaned) throw new Error('问题分析返回空内容');
  if (cleaned.length > 1200) cleaned = cleaned.slice(0, 1200);
  const live = _findGraphNode(node.id);
  if (live) {
    live.analysis = cleaned;
    live.analysisHash = _simpleHash(question + '|' + (node.requirements || ''));
    live.status = 'done';
    live.busy = false;
  }
  const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
  if (renderBox && live) {
    renderBox.innerHTML = _renderCustomNodeContentHtml(live);
    if (typeof renderMath === 'function') renderMath(renderBox);
  }
  _saveCustomNodes();
  _refreshWorkflowNodeStatusUi(live);
  if (typeof hideProgress === 'function') hideProgress();
}

function _refreshWorkflowNodeStatusUi(node) {
  if (!node) return;
  if (workflowRunActive) {
    if (typeof _refreshWorkflowNodeUi === 'function') _refreshWorkflowNodeUi(node);
  } else {
    renderGraphCanvas();
  }
}

