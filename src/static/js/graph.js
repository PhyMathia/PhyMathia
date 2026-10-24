// ===== PhyMathia 知识网络画布：核心状态与节点属性（2026-10-24 T397 拆分）=====
// 图数据构建在 graph-data.js、修改历史三件 graph-history*.js、图体检在 graph-consistency.js、
// 画布事件与分组操作在 graph-events.js；色板与端口加口权限的唯一裁决处仍在本件。

// ===== PhyMathia 知识网络画布 =====
// 色板一律引用 CSS 令牌（值定义在 graph-override.css「节点属性色板」，T166 收编）；
// 消费路径全是 DOM 样式（--node-attr / style color / --port-color），var() 即可即取。
const GRAPH_MODULE_META = {
  physics: { label: '物理视角', color: 'var(--node-physics)' },
  math: { label: '数学视角', color: 'var(--node-math)' },
  graph: { label: '知识图谱', color: 'var(--node-graph)' },
  viz: { label: '交互可视化', color: 'var(--node-viz)' },
  socratic: { label: '苏格拉底追问', color: 'var(--node-socratic)' },
  learn: { label: '进阶学习', color: 'var(--node-learn)' },
  manual: { label: '我的回答', color: 'var(--ink-human)' },
  hub: { label: '汇聚', color: 'var(--node-hub)' },
  summary: { label: 'AI 总结', color: 'var(--node-summary)' },
  note: { label: '我的总结', color: 'var(--ink-human)' },
  source: { label: '输入', color: 'var(--node-source)' },
  relation: { label: '联系', color: 'var(--node-relation)' },
};

const GRAPH_MODULE_DEFAULT_OUTPUTS = {
  physics: ['追问'],
  math: ['追问'],
  graph: ['追问'],
  viz: ['追问'],
  socratic: ['回答练习', '直接问AI', '追问'],
  learn: ['进阶学习', '追问'],
};

// ── 端口机制统一（2026-10-10）：加口权限的唯一裁决处 ──
// 渲染（graph-render 的＋号与×键）、右键菜单（graph-contextmenu）、增删守卫
// （graph-interact）三处共用这两个门，别再在各处另写 kind 名单。口径＝常驻
// 节点两侧都开放附加口，例外有四条：draft（临时提问卡，两侧全关）、
// source 的输入侧（源头节点，连输入列都不渲染）、动态出口配方（出口数随
// 正文解析，手加会被冲掉）——answer 底座配方未声明静态出口同样锁出口
// （T263 口径）——以及 junction（2026-10-11 中转节点：固定一进一出，
// 多路汇入/扇出走单口多线，扇入口子在 _resolveGraphEdges、扇出在
// _connectPorts，都不长口）。基础口（身份口）永远不可删，删的只能是附加口。
function _nodeRecipeOutputLocked(node) {
  if (!node || !node.recipeId) return false;
  if (node.kind !== 'module' && node.kind !== 'answer') return false;
  const snapshot = typeof _nodeRecipeSnapshot === 'function' ? _nodeRecipeSnapshot(node) : null;
  if (!snapshot || (snapshot.ports && snapshot.ports.dynamic)) return true;
  if (node.kind === 'answer' && !(typeof _recipeStaticPorts === 'function' && _recipeStaticPorts(node).length > 0)) return true;
  return false;
}

function _nodeCanAddInputPorts(node) {
  if (!node) return false;
  if (node.kind === 'draft' || node.kind === 'source' || node.kind === 'junction') return false;
  return true;
}

function _nodeCanAddOutputPorts(node) {
  if (!node) return false;
  // 素材篮（2026-10-24 开放加口）：新数据的附加输出口＝「整篮出口」（out-N 越界
  // 取材回落全部条目拼接，见 _nodeOutputContent/_collectUpstreamImages）；旧节点
  // （知识点形状 items）只读不开放。加口后条目增删须同步平移附加口边与 portCounts
  // （_sourcePushItem 右移＋1 / deleteSourceItem 左移−1），保住 out-i↔items[i] 对应
  if (node.kind === 'draft' || node.kind === 'junction') return false;
  if (node.kind === 'source') return !_sourceIsLegacyNode(node);
  return !_nodeRecipeOutputLocked(node);
}

