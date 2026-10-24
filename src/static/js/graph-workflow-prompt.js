// ====== 工作流上下文收集与提示词拼装（2026-10-10 自 graph-workflow.js 拆出，T261 纯搬家）=====
// 纯函数段：从节点上游链收集问题/输出生成 workflowContext，拼各模块提示词；
// 被 graph-workflow-generate.js（生成段）与 graph-workflow-recipe.js 运行期调用（函数声明全脚本提升）。
function _simpleHash(value) {
  let hash = 5381;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function _nodeStoredContent(node) {
  if (!node) return '';
  if (node.messageIndex >= 0) {
    // T313：messageIndex 派生节点的内容取材走世界消息表——切了画布之后
    // _getChatHistory 是别人家的消息，按索引取会张冠李戴（没世界时就是现场表）
    const msg = _workflowWorldMessages()[node.messageIndex] || null;
    if (node.kind === 'user') return msg?.content || '';
    if (node.kind === 'answer') return _graphSummary(msg?.content || '') || '';
    if (node.kind === 'module') return _nodeContent(msg, node);
  }
  // 派生追问节点（sq- 前缀自定义节点，messageIndex=-1）落到这里返回其 markdown 内容
  return node.summary || node.content || '';
}

// ===== T364：苏格拉底闭环作答卡识别（2026-10-18）=====
// 闭环每轮作答是 kind:'user' 的 user-custom 节点（graph-workflow-template.js
// _createSocraticWorkflowTemplate，内容＝提交瞬间定稿的 prompt 原文，一律以
// [苏格拉底回答]/[苏格拉底提示]/[苏格拉底讲解] 开头，与服务端口径同款——
// context.py _SOCRATIC_PROMPT_PREFIXES）。它是学生的回答不是问题：三处问题节点
// 判定（_findQuestionContentUpstream/_nearestUserInPath/_nearestQuestionNodeUpstream）
// 必须跳过它，否则闭环深链上 question 槽锚到作答原文、机器前缀漏进「原始问题」
// 渲染（T364）。判别走内容前缀，存量闭环节点没有标记字段也能识别；用户事后
// 改写正文去掉前缀＝退化成普通手写卡，与服务器同口径，属预期。
const _SOCRATIC_LOOP_ANSWER_PREFIXES = ['[苏格拉底回答]', '[苏格拉底提示]', '[苏格拉底讲解]'];

function _isSocraticLoopAnswer(node) {
  if (!node || node.kind !== 'user') return false;
  const text = String(node.content || '').replace(/^\s+/, '');
  return _SOCRATIC_LOOP_ANSWER_PREFIXES.some(prefix => text.indexOf(prefix) === 0);
}

// 作答卡进下游喂料前剥掉机器前缀——「我的作答」标签已表达身份，前缀是服务端
// 状态机的识别暗号，不该出现在给模型的正文里（非作答卡无前缀，replace 为 no-op）
function _stripSocraticAnswerMarker(text) {
  return String(text || '').replace(/^\s*\[(?:苏格拉底回答|苏格拉底提示|苏格拉底讲解)\]\s*/, '');
}

function _findQuestionContentUpstream(node) {
  const visited = new Set();
  function walk(current) {
    if (!current || visited.has(current.id)) return '';
    visited.add(current.id);
    if (current.kind === 'user' && !_isSocraticLoopAnswer(current)) return _nodeStoredContent(current);
    const incoming = _workflowEdgeTable().filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    for (const edge of incoming) {
      const source = _findGraphNode(edge.from);
      const found = walk(source);
      if (found) return found;
    }
    return '';
  }
  return walk(node);
}

function _nodeOutputContent(node, seen, fromPort) {
  if (!node) return '';
  seen = seen || new Set();
  // 素材篮（2026-10-22）：同一个输入节点的两个口是两份不同的素材——seen 按
  // id@port 记（不按口去重会把同节点的第二个口整个吞掉），hub/junction 透传同理
  const seenKey = node.id + '@' + (fromPort || '');
  if (seen.has(seenKey)) return '';
  seen.add(seenKey);
  // hub（存量汇聚）与 junction（2026-10-11 中转）都无自己的内容：入边内容拼接后
  // 当自己的输出——追问链穿过它们时，下游看到的就是上游本身。收集清单里两者都
  // 透明不出场（_collectUpstreamPath / _collectInboundChain；T273：hub 原先作为
  // 集合点出现在清单里，它的"内容"就是上游拼接，再进一份等于每篇上游写两遍）。
  if (node.kind === 'hub' || node.kind === 'junction') {
    const incoming = _workflowEdgeTable().filter(edge => String(edge.to) === node.id && !edge.draft && !edge.link);
    return incoming
      .map(edge => _nodeOutputContent(_findGraphNode(edge.from), seen, edge.fromPort))
      .filter(Boolean)
      .join('\n\n');
  }
  // 素材篮（2026-10-22）：按口取材——out-i 对应 items[i]，出口载荷=这条素材本身
  // （文本或占位），A 的口里永远不出现 B 的内容。旧 source 节点（知识点形状
  // items）不走此分支，保持旧口径（内容恒空）与改前一致
  if (node.kind === 'source' && !_sourceIsLegacyNode(node)) {
    const items = Array.isArray(node.items) ? node.items : [];
    const m = /^out-(\d+)$/.exec(String(fromPort || ''));
    if (m) {
      const item = items[parseInt(m[1], 10)];
      if (item && item.kind) return String(item.text || '') || _sourceItemPlaceholder(item);
      // 2026-10-24（三）按素材加的附加口：绑定的素材只送它自己；无绑定的附加口
      // ＝整篮出口，回落全部条目拼接（空则回落 node.content，与不传 fromPort 同路）
      const addon = (typeof _sourceAddonBinding === 'function') ? _sourceAddonBinding(node, parseInt(m[1], 10)) : null;
      if (addon && addon.item) {
        const bound = items.find(it => it && it.id === addon.item && it.kind);
        if (bound) return String(bound.text || '') || _sourceItemPlaceholder(bound);
      }
    }
    // 不传 fromPort（节点体拖拽等兜底路径）：全部条目拼接；拼接为空回落
    // node.content（它是拼接的缓存，兼容无 items 但带 content 的旧夹具/旧数据）
    const joined = items
      .map(it => it && it.kind ? (String(it.text || '') || _sourceItemPlaceholder(it)) : '')
      .filter(Boolean)
      .join('\n\n');
    return joined || String(node.content || '');
  }
  if (node.kind === 'answer' && !node.manual && node.messageIndex < 0) {
    // T364：闭环反馈卡（socraticMeta）正文在 content、analysis 恒空——旧回退把它
    // 替换成根问题文本，反馈的判定/提示/讲解从来进不了下游上下文
    if (node.socraticMeta) return _nodeStoredContent(node);
    return node.analysis || _findQuestionContentUpstream(node) || '';
  }
  return _nodeStoredContent(node);
}

// 素材条目的出口名（out-i ↔ items[i]，名字=素材名）——取材条目 label 用它，
// 否则同一个输入节点的两口在下游上下文里都叫「输入」
function _sourcePortLabel(node, fromPort) {
  // 旧 source 节点（知识点形状）口径恒空——新字段/新标签不写旧节点
  if (typeof _sourceIsLegacyNode === 'function' && _sourceIsLegacyNode(node)) return '';
  const m = /^out-(\d+)$/.exec(String(fromPort || ''));
  if (!m) return '';
  const idx = parseInt(m[1], 10);
  const items = Array.isArray(node.items) ? node.items : [];
  const item = items[idx];
  if (item && item.kind) return String(item.name || '');
  // 2026-10-24（三）：附加口——绑定的取素材名，无绑定的整篮口标「全部素材」
  const addon = (typeof _sourceAddonBinding === 'function') ? _sourceAddonBinding(node, idx) : null;
  if (addon && addon.item) {
    const bound = items.find(it => it && it.id === addon.item && it.kind);
    if (bound) return String(bound.name || '');
  }
  return items.length ? '全部素材' : '';
}

function _collectUpstreamPath(node) {
  const ordered = [];
  const orderedKeys = new Set();
  // T263 喂料分路：记录每个祖先经由哪条入边（toPort）进入，具名输入口分组用；
  // 素材篮（2026-10-22）：递归再带上 fromPort（经由哪条出边出来）——去重键从
  // node.id 改成 id@fromPort，同一个输入节点的两个口（两份素材）必须都留下
  function collect(current, viaPort, fromPort) {
    const dedupeKey = current.id + '@' + (fromPort || '');
    if (!current || orderedKeys.has(dedupeKey)) return;
    const incoming = _workflowEdgeTable().filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    for (const edge of incoming) {
      const source = _findGraphNode(edge.from);
      if (source) collect(source, edge.toPort || 'in-0', edge.fromPort || 'out-0');
    }
    if (!orderedKeys.has(dedupeKey)) {
      orderedKeys.add(dedupeKey);
      // 无内容节点（junction/hub）透明：上游照常递归（内容经 _nodeOutputContent
      // 直通），自身不进取材清单——否则上游每篇内容会在提示词里出现两遍（T273）
      if (current.kind !== 'junction' && current.kind !== 'hub') {
        ordered.push({ node: current, port: viaPort || '', fromPort: fromPort || '' });
      }
    }
  }
  collect(node, '', '');
  return ordered.map(entry => {
    const item = entry.node;
    const raw = _nodeOutputContent(item, undefined, entry.fromPort);
    return {
      id: item.id,
      kind: item.kind,
      timestamp: item.timestamp || '',
      module: item.moduleKey || '',
      manual: !!item.manual,
      // T364：闭环身份随条目走——标签分设「我的作答/苏格拉底反馈」、最近反馈卡
      // 全文额度都在 _workflowUpstreamEntry 消费这两个标记
      socraticAnswer: _isSocraticLoopAnswer(item),
      socraticFeedback: !!(item.kind === 'answer' && !item.manual && item.socraticMeta),
      // 节点标题（2026-10-10 ③）：note/我的回答 起的名优先于品类名进下游喂料标签
      title: item.title || '',
      analysis: item.kind === 'answer' && !item.manual ? (item.analysis || '') : '',
      // 素材篮（2026-10-22）：条目带上出口（fromPort）与出口名（portLabel）——
      // source 的两口是两份素材，label 与内容都按口区分
      fromPort: entry.fromPort,
      portLabel: item.kind === 'source' ? _sourcePortLabel(item, entry.fromPort) : '',
      summary: _graphSummary(raw) || '',
      content: raw,
      toPort: entry.port,
    };
  });
}

// ===== 取材附图（2026-10-23 打通传图；T381 接全部发送链；T382 扫描版 PDF 页转图）=====
// 一条消息最多几张图（服务端 CHAT_IMAGES_MAX=6 兜底，上游 4xx 会去图重发）
const WORKFLOW_SEND_IMAGE_MAX = 4;
// 单份扫描版 PDF 最多参与前几页（与后端 documents.PDF_PAGE_MAX 同口径；配额见
// _allocateSendImageRefs——页多不等于张数多）
const WORKFLOW_PDF_PAGE_MAX = 8;

// 上游收集路与 workflowContext **同源**：配方声明 aggregation=first_inbound 的
// 节点走单父链，其余走全祖先。图片素材必须跟各链的语义一致——否则提示词里的
// 「证据」与随消息发的「图」来自两套节点集合，模型看图与读文对不上号
function _workflowContextRoute(node) {
  const recipeAgg = node && node.recipeId && node.recipe ? String(node.recipe.aggregation || '') : '';
  return recipeAgg === 'first_inbound' ? 'inbound' : 'path';
}

function _workflowContextEntries(node, route) {
  const how = route === 'inbound' || route === 'path' ? route : _workflowContextRoute(node);
  return how === 'inbound' ? _collectInboundChain(node) : _collectUpstreamPath(node);
}

// 存量条目兼容（T382 打标前的素材篮）：没有 scanned 字段时按「无文字层的 .pdf」
// 现场判定——旧画布里的扫描件不用重新入篮也能走页转图
function _sourceItemIsScannedPdf(item) {
  if (!item || !item.fileId) return false;
  if (item.kind === 'image') return false;
  if (item.scanned === true) return true;
  if (item.scanned === false) return false;
  if (!/\.pdf$/i.test(String(item.fileName || item.name || ''))) return false;
  return !String(item.text || '').trim();
}

// 一份素材能贡献的图：图片条目＝原图一张（page 0＝原字节，不经页渲染）；
// 扫描版 PDF＝前若干页（1-based 页号）。其余条目（文字/未打标的普通文件）不产图
// 2026-10-24（三）：附加口按绑定分流图片条目——绑定口只收那条素材；整篮口收
// 全部条目；基础口越界之外与无 fromPort 兜底返回空（不掺图）
function _sourcePortImageItems(src, portIdx) {
  const items = Array.isArray(src.items) ? src.items : [];
  if (portIdx < items.length) return [];
  const addon = (typeof _sourceAddonBinding === 'function') ? _sourceAddonBinding(src, portIdx) : null;
  if (addon && addon.item) {
    const bound = items.find(it => it && it.id === addon.item && it.kind);
    return bound ? [bound] : [];
  }
  return items.filter(it => it && it.kind);
}

function _sourceItemImageGroup(item) {
  if (!item || !item.fileId) return null;
  const name = item.fileName || item.name || '';
  if (item.kind === 'image') {
    return { fileId: item.fileId, name: name, pages: [0] };
  }
  if (!_sourceItemIsScannedPdf(item)) return null;
  const declared = parseInt(item.pages, 10);
  const total = Number.isFinite(declared) && declared > 0
    ? Math.min(declared, WORKFLOW_PDF_PAGE_MAX)
    : WORKFLOW_PDF_PAGE_MAX;
  const pages = [];
  for (let p = 1; p <= total; p++) pages.push(p);
  return { fileId: item.fileId, name: name, pages: pages };
}

// 配额分配（T382 拍板）：图片与扫描版 PDF 页混在一个篮子里，4 张按**轮转**分——
// 第一轮每种素材各取一张（图片＝原图，PDF＝第 1 页），还有余量再按同一顺序给
// 扫描版 PDF 补第 2/3/… 页。三条理由：
//   ① 每种素材都至少露一次脸：直接截前 4 张时，排在后面的素材（尤其扫描件）
//      可能整份缺席，用户看到的是「图根本没发出去」；
//   ② 只有一份多页扫描件时仍能用满 4 张（它自己按轮次吃满余量）；
//   ③ 顺序只由收集顺序决定，同一份上游每次拼出同一组图，可复现、好排查。
// 轮转在「页」粒度上做，所以两份扫描件＝各前 2 页，不会一份吃满、另一份饿死。
function _allocateSendImageRefs(groups, max) {
  const limit = Math.max(0, parseInt(max, 10) || 0);
  const refs = [];
  if (!limit) return refs;
  const queues = (groups || []).filter(Boolean).map(group => ({
    fileId: group.fileId,
    name: group.name || '',
    pages: Array.isArray(group.pages) ? group.pages.slice() : [],
    cursor: 0,
  }));
  let progressed = true;
  while (refs.length < limit && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (refs.length >= limit) break;
      if (queue.cursor >= queue.pages.length) continue;
      refs.push({ fileId: queue.fileId, name: queue.name, page: queue.pages[queue.cursor++] });
      progressed = true;
    }
  }
  return refs;
}