// ===== T275：生成中断电清扫 =====
// 生成入口（graph-workflow/graph-custom）都是「先存 busy=true/status='running'
// 再发请求」，页面中途被关后负责复位的 catch/finally 永远不会跑——持久层把
// 「生成中」原样带回重启后的画布，节点永久转圈，且生成守卫让重生成点不动。
// 口径：凡「从外部存储水合」的时刻（启动、历史版本回放、服务端状态落地）不可能仍有
// 合法生成在跑，busy 一律剥除、status==='running' 归位空串；勿接进每帧渲染与常规保存
// ——生成期间的重渲染和落盘恰恰靠持久层里的 busy 存活。
//
// T359（2026-10-17）在同一条清扫上补「中断结算」：生成开跑会先清空 content 并立刻落盘
// （2026-10-15 用户拍板：不许旧文压着新流），旧文进 versions 账本（T339）；流式期间还有
// 400ms 周期落盘（T359 补齐），所以盘上可能是「空卡」或「流到一半的草稿」。剥离 busy 的
// 同时把这次中断结清，别让用户屏幕上见过的内容凭空消失：
//   ①盘上有草稿（content 非空且不等于账本 activeVersion 那版）→ 收进账本当最新一版：
//     用户见过的内容比账本里的旧文新，不能回退成旧文；
//   ②盘上没内容而账本有版 → 兜回 activeVersion（旧文找回来，不再只剩 ‹› 手动切）；
//   ③这次生成没跑完 → status 归 'error'（徽章「失败」，全部开始会重新收编它）。
// 活页面里正在跑的那颗不动（流没断，busy 是它自己写的；服务端水合也会走这道清洗，
// 误伤在途生成会把它的落点节点对象换掉）。
function _settleInterruptedCustomNode(node) {
  const next = { ...node, busy: false, status: node.status === 'running' ? '' : node.status };
  const content = typeof next.content === 'string' ? next.content : '';
  const versions = Array.isArray(next.versions) ? next.versions : null;
  if (versions && versions.length) {
    const total = versions.length;
    const av = (typeof next.activeVersion === 'number' && next.activeVersion >= 0 && next.activeVersion < total)
      ? next.activeVersion : total - 1;
    const active = versions[av];
    if (content.trim()) {
      if (String((active && active.content) || '') !== content) {
        // 草稿入账（浅拷一份账本，入参一字不动）：新一版就是屏幕上那一版
        const ledger = versions.map(v => ({ ...v }));
        ledger.push({ content: content, at: Date.now(), humanDone: !!next.humanDone });
        next.versions = ledger;
        next.activeVersion = ledger.length - 1;
      } else {
        next.activeVersion = av;
      }
    } else if (active && String(active.content || '').trim()) {
      next.content = String(active.content);
      next.summary = typeof _graphSummary === 'function'
        ? _graphSummary(next.content) : next.content.slice(0, 120);
      next.activeVersion = av;
      next.humanDone = !!active.humanDone;
    } else {
      next.activeVersion = av;
    }
    next.status = 'error';
    return next;
  }
  // 账本都没有＝首次生成被打断：草稿留着（屏幕上见过的字不删），只是它还不算一版——
  // 与「人工写的内容也不在账本里」同口径，不硬造账本；状态仍按 T275 归空串。
  return next;
}

function _sanitizeStaleBusyCustomNodes(list) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const next = list.map(cn => {
    if (cn && typeof cn === 'object' && (cn.busy || cn.status === 'running')) {
      // 在途生成守卫：这颗节点的流还在本页面里跑（busy 是它自己写的），别动它
      if (typeof _findGraphNode === 'function') {
        const live = _findGraphNode(cn.id);
        if (live && live.busy) return cn;
      }
      changed = true;
      return _settleInterruptedCustomNode(cn);
    }
    return cn;
  });
  return changed ? next : list;
}

// 启动全库扫一次（同 session.js 坏键清扫的手法）：只洗活图键 phymathia_graph_*，
// 历史快照键不动（体量大，且回放时有 _restoreGraphVersion 兜住）；洗完顺手把
// 服务端 kv 镜像也覆写成净值——否则下次切会话「服务端较新」分支会把脏
// customNodes 原样盖回本地。
function _sweepStaleBusyGraphKeys() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('phymathia_graph_') || key.startsWith('phymathia_graph_history_')) continue;
      const raw = localStorage.getItem(key);
      // 预过滤避免逐键 JSON.parse：两串取值均出自 JSON.stringify（无空格）
      if (!raw || (raw.indexOf('"busy":true') === -1 && raw.indexOf('"status":"running"') === -1)) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const cleaned = _sanitizeStaleBusyCustomNodes(parsed.customNodes);
      if (cleaned === parsed.customNodes) continue; // busy 只出现在 checkpoint 等无关字段：不动
      parsed.customNodes = cleaned;
      try { localStorage.setItem(key, JSON.stringify(parsed)); } catch (e) { continue; }
      const sid = key.slice('phymathia_graph_'.length);
      try {
        // T360：回写走合并通道（见 session.js 的 _graphSyncMergePayload）——直连 POST 会
        // 拿整份本地状态盖掉另一台设备刚生成的内容，而「旧设备开机触发清扫」正是 T360
        // 报告里那条路径。HARNESS 之外的调用方缺失时（viewer 子集）退回直连。
        if (typeof window.postGraphStateMerged === 'function') {
          window.postGraphStateMerged(sid, parsed);
        } else {
          fetch('/api/kv/' + encodeURIComponent('graph:' + sid), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: parsed }),
          }).catch(function () {});
        }
      } catch (e) { /* 服务端洗不动无害：本地已净，下次启动再补 */ }
    }
  } catch (e) { /* localStorage 不可用等：清扫只是兜底，不阻断启动 */ }
}
_sweepStaleBusyGraphKeys();

const GRAPH_NODE_ATTRIBUTES = {
  question: { key: 'question', label: '问题', color: 'var(--node-question)' },
  followup: { key: 'followup', label: '追问', color: 'var(--node-followup)' },
  answer: { key: 'answer', label: '问题分析', color: 'var(--node-answer)' },
  // 直接回答（2026-10-24）：AI 侧成品答案卡，与问题分析同色系（同为「AI 给出的回答」），
  // 靠绿族亮一档（--node-direct #4ade80）与问题分析相邻可辨；端口/属性类名 graph-attr-direct
  direct: { key: 'direct', label: '直接回答', color: 'var(--node-direct)' },
  physics: { key: 'physics', label: '物理视角', color: 'var(--node-physics)' },
  math: { key: 'math', label: '数学视角', color: 'var(--node-math)' },
  graph: { key: 'graph', label: '知识图谱', color: 'var(--node-graph)' },
  viz: { key: 'viz', label: '交互可视化', color: 'var(--node-viz)' },
  socratic: { key: 'socratic', label: '苏格拉底追问', color: 'var(--node-socratic)' },
  learn: { key: 'learn', label: '进阶学习', color: 'var(--node-learn)' },
  manual: { key: 'manual', label: '我的回答', color: 'var(--ink-human)' },
  human_note: { key: 'human_note', label: '我的理解', color: 'var(--ink-note)' },
  ai_eval: { key: 'ai_eval', label: 'AI 评价', color: 'var(--node-ai-eval)' },
  hub: { key: 'hub', label: '汇聚', color: 'var(--node-hub)' },
  summary: { key: 'summary', label: 'AI 总结', color: 'var(--node-summary)' },
  note: { key: 'note', label: '我的总结', color: 'var(--ink-human)' },
  source: { key: 'source', label: '输入', color: 'var(--node-source)' },
  relation: { key: 'relation', label: '联系', color: 'var(--node-relation)' },
  junction: { key: 'junction', label: '中转', color: 'var(--node-junction)' },
  any: { key: 'any', label: '任意输入', color: 'var(--node-any)' },
  // 配方节点的属性键（P1）：颜色按节点内嵌快照的色板令牌注入 --node-attr，
  // 这里只是 draft/端口兜底用的中性条目——具体颜色永远以 _recipeNodeAttribute 为准
  recipe: { key: 'recipe', label: '配方', color: 'var(--accent)' },
};

const ANSWER_OUTPUT_SCHEMA = ['physics', 'math', 'graph', 'viz', 'learn', 'socratic'];
const ANSWER_OUTPUT_INDEX = { physics: 0, math: 1, graph: 2, viz: 3, learn: 4, socratic: 5 };

// 16 入口由节点配方注册表派生（graph-recipes.js，P0 起单一事实源），字段与形状
// 与原字面量逐项一致；GRAPH_MODULE_META / GRAPH_NODE_ATTRIBUTES / GRAPH_MODULE_DEFAULT_OUTPUTS
// 是渲染细节表，P1 随配方行为挂载一起并入注册表。
const MANUAL_NODE_OPTIONS = deriveManualNodeOptions();