// 上游要发的图清单（发送侧取字节用）：按口收集 → 配额分配，返回
// [{fileId, name, page}]。route 缺省跟随该节点的上下文收集路（见 _workflowContextRoute）；
// 空白节点这条单父链生成显式传 'inbound'
function _collectUpstreamImages(node, route) {
  const groups = [];
  const seen = new Set();
  for (const entry of _workflowContextEntries(node, route)) {
    if (entry.kind !== 'source') continue;
    const src = _findGraphNode(entry.id);
    if (!src || _sourceIsLegacyNode(src)) continue;
    const m = /^out-(\d+)$/.exec(String(entry.fromPort || ''));
    const item = (m && Array.isArray(src.items)) ? src.items[parseInt(m[1], 10)] : null;
    // 2026-10-24（三）：附加口带绑定（按素材加口）→ 只收那条素材的图；无绑定的
    // 附加口＝整篮口，收全篮图片/扫描件条目各成一组（seen 键带条目 fileId，防同口
    // 多条目互吞）；无 fromPort 的兜底路径维持旧口径不掺图
    const portItems = item && item.kind
      ? [item]
      : (m ? _sourcePortImageItems(src, parseInt(m[1], 10)) : []);
    for (const it of portItems) {
      const group = _sourceItemImageGroup(it);
      if (!group) continue;
      const key = entry.id + '@' + entry.fromPort + '@' + (it.fileId || it.id);
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(group);
    }
  }
  return _allocateSendImageRefs(groups, WORKFLOW_SEND_IMAGE_MAX);
}
window._collectUpstreamImages = _collectUpstreamImages;