// 自定义节点 kind 白名单（含 relation：创建口径已移除，但旧会话数据里的 relation 节点
// 不能在保存/恢复时被静默抹掉——backlog T75，2026-09-29 修复）
const GRAPH_CUSTOM_NODE_KINDS = deriveGraphCustomNodeKinds();

// 族别形状：面板色点用这一套，画布上的属性标签用同一套（graph-override.css 第 7 轮，
// 按 graph-node-* / graph-attr-* 类名上形状）。圆＝AI 产出、方＝人工书写、菱＝结构、环＝原始素材。
// 之所以有形状而不是只靠颜色：知识图谱↔输入、数学视角↔问题这些配对色相只差 3°–5°，1px 描边上看不出来。
function _nodeFamilyShape(option) {
  const group = (option && option.group) || 'ai';
  if (group === 'human') return 'is-square';
  if (group === 'structure') return 'is-diamond';
  if (group === 'data') return 'is-ring';
  return 'is-round';
}

let graphCanvas = null;
let graphInner = null;
let graphEdgeLayer = null;

const graphView = {
  nodes: [],
  edges: [],
  defaultEdges: [],
  nodeById: {},
  previewNodes: [],
  previewEdges: [],
  selectedNodeIds: new Set(),
  selectedGroupIds: new Set(),
  dragNodeId: null,
  linkDrag: null,
  dragStartPositions: {},
  dragWasSelected: false,
  dragModifier: false,
  boxSelect: null,
  suppressClick: false,
  selectMode: false,
  linkMode: false,
  linkFirstNodeId: null,
  keyHandlerBound: false,
  resizeNodeId: null,
  resizeStartX: 0,
  resizeStartY: 0,
  resizeStartW: 0,
  resizeStartH: 0,
  panning: false,
  moved: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  panStartX: 0,
  panStartY: 0,
  nodeStartX: 0,
  nodeStartY: 0,
  groups: [],
  dragGroupId: null,
  dragGroupStartX: 0,
  dragGroupStartY: 0,
  dragGroupNodeStartPositions: {},
  resizeGroupId: null,
  resizeGroupStartX: 0,
  resizeGroupStartY: 0,
  resizeGroupStartW: 0,
  resizeGroupStartH: 0,
  resizeGroupStartClientX: 0,
  resizeGroupStartClientY: 0,
};

let workflowAbortController = null;
let workflowRunActive = false;
// 上一轮工作流是否被用户停掉（T285）：收尾提取等「跑完才该做的事」以此为闸。
let workflowLastAborted = false;
// 在跑节点各自 AbortController 的登记簿（T299）：总闸 stopWorkflowRun 按下时要连
// 正在流的节点一起掐断。只结总账不管它们的话，最多 6 颗并行节点会各自把当前这一轮
// 流式跑完才收工——用户点了「停止生成」还在出字，等于按钮失灵。
let workflowInFlightControllers = new Set();
const WORKFLOW_MAX_CONCURRENCY = 6;
let workflowProgressActive = new Set();
let _graphMermaidTimer = null;