// 单父链取材（P2，空白节点式）：只沿每个节点的第一条入边回溯一条链，
// 与 _collectUpstreamPath 输出同形（含自身，answer 仍被抽出进 analysis 槽）。
// 素材篮（2026-10-22）：fromPorts 记录链上每颗经由哪条出边进入下一环——
// source 的出口按口取材需要它
function _collectInboundChain(node) {
  const chain = [];
  const ports = [];
  const fromPorts = [];
  const visited = new Set();
  let current = node;
  let prevIncoming = null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    // 无内容节点（junction/hub）穿透：自身不进链，顺它的第一条入边继续往上走——
    // 单链取材对它是"线的一截"，不是链上的一环（T273：与 collect 同口径去双写）
    if (current.kind === 'junction' || current.kind === 'hub') {
      const hop = _workflowEdgeTable().find(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
      current = hop ? _findGraphNode(hop.from) : null;
      continue;
    }
    chain.push(current);
    const incoming = _workflowEdgeTable().find(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    ports.push(incoming ? (incoming.toPort || 'in-0') : '');
    // 本条目的出边＝上一轮（下游侧）的入边：fromPort 表达「我从哪个口出去」，
    // 与 _collectUpstreamPath 的 fromPort 同口径（条目自己的输出口）
    fromPorts.push(prevIncoming ? (prevIncoming.fromPort || 'out-0') : '');
    prevIncoming = incoming;
    current = incoming ? _findGraphNode(incoming.from) : null;
  }
  chain.reverse();
  ports.reverse();
  fromPorts.reverse();
  return chain.map((item, index) => {
    const raw = _nodeOutputContent(item, undefined, fromPorts[index] || '');
    return {
      id: item.id,
      kind: item.kind,
      timestamp: item.timestamp || '',
      module: item.moduleKey || '',
      manual: !!item.manual,
      // T364：与 _collectUpstreamPath 同款闭环身份标记
      socraticAnswer: _isSocraticLoopAnswer(item),
      socraticFeedback: !!(item.kind === 'answer' && !item.manual && item.socraticMeta),
      title: item.title || '',
      analysis: item.kind === 'answer' && !item.manual ? (item.analysis || '') : '',
      fromPort: fromPorts[index] || '',
      portLabel: item.kind === 'source' ? _sourcePortLabel(item, fromPorts[index] || '') : '',
      summary: _graphSummary(raw) || '',
      content: raw,
      toPort: ports[index] || '',
    };
  });
}

// 路径数组（_blankNodeGraphPath 产物，根→目标序）里离目标最近的问题节点——
// 从尾反向扫（原生 for，勿用 findLast 防旧内核，T333a 同款）。旧调用点的
// Array.find 取到的是最早的根问题，深链上空白节点生成跟着最初的问题跑（T340）。
// T364：闭环作答卡（kind user 但内容是 [苏格拉底回答] 定稿）不算问题，跳过。
function _nearestUserInPath(path) {
  const arr = path || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i].kind === 'user' && !_isSocraticLoopAnswer(arr[i])) return arr[i];
  }
  return null;
}

// T327：工作流上游条目的规范化顺序（_buildWorkflowContextForNode 排序用）：
// timestamp 优先——建点时间，链上图天然「源节点在前」，与 _collectUpstreamPath
// 的后序遍历多数场景重合；同秒/缺时间戳按 kind/module/title/label/content 稳定
// 决胜。排序键只取节点属性，与边在 edge 表里的插入顺序无关——同一份上游集合
// 任何时候都拼出同一串上下文字节，与 _nodeInputHash 对 parts 的 sort 口径同属
// 「规范化后无序敏感」（hash 公式不动，存量节点哈希仍可比）；兄弟模块的共享
// 前缀（T4）与重放/排队重放的缓存命中因此稳定。
function _wfTsRank(v) {
  if (v === '' || v === null || v === undefined) return -1;
  const n = Number(v);
  return Number.isFinite(n) ? n : -1;
}

function _workflowUpstreamCompare(a, b) {
  const ta = _wfTsRank(a.timestamp), tb = _wfTsRank(b.timestamp);
  if (ta !== tb) return ta - tb;
  const ka = [a.kind || '', a.module || '', a.title || '', a.label || '', a.summary || '', a.content || ''];
  const kb = [b.kind || '', b.module || '', b.title || '', b.label || '', b.summary || '', b.content || ''];
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

// ===== T328：追问来源卡（链上 A→问题→分析/模块 的 A）全文取材 =====
// 旧取材断在问题节点上：_findQuestionContentUpstream 找到 user 节点就返回，
// 模块侧 _collectUpstreamPath 虽收全祖先、每条却只切 800 字。追问常常是针对
// 被追问那张卡中后段的某一步/某个公式提的——用户实测：机械波弦的 T·Δs 在
// 上游缺席时被模型读成热力学 T·ΔS，整棵问题分析答错领域（T328）。
// 规则：从目标节点上溯找到问题节点，它第一条入边的来源＝追问来源卡；该条
// 目标 full 走大额度，其余祖先维持 800 字旧口径（非 full 条目字节形状不变，
// T4 兄弟共享前缀与 T322/T323 冻结的 shared 段行序都不破）。
const WORKFLOW_UPSTREAM_MAX_CHARS = 800;
const WORKFLOW_FOLLOWUP_SOURCE_MAX_CHARS = 6000;

// A 可能是 viz 节点：正文是完整 HTML 页面（几万字节）。围栏折叠成占位行——
// 全文灌进「1 次分析＋N 个兄弟」只会稀释注意力、白烧 token（6000 字兜底之上
// 的第二道闸，viz 追问场景 HTML 本身也不是分析需要的形态）。
function _foldHtmlFences(text) {
  return String(text || '').replace(/```html[\s\S]*?(?:```|$)/gi, '（交互可视化 HTML 页面已折叠）');
}

// 从目标节点沿第一条入边上溯（跳过 draft/link 边）找**最近**的问题节点；visited
// 由调用方传入时复用同一份（_followupSourceNodeId 来源侧的成环防护要看到同一条
// 走过的链），没传就自建。找不到（无上游成环且无 user）返回 null。
// T364：闭环作答卡不算问题——否则闭环深链的 question 槽锚到学生作答原文。
function _nearestQuestionNodeUpstream(node, visited) {
  const seen = visited || new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.kind === 'user' && !_isSocraticLoopAnswer(current)) return current;
    const incoming = _workflowEdgeTable().filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    current = incoming.length ? _findGraphNode(incoming[0].from) : null;
  }
  return null;
}

// T364：从目标节点沿第一条入边上溯找**最近**的闭环反馈卡（answer-custom 带
// socraticMeta）。它的判定/提示/讲解是闭环链下游生成（sq 下一题重生成、反馈卡下
// 挂空白节点等）最该看全的一段，给它来源卡同款 6000 字全文额度；更早的轮次维持
// 800 字摘要。非闭环链上溯不到反馈卡，返回 null——零字节变化。
function _nearestSocraticFeedbackUpstream(node) {
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.kind === 'answer' && !current.manual && current.socraticMeta) return current;
    const incoming = _workflowEdgeTable().filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
    current = incoming.length ? _findGraphNode(incoming[0].from) : null;
  }
  return null;
}

function _followupSourceNodeId(node) {
  if (!node) return '';
  const visited = new Set();
  const question = _nearestQuestionNodeUpstream(node, visited);
  if (!question) return '';
  const parentEdges = _workflowEdgeTable().filter(edge => String(edge.to) === question.id && !edge.draft && !edge.link);
  let source = parentEdges.length ? _findGraphNode(parentEdges[0].from) : null;
  // T332：来源卡与问题之间隔 junction/hub（透明节点）时沿第一条入边继续上溯，
  // 透明节点不占来源名额；复用 visited 防来源侧成环——落到已访问节点即视为无
  // 来源，穿透落点是 user 同样等于没有来源卡（根问题链语义）
  while (source && (source.kind === 'junction' || source.kind === 'hub')) {
    if (visited.has(source.id)) return '';
    visited.add(source.id);
    const hopEdges = _workflowEdgeTable().filter(edge => String(edge.to) === source.id && !edge.draft && !edge.link);
    source = hopEdges.length ? _findGraphNode(hopEdges[0].from) : null;
  }
  if (!source || source.kind === 'user') return '';
  return String(source.id || '');
}