const GRAPH_UNDO_LIMIT = 30;
const GRAPH_HISTORY_STORAGE_MAX = 1500000;
let graphUndoStack = [];
// T365 游标模型（2026-10-18，替代旧的双栈 undo/redo 暂存）：一份版本列表
// ＋当前位置游标（Photoshop 式时间旅行）。graphUndoStack 仍是「编辑前快照」序列，
// 条目语义与序列化格式（checkpointRef/msgDelta）不动；graphHistoryCursor 取值
// 0..graphUndoStack.length，=== length 表示停在「最新」（live 虚拟位，当前图状态本身
// 不占条目）；< length 表示时间旅行中，当前所见＝graphUndoStack[cursor]。
let graphHistoryCursor = 0;
// 离开 live 位（撤销/跳转）时懒捕获的「最新」锚点， redo/跳回最新/持久化都吃它；
// 停在 live 位时恒为 null。没有它，「未来」就只剩内存外无落点的悬空状态。
let graphHistoryLive = null;
let graphHistorySession = "";
// T349：清空/删除画布作废撤销历史时的纪元号。在途的服务端存档补回
// （_upgradeGraphHistoryFromServer）起飞前记号、落地时对号，号变了就地丢弃——
// 防止清空后一张迟到的旧存档把清空前的撤销栈整段接回来。
let _graphHistoryWipeEpoch = 0;
let graphHistoryPanel = null;
let graphHistoryPreviewing = -1;
let graphHistoryDiffSummary = "";
let graphPendingLiveMeta = null;
let graphHistoryTimer = null;
let graphHistoryLastSignature = "";
// ===== 2026-10-24 修改历史增强（R1–R9）＋同日简化批次 =====
// 单槽「另一条路」（R7）已随简化批次退役：回退后落真编辑＝按业界惯例直接丢弃被跳过的
// 「未来」（toast 指路「⧉ 另开」）；信封可选字段 s 读回静默忽略、不再写出。存量信封里
// 那条旁路就此放下——拍板过的取舍，别当丢数据的 bug 报。
// 退出结算（§6）：正常关闭/刷新只写标记，下次打开时结算。标记键走 localStorage
// 垫片（多账号自动隔离），只记「条数＋末条时间戳＋游标」的轻量指纹，卸载期不算全量哈希。
const GRAPH_HISTORY_EXIT_KEY = "phymathia_graph_history_exit_";
const GRAPH_HISTORY_STALE_SETTLE_MS = 12 * 3600 * 1000;
let graphHistorySavedAt = 0;        // 本地信封落盘时间（12h 兜底结算用）
// 面板 800ms 刷新的脏标记（T219/R9）：只有图真被写过才重算「当前状态」与它跟最后
// 一条的差异；打开面板先算一次。没有它，面板常开时每 800ms 做一次全图深比较。
let graphHistoryLiveDirty = true;
let graphHistoryLiveMetaCache = null;
let graphHistoryLastScrollCursor = -1;
// 对比清单与导航（R4）：当前对比的条目、清单、聚焦序号。
let graphHistoryDiffModel = null;
// 对比方向（简化批次）：'back'＝回到这里会怎样（默认），'step'＝这一步改了什么。
// 原「与上一步对比」行内按钮退役，两向并进对比面板底部的切换钮。
let graphHistoryCompareDir = "back";
// 投影构建期间屏蔽存盘副作用（_buildGraphData 派生苏格拉底节点后会顺手存盘）。
let _graphProjQuiet = 0;
// 时间旅行位的「待截断」标记（1.2）：推送发生在编辑之前，所以第一次编辑的推送与
// 「什么都没改的推送」长得一模一样，不能当场截断未来的重做链。这里先挂个标记，
// 等真正的图状态写到（_saveGraphState，内容确实变了）再截断＋存槽（立即生效）。
let graphHistoryPendingTruncate = false;
// ===== 2026-10-25 T389（批次 4）：另开探索线 + 打磨（部分已随简化批次退役） =====
// 容量提示：dropped＝被 30 步上限挤出的条数（面板只说「更早的 N 步已移出」；
// 体积 KB 展示与起名收藏已随 2026-10-24 简化批次退役）。
let graphHistoryDropped = 0;
// 合并连续编辑（4.3）：1.2 秒内对同一颗节点的连续改动只记一次。推送发生在编辑之前，
// 所以这里记的是「上一次编辑改了哪颗节点、什么时候改的」——由下一次推送算出的差异反推
// （那个差异描述的正是上一动作的效果）。跨刷新/撤销/切会话即重置。
const GRAPH_HISTORY_MERGE_MS = 1200;
let graphHistoryLastEffect = { op: "", touch: "", at: 0 };
let graphSearchOpen = false;
let graphSearchScope = 'current';
let graphSearchQuery = '';
let graphSearchIndexCache = new Map();
let graphSearchDebounce = null;
let graphSearchAllSynced = false;

const LAYOUT_VERSION = 4;
const TARGET_R = [0, 420, 940, 1460, 2000, 2560, 3120, 3680];
const MAX_ITERATIONS = 120;
let addBlankNodePoint = { x: 0, y: 0 };
let addBlankNodeOverlay = null;
// 添加节点面板的「挂起连线」：待命名附加输出口拖到空处时记下来源端口，面板里
// 选中节点后由 createManualNode/createRecipeNode 消费（建点即自动连回来源口）；
// 关闭面板（取消/改道）就地清掉。普通双击建点无挂起，消费函数是空操作。
let addBlankNodePendingLink = null;


const GRAPH_LAYOUT_FIELDS = ["positions", "sizes", "pan", "zoom", "collapsed", "hidden", "pinned", "layoutVersion", "groups", "portCounts", "inputPortCounts"];