// 素材篮（2026-10-22）：下游单条素材的 content 额度——800/6000 的通用档对
// 素材条目不适用，单条素材恒 2000（已定口径 6），截断时明示原文长度。
// 命名与 graph-custom 的 SOURCE_ITEM_MAX_CHARS（条目存储上限 8000）区分开
const SOURCE_FEED_MAX_CHARS = 2000;

// 上游条目映射（模块步与分析步共用，原 _buildWorkflowContextForNode 内联 logic
// 提来共用）。追问来源条目：full 标记＋6000 字额度＋summary 置空——后端 shared
// 段渲染是 summary 优先，不置空的话 A 的 <summary> 会抢先、全文仍旧进不去。
// T364：闭环反馈卡同款 full 额度（feedbackFullId＝最近一颗，调用方算好传入）；
// 闭环身份标签分设「我的作答/苏格拉底反馈」，作答卡正文剥机器前缀。
// 素材篮（2026-10-22）：source 条目 label 用端口名（素材名——同一个输入节点的
// 两口在下游上下文里必须可区分）；content 恒 2000 档，不被 full 6000 放大
function _workflowUpstreamEntry(item, sourceId, portMeta, typeLabels, feedbackFullId) {
  const isSource = !!sourceId && String(item.id || '') === sourceId;
  const isFeedbackFull = !!feedbackFullId && String(item.id || '') === String(feedbackFullId || '');
  const isFull = isSource || isFeedbackFull;
  const entry = {
    kind: item.kind,
    module: item.module,
    label: item.socraticAnswer
      ? '我的作答'
      : item.kind === 'user'
        ? '问题'
        : item.kind === 'note'
          ? (item.title || '我的总结')
          : item.kind === 'relation'
              ? '知识联系'
              : item.kind === 'source'
                ? (item.portLabel || '输入')
            : item.kind === 'answer'
              ? (item.manual ? (item.title || '我的回答') : (item.socraticFeedback ? '苏格拉底反馈' : '问题分析'))
              : item.kind === 'direct'
                ? '直接回答'
                : ((GRAPH_MODULE_META[item.module] || {}).label || item.module || '上游节点'),
    summary: isFull ? '' : _stripSocraticAnswerMarker(item.summary || ''),
    analysis: item.analysis || '',
  };
  if (item.kind === 'source') {
    const raw = _stripSocraticAnswerMarker(item.content || '');
    entry.content = raw.length > SOURCE_FEED_MAX_CHARS
      ? raw.slice(0, SOURCE_FEED_MAX_CHARS) + '（已截断，原文 ' + raw.length + ' 字）'
      : raw;
  } else {
    entry.content = isFull
      ? _foldHtmlFences(_stripSocraticAnswerMarker(item.content || '')).slice(0, WORKFLOW_FOLLOWUP_SOURCE_MAX_CHARS)
      : _stripSocraticAnswerMarker(item.content || '').slice(0, WORKFLOW_UPSTREAM_MAX_CHARS);
  }
  if (isFull) entry.full = true;
  if (portMeta) {
    entry.input_port = portMeta.label;
    if (portMeta.type) entry.input_type = (typeLabels || {})[portMeta.type] || portMeta.type;
  }
  return entry;
}

// T334 总纲·第二步形状统一（2026-10-15）：全仓唯一取材入口。总纲四句直读——
// 从目标节点向前寻找到最近的问题节点（_followupSourceNodeId，含 junction/hub
// 穿透）；问题前面那一颗实体祖先（来源卡，不看卡片类型）走 full 原文；其余
// 全部实体祖先（含分析节点——「之前的为摘要」）走 800 字摘要；问题之前没有
// 上游则没有来源卡、一览皆摘要（根链零 full 已核验）。T340：question 字段与
// 来源卡同锚最近问题节点——旧 find 在 timestamp 升序下命中的是最早的根问题，
// 深链追问后下游全被「原始问题：根问题」带跑。分析步/模块步/配方步/
// 内联四路消费同一形状：answer-filter 与 analysis 特殊字段退役（T331 豁免逻辑
// 随 filter 一并消解——分析节点本来就是普通祖先），shared 段行序改为
// question→upstream（cp context.py，test_prefix_stability 已重钉）。
// 显式例外保留：配方声明 first_inbound 时走单链取材（配方作者的显式选择，
// 总纲是默认行为）；问题节点多入边暂取边表第一条（真机出语义问题再拍板）。
// T364（2026-10-18）：闭环链两条补丁——问题节点判定跳过作答卡（question 不再
// 锚到 [苏格拉底回答] 原文）；最近一颗反馈卡给来源卡同款 full 额度。非闭环链
// 两条都不触发，字节零变。
function _collectWorkflowContext(node, portMetaFor, typeLabels) {
  // 收集路由 _workflowContextRoute 统一定义（取材附图共用同一判断，T381）：
  // 默认全祖先；配方显式声明 first_inbound 时走单父链
  let allUpstream = _workflowContextEntries(node);
  // answer 目标剔自身：自己的上游不含自己（旧口径由 answer-filter 顺手剔掉，
  // filter 退役后补成显式规则——分析节点按普通祖先摘要进 upstream（T333 统一
  // 解法），但目标自己不是自己的祖先；answer 目标 analysis 为空时
  // _nodeOutputContent 回退问题文本，不剔会问题文本进 shared 段两遍）。
  // 模块/配方目标的自身条目保留——重生成时模型要看自己的旧文（T263 行为）
  if (node && node.kind === 'answer' && !node.manual) {
    const ownId = String(node.id || '');
    allUpstream = allUpstream.filter(item => String(item.id || '') !== ownId);
  }
  // T327 规范化排序：在原始条目上做——label/summary/content 三键经 entry 映射
  // 后语义会变（来源条目 summary 置空、content 折叠截断），换序会动 T4 兄弟
  // 共享前缀字节；同一份上游集合任何时候拼出同串字节
  allUpstream.sort(_workflowUpstreamCompare);
  const sourceId = _followupSourceNodeId(node);
  // T364：最近反馈卡全文额度（feedbackFullId）。_nearestSocraticFeedbackUpstream
  // 与 _nearestQuestionNodeUpstream 同一条第一入边链，上溯结果必在 allUpstream 里；
  // 非闭环链返回 null，条目映射零变化
  const nearestFeedback = _nearestSocraticFeedbackUpstream(node);
  // T340：question 与来源卡同锚「最近问题节点」（总纲"向前寻找到最近的问题节点"
  // 的同一口径）。旧 allUpstream.find 在 timestamp 升序里命中的是最早的根问题——
  // 深链追问后，下游模块步/分析兜底的「原始问题」全是最初那问，真正的追问只剩
  // 上游清单里 800 字一条（用户实测"追问答非所问"）。单问题链最近＝最早，字节零变。
  const nearestQuestion = _nearestQuestionNodeUpstream(node);
  const questionNode = (nearestQuestion && allUpstream.find(item => String(item.id || '') === String(nearestQuestion.id || '')))
    || allUpstream.find(item => item.kind === 'user' && !item.socraticAnswer);
  return {
    sourceId: sourceId,
    question: questionNode ? questionNode.content : '',
    // 来源卡 full＋6000，其余（含分析节点）800 摘要；映射逻辑见 _workflowUpstreamEntry
    upstream: allUpstream.map(item => _workflowUpstreamEntry(
      item, sourceId,
      portMetaFor ? portMetaFor(item.toPort) : null,
      typeLabels || {},
      nearestFeedback ? String(nearestFeedback.id || '') : ''
    )),
  };
}

// T328：问题分析步的上下文。与模块步共用 _collectWorkflowContext 取材（分析请求
// 带全上游，修掉「分析请求只带裸问题」——画布工作流问答不写会话消息表，后端
// _recent_context_messages 的历史兜底对纯画布会话也是空的，上游缺席时模型只能
// 就着歧义记号猜领域）。配方双阶段概要步（P2，analysis_phase）同源复用，
// target 由调用方给。
function _buildAnalysisWorkflowContext(node, question, target) {
  // T263 喂料分路：目标配方声明了具名输入口时，上游条目标注「来自哪个输入口」；
  // 未声明（旧配方/旧快照）不设键，载荷形状与旧口径一致
  const declaredInputs = (node && node.recipeId && typeof _recipeInputPorts === 'function') ? _recipeInputPorts(node) : [];
  const typeLabels = typeof RECIPE_PORT_TYPE_LABELS !== 'undefined' ? RECIPE_PORT_TYPE_LABELS : {};
  const portMetaFor = (toPort) => {
    if (!declaredInputs.length || !toPort) return null;
    const m = /^in-(\d+)$/.exec(String(toPort));
    if (!m) return null;
    const named = declaredInputs[parseInt(m[1], 10)];
    if (named) return { label: named.label, type: named.type || '' };
    return { label: '其他输入', type: '' };
  };
  const collected = _collectWorkflowContext(node, portMetaFor, typeLabels);
  return {
    mode: 'analysis',
    target: target,
    // 调用方给了 question 就用调用方的（追问模板与配方概要步自带问题文本）；
    // 否则从上游链里找（统一取材函数已定位最近问题节点）
    question: (question !== undefined && question !== null && question !== '') ? question : collected.question,
    requirements: (node && node.requirements) || '',
    upstream: collected.upstream,
  };
}

function _buildWorkflowContextForNode(node) {
  const meta = node.recipeId && node.recipe && node.recipe.name
    ? { label: node.recipe.name }
    : node.kind === 'module'
    ? (GRAPH_MODULE_META[node.moduleKey] || { label: node.moduleKey || '模块节点' })
    : node.kind === 'answer'
      ? { label: node.manual ? (node.title || '我的回答') : '问题分析' }
      : node.kind === 'direct'
        ? { label: '直接回答' }
        : node.kind === 'hub'
        ? { label: '汇聚' }
        : node.kind === 'junction'
          ? { label: '中转' }
          : node.kind === 'summary'
          ? { label: 'AI 总结' }
      : node.kind === 'note'
          ? { label: node.title || '我的总结' }
          : node.kind === 'source'
            ? { label: '输入' }
            : node.kind === 'relation'
                ? { label: '知识联系' }
            : { label: '问题' };
  // T263 喂料分路：目标配方声明了具名输入口时，上游条目标注「来自哪个输入口」，
  // 结构化载荷与内联文本都按口分组；未声明（旧配方/旧快照）不设键，载荷形状与今日一致
  const declaredInputs = (node.recipeId && typeof _recipeInputPorts === 'function') ? _recipeInputPorts(node) : [];
  const typeLabels = typeof RECIPE_PORT_TYPE_LABELS !== 'undefined' ? RECIPE_PORT_TYPE_LABELS : {};
  const portMetaFor = (toPort) => {
    if (!declaredInputs.length || !toPort) return null;
    const m = /^in-(\d+)$/.exec(String(toPort));
    if (!m) return null;
    const named = declaredInputs[parseInt(m[1], 10)];
    if (named) return { label: named.label, type: named.type || '' };
    return { label: '其他输入', type: '' };
  };
  // T328：追问来源卡（A）全文条目 full＋6000、其余祖先 800——规则见
  // _workflowUpstreamEntry 注；分析节点（如有）随普通祖先摘要进 upstream
  const collected = _collectWorkflowContext(node, portMetaFor, typeLabels);
  return {
    target: { kind: node.kind, module: node.moduleKey || '', label: meta.label || node.moduleKey || '节点' },
    question: collected.question,
    // direct（2026-10-24）：后端据 mode='direct' 走「完整作答」指令块，不再套
    // 模块步的「只补上游缺失内容」口径；其余目标维持 module 字节不变
    mode: node.kind === 'direct' ? 'direct' : 'module',
    requirements: node.requirements || '',
    upstream: collected.upstream,
  };
}

// T263：内联上游文本（summary/relation 与配方 prompt_inline 共用）。条目带 input_port
// （目标配方声明了具名输入口）时按口分组加小标题；未声明保持旧拼法逐条平铺。
function _upstreamInlineText(upstream) {
  const items = (upstream || []).filter(item => item && item.content);
  if (!items.some(item => item.input_port)) {
    return items.map(item => item.label + '：\n' + item.content).join('\n\n').slice(0, 8000);
  }
  const order = [];
  const byPort = new Map();
  items.forEach(item => {
    const key = item.input_port || '';
    if (!byPort.has(key)) { byPort.set(key, []); order.push(key); }
    byPort.get(key).push(item);
  });
  return order.map(key => {
    const body = byPort.get(key)
      .map(item => item.label + (item.input_type ? '（' + item.input_type + '）' : '') + '：\n' + item.content)
      .join('\n\n');
    return key ? '【输入「' + key + '」】\n' + body : body;
  }).join('\n\n').slice(0, 8000);
}

function _nodeInputHash(node) {
  const incoming = _workflowEdgeTable().filter(edge => String(edge.to) === node.id && !edge.draft && !edge.link);
  // T263：仅当目标配方声明具名输入口时才把接线口计入哈希——旧图哈希逐字节不变，
  // 不会触发存量节点全量重生成；新配方换口接线能正确触发重生成
  const usePorts = !!(node.recipeId && typeof _recipeInputPorts === 'function' && _recipeInputPorts(node).length);
  const parts = incoming
    // 素材篮（2026-10-22）：_nodeOutputContent 补 fromPort——source 按口取材后，
    // 同节点换口接线要触发重生成；哈希串前缀本就含 fromPort=
    .map(edge => (edge.fromPort || 'out-0') + '=' + _nodeOutputContent(_findGraphNode(edge.from), undefined, edge.fromPort) + (usePorts ? '@' + (edge.toPort || 'in-0') : ''))
    .sort();
  return _simpleHash((node.moduleKey || '') + '|' + (node.recipeId || '') + '|' + (node.requirements || '') + '|' + parts.join('|'));
}

// 配方节点的生成提示词（P1）：按底座路由。四槽来自节点内嵌快照（node.recipe），
// 与官方分支同构：module 走结构化 workflow_context（或声明 prompt_inline 时上游全文内联），
// summary/relation 上游全文内联；人工底座不会走到这里。
function _recipeWorkflowPrompt(node, recipe, workflowContext, targetLabel) {
  const g = (recipe.generate || {});
  const baseKind = (recipe.base && recipe.base.kind) || 'module';
  const name = recipe.name || targetLabel || '配方';
  let inline = '';
  if (baseKind === 'summary' || baseKind === 'relation' || (baseKind === 'module' && g.context_channel === 'prompt_inline')) {
    inline = _upstreamInlineText(workflowContext.upstream);
  }
  const parts = [];
  parts.push('请生成「' + name + '」节点内容。');
  if (baseKind === 'module' || baseKind === 'summary') {
    parts.push('只输出该节点正文，不要输出完整学习卡片的 XML 标签，不要重复其他模块内容。');
  }
  if (g.prompt) parts.push(g.prompt);
  // T334 第二步：双阶段配方概要步产物（phase1 输出存节点自身 analysis 字段，
  // 不在上游链里）——analysis 特殊键退役后改由 prompt 段承载，prompt_inline
  // 与结构化两条通道都覆盖（graph-workflow.js 原注入点已删）
  if (node.analysis) parts.push('问题分析（概要）：\n' + node.analysis);
  if (g.strict_output) parts.push(g.strict_output);
  if (inline) {
    parts.push('如出现公式仍按 <formula> 规范标注。\n\n' + (inline || '（暂无已连接的上游内容）'));
  }
  return parts.join('\n\n');
}

function _workflowPromptForNode(node, workflowContext) {
  const targetLabel = workflowContext.target.label || '节点';
  if (node.recipeId && node.recipe) {
    return _recipeWorkflowPrompt(node, node.recipe, workflowContext, targetLabel);
  }
  if (node.kind === 'hub') {
    return '这是汇聚节点，由上游连线收集内容，不需要 AI 生成。';
  }
  if (node.kind === 'summary') {
    const upstreamText = (workflowContext.upstream || [])
      .map(item => (item.content ? item.label + '：\n' + item.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8000);
    return '请根据以下已连接内容生成一份简明、结构化的 AI 总结。'
      + '要求：只提炼有依据的物理直觉、数学本质、关键结论、公式和后续建议；不要逐段复述上游，也不要为了完整而编造缺失信息；只输出总结正文；不要输出完整学习卡片 XML，不要输出 <summary> 标签，不要输出其他模块正文；如出现公式仍按 <formula> 规范标注。\n\n'
      + (upstreamText || '（暂无已连接的上游内容）');
  }
  if (node.kind === 'relation') {
    const upstreamText = (workflowContext.upstream || [])
      .map(item => (item.content ? item.label + '：\n' + item.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8000);
    return '请基于以下已连接节点，用一句简短中文说明它们之间的联系。'
      + '要求：只陈述上游内容能够支持的关系，内容简短，最好不超过100字；如果证据不足，直接说明关系尚不明确；不要输出XML标签，不要重复完整节点内容；如出现公式仍按 <formula> 规范标注。\n\n'
      + (upstreamText || '（暂无已连接的上游内容）');
  }
  if (node.kind === 'direct') {
    // 直接回答（2026-10-24）：与问题分析相反——要成品答案，不要概要、不拆模块。
    // 与 _buildWorkflowContextForNode 的 mode='direct' 配套（后端补同口径指令块）
    const req = String(node.requirements || '').trim();
    return '请直接回答原始问题，输出一份完整、可直接阅读的答案正文（不是问题概要，也不要拆成多个模块）。\n'
      + '要求：\n'
      + '1. 先给结论与核心思路，再按需要展开推导、公式与例子，推导要能自洽走通。\n'
      + '2. 同时讲清物理直觉（现实中发生了什么、为什么）与数学本质（对象、关系、成立条件）。\n'
      + '3. 用 Markdown 小标题组织答案；公式按 <formula>纯 LaTeX</formula> 规范标注。\n'
      + '4. 上游内容（问题分析、我的回答、素材等）是依据与上下文：可引用、可展开，但不要与之矛盾；发现上游有误时明确指出并给出正确版本。\n'
      + '5. 不要输出完整学习卡片 XML，不要输出 <physics>、<math>、<graph>、<viz>、<extend>、<summary> 或 <socratic_meta> 标签，不要输出「建议模块：」行。\n'
      + '6. 信息不足时写明假设与适用条件，不要编造数据、历史或结论。'
      + (req ? '\n\n用户额外要求（优先满足）：' + req : '');
  }
  if (node.kind === 'answer' && !node.manual) {
    return '请根据原始问题和上游上下文生成“问题分析”节点的完整内容。'
      + '这是工作流的分析分发节点：输出可供下游物理视角、数学视角、知识图谱、交互可视化、苏格拉底追问和进阶学习节点共同使用的结构化学习底稿。'
      + '除非工作流另有明确要求，不要输出完整学习卡片 XML，不要输出 <physics>、<math>、<graph>、<viz>、<extend>、<summary> 或 <socratic_meta> 标签。'
      + '请覆盖：问题核心、关键概念、必要假设/适用条件、物理与数学的主要方向、适合的可视化线索，以及下游应避免重复的内容。使用清晰的 Markdown 小标题。';
  }
  if (node.kind === 'module') {
    const strictInstruction = _strictModuleOutputInstruction(node.moduleKey || workflowContext.target.module || '');
    return '请基于工作流上下文中的隐藏问题分析保持一致性，但不要重复分析内容。'
      + '请生成「' + targetLabel + '」节点内容。'
      + '只输出该模块正文，不要输出完整学习卡片的 XML 标签，不要重复其他模块内容。'
      + (strictInstruction ? '\n\n' + strictInstruction : '');
  }
  if (node.manual) {
    return '这是“我的回答”节点，由用户手动填写即可，不需要 AI 生成。';
  }
  return '请生成问题节点内容。';
}

function _strictModuleOutputInstruction(moduleKey) {
  if (moduleKey === 'socratic') {
    return '严格按以下格式输出，不得增加前言、答案、解释或任何其他模块：\n'
      + '### 苏格拉底追问\n'
      + '1. [基础] 只写一个基础引导问题\n'
      + '2. [进阶] 只写一个进阶引导问题\n'
      + '3. [拓展] 只写一个拓展引导问题\n'
      + '不要使用 XML 标签，不要输出“进阶学习方向”，不要展开问题背景，不要写“想一想”等引导语。';
  }
  if (moduleKey === 'learn') {
    return '严格按以下格式输出，不得增加前言、公式段、步骤讲解或任何其他模块：\n'
      + '### 进阶学习方向\n'
      + '1. 方向1\n'
      + '2. 方向2\n'
      + '3. 方向3\n'
      + '不要使用 XML 标签，不要输出“苏格拉底追问”，每条方向只保留一个短句，不要展开学习步骤。';
  }
  if (moduleKey === 'physics') {
    return '物理视角必须从“现实中的系统如何发生”出发，而不是把数学视角换一种说法：\n'
      + '1. 先明确研究对象、系统边界、环境、可观测量和时间尺度；说明在现实中什么在变化、什么在相互作用。\n'
      + '2. 写出至少一条具体因果链：机制/相互作用 → 可观测变化 → 可检验预测；优先使用受力、能量、动量、场、约束、耗散、守恒等物理语言，但只使用与主题真正相关的概念。\n'
      + '3. 明确模型假设和适用条件（例如理想化、近似、初始条件、边界条件），并说明改变关键条件后现象会怎样变化。\n'
      + '4. 至少给出一个可操作的实验、测量或数量级判断，并用极限情形/反事实检查直觉；不要只写泛泛类比。\n'
      + '5. 若需要公式，只写能表达物理机制或可测关系的少量公式，并逐项解释其物理意义；不要展开数学推导，也不要把定义、定理、函数性质当作物理解释。\n'
      + '正文至少覆盖：物理对象与现象、机制与因果链、假设与边界、预测/实验检查。不要重复数学视角的形式推导。';
  }
  if (moduleKey === 'math') {
    return '数学视角必须解释结构和推理，而不是复述物理故事：明确数学对象、定义、变量关系、推导步骤、不变性/对称性，以及结论成立的条件；用 LaTeX 展示必要公式并逐项解释符号。不要把实验、受力、能量或生活类比当作主体，也不要重复物理视角的因果叙述。';
  }
  if (moduleKey === 'graph') {
    return '严格输出知识图谱 Mermaid 代码，不要输出其他模块、不要输出 XML 标签：\n'
      + '用 ```mermaid ... ``` 代码块包裹；优先保留真实且有教学价值的关系，通常提供 2~4 个上游和 2~4 个下游概念；如果真实关系不足，不要为了凑数编造节点。\n'
      + '箭头尽量用关系标签说明前置概念、推广、特例或应用；中文标注，节点文字避免括号（可用下划线替代）。';
  }
  if (moduleKey === 'viz') {
    return '严格输出 ```html ... ``` 完整 HTML 交互可视化页面，禁止只输出文字描述而不输出 HTML：\n'
      + '页面内顶部必须包含图说四段（用页面内可见标题/提示框呈现，缺一不可）：\n'
      + '**这张图在讲什么**：2~4 句大白话说明图的核心结论；\n'
      + '**怎么看这张图**：1. 2. 3. 编号观察步骤，每步“操作 → 会看到什么”；\n'
      + '**和公式的联系**：图中现象与公式如何互相印证；\n'
      + '**自测**：1 个不实际操作就答不出的问题（只提问不给答案）。\n'
      + '每个滑块/按钮旁标注对应物理量/数学量及在公式中的位置，关键结论数值旁给出对应公式。\n'
      + '优先使用简单、可暂停、可调速的交互；只有确实有助于理解时才使用动画或 3D。页面必须自包含，不引入 CDN 或外部资源。\n'
      + '不要输出 XML 标签，不要输出其他模块内容。';
  }
  return '';
}

// ====== SSE 帧读取：本文件三个流式通道共用的一份 ======
// 三个流式函数（模块节点 / 问题分析 / 空白节点）原本各抄一份：getReader →
// TextDecoder → 拆 \n\n → 逐行取 data: → 跳 [DONE] → JSON.parse → 错误帧抛错 →
// 吐 delta.content。同样的逻辑改一次要改三处，漏一处就只在那一条通道上出问题，
// 而症状是「某类节点偶发不更新」——极难查。这里抽成唯一的读取口，三处共用。
//
// **别把「唯一」读成「全仓唯一」**：全仓另有 4 处各自一份 getReader() 副本
