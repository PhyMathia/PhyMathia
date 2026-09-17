// ===== 知识大陆（大陆计划 v1 投影 + v2 簇间边 + v3 边界城市 + v4 证据卫生 + v5 城市与群岛）=====
// 主图是投影层：聚簇与共享概念全部来自 GET /api/continent（服务端从 knowledge +
// sessions 现算），本文件绝不写任何 phymathia_graph_ 会话键——子图（各会话探索
// 网）是唯一事实源，主图随时可重算。
// v2 起主图拥有**自己的**簇间边（KV `continent_edges`，经 /api/kv 读写）：
// 「连接」模式点两个不同区域的概念完成落笔；端点失效的边渲染成断桥，工具条提供
// 清理入口；撤销栈只记边操作（新增/删除/清理/改备注），视口平移缩放不入栈。
// v3 给共享概念的端点卡挂 ◈ 徽标；v4 做证据卫生（弱证据不上图，只进折叠清单）。
// v5.1 共享概念从「弧线 + 浮空标签」升级为**边界城市**：城市摆在它所连的岛之间的
// 走廊里（摆不下进折叠清单，不许叠在岛上），每座岛伸一根辐条连到代表卡；点城市弹
// **重逢清单**（每座岛一行 + 「去看」），绝不替用户猜该跳哪座岛。
// v5.2 群岛布局：岛的摆放从「最近更新排网格」改为**亲缘排序**（强共享概念 + 用户
// 航线）+ 蛇形填充——讲同一主题的岛自然挨成一片，位置本身就是联系，一根线不画。
// v5.3 折叠清单「问 Φ」：机器没把握的折叠行可让 Φ 出一句人话判断；判断块里带
// 「画成大陆边」芯片，落笔权永远在用户（走 /api/models/chat 的 stream:false 通道）。
// v5.4 岛牌一句话 + 空态引导：岛头副行「前 3 个概念名 + 最近更新」（纯拼接）；
// 没有共享连线时顶栏明示点亮机制——空态是引导，不是缺陷。
// v5.5 汇聚口径修正：① 弱证据（2 字共享串）参与**摆位**但不参与断言——梯度/散度这类
// 真关系以前既不画线也不影响摆位，地图看起来「一片孤岛」；② 证据被更具体标签完全覆盖
// 的标签（截断名，如「量守恒定律」）不再单独成城，折进清单（原因「已被更具体的城市
// 覆盖」）——地图上不再出现两座几乎重合、名字还读不懂的城。
// 交互三层口径（游戏地图模型：层级离散、整层切换，不是连续语义缩放）：
// - 下钻：点簇 / 概念节点 → 镜头向点击处推进（转场动画）→ switchToSession，
//   概念节点再经 goToKnowledgeNode 直达定位（等于点 POI 而非进城门口）；
// - 返回：探索网面包屑「‹ 大陆」→ 恢复离开时的平移缩放视口（回来还在原地）；
// - 视图自身克制编辑：只有簇间边一种写路径，Esc / 关闭按钮收起。

const CONTINENT_VIEW_KEY = 'phymathia_continent_view'; // 视口记忆（非会话键）
const CONTINENT_EDGES_API = '/api/kv/continent_edges'; // 主图簇间边的读写端点（现成 KV 通道）
const CONTINENT_REGIONS_API = '/api/kv/continent_regions'; // v7.1a 海域覆盖（改名/挪岛）的读写端点
const CONTINENT_LINE_LIMIT = 24;      // 与服务端 SHARED_CONCEPT_LIMIT 同口径的二次保险
// v5.1 边界城市：同一对区域之间最多几座城（沿用 v4「每对上限」的精神）+ 全图总量上限。
// 城市尺寸按「摆得进两岛之间的走廊」定：CONTINENT_CLUSTER_GAP = 150，城市 112 宽
// 居中放进去两侧各余 19px，够本；再宽就必然压到岛上。
const CONTINENT_PAIR_CITY_LIMIT = 3;
const CONTINENT_CITY_LIMIT = 12;
const CONTINENT_CITY_W = 112;
const CONTINENT_CITY_H = 32;
const CONTINENT_CITY_GAP = 8;         // 城市与岛、城市与城市的最小间隙
const CONTINENT_USER_EDGE_LIMIT = 120; // 与服务端 USER_EDGE_LIMIT 同口径
const CONTINENT_NODE_W = 160;
const CONTINENT_NODE_H = 46;
const CONTINENT_COLS = 3;             // 簇内概念排几列
const CONTINENT_GAP = 10;
const CONTINENT_PAD = 18;
const CONTINENT_HEADER_H = 36;
// 岛块宽度下限：岛牌头部一行固定件（▾16 + 计数 ~45 + 徽标 ~60 + 间隙）在小岛上会
// 把岛名挤到只剩十几像素，被 head 的 overflow:hidden 拦腰裁成残字（真机截图：
// 「梯度」「散度」只见半个字）。1 卡岛按卡网格只有 196px，装不下这一行
const CONTINENT_ISLAND_MIN_W = 240;
const CONTINENT_CLUSTER_GAP = 150;
const CONTINENT_WORLD_MARGIN = 60;
const CONTINENT_ZOOM_MIN = 0.15;    // v7.3：0.3 → 0.15（有 LOD 兜底才敢放）
const CONTINENT_ZOOM_MAX = 2.5;
const CONTINENT_DIVE_MS = 430;
const CONTINENT_DIVE_FACTOR = 2.6;
const CONTINENT_SURFACE_FACTOR = 1.14;
// v7.1a 海域层：两级布局的块间距与海域板尺寸（板 = 块内岛矩形并集外扩，
// 顶部另留一行给海域牌）；色盘 12 格，同领域永远同色。
const CONTINENT_REGION_GAP = 230;
const CONTINENT_REGION_PAD = 26;
const CONTINENT_REGION_HEADER_H = 34;
const CONTINENT_HUE_COUNT = 12;
// 置信度三档（后端如实报概率，档位是前端消费口径）：实色 / 淡色+「?」 / 中性+待确认。
// 与服务端 GATE_CONF_SOLID / GATE_CONF_LIGHT 同数值（前端只拿 domainConf 判档）。
const CONTINENT_CONF_SOLID = 0.7;
const CONTINENT_CONF_LIGHT = 0.4;
// 每片海域的岛数容量（MoE 的 expert capacity）：超限提示拆分，不静默丢
const CONTINENT_REGION_CAPACITY = 12;
// v7.3 渐进披露：三档细节只切一个 CSS 类（挂在 #continentWorld 上，零重建 DOM）——
// 世界档只画海域板+岛牌+城市+航线，区域档加卡片标题，细节档加公式行与锚点短接。
// 有 LOD 才敢把缩放下限放到 0.15（修「≥43 岛一屏装不下」：旧下限 0.3 会卡死适配）
const CONTINENT_LOD_WORLD = 0.55;
const CONTINENT_LOD_DETAIL = 1.1;
// 岛内近似卡片折叠（显示层）：岛默认画前 N 张 +「另有 k 张」——只折叠不删数据
const CONTINENT_ISLAND_CARD_MAX = 9;

let _continentOpen = false;
let _continentDrilling = false;
let _continentPan = { x: 0, y: 0 };
let _continentZoom = 1;
let _continentPlacements = {};  // itemId → {x,y,w,h,cx,cy}（世界坐标，布局解析算出）
let _continentClusterRects = [];
let _continentKeyHandler = null;
let _continentDragState = null;
let _continentSkipViewPersist = false;
let _continentData = null;         // 最近一次投影数据（边操作后就地刷新）
let _continentLinkMode = false;    // v2 连接模式
let _continentLinkSource = null;   // {itemId, sessionId}
let _continentEdgeUndo = [];       // 撤销栈：只记边操作，视口变化不入栈
let _continentPopover = null;      // 单例弹层（共享概念详情 / 我的边操作）
let _continentFolded = [];         // v4 折叠清单：[{entry, reason}]（weak=弱证据 / covered=已被更具体的城市覆盖 / capped=超出每对上限 / map_capped=超出全图上限 / no_room=无位可放）
let _continentGuideText = '';      // v5.4 顶栏空态引导文案（空串=不该显示）
const _continentPhiInflight = new Set(); // v5.3 在途「问 Φ」请求：弹层关闭时全部中止
// v7.1a 海域层状态
let _continentRegionOverrides = { renames: {}, assign: {} }; // KV continent_regions（用户覆盖）
let _continentLegendFocus = '';    // 图例聚焦的海域 key（空=不聚焦；只淡化不删不重排）
let _continentRegionInfo = null;   // 最近一次 _continentRegions 的产物（聚焦/徽标消费）
// v7.3 折叠态（岛/海域，localStorage 非会话键）：收起的岛只留岛牌，收起的海域整片
// 收成一枚印章——多枚印章叠着看全局；展开回来布局不变（布局对折叠集是确定性的）
const CONTINENT_COLLAPSED_KEY = 'phymathia_continent_collapsed';
let _continentCollapsed = { islands: [], regions: [] };

function _continentLoadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTINENT_COLLAPSED_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      _continentCollapsed = {
        sessions: Array.isArray(raw.sessions) ? raw.sessions.slice(0, 200).map(String) : [],
        regions: Array.isArray(raw.regions) ? raw.regions.slice(0, 40).map(String) : [],
      };
      return;
    }
  } catch (e) { /* 容忍 */ }
  _continentCollapsed = { sessions: [], regions: [] };
}

function _continentSaveCollapsed() {
  try { localStorage.setItem(CONTINENT_COLLAPSED_KEY, JSON.stringify(_continentCollapsed)); }
  catch (e) { /* 容忍 */ }
}

function _continentToggleCollapse(kind, key) {
  const list = kind === 'region' ? _continentCollapsed.regions : _continentCollapsed.sessions;
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1); else list.push(key);
  _continentSaveCollapsed();
  if (_continentOpen && _continentData) _continentRender(_continentData);  // 重排（确定性，展开回来布局不变）
}

function _continentEsc(text) {
  if (typeof escapeHtml === 'function') return escapeHtml(text);
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// v6：汇聚条目的三种来源各有一个前缀，一眼分得清「机器算出来的」与「领域知识认的」
// ◈ = 标题里共享了一段字；∑ = 公式共享了同一个符号/词；❖ = 概念族（内置族表 /
// 用户或 Φ 确认过的汇聚结果）。族最可信也最"粗"——城市名是族的规范名（如「矢量分析」），
// 它连的几座岛各自可能只共享 2 字领域词（梯度/散度/旋度），字面尺子认不出这层关系。
function _continentKindPrefix(kind) {
  if (kind === 'formula') return '∑ ';
  if (kind === 'family') return '❖ ';
  return '◈ ';
}

function _continentKindClass(kind) {
  if (kind === 'formula') return ' is-formula';
  if (kind === 'family') return ' is-family';
  return '';
}

function _continentToast(msg) {
  if (typeof showToast === 'function') showToast(msg);
}

// 节点公式：渲成一行小字 KaTeX（不占地图视觉重量）；溢出交给容器裁剪，
// 库缺失/渲染失败回退纯文本。TeX 先过 _cleanFormulaLatex（剥 $ 定界符等，
// 与主渲染链路同一把尺子）。
function _continentRenderFormula(el, latex) {
  let tex = String(latex || '');
  if (typeof _cleanFormulaLatex === 'function') tex = _cleanFormulaLatex(tex);
  else tex = tex.replace(/^\$+|\$+$/g, '').trim();
  if (!tex) { if (el.textContent !== undefined) el.textContent = ''; return; }
  if (typeof katex !== 'undefined' && katex && typeof katex.render === 'function') {
    try {
      katex.render(tex, el, { throwOnError: false, displayMode: false });
      return;
    } catch (e) { /* 回退纯文本 */ }
  }
  if (el.textContent !== undefined) el.textContent = tex;
}

// ---------- v5.2 群岛布局：亲缘排序（位置本身就是联系，纯函数无 DOM） ----------
// 亲缘三个来源：① 强共享概念（≥3 字实词或公式共享）每个跨会话对记 1 分；② 弱共享
// 概念（「振动」「梯度」这类 2 字证据）每个跨会话对记 0.3 分、每对累计封顶 0.9——v5.5
// 起弱证据参与摆位：摆位**不宣称任何概念同一性**（不画线、不建城），是风险最低的表达，
// 正该承接最弱的证据；封顶保证任意多条弱证据都压不过一条强证据。③ 用户亲手画的大陆边
// 记 2 分（人的认定是最强证据）。主题层面的亲近用布局表达，一根线都不用画。
const CONTINENT_KIN_STRONG = 1;
const CONTINENT_KIN_WEAK = 0.3;
const CONTINENT_KIN_WEAK_CAP = 0.9;
const CONTINENT_KIN_EDGE = 2;

function _continentKinshipKey(a, b) {
  return String(a) < String(b) ? a + '|' + b : b + '|' + a;
}

// 亲缘矩阵：只统计画布上真实存在的会话对；返回 { 'a|b': 权重 }。
function _continentKinship(sessionIds, shared, userEdges) {
  const kin = {}, weak = {};
  const known = new Set(sessionIds || []);
  const add = (a, b, w) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = _continentKinshipKey(a, b);
    kin[key] = (kin[key] || 0) + w;
  };
  const addWeak = (a, b) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = _continentKinshipKey(a, b);
    weak[key] = Math.min(CONTINENT_KIN_WEAK_CAP, (weak[key] || 0) + CONTINENT_KIN_WEAK);
  };
  (shared || []).forEach(s => {
    if (!s) return;
    const sids = (s.sessions || []).filter(sid => known.has(sid));
    const strong = s.strength === 'strong';
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        if (strong) add(sids[i], sids[j], CONTINENT_KIN_STRONG);
        else addWeak(sids[i], sids[j]);
      }
    }
  });
  // 弱证据封顶后合入（封顶按「对」算，与强证据/用户边的量纲分开）
  Object.keys(weak).forEach(key => { kin[key] = (kin[key] || 0) + weak[key]; });
  (userEdges || []).forEach(e => add(e.fromSession, e.toSession, CONTINENT_KIN_EDGE));
  return kin;
}

// 贪心链式排序：从亲缘总数最多的岛出发，每步走向与当前岛亲缘最高的下一座
// （并列看全局亲缘总数，再并列保持原序＝服务端最近更新序）。链 A→B→C→D 折进
// 网格时配合蛇形填充，行末与下一行行首上下相邻——亲缘链不会在对角线上断开。
// 无亲缘时每步并列都走原序：输出与输入同序，行为与 v5.1 完全一致（不引入回归）。
function _continentClusterOrder(clusters, shared, userEdges) {
  const list = (clusters || []).slice();
  if (list.length < 3) return list;  // 0–2 座岛怎么排都相邻，不必排
  const sids = list.map(c => String(c.sessionId || ''));
  const kin = _continentKinship(sids, shared, userEdges);
  const total = {};
  Object.keys(kin).forEach(key => {
    const pair = key.split('|');
    total[pair[0]] = (total[pair[0]] || 0) + kin[key];
    total[pair[1]] = (total[pair[1]] || 0) + kin[key];
  });
  const kinOf = (a, b) => kin[_continentKinshipKey(a, b)] || 0;
  const remaining = list.slice();
  let startIdx = 0;
  for (let i = 1; i < remaining.length; i++) {
    if ((total[sids[i]] || 0) > (total[sids[startIdx]] || 0)) startIdx = i;
  }
  const ordered = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length) {
    const cur = ordered[ordered.length - 1];
    let bestIdx = 0, bestKin = -1, bestTotal = -1;
    remaining.forEach((c, i) => {
      const k = kinOf(cur.sessionId, c.sessionId);
      const t = total[c.sessionId] || 0;
      if (k > bestKin || (k === bestKin && t > bestTotal)) {
        bestIdx = i; bestKin = k; bestTotal = t;
      }
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

// ---------- v7.1a 海域层：把已有的领域归属画出来（纯函数，无 DOM） ----------
// 后端早就算得出每座岛属于哪个领域（v6 族表 + v7 softmax 评分核心），v7 之前这份归属
// 只用于「跨 ≥2 岛建一座城」——分类结果画不出来，用户看到的就只是 6 个同色等权方块。
// 这一层只做三件事：按领域分组（≥2 座岛才画板）、配色（同领域永远同色）、可纠正（KV）。

// 领域名 → 稳定色相。铁律②的视觉面：专家名单固定 → 色槽确定——内置名单先分配
// （表序固定，槽位永不动），自定义领域按 domainList 里的稳定顺序排在后面，新增
// 自定义只会影响排在其后的自定义项。>12 个活跃领域由 _continentRegions 并「其他」，
// 所以色槽永远够用。
function _continentStrHash(s) {
  let h = 5381;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function _continentRegionHue(name, universe) {
  const names = (universe && universe.length ? universe.slice() : [name]);
  if (names.indexOf(name) < 0) names.push(name);
  const taken = new Array(CONTINENT_HUE_COUNT).fill(false);
  for (let i = 0; i < names.length; i++) {
    let slot = _continentStrHash(names[i]) % CONTINENT_HUE_COUNT;
    let probe = 0;
    while (probe < CONTINENT_HUE_COUNT && taken[slot]) {
      slot = (slot + 1) % CONTINENT_HUE_COUNT;
      probe++;
    }
    if (names[i] === name) return Math.round(slot * (360 / CONTINENT_HUE_COUNT)) % 360;
    taken[slot] = true;
  }
  return 0;
}

// 归属解析：后端概率 + 用户覆盖（KV continent_regions，优先级①）→ 每座岛的
// {key, tier, source}。tier 三档：solid（p≥0.7）/ light（0.4–0.7，「?」徽标）/
// pending（<0.4，中性灰不上地盘，进「待确认」）——「不确定也要可见」。
// 用户指派永远 solid（人说了算，conf=1）。查空是正常路径：没证据 → neutral。
function _continentRegions(clusters, overrides, domainList) {
  const assign = (overrides && overrides.assign) || {};
  const renames = (overrides && overrides.renames) || {};
  const bySid = {};
  const groups = {};
  const pending = [];
  const neutral = [];
  (clusters || []).forEach(c => {
    const sid = String(c.sessionId || '');
    if (Object.prototype.hasOwnProperty.call(assign, sid)) {
      const key = assign[sid] || null;
      if (!key) { bySid[sid] = { key: null, tier: 'neutral', source: 'user' }; neutral.push(sid); return; }
      bySid[sid] = { key: key, tier: 'solid', conf: 1, source: 'user' };
      (groups[key] = groups[key] || []).push(sid);
      return;
    }
    const key = c.domain || null;
    const conf = Number(c.domainConf) || 0;
    if (!key) { bySid[sid] = { key: null, tier: 'neutral', source: '' }; neutral.push(sid); return; }
    if (conf < CONTINENT_CONF_LIGHT) {
      bySid[sid] = { key: key, tier: 'pending', conf: conf, source: c.domainSource || '' };
      pending.push({ sid: sid, domain: key, conf: conf, title: c.title || '' });
      return;
    }
    bySid[sid] = { key: key, tier: conf >= CONTINENT_CONF_SOLID ? 'solid' : 'light',
                   conf: conf, source: c.domainSource || '' };
    (groups[key] = groups[key] || []).push(sid);
  });
  // ≥2 座岛同领域才画海域板（单岛自成一国＝没有分组）；>12 片按岛数升序并「其他」
  let regions = [];
  const singles = [];
  Object.keys(groups).forEach(key => {
    if (groups[key].length >= 2) regions.push({ key: key });
    else singles.push.apply(singles, groups[key]);
  });
  regions.forEach(r => { r.sessions = groups[r.key].slice(); });
  if (regions.length > CONTINENT_HUE_COUNT) {
    const sorted = regions.slice().sort((a, b) => a.sessions.length - b.sessions.length);
    const tail = sorted.slice(0, regions.length - CONTINENT_HUE_COUNT + 1);
    const tailKeys = new Set(tail.map(r => r.key));
    const merged = [];
    tail.forEach(r => merged.push.apply(merged, r.sessions));
    regions = regions.filter(r => !tailKeys.has(r.key));
    if (merged.length >= 2) regions.push({ key: '其他', sessions: merged, merged: true });
    else singles.push.apply(singles, merged);
  }
  const itemCountOf = sid => {
    const c = (clusters || []).find(x => String(x.sessionId) === sid);
    return (c && c.itemCount) || 0;
  };
  regions.forEach(r => {
    r.name = r.merged ? '其他' : (renames[r.key] || r.key);
    r.hue = r.merged ? null : _continentRegionHue(r.key, domainList);
    r.itemCount = r.sessions.reduce((acc, sid) => acc + itemCountOf(sid), 0);
    const srcs = r.sessions.map(sid => bySid[sid].source);
    r.source = srcs.indexOf('user') >= 0 ? 'user'
      : srcs.indexOf('gate') >= 0 ? 'gate' : 'family';
    r.userNamed = !r.merged && Object.prototype.hasOwnProperty.call(renames, r.key);
  });
  return { regions: regions, singles: singles, neutral: neutral, pending: pending, bySid: bySid };
}

// ---------- 纯布局：簇网格摆放，簇内概念流式网格；坐标全部解析算出，无需 DOM 实测 ----------
// v7.1a 起拆两层：_continentLayoutGrid 管一块内怎么摆（蛇形网格，块=海域或散岛群），
// _continentRegionLayout 管块与块怎么摆（跨海域亲缘排序）。无海域时走旧单网格路径
// （行为与 v6 完全一致，不引入回归）。
// 测量一座岛的占地：v7.3 起吃两个折叠口径——collapsed（整岛收起只留岛牌）与
// cardCap（岛内只画前 N 张 +「另有 k 张」，显示层折叠、不删数据）
function _continentMeasure(c, collapsed, cardCap) {
  if (collapsed) {
    return {
      cluster: c, cols: 0, rows: 0, collapsed: true, shown: 0,
      w: CONTINENT_PAD * 2 + 300,
      h: 14 + CONTINENT_HEADER_H + 10,
    };
  }
  const all = (c.items || []);
  const shown = cardCap ? Math.min(all.length, cardCap) : all.length;
  const n = Math.max(1, shown);
  const cols = Math.min(CONTINENT_COLS, n);
  const rows = Math.ceil(n / cols);
  return {
    cluster: c, cols: cols, rows: rows, collapsed: false, shown: shown,
    w: Math.max(
      CONTINENT_PAD * 2 + cols * CONTINENT_NODE_W + (cols - 1) * CONTINENT_GAP,
      CONTINENT_ISLAND_MIN_W),
    h: CONTINENT_PAD * 2 + CONTINENT_HEADER_H + rows * CONTINENT_NODE_H + (rows - 1) * CONTINENT_GAP,
  };
}

// 一块内的岛摆进蛇形网格（列宽/行高统计与落位共用同一个 gridPos 映射——两处各写
// 一份会出现「岛摆进没按它撑宽的列」）。origin 是这块在世界里的左上角；items 按
// 测量时的折叠口径裁剪（岛内只画前 cardCap 张——显示层折叠，锚点卡是最早学的、必在前 N 张内）
function _continentLayoutGrid(measured, originX, originY) {
  const placements = {};
  const clusterRects = [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(measured.length)));
  const gridPos = i => {
    const ri = Math.floor(i / cols), posInRow = i % cols;
    return { ci: ri % 2 === 1 ? cols - 1 - posInRow : posInRow, ri: ri };
  };
  const colW = [], rowH = [];
  measured.forEach((m, i) => {
    const g = gridPos(i);
    colW[g.ci] = Math.max(colW[g.ci] || 0, m.w);
    rowH[g.ri] = Math.max(rowH[g.ri] || 0, m.h);
  });
  // 两个累加器必须分开：以前列、行共用同一个 acc，worldW 实际拿到的是**行**的累加值
  // （worldW === worldH），多列布局下世界宽度被算小 → 适配画布按假宽度算，地图一开
  // 就被裁掉右半边（真机截图才发现：岛排到 x=1628，世界却声明 674 宽）
  const colX = [], rowY = [];
  let accX = 0;
  for (let i = 0; i < colW.length; i++) { colX.push(accX); accX += colW[i] + CONTINENT_CLUSTER_GAP; }
  let accY = 0;
  for (let i = 0; i < rowH.length; i++) { rowY.push(accY); accY += rowH[i] + CONTINENT_CLUSTER_GAP; }
  const innerW = Math.max(0, accX - CONTINENT_CLUSTER_GAP);
  const innerH = Math.max(0, accY - CONTINENT_CLUSTER_GAP);
  measured.forEach((m, i) => {
    const g = gridPos(i);
    const x = originX + colX[g.ci] + (colW[g.ci] - m.w) / 2;
    const y = originY + rowY[g.ri] + (rowH[g.ri] - m.h) / 2;
    clusterRects.push({
      sessionId: m.cluster.sessionId, title: m.cluster.title || '',
      x: x, y: y, w: m.w, h: m.h, cx: x + m.w / 2, cy: y + m.h / 2,
      itemCount: (m.cluster.items || []).length,
      shownCount: m.shown !== undefined ? m.shown : (m.cluster.items || []).length,
      collapsed: !!m.collapsed,
    });
    if (!m.collapsed) {
      // 卡网格在块内水平居中：块宽被岛牌下限撑宽时卡不歪在一边；
      // 块宽=网格宽+2×PAD 时（≥2 卡岛）值与旧的 x+PAD 逐字节一致
      const gridW = m.cols * CONTINENT_NODE_W + (m.cols - 1) * CONTINENT_GAP;
      (m.cluster.items || []).slice(0, m.shown || (m.cluster.items || []).length).forEach((item, j) => {
        const icol = j % m.cols, irow = Math.floor(j / m.cols);
        const nx = x + (m.w - gridW) / 2 + icol * (CONTINENT_NODE_W + CONTINENT_GAP);
        const ny = y + CONTINENT_PAD + CONTINENT_HEADER_H + irow * (CONTINENT_NODE_H + CONTINENT_GAP);
        placements[item.itemId] = {
          x: nx, y: ny, w: CONTINENT_NODE_W, h: CONTINENT_NODE_H,
          cx: nx + CONTINENT_NODE_W / 2, cy: ny + CONTINENT_NODE_H / 2,
        };
      });
    }
  });
  return { placements: placements, clusterRects: clusterRects, w: innerW, h: innerH };
}

function _continentLayoutClusters(clusters, collapsed, cardCap) {
  const collapsedSet = new Set((collapsed && collapsed.sessions) || []);
  const cap = cardCap === undefined ? CONTINENT_ISLAND_CARD_MAX : cardCap;
  const measured = (clusters || []).map(c => _continentMeasure(c, collapsedSet.has(c.sessionId), cap));
  const grid = _continentLayoutGrid(measured, CONTINENT_WORLD_MARGIN, CONTINENT_WORLD_MARGIN);
  const worldW = Math.max(400, grid.w + CONTINENT_WORLD_MARGIN * 2);
  const worldH = Math.max(300, grid.h + CONTINENT_WORLD_MARGIN * 2);
  return { placements: grid.placements, clusterRects: grid.clusterRects,
           regionRects: [], worldW: worldW, worldH: worldH };
}

// 两级布局（v7.1a）：先按海域分块——块内岛走既有亲缘排序 + 蛇形填充；块间按
// 「跨海域亲缘总和」降序（并列按海域名稳定序，散岛块永居末位）排进块级网格，
// 间距用更大的 REGION_GAP。海域板 = 块内岛矩形并集外扩（顶部多留一行给海域牌）。
// worldW/H 必须罩住**海域板**（板比岛并集大一圈）——否则边缘板上的城市会被
// 判「出界」折叠。
function _continentRegionLayout(regions, bySid, clusters, shared, userEdges, collapsed) {
  const collapsedSet = new Set((collapsed && collapsed.sessions) || []);
  const collapsedRegions = new Set((collapsed && collapsed.regions) || []);
  const cap = CONTINENT_ISLAND_CARD_MAX;
  const byKey = {};
  (clusters || []).forEach(c => {
    const sid = String(c.sessionId || '');
    const info = bySid[sid] || {};
    const key = info.key || '';
    (byKey[key] = byKey[key] || []).push(c);
  });
  // 块定义：每片海域一块（板），单岛领域 + 中性 + 待确认合成一块「散岛」（无板）；
  // 收起的海域整块收成一枚印章（岛不占位不渲染），展开回来布局不变（确定性）
  const blocks = [];
  regions.forEach(r => blocks.push({ key: r.key, name: r.name, plate: true,
    stamp: collapsedRegions.has(r.key), clusters: byKey[r.key] || [] }));
  const loose = [];
  Object.keys(byKey).forEach(key => {
    if (!key) { loose.push.apply(loose, byKey[key]); return; }
    const inRegion = regions.some(r => r.key === key);
    if (!inRegion) loose.push.apply(loose, byKey[key]); // 单岛领域：不上板，进散岛块
  });
  if (loose.length) blocks.push({ key: '', name: '', plate: false, stamp: false, clusters: loose });

  // 块内亲缘排序（复用 v5.2 的贪心链式）；块间按跨块亲缘总和排序。
  // 收起的海域整块收成**一枚**印章（岛不占位不渲染）——多枚印章叠着看全局
  const laid = blocks.map(b => {
    const ordered = _continentClusterOrder(b.clusters, shared, userEdges);
    const measured = b.stamp
      ? [{ cluster: ordered[0] || { sessionId: '', items: [] }, stamp: true,
          w: 190, h: 48, shown: 0, collapsed: true }]
      : ordered.map(c => _continentMeasure(c, collapsedSet.has(c.sessionId), cap));
    return { block: b, measured: measured, sids: ordered.map(c => String(c.sessionId || '')) };
  });
  const allSids = (clusters || []).map(c => String(c.sessionId || ''));
  const kin = _continentKinship(allSids, shared, userEdges);
  const crossKin = {};
  laid.forEach(a => laid.forEach(b => {
    if (a === b) return;
    a.sids.forEach(sa => b.sids.forEach(sb => {
      const w = kin[_continentKinshipKey(sa, sb)] || 0;
      if (w) crossKin[a.block.key + '\u0000' + b.block.key] =
        (crossKin[a.block.key + '\u0000' + b.block.key] || 0) + w;
    }));
  }));
  const blockWeight = key => {
    let sum = 0;
    Object.keys(crossKin).forEach(pairKey => {
      const parts = pairKey.split('\u0000');
      if (parts[0] === key || parts[1] === key) sum += crossKin[pairKey];
    });
    return sum;
  };
  laid.sort((a, b) => {
    const ka = a.block.plate ? blockWeight(a.block.key) : -1;
    const kb = b.block.plate ? blockWeight(b.block.key) : -1;
    if (ka !== kb) return kb - ka;
    if (a.block.plate && b.block.plate) return String(a.block.name).localeCompare(String(b.block.name), 'zh');
    return a.block.plate ? -1 : 1;  // 散岛块永居末位（无板无名，不参与海域排序）
  });

  // 块级网格：与岛级同一套 colW/rowH 逻辑，间距换 REGION_GAP；先按内容尺寸摆好块，
  // 再在块内部按「板框 = 内容外扩」重排——板的 padding 计入块尺寸，岛内相对坐标不变
  const cols = Math.max(1, Math.ceil(Math.sqrt(laid.length)));
  const blockW = [], blockH = [];
  laid.forEach(l => {
    const grid = _continentLayoutGrid(l.measured, 0, 0);
    l.grid = grid;
    l.paddedW = grid.w + (l.block.plate ? CONTINENT_REGION_PAD * 2 : 0);
    l.paddedH = grid.h + (l.block.plate ? CONTINENT_REGION_PAD * 2 + CONTINENT_REGION_HEADER_H : 0);
  });
  const gridPos = i => {
    const ri = Math.floor(i / cols), posInRow = i % cols;
    return { ci: ri % 2 === 1 ? cols - 1 - posInRow : posInRow, ri: ri };
  };
  laid.forEach((l, i) => {
    const g = gridPos(i);
    blockW[g.ci] = Math.max(blockW[g.ci] || 0, l.paddedW);
    blockH[g.ri] = Math.max(blockH[g.ri] || 0, l.paddedH);
  });
  const colX = [], rowY = [];
  let accX = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < blockW.length; i++) { colX.push(accX); accX += blockW[i] + CONTINENT_REGION_GAP; }
  let accY = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < blockH.length; i++) { rowY.push(accY); accY += blockH[i] + CONTINENT_REGION_GAP; }

  const placements = {};
  const clusterRects = [];
  const regionRects = [];
  laid.forEach((l, i) => {
    const g = gridPos(i);
    const bx = colX[g.ci] + (blockW[g.ci] - l.paddedW) / 2;
    const by = rowY[g.ri] + (blockH[g.ri] - l.paddedH) / 2;
    const originX = bx + (l.block.plate ? CONTINENT_REGION_PAD : 0);
    const originY = by + (l.block.plate ? CONTINENT_REGION_PAD + CONTINENT_REGION_HEADER_H : 0);
    const grid = _continentLayoutGrid(l.measured, originX, originY);
    Object.assign(placements, grid.placements);
    // 收起成印章的海域：岛不渲染（clusterRects 不进），板自己就是那枚印章
    if (!l.block.stamp) clusterRects.push.apply(clusterRects, grid.clusterRects);
    if (l.block.plate) {
      regionRects.push({
        key: l.block.key, x: bx, y: by, w: l.paddedW, h: l.paddedH,
        cx: bx + l.paddedW / 2, cy: by + l.paddedH / 2,
        stamp: !!l.block.stamp,
      });
    }
  });
  const worldW = Math.max(400, accX - CONTINENT_REGION_GAP + CONTINENT_WORLD_MARGIN);
  const worldH = Math.max(300, accY - CONTINENT_REGION_GAP + CONTINENT_WORLD_MARGIN);
  return { placements: placements, clusterRects: clusterRects,
           regionRects: regionRects, worldW: worldW, worldH: worldH };
}

// ---------- 数据 ----------
async function _continentFetchData() {
  const resp = await fetch('/api/continent', { cache: 'no-cache' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  if (!data || !Array.isArray(data.clusters)) throw new Error('投影数据格式不符');
  return data;
}

function _continentItemIndex() {
  const d = _continentData || {};
  const items = {}, clusterTitles = {}, itemSession = {}, itemCreated = {}, itemSummary = {};
  (d.clusters || []).forEach(c => {
    clusterTitles[c.sessionId] = c.title || '未命名画布';
    (c.items || []).forEach(it => {
      items[it.itemId] = it.title || '';
      itemSession[it.itemId] = c.sessionId;
      itemCreated[it.itemId] = it.createdAt || 0;
      // v5.3「问 Φ」的判断素材（服务端只带 model/manual 的真摘要，local 模板为空串）
      itemSummary[it.itemId] = it.summary || '';
    });
  });
  return { items, clusterTitles, itemSession, itemCreated, itemSummary };
}

function _continentNodeEl(itemId) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelector) return null;
  const safe = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(itemId)) : String(itemId);
  return world.querySelector('.continent-node[data-item-id="' + safe + '"]');
}

// ---------- DOM ----------
function _continentEnsureLayer() {
  let layer = document.getElementById('continentLayer');
  if (layer) return layer;
  const ws = document.getElementById('graphWorkspace');
  if (!ws || typeof ws.appendChild !== 'function') return null;
  layer = document.createElement('div');
  layer.id = 'continentLayer';
  layer.className = 'continent-layer';
  layer.hidden = true;
  layer.innerHTML =
    '<div class="continent-topbar">' +
      '<div class="continent-brand"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><ellipse cx="12" cy="12" rx="4.5" ry="9"></ellipse></svg>' +
      '知识大陆<span class="continent-sub" id="continentStats"></span></div>' +
      '<div class="continent-tools">' +
        '<button class="continent-tool" id="continentLinkBtn" title="连接两个不同区域的概念（画一条大陆边）">连接</button>' +
        '<button class="continent-tool is-quiet" id="continentGateBtn" hidden title="让 Φ 读卡片内容做领域归类（词面认不出的它来补；打开大陆本身不烧调用，点了才跑）">Φ 归类</button>' +
        '<button class="continent-tool is-quiet" id="continentRouteBtn" hidden title="航线的全局显示（总开关 / 透明度）；单条样式点线本身调">航线</button>' +
        '<button class="continent-tool is-quiet" id="continentWeakBtn" title="没画到地图上的共享点（弱证据 / 超上限 / 无位可放）：照报，可逐条确认落笔" hidden>折叠 0 条</button>' +
        '<button class="continent-tool" id="continentUndoBtn" title="撤销上一条边操作 (Ctrl+Z)" hidden>↩ 撤销</button>' +
        '<button class="continent-tool is-warn" id="continentCleanBtn" title="移除一端已不在大陆上的连线" hidden>清理断线</button>' +
      '</div>' +
      '<span class="continent-hint" id="continentHint" hidden></span>' +
      '<span class="continent-hint" id="continentGuide" hidden></span>' +
      '<button class="continent-close" id="continentCloseBtn" title="收起大陆 (Esc)">&times;</button>' +
    '</div>' +
    '<div class="continent-viewport" id="continentViewport">' +
      '<div class="continent-world" id="continentWorld"></div>' +
      '<div class="continent-empty" id="continentEmpty" hidden>大陆还在形成中——先去画布上学点什么，概念会自己长出来。</div>' +
      '<div class="continent-legend aurora-glass aurora-glass--compact" id="continentLegend" hidden></div>' +
    '</div>';
  ws.appendChild(layer);
  _continentBindViewport(document.getElementById('continentViewport'));
  // v7.1a 图例是交互控件不是地图：pointerdown 不进画布拖拽（其内部按钮各自再处理点击）
  const legend = document.getElementById('continentLegend');
  if (legend && legend.addEventListener) {
    legend.addEventListener('pointerdown', e => e.stopPropagation());
  }
  const closeBtn = document.getElementById('continentCloseBtn');
  if (closeBtn && closeBtn.addEventListener) closeBtn.addEventListener('click', () => closeContinentView());
  const linkBtn = document.getElementById('continentLinkBtn');
  if (linkBtn && linkBtn.addEventListener) linkBtn.addEventListener('click', () => _continentSetLinkMode(!_continentLinkMode));
  const undoBtn = document.getElementById('continentUndoBtn');
  if (undoBtn && undoBtn.addEventListener) undoBtn.addEventListener('click', () => { _continentUndoEdgeOp(); });
  const cleanBtn = document.getElementById('continentCleanBtn');
  if (cleanBtn && cleanBtn.addEventListener) cleanBtn.addEventListener('click', () => { _continentCleanDangling(); });
  const weakBtn = document.getElementById('continentWeakBtn');
  if (weakBtn && weakBtn.addEventListener) weakBtn.addEventListener('click', e => { _continentFoldedPopover(e); });
  // v7.1b：Φ 批量归类入口（触发不自动——打开大陆不烧调用，点了才跑）
  const gateBtn = document.getElementById('continentGateBtn');
  if (gateBtn && gateBtn.addEventListener) gateBtn.addEventListener('click', () => { _continentGateClassify(); });
  // v7.2：航线全局显示入口
  const routeBtn = document.getElementById('continentRouteBtn');
  if (routeBtn && routeBtn.addEventListener) routeBtn.addEventListener('click', e => { _continentRoutePrefsPopover(e); });
  // v7.2 悬停隔离（只看这座岛的航线）：事件委托挂世界层（节点是岛的兄弟元素，
  // mouseenter 挂岛牌会在指针移上卡片时误判离开）；world 元素不随重渲更换，只绑一次
  const worldEl = document.getElementById('continentWorld');
  if (worldEl && worldEl.addEventListener && !worldEl.dataset.isoBound) {
    worldEl.dataset.isoBound = '1';
    worldEl.addEventListener('mouseover', e => {
      const el = e.target && e.target.closest
        ? e.target.closest('.continent-cluster, .continent-node') : null;
      _continentSetRouteIso(el && el.dataset ? el.dataset.sessionId : null);
    });
    worldEl.addEventListener('mouseleave', () => _continentSetRouteIso(null));
  }
  // 弹层单例的场外关闭：捕获阶段先于画布交互，点弹层内部不关
  document.addEventListener('pointerdown', e => {
    if (!_continentPopover) return;
    if (_continentPopover.contains && _continentPopover.contains(e.target)) return;
    _continentClosePopover();
  }, true);
  return layer;
}

// ---------- v4/v5.1 画什么：城市选位 + 每对区域上限 + 折叠原因（纯函数，无 DOM 实测） ----------
// 一枚城市 = 一条跨 ≥2 画布的共享概念（同词跨 N 会话仍是一枚，不是每条链路一枚）。
// v4 的「弧线 + 浮空标签」在 v5.1 整体退役：共享概念升级为岛与岛之间的**城市节点**，
// 每座岛伸一根辐条连到该岛的代表卡；摆不下（撞岛 / 撞别的城）就进折叠清单（原因
// 「无位可放」）——绝不叠在别的岛上。弱证据照旧不上图，只进清单。
function _continentLinkMid(a, b) {
  // 二次贝塞尔（控制点上抬 lift）上 t=0.5 的点：与连线绘制同一公式，标签才落在弧上
  const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const len = Math.max(1, Math.hypot(dx, dy));
  const lift = Math.min(60, len * 0.14);
  const qx = mx + (-dy / len) * lift, qy = my + (dx / len) * lift;
  return { x: (a.cx + 2 * qx + b.cx) / 4, y: (a.cy + 2 * qy + b.cy) / 4, qx, qy };
}

// ---------- v7.2 航线走线（纯函数，无 DOM）：端点从岛框出发，永不穿过岛内部 ----------
// 旧版大陆边直接连两张卡的**中心**（二次贝塞尔），线必然穿过岛内部与中间的岛
// （岛底色 7% 透明度，线全透出来）——几何上的必然，不是审美问题。v7.2 起端点升级
// 为岛框边缘，走线三档：straight 直连 / detour 绕行（默认：撞岛就把控制点垂直推开，
// 最多 3 次，取首个不撞）/ lane 沿世界边缘车道（逃生档）。

// 从 rect 边缘朝目标方向出框的点（线从岛「边上」走，不从岛「心里」穿）
function _continentBorderPoint(rect, towardX, towardY) {
  const cx = Number(rect.cx), cy = Number(rect.cy);
  const dx = Number(towardX) - cx, dy = Number(towardY) - cy;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return { x: cx, y: cy };
  }
  const scaleX = dx !== 0 ? (rect.w / 2) / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? (rect.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(scaleX, scaleY);
  return { x: cx + dx * t, y: cy + dy * t };
}

// 二次贝塞尔采样撞岛检测（端点在岛框上、不算撞自己；采样点在矩形内即撞）
function _continentBezierHits(p0, q, p2, rects, samples) {
  return _continentBezierHitCount(p0, q, p2, rects, samples) > 0;
}

// 撞点计数（绕行两侧都撞时，取撞得最少的那条兜底）
function _continentBezierHitCount(p0, q, p2, rects, samples) {
  const n = samples || 14;
  let hits = 0;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * q.x + t * t * p2.x;
    const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * q.y + t * t * p2.y;
    for (let k = 0; k < (rects || []).length; k++) {
      const r = rects[k];
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hits++; break; }
    }
  }
  return hits;
}

// 车道走线（沿世界边缘）：四个方向的车道 × 两种入线（从端点直插车道 / 先出岛框再
// 上车道），采样数撞点取最优——单条固定车道会被「入线段横穿同排岛」坑（真机验收
// 抓过：恒定 y 的水平段连穿 4 座岛）
function _continentLaneRoute(a, b, pA, pB, rects, world) {
  const segHits = (from, to) => {
    let hits = 0;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      for (let k = 0; k < (rects || []).length; k++) {
        const r = rects[k];
        if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hits++; break; }
      }
    }
    return hits;
  };
  const aRect = { x: a.x, y: a.y, w: a.w, h: a.h, cx: a.cx, cy: a.cy };
  const bRect = { x: b.x, y: b.y, w: b.w, h: b.h, cx: b.cx, cy: b.cy };
  const margin = 26;
  const lanes = [
    { vertical: true, coord: world.x + margin },
    { vertical: true, coord: world.x + world.w - margin },
    { vertical: false, coord: world.y + margin },
    { vertical: false, coord: world.y + world.h - margin },
  ];
  let best = null, bestHits = Infinity;
  lanes.forEach(lane => {
    const candidates = [];
    const entryA = lane.vertical ? { x: lane.coord, y: pA.y } : { x: pA.x, y: lane.coord };
    const entryB = lane.vertical ? { x: lane.coord, y: pB.y } : { x: pB.x, y: lane.coord };
    candidates.push([pA, entryA, entryB, pB]);
    // 先出岛框再上车道：入线沿车道法线方向，避开从岛间走廊斜插
    const exitA = lane.vertical
      ? _continentBorderPoint(aRect, lane.coord, aRect.cy)
      : _continentBorderPoint(aRect, aRect.cx, lane.coord);
    const exitB = lane.vertical
      ? _continentBorderPoint(bRect, lane.coord, bRect.cy)
      : _continentBorderPoint(bRect, bRect.cx, lane.coord);
    const entryA2 = lane.vertical ? { x: lane.coord, y: exitA.y } : { x: exitA.x, y: lane.coord };
    const entryB2 = lane.vertical ? { x: lane.coord, y: exitB.y } : { x: exitB.x, y: lane.coord };
    candidates.push([exitA, entryA2, entryB2, exitB]);
    candidates.forEach(pts => {
      const hits = segHits(pts[0], pts[1]) + segHits(pts[1], pts[2]) + segHits(pts[2], pts[3]);
      if (hits < bestHits) { bestHits = hits; best = pts; }
    });
  });
  if (!best) return null;
  return {
    d: 'M ' + best[0].x + ' ' + best[0].y + ' L ' + best[1].x + ' ' + best[1].y +
       ' L ' + best[2].x + ' ' + best[2].y + ' L ' + best[3].x + ' ' + best[3].y,
    mid: { x: (best[1].x + best[2].x) / 2, y: (best[1].y + best[2].y) / 2 },
    mode: 'lane', p0: best[0], p1: best[1], p2: best[2], p3: best[3],
    hits: bestHits,
  };
}

// 主走线函数：返回 {d, mid, mode, p0, p1, p2, q}。mid 是标签落点（贝塞尔 t=0.5 或
// 车道中点），带 finite 兜底——给 DOM 写 'px' 的落点必须是有限数，NaN 是静默失败
// （v2 的老账：arc.qx undefined → NaNpx → 标签飘到世界层左上角）。
function _continentRoute(a, b, obstacles, mode, world) {
  const rects = (obstacles || []).filter(r => r && r !== a && r !== b);
  const ax = Number.isFinite(a.cx) ? a.cx : 0, ay = Number.isFinite(a.cy) ? a.cy : 0;
  const bx = Number.isFinite(b.cx) ? b.cx : 0, by = Number.isFinite(b.cy) ? b.cy : 0;
  const aRect = { x: a.x, y: a.y, w: a.w, h: a.h, cx: ax, cy: ay };
  const bRect = { x: b.x, y: b.y, w: b.w, h: b.h, cx: bx, cy: by };
  const pA = _continentBorderPoint(aRect, bx, by);
  const pB = _continentBorderPoint(bRect, ax, ay);
  const modeN = mode === 'straight' || mode === 'lane' ? mode : 'detour';
  if (modeN === 'lane' && world && Number.isFinite(world.w)) {
    const lane = _continentLaneRoute(aRect, bRect, pA, pB, rects, world);
    if (lane) return lane;
  }
  const mx = (pA.x + pB.x) / 2, my = (pA.y + pB.y) / 2;
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = -dy / len, uy = dx / len;
  let q = { x: mx, y: my };
  if (modeN === 'detour') {
    // 绕行：垂直推开控制点——**两侧都试**（只推一侧时，另一侧恰好挡着就永远绕不
    // 出去；真机验收抓过：5 个采样点穿岛），每侧最多 3 档抬升，取首个不撞的；
    // 两侧全撞（走廊真被堵死）→ 升级沿边车道（「直达路堵了走环线」，仍不穿岛）
    const lift0 = Math.min(110, 46 + len * 0.18);
    let best = null, bestHits = Infinity;
    for (let side = 1; side >= -1; side -= 2) {
      for (let k = 1; k <= 3; k++) {
        const lift = lift0 * k * side;
        const cand = { x: mx + ux * lift, y: my + uy * lift };
        if (!_continentBezierHits(pA, cand, pB, rects)) { best = cand; bestHits = 0; break; }
        const hits = _continentBezierHitCount(pA, cand, pB, rects);
        if (hits < bestHits) { bestHits = hits; best = cand; }
      }
      if (bestHits === 0) break;
    }
    if (bestHits === 0) {
      q = best;
    } else if (world && Number.isFinite(world.w)) {
      const lane = _continentLaneRoute(aRect, bRect, pA, pB, rects, world);
      if (lane) return lane;
      q = best || { x: mx, y: my };   // world 都没有就退而求其次：撞得最少的那条弧
    } else {
      q = best || { x: mx, y: my };
    }
  }
  const fin = v => Number.isFinite(v) ? v : 0;
  const qx = (pA.x + 2 * q.x + pB.x) / 4, qy = (pA.y + 2 * q.y + pB.y) / 4;
  const mid = {
    x: Number.isFinite(qx) ? qx : fin(mx),
    y: Number.isFinite(qy) ? qy : fin(my),
  };
  return {
    d: 'M ' + pA.x + ' ' + pA.y + ' Q ' + q.x + ' ' + q.y + ' ' + pB.x + ' ' + pB.y,
    mid: mid, mode: modeN, p0: pA, q: q, p2: pB,
  };
}

function _continentCityBox(cx, cy) {
  return {
    x: cx - CONTINENT_CITY_W / 2, y: cy - CONTINENT_CITY_H / 2,
    w: CONTINENT_CITY_W, h: CONTINENT_CITY_H, cx: cx, cy: cy,
  };
}

// 城市候选落点：所连岛群的质心 + 每对岛的中点（两岛之间的走廊 = 首选），各带一圈
// 小偏移——走廊被占时挤一挤（同一条走廊竖着摆得下 3 座城），别动不动判「无位可放」。
function _continentCitySpots(targets) {
  const pts = (targets || []).filter(t => t && isFinite(t.cx) && isFinite(t.cy));
  if (pts.length < 2) return [];
  const seeds = [];
  let sx = 0, sy = 0;
  pts.forEach(t => { sx += t.cx; sy += t.cy; });
  seeds.push({ x: sx / pts.length, y: sy / pts.length });
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      seeds.push({ x: (pts[i].cx + pts[j].cx) / 2, y: (pts[i].cy + pts[j].cy) / 2 });
    }
  }
  const stepX = CONTINENT_CITY_W + CONTINENT_CITY_GAP;
  const stepY = CONTINENT_CITY_H + CONTINENT_CITY_GAP;
  const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
                [2, 0], [-2, 0], [0, 2], [0, -2],
                [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const out = [];
  seeds.forEach(s => ring.forEach(r => {
    out.push({ x: s.x + r[0] * stepX, y: s.y + r[1] * stepY });
  }));
  return out;
}

// 世界边界（岛群包围盒 + 一个走廊宽）：城市属于「岛之间」，不许飘到地图外的荒野
function _continentWorldBounds(rects) {
  const list = (rects || []).filter(r => r && isFinite(r.x) && isFinite(r.y) && r.w > 0 && r.h > 0);
  if (!list.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  list.forEach(r => {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  });
  const pad = CONTINENT_CLUSTER_GAP;
  return { x: minX - pad, y: minY - pad,
           w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

function _continentFits(box, obstacles, margin) {
  const m = margin || 0;
  return !(obstacles || []).some(o => o &&
    box.x - m < o.x + o.w && box.x + box.w + m > o.x &&
    box.y - m < o.y + o.h && box.y + box.h + m > o.y);
}

function _continentInside(box, bounds) {
  return box.x >= bounds.x && box.y >= bounds.y &&
    box.x + box.w <= bounds.x + bounds.w && box.y + box.h <= bounds.y + bounds.h;
}

// 城市选位：候选里挑「不撞岛、不撞别的城、留在世界内」且**离它所连的岛总距离最短**
// 的那个（辐条最短最好读）。一个都放不下 → null（调用方折叠，原因「无位可放」）。
function _continentPlaceCity(targets, obstacles, bounds) {
  const pts = (targets || []).filter(t => t && isFinite(t.cx) && isFinite(t.cy));
  if (pts.length < 2) return null;
  let best = null, bestCost = Infinity;
  _continentCitySpots(pts).forEach(spot => {
    const box = _continentCityBox(spot.x, spot.y);
    if (bounds && !_continentInside(box, bounds)) return;
    if (!_continentFits(box, obstacles, CONTINENT_CITY_GAP)) return;
    const cost = pts.reduce((acc, t) => acc + Math.hypot(t.cx - spot.x, t.cy - spot.y), 0);
    if (cost < bestCost - 1e-6) { bestCost = cost; best = box; }
  });
  return best;
}

// 折叠原因：四种都要能分辨，用户才知道该不该管它（弱证据要修标题 / 无位可放是地图太挤）
const CONTINENT_FOLD_REASON = {
  weak: '弱证据',
  covered: '已被更具体的城市覆盖',
  capped: '超出每对上限',
  map_capped: '超出全图上限',
  no_room: '无位可放',
};

function _continentDrawPlan(shared, placements, clusterRects, pairLimit, cityLimit, extraBounds) {
  const rects = clusterRects || [];
  const pairLimitN = pairLimit || CONTINENT_PAIR_CITY_LIMIT;
  const cityLimitN = cityLimit || CONTINENT_CITY_LIMIT;
  const cities = [], boundary = {}, folded = [];
  const obstacles = rects.slice();
  // v7.1a：世界边界罩住海域板（板比岛并集大一圈）——否则边缘板上的城市会被判
  // 「出界」折叠。板只进边界、不进障碍（城市可以落在板上，那本来就是它的地盘）
  const bounds = _continentWorldBounds((extraBounds && extraBounds.length ? extraBounds : []).concat(rects));
  const pairs = {};
  let spokes = 0;
  (shared || []).slice(0, CONTINENT_LINE_LIMIT).forEach(s => {
    if (s.strength === 'weak') { folded.push({ entry: s, reason: 'weak' }); return; }
    // v5.5：证据被更具体的标签完全覆盖（服务端 covered 字段）——比如 8 座岛的「能量
    // 守恒定律」+ 2 座岛的「角动量守恒定律」旁边的那个 10 岛「量守恒定律」（截断名）。
    // 它不单独成城（名字读不懂、城与城几乎重合），但照进折叠清单，也要参与摆位亲缘
    if (s.covered) { folded.push({ entry: s, reason: 'covered' }); return; }
    if (cities.length >= cityLimitN) { folded.push({ entry: s, reason: 'map_capped' }); return; }
    // 每会话一张代表卡：服务端 _links_for 已按「岛内最早学的」取端点，这里按会话去重。
    // placements 里找不到的条目跳过——投影与布局不同步时宁可不画，也不画到错地方。
    const reps = [], seen = {};
    (s.links || []).forEach(l => {
      [[l.fromSession, l.from], [l.toSession, l.to]].forEach(pair => {
        const sid = pair[0], iid = pair[1];
        if (!sid || !iid || seen[sid] || !placements[iid]) return;
        seen[sid] = true;
        reps.push({ sessionId: sid, itemId: iid });
      });
    });
    // 一栋楼要有两座以上的岛才叫边界城市（单岛共享是同岛词面重叠，服务端已经不算）
    if (reps.length < 2) { folded.push({ entry: s, reason: 'no_room' }); return; }
    const sids = reps.map(r => r.sessionId).slice().sort();
    let blocked = false;
    for (let i = 0; i < sids.length && !blocked; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        if ((pairs[sids[i] + '|' + sids[j]] || 0) >= pairLimitN) { blocked = true; break; }
      }
    }
    if (blocked) { folded.push({ entry: s, reason: 'capped' }); return; }
    const targets = reps.map(r => {
      const rect = rects.find(x => x && x.sessionId === r.sessionId);
      const p = placements[r.itemId];
      return { cx: rect ? rect.cx : p.cx, cy: rect ? rect.cy : p.cy };
    });
    const box = _continentPlaceCity(targets, obstacles, bounds);
    if (!box) { folded.push({ entry: s, reason: 'no_room' }); return; }
    obstacles.push(box);
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        const key = sids[i] + '|' + sids[j];
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
    spokes += reps.length;
    // 代表卡挂 ◈ 徽标（辐条一眼看得到头）；同岛的其他命中卡不挂徽标，但进重逢清单
    reps.forEach(r => { boundary[r.itemId] = s.label; });
    cities.push({ entry: s, reps: reps, total: reps.length,
                  x: box.cx, y: box.cy, box: box });
  });
  return { cities: cities, boundary: boundary, cityCount: cities.length,
           spokeCount: spokes, folded: folded };
}

function _continentRender(data) {
  const world = document.getElementById('continentWorld');
  if (!world) return null;
  world.innerHTML = '';
  // v7.1a 海域层：后端概率 + 用户覆盖（KV）→ 归属解析；有 ≥2 座岛同领域才走两级
  // 布局（海域分块），否则走 v6 旧单网格（行为不变，不引入回归）
  const regionInfo = _continentRegions(data.clusters || [], _continentRegionOverrides,
                                       data.domainList);
  _continentRegionInfo = regionInfo;
  let layout;
  if (regionInfo.regions.length) {
    layout = _continentRegionLayout(regionInfo.regions, regionInfo.bySid,
                                    data.clusters || [], data.shared || [], data.userEdges || [],
                                    _continentCollapsed);
  } else {
    layout = _continentLayoutClusters(
      _continentClusterOrder(data.clusters || [], data.shared || [], data.userEdges || []),
      _continentCollapsed);
  }
  _continentPlacements = layout.placements;
  _continentClusterRects = layout.clusterRects;
  world.style.width = layout.worldW + 'px';
  world.style.height = layout.worldH + 'px';

  const esc = _continentEsc;
  // 边界城市（v5.1）：共享概念的端点条目 → 概念名 → 共享词。只认**画到地图上**的那些
  // （强证据、没超上限、有位置）——弱证据不该把节点标成边界城市。
  // v7.1a：世界边界罩住海域板（城市不许因板外扩被判「出界」）
  const plan = _continentDrawPlan(data.shared || [], layout.placements,
    layout.clusterRects, CONTINENT_PAIR_CITY_LIMIT, CONTINENT_CITY_LIMIT,
    layout.regionRects || []);
  const boundary = plan.boundary;
  _continentFolded = plan.folded;

  // 海域板（v7.1a 学科地盘 / v7.3 可折叠）：领域分块的地皮，先画＝垫在岛与卡之下。
  // 板头 = 名字 + 岛数 + 来源标记 + 折叠钮；点板头聚焦这片（再点取消），板身不拦画布
  // 拖拽。收起的海域整片收成一枚印章（岛不渲染），多枚印章叠着看全局
  (layout.regionRects || []).forEach(rect => {
    const region = regionInfo.regions.find(r => r.key === rect.key) || {};
    const el = document.createElement('div');
    el.className = 'continent-region' +
      (region.hue === null || region.hue === undefined ? ' is-gray' : '') +
      (rect.stamp ? ' is-stamp' : '');
    el.dataset.region = rect.key || '';
    if (region.hue !== null && region.hue !== undefined) {
      el.style.setProperty('--region-h', String(region.hue));
    }
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    el.title = '海域：' + (region.name || rect.key) + '（' + (region.sessions || []).length +
      ' 座岛 · 点名字聚焦这片，点 ' + (rect.stamp ? '▸ 展开整片' : '▾ 收成印章') + '）';
    el.innerHTML =
      '<div class="continent-region-head">' +
        '<span class="continent-region-fold" data-region-fold="' + esc(rect.key) + '">' +
          (rect.stamp ? '▸' : '▾') + '</span>' +
        '<span class="continent-region-name">' + esc(region.name || rect.key) + '</span>' +
        '<span class="continent-region-count">' + (region.sessions || []).length + ' 座岛 · ' +
          (region.itemCount || 0) + ' 张卡</span>' +
        (rect.stamp ? '' :
          '<span class="continent-region-src">' + esc(_continentRegionSourceLabel(region.source)) + '</span>') +
      '</div>';
    const head = el.firstChild;
    if (head && head.addEventListener) {
      head.addEventListener('pointerdown', e => {
        e.stopPropagation();  // 板头是聚焦按钮，不是画布拖拽起点
        _continentToggleLegendFocus(rect.key);
      });
    }
    const fold = el.querySelector ? el.querySelector('[data-region-fold]') : null;
    if (fold) {
      fold.addEventListener('pointerdown', e => {
        e.stopPropagation();
        _continentToggleCollapse('region', rect.key);
      });
    }
    world.appendChild(el);
  });

  // 簇底板（区域图的地皮）。岛牌一句话（v5.4）：前 3 个概念名 + 最近更新时间——
  // 纯拼接、不调模型；看懂岛是看懂联系的前提。
  // v7.1a：岛底板跟海域走——solid 实色岛底 + 领域徽标（点开可改归类）、light 淡色 +
  // 「?」徽标、pending 中性灰 + 「?」（进图例「待确认」）、neutral 纯中性不划地盘。
  // v7.3：岛可折叠（▾ 收起只留岛牌）+ 岛内近似卡片折叠（默认画前 N 张 +「另有 k 张」）
  layout.clusterRects.forEach(rect => {
    const cluster = (data.clusters || []).find(c => c.sessionId === rect.sessionId);
    const tagline = _continentIslandTagline(cluster, _continentRelTime);
    const info = regionInfo.bySid[rect.sessionId] || {};
    const tier = info.tier || 'neutral';
    const region = info.key && tier !== 'neutral'
      ? regionInfo.regions.find(r => r.key === info.key) : null;
    const el = document.createElement('div');
    el.className = 'continent-cluster' +
      (region && region.hue != null && region.hue !== undefined ? ' has-region' : '') +
      (tier === 'solid' ? ' r-solid' : tier === 'light' ? ' r-light' : tier === 'pending' ? ' r-pending' : '') +
      (rect.collapsed ? ' is-collapsed' : '');
    el.dataset.sessionId = rect.sessionId || '';
    if (region && region.hue != null && region.hue !== undefined) {
      el.style.setProperty('--region-h', String(region.hue));
    }
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    // v7.3 岛内折叠注脚：只画了前 N 张时明示「另有 k 张」——缺失要可见，不许静默吞卡
    const hiddenCount = Math.max(0, rect.itemCount - (rect.shownCount !== undefined ? rect.shownCount : rect.itemCount));
    const moreNote = (!rect.collapsed && hiddenCount > 0)
      ? ' · 另有 ' + hiddenCount + ' 张（收进岛里）' : '';
    let headHtml =
      '<div class="continent-cluster-head">' +
        '<span class="continent-cluster-headline">' +
          '<span class="continent-cluster-fold" data-island-fold="' + esc(rect.sessionId) + '">' +
            (rect.collapsed ? '▸' : '▾') + '</span>' +
          '<span class="continent-cluster-title">' + esc(rect.title) + '</span>' +
          '<span class="continent-cluster-count">' + rect.itemCount + ' 个概念</span>' +
        '</span>' +
        (rect.collapsed || !tagline ? '' :
          '<span class="continent-cluster-sub">' + esc(tagline) + esc(moreNote) + '</span>') +
      '</div>';
    // 领域徽标（v7.1a 手动纠正入口）：点开「归到哪个领域」清单——一步落笔写 KV。
    // 徽标不在（neutral 无归属）就不占位；淡色/待确认档带「?」（不确定也要可见）。
    // 徽标旁的色点 = 次要领域（混合岛，后端 domains[1] 概率够高才显示）
    const secondaryDot = _continentSecondaryDot(cluster, data.domainList);
    if (info.key && tier !== 'neutral') {
      const region2 = regionInfo.regions.find(r => r.key === info.key);
      const badgeName = region2 ? region2.name : info.key;
      headHtml =
      '<div class="continent-cluster-head">' +
        '<span class="continent-cluster-headline">' +
          '<span class="continent-cluster-fold" data-island-fold="' + esc(rect.sessionId) + '">' +
            (rect.collapsed ? '▸' : '▾') + '</span>' +
          '<span class="continent-cluster-title">' + esc(rect.title) + '</span>' +
          '<span class="continent-cluster-count">' + rect.itemCount + ' 个概念</span>' +
          '<button class="continent-domain-badge' + (tier === 'solid' ? '' : ' is-unsure') + '"' +
            ' data-domain-sid="' + esc(rect.sessionId) + '"' +
            ' title="这座岛归在「' + esc(badgeName) + '」——点开可改归类（写进大陆记忆，Ctrl+Z 可撤销）">' +
            esc(badgeName) + (tier === 'light' || tier === 'pending' ? ' ?' : '') +
          '</button>' + secondaryDot +
        '</span>' +
        (rect.collapsed || !tagline ? '' :
          '<span class="continent-cluster-sub">' + esc(tagline) + esc(moreNote) + '</span>') +
      '</div>';
    }
    el.innerHTML = headHtml;
    const badge = el.querySelector ? el.querySelector('.continent-domain-badge') : null;
    if (badge) {
      badge.addEventListener('pointerdown', e => {
        e.stopPropagation();  // 徽标是归类菜单入口，不进画布拖拽/下钻
        _continentDomainMenu(e, rect.sessionId);
      });
    }
    const foldBtn = el.querySelector ? el.querySelector('[data-island-fold]') : null;
    if (foldBtn) {
      foldBtn.addEventListener('pointerdown', e => {
        e.stopPropagation();
        _continentToggleCollapse('island', rect.sessionId);
      });
    }
    world.appendChild(el);
  });

  // 概念节点（POI）：标题一行 + 公式渲成一行小字 KaTeX（简略口径，容器裁剪）
  (data.clusters || []).forEach(c => (c.items || []).forEach(item => {
    const p = layout.placements[item.itemId];
    if (!p) return;
    const el = document.createElement('div');
    el.className = 'continent-node' + (boundary[item.itemId] ? ' continent-node--boundary' : '');
    el.dataset.sessionId = c.sessionId || '';
    el.dataset.itemId = item.itemId;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    if (boundary[item.itemId]) {
      el.title = '边界城市：其他画布也学过（共享「' + boundary[item.itemId] + '」）';
    }
    let html = '<div class="continent-node-title">' + esc(item.title) + '</div>';
    if (item.formula || item.formulaPreview) {
      html += '<div class="continent-node-formula"></div>';
    }
    if (boundary[item.itemId]) {
      html += '<span class="continent-node-badge" aria-hidden="true">◈</span>';
    }
    el.innerHTML = html;
    const fEl = el.querySelector ? el.querySelector('.continent-node-formula') : null;
    if (fEl) _continentRenderFormula(fEl, item.formula || item.formulaPreview);
    world.appendChild(el);
  }));

  // 边界城市（v5.1）：共享概念的「地点」——摆在它所连的岛之间的走廊里，每座岛一根
  // 辐条连到代表卡。点开是**重逢清单**（每座岛学过的那些卡 + 「去看」）：绝不替你猜
  // 跳哪座岛，机器猜「最近学的」总有一半时候不是你想去的。
  plan.cities.forEach(city => {
    const s = city.entry || {};
    const el = document.createElement('div');
    el.className = 'continent-city' + _continentKindClass(s.kind);
    el.dataset.cityLabel = s.label || '';
    el.dataset.citySids = city.reps.map(r => r.sessionId).join(',');  // v7.1a 图例聚焦判定用
    el.style.left = city.box.x + 'px';
    el.style.top = city.box.y + 'px';
    el.title = '边界城市：' + city.reps.length + ' 块画布都学过——点开看重逢清单';
    el.innerHTML = '<span class="continent-city-name">' +
      _continentKindPrefix(s.kind) + esc(s.label || '') + '</span>';
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();  // 标签/用户边同规：不让城市点击进画布拖拽态
      _continentCityPopover(city, e);
    });
    const ends = city.reps.map(r => r.itemId);
    el.addEventListener('mouseenter', () => _continentHighlightNodes(ends, true));
    el.addEventListener('mouseleave', () => _continentHighlightNodes(ends, false));
    world.appendChild(el);
  });

  // ---------- 连线层：辐条（城市→岛）+ 我的航线（岛框→岛框，v7.2）+ 断桥 ----------
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'continent-links');
  svg.setAttribute('width', String(layout.worldW));
  svg.setAttribute('height', String(layout.worldH));

  // 辐条：城市 → 该岛代表卡。两端都被节点盖住（SVG 是世界层首个子元素，节点画在它
  // 上面），所以露出来的正好是走廊那一段——「城市连着哪几座岛」一眼可见。
  plan.cities.forEach(city => {
    city.reps.forEach(r => {
      const p = layout.placements[r.itemId];
      if (!p) return;
      const spoke = document.createElementNS(svgNS, 'line');
      spoke.setAttribute('class', 'continent-spoke');
      spoke.setAttribute('x1', String(city.box.cx));
      spoke.setAttribute('y1', String(city.box.cy));
      spoke.setAttribute('x2', String(p.cx));
      spoke.setAttribute('y2', String(p.cy));
      spoke.setAttribute('data-sids', city.reps.map(x => x.sessionId).join(','));
      svg.appendChild(spoke);
    });
  });
  const cityCount = plan.cityCount;

  // 我的航线（v2 落笔 / v7.2 重做）：端点从**岛框边缘**出发、绕行不穿岛——旧版连
  // 两张卡中心的弧线必然穿过岛内部与中间的岛。样式逐条可调（线型/颜色/粗细/走线/
  // 显隐/锚点卡），全局可关（数据不动）；细节档（LOD detail）才画锚点卡的虚线短接。
  const routePrefs = _continentRoutePrefs();
  (data.userEdges || []).forEach(e => {
    const ra = layout.clusterRects.find(r => r.sessionId === e.fromSession);
    const rb = layout.clusterRects.find(r => r.sessionId === e.toSession);
    const pa = layout.placements[e.fromItem], pb = layout.placements[e.toItem];
    if (!ra || !rb) return;  // 找不到岛框的走断桥通道（下方 danglingEdges）
    if (!routePrefs.on || (e.style && e.style.hidden)) return;
    const style = e.style || {};
    const route = _continentRoute(ra, rb, layout.clusterRects, style.route || 'detour',
      { x: 0, y: 0, w: layout.worldW, h: layout.worldH });
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'continent-route');
    path.setAttribute('d', route.d);
    path.setAttribute('data-edge-id', e.id);
    path.setAttribute('data-sids', [e.fromSession, e.toSession].join(','));
    const stroke = _continentRouteStroke(style, e, _continentRegionInfo);
    path.setAttribute('stroke', stroke.color);
    path.setAttribute('stroke-width', String(stroke.width));
    if (stroke.dash) path.setAttribute('stroke-dasharray', stroke.dash);
    path.setAttribute('opacity', String(routePrefs.opacity));
    path.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      _continentEdgePopover(e, ev);
    });
    svg.appendChild(path);
    if (e.label && !style.noLabel) {
      const label = document.createElement('div');
      label.className = 'continent-user-link-label';
      // 落点走走线产物 route.mid（finite 兜底在纯函数里）——标签必须压在线上
      label.style.left = route.mid.x + 'px';
      label.style.top = route.mid.y + 'px';
      label.textContent = e.label;
      label.title = '我的航线：' + e.label;
      label.addEventListener('pointerdown', ev => {
        ev.stopPropagation();
        _continentEdgePopover(e, ev);
      });
      world.appendChild(label);
    }
    // 锚点短接（细节档才显，CSS 管显隐）：从锚点卡到出岛点的一小段虚线——
    // 「这条线具体连哪张卡」降级为细节信息，不再穿岛去连卡片中心
    if (pa && pb) {
      const laneMode = route.mode === 'lane' || route.mode === 'detour-lane';
      [[pa, route.p0], [pb, laneMode ? route.p3 : route.p2]].forEach(pair => {
        const stub = document.createElementNS(svgNS, 'line');
        stub.setAttribute('class', 'continent-route-stub');
        stub.setAttribute('x1', String(pair[0].cx));
        stub.setAttribute('y1', String(pair[0].cy));
        stub.setAttribute('x2', String(pair[1].x));
        stub.setAttribute('y2', String(pair[1].y));
        stub.setAttribute('data-sids', [e.fromSession, e.toSession].join(','));
        svg.appendChild(stub);
      });
    }
  });

  // 断桥（v2）：一端已不在大陆上的边——从幸存端朝目标簇方向画残线，中段断开。
  // 两端都在但同会话的无效边无残线可画，只进清理清单。
  (data.danglingEdges || []).forEach(e => {
    if (e.missing === 'same_session') return;
    const anchor = e.missing === 'from' ? layout.placements[e.toItem] : layout.placements[e.fromItem];
    if (!anchor) return;
    const targetSid = e.missing === 'from' ? e.fromSession : e.toSession;
    const cluster = layout.clusterRects.find(r => r.sessionId === targetSid);
    const tx = cluster ? cluster.cx : anchor.cx + 140, ty = cluster ? cluster.cy : anchor.cy + 90;
    const dx = tx - anchor.cx, dy = ty - anchor.cy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const seg = (t0, t1) => {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('class', 'continent-dangle-link');
      p.setAttribute('d', 'M ' + (anchor.cx + ux * len * t0) + ' ' + (anchor.cy + uy * len * t0) +
        ' L ' + (anchor.cx + ux * len * t1) + ' ' + (anchor.cy + uy * len * t1));
      svg.appendChild(p);
    };
    seg(0, 0.55); seg(0.68, 0.8);  // 中段留空 = 桥断了
    const mark = document.createElement('div');
    mark.className = 'continent-dangle-mark';
    mark.style.left = (anchor.cx + ux * len * 0.615) + 'px';
    mark.style.top = (anchor.cy + uy * len * 0.615) + 'px';
    mark.textContent = '✕';
    mark.title = '这条大陆边的一端已不在大陆上（画布被清空或概念被删除），可用工具条「清理断线」移除';
    world.appendChild(mark);
  });

  world.insertBefore(svg, world.firstChild);

  const mineCount = (data.userEdges || []).length;
  const stats = document.getElementById('continentStats');
  if (stats) stats.textContent =
    data.clusterCount + ' 个区域 · ' + data.itemCount + ' 个概念' +
    (regionInfo.regions.length ? ' · ' + regionInfo.regions.length + ' 片海域' : '') +
    (cityCount ? ' · ' + cityCount + ' 座边界城市' : '') +
    (plan.folded.length ? ' · 折叠 ' + plan.folded.length + ' 条' : '') +
    (mineCount ? ' · 我的连线 ' + mineCount : '');
  const empty = document.getElementById('continentEmpty');
  if (empty) empty.hidden = (data.itemCount || 0) > 0;
  // 空态引导（v5.4 + 空画布说明）：两句话各自独立成立，用「；」拼进同一条引导——
  // 「暂无共享连线」管「有岛但 0 城市」；「N 个画布还没有知识点」管「画布为什么
  // 不在大陆上」（不以上图内容为前提：只有一个空画布时大字提示之外顶栏也要教机制）。
  // 与连接模式提示互斥的约定不变（见 _continentSetLinkMode）。
  const guide = document.getElementById('continentGuide');
  if (guide) {
    const parts = [];
    if (cityCount === 0 && (data.itemCount || 0) > 0) {
      parts.push('暂无共享连线——同一个概念在第二座岛出现时，这里会自动亮起边界城市');
    }
    const emptyCount = _continentEmptyCanvasCount(
      (typeof window !== 'undefined' && typeof window.getAllSessions === 'function')
        ? window.getAllSessions() : [],
      (data.clusters || []).map(c => c.sessionId));
    if (emptyCount > 0) {
      parts.push('有 ' + emptyCount + ' 个画布还没有知识点，暂时不会出现在大陆上，学出知识点后这里会长出岛');
    }
    _continentGuideText = parts.join('；');
    guide.hidden = !_continentGuideText;
    guide.textContent = _continentGuideText;
  }
  // v7.1a 图例（左下角，不与顶栏争位）+ 聚焦态恢复 + 归类入口
  _continentRenderLegend(regionInfo, data);
  _continentApplyFocus();
  // v5.6：备注标签挂在世界层里，会随地图缩放一起变形——渲染完成后按当前倍率抵消一次
  _continentSyncEdgeLabels();
  return layout;
}

function _continentHighlightNodes(ids, on) {
  (ids || []).forEach(id => {
    const el = _continentNodeEl(id);
    if (el && el.classList) el.classList.toggle('is-hot', !!on);
  });
}

function _continentHighlightPair(a, b, on) {
  _continentHighlightNodes([a, b], on);
}

// ---------- 弹层（单例）：共享概念详情 / 我的边操作 ----------
function _continentClosePopover() {
  // v5.3：在途的「问 Φ」判断没处落了，随弹层关闭一并中止
  if (_continentPhiInflight.size) {
    _continentPhiInflight.forEach(c => { try { c.abort(); } catch (e) { /* 容忍 */ } });
    _continentPhiInflight.clear();
  }
  if (_continentPopover && _continentPopover.remove) _continentPopover.remove();
  _continentPopover = null;
}

function _continentOpenPopover(html, x, y) {
  _continentClosePopover();
  const layer = document.getElementById('continentLayer');
  if (!layer) return null;
  const el = document.createElement('div');
  el.className = 'continent-popover aurora-glass aurora-glass--dialog';
  el.innerHTML = html;
  el.addEventListener('pointerdown', e => e.stopPropagation());  // 场外关闭靠 document 捕获
  layer.appendChild(el);
  const vw = layer.clientWidth || 900, vh = layer.clientHeight || 600;
  const w = el.offsetWidth || 220, h = el.offsetHeight || 120;
  el.style.left = Math.max(8, Math.min(x + 12, vw - w - 8)) + 'px';
  el.style.top = Math.max(64, Math.min(y - h / 2, vh - h - 8)) + 'px';
  _continentPopover = el;
  return el;
}

// v3 确认落笔口：Φ 只会口头建议「去大陆连接」；真正写边在这里，用户亲手点按钮。
// v4：一枚标签可能对应多条链路（同词跨 N 会话），所以按链路逐行列出、逐行落笔。
function _continentSharedPopover(s, ev) {
  const idx = _continentItemIndex();
  const links = (s.links || []).slice(0, 6);
  const userEdges = (_continentData && _continentData.userEdges) || [];
  const rows = links.map((link, i) => {
    const fromTitle = idx.items[link.from] || '（概念已不在）';
    const toTitle = idx.items[link.to] || '（概念已不在）';
    const fromCluster = idx.clusterTitles[link.fromSession] || '已删除的画布';
    const toCluster = idx.clusterTitles[link.toSession] || '已删除的画布';
    const already = userEdges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    return '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">「' + _continentEsc(fromCluster) + '」的 ' + _continentEsc(fromTitle) +
      ' ↔ 「' + _continentEsc(toCluster) + '」的 ' + _continentEsc(toTitle) + '</span>' +
      (already
        ? '<span class="continent-pop-note-inline">已连线</span>'
        : '<button class="continent-pop-btn" data-link="' + i + '">画成大陆边</button>') +
      '</div>';
  }).join('');
  const kindText = s.kind === 'formula'
    ? '两边画布的公式共享结构「' + _continentEsc(s.label) + '」'
    : (s.kind === 'family'
      ? '两边画布同属概念族「' + _continentEsc(s.label) + '」（族表给的领域关系，不靠字面撞车）'
      : '两边画布的概念标题共享「' + _continentEsc(s.label) + '」');
  const html =
    '<div class="continent-pop-title">' + _continentKindPrefix(s.kind) + _continentEsc(s.label) +
    (links.length > 1 ? ' <span class="continent-pop-count">×' + links.length + '</span>' : '') + '</div>' +
    rows +
    '<div class="continent-pop-desc">' + kindText + '——自动检出的共享点不会自动连线，要不要由你落笔。</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-link]').forEach(btn => btn.addEventListener('click', async () => {
    const link = links[Number(btn.getAttribute('data-link'))];
    if (!link) return;
    try {
      const ok = await _continentAddUserEdge(link.from, link.to, s.label);
      if (ok) { _continentClosePopover(); _continentToast('已画上这条大陆边'); }
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
}

// ---------- v5.1 重逢清单：点城市选去哪儿 ----------
// 铁律「跳转不猜」：一座城市连着 N 座岛就有 N 个目标，绝不替用户猜「最近学的」。
// 一岛一行（画布名 + 卡片名 + 学的时间 + 「去看」）；同一座岛有多张卡命中同一概念时
// 全部列出来（缩进次行、各带自己的「去看」）——词面命中是事实，不该被代表卡口径吞掉。
function _continentRelTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  if (typeof formatRelativeTime === 'function') {
    try { return formatRelativeTime(t); } catch (e) { /* 兜底空串 */ }
  }
  return '';
}

// ---------- 空画布说明：大陆只画有知识点的会话，没知识点的画布完全不上图 ----------
// 用户两次被「我的画布为什么不在大陆里」困扰（docs/日志/2026-09-15.md 排查段）——
// 顶栏把机制说清。灰色空岛明确不做（轻量版口径，见任务拆解）。
// 纯函数（无 DOM）：会话记录同时按 id / sessionId 两种标识比对（知识条目存的是
// sess_xxx 形，会话记录两个字段都有），两种标识都命中不了投影簇才算「还没知识点」。
function _continentEmptyCanvasCount(sessionRecords, clusterSessionIds) {
  const onMap = new Set((clusterSessionIds || []).map(s => String(s)));
  let n = 0;
  (sessionRecords || []).forEach(s => {
    if (!s) return;
    const id = String(s.id || '');
    const sid = String(s.sessionId || '');
    if ((!id || !onMap.has(id)) && (!sid || !onMap.has(sid))) n++;
  });
  return n;
}

// ---------- v5.4 岛牌一句话：前 3 个概念名 + 最近更新时间（纯拼接、不调模型） ----------
// 看懂岛是看懂联系的前提。以后接了 descriptor 槽位可升级成真摘要，拼接口径不变。
// rel 注入是为了 smoke 可测（formatRelativeTime 依赖当前时钟）。
function _continentIslandTagline(cluster, rel) {
  const items = (cluster && cluster.items) || [];
  const names = [];
  let latest = 0;
  (items || []).forEach(it => {
    const t = String((it && it.title) || '').trim();
    if (t && names.length < 3) names.push(t);
    const ts = Number(it && it.createdAt) || 0;
    if (ts > latest) latest = ts;
  });
  const when = latest ? (rel || _continentRelTime)(latest) : '';
  if (when) names.push(when);
  return names.join(' · ');
}

// ---------- v7.1a 海域层：图例 / 聚焦 / 手动纠正（改海域名 / 挪岛） ----------
// 图例回答「这块颜色是什么意思、谁说的」；聚焦只淡化不删不重排（地图的空间记忆是
// 资产）；纠正写 KV continent_regions（与 continent_edges 同通道），撤销栈兼容。

const CONTINENT_REGION_SOURCE_LABEL = {
  family: '按概念族推断',
  gate: 'Φ 归类',
  user: '你指定',
};

function _continentRegionSourceLabel(source) {
  return CONTINENT_REGION_SOURCE_LABEL[source] || CONTINENT_REGION_SOURCE_LABEL.family;
}

// 混合岛次要领域色点（岛牌主导领域徽标旁）：后端 domains[1] 概率 ≥ 0.25 才有——
// 「多标签」的可见形态，悬停显示分布
function _continentSecondaryDot(cluster, domainList) {
  const second = cluster && cluster.domains && cluster.domains[1];
  if (!second || !(Number(second.p) >= CONTINENT_CONF_LIGHT - 0.15)) return '';
  const hue = _continentRegionHue(second.name, domainList);
  return '<span class="continent-domain-dot" style="--region-h:' + hue + '"' +
    ' title="次要领域：' + _continentEsc(second.name) + '（' + Math.round(Number(second.p) * 100) + '%）"></span>';
}

// 图例本体（#continentLegend，挂在视口左下角——不与顶栏 #continentGuide/连接模式提示
// 争位，那是 v5.4 踩过的互斥坑）。自身可折叠（不许变成新的复杂度）。
function _continentRenderLegend(regionInfo, data) {
  const legend = document.getElementById('continentLegend');
  if (!legend) return;
  const regions = (regionInfo && regionInfo.regions) || [];
  const pending = (regionInfo && regionInfo.pending) || [];
  if (!regions.length && !pending.length) { legend.hidden = true; legend.innerHTML = ''; return; }
  legend.hidden = false;
  let collapsed = false;
  try { collapsed = localStorage.getItem('phymathia_continent_legend') === '1'; } catch (e) { /* 容忍 */ }
  const esc = _continentEsc;
  const items = regions.map(r => {
    const hueAttr = (r.hue !== null && r.hue !== undefined) ? ' style="--region-h:' + r.hue + '"' : '';
    const over = r.sessions.length > CONTINENT_REGION_CAPACITY
      ? '<span class="continent-region-over" title="这片海域超过 ' + CONTINENT_REGION_CAPACITY +
        ' 座岛，地图还能画，但可以考虑拆成子海域">超容量</span>' : '';
    return '<li class="continent-legend-item' + (_continentLegendFocus === r.key ? ' is-active' : '') + '"' +
      hueAttr + ' data-region="' + esc(r.key) + '" title="点一下聚焦这片海域（其他海域淡出，再点恢复）">' +
      '<span class="continent-legend-chip"></span>' +
      '<span class="continent-legend-name">' + esc(r.name) + '</span>' +
      '<span class="continent-legend-count">' + r.sessions.length + ' 岛 · ' + r.itemCount + ' 卡</span>' +
      over +
      '<span class="continent-legend-src">' + esc(_continentRegionSourceLabel(r.source)) + '</span>' +
      (r.merged ? '' : '<button class="continent-legend-rename" data-rename="' + esc(r.key) +
        '" title="给这片海域改个名（只改显示名，颜色与归类不变）">改名</button>') +
      '</li>';
  }).join('');
  const totalIslands = ((data && data.clusters) || []).length;
  const pendingRatio = totalIslands ? Math.round(pending.length * 100 / totalIslands) : 0;
  // 负载均衡提示（MoE 的 aux loss 位：只提示不硬拆——均衡不是目标，可读才是）：
  // 某领域吃掉 >35% 的卡且库 ≥30 卡时提一句「可拆子海域」，拆不拆用户说了算
  let shareHint = '';
  const totalCards = (data && data.itemCount) || 0;
  if (totalCards >= 30) {
    const biggest = regions.reduce((a, b) => (!a || b.itemCount > a.itemCount) ? b : a, null);
    if (biggest && biggest.itemCount / totalCards > CONTINENT_GATE_DOMINANT_SHARE) {
      shareHint = '「' + biggest.name + '」占了 ' +
        Math.round(biggest.itemCount * 100 / totalCards) + '% 的卡片——海域过大可拆子海域';
    }
  }
  const footBits = [];
  if (pending.length) {
    footBits.push('低置信 ' + pending.length + '/' + totalIslands + '（' + pendingRatio +
      '%）——占比高说明领域名单或词表该补了');
  }
  if (shareHint) footBits.push(shareHint);
  legend.innerHTML =
    '<div class="continent-legend-head">' +
      '<span class="continent-legend-title">图例' + (collapsed ? ' ▸' : ' ▾') + '</span>' +
      (pending.length
        ? '<button class="continent-legend-pending" data-pending>待确认 ' + pending.length + ' 座岛</button>'
        : '') +
    '</div>' +
    (collapsed ? '' :
      '<ul class="continent-legend-list">' + items + '</ul>' +
      (footBits.length ? '<div class="continent-legend-foot">' + esc(footBits.join('；')) + '</div>' : ''));
  const toggle = legend.querySelector ? legend.querySelector('.continent-legend-head') : null;
  if (toggle) toggle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    try {
      localStorage.setItem('phymathia_continent_legend',
        localStorage.getItem('phymathia_continent_legend') === '1' ? '0' : '1');
    } catch (err) { /* 容忍 */ }
    _continentRenderLegend(_continentRegionInfo, data);
  });
  (legend.querySelectorAll ? legend.querySelectorAll('[data-region]') : []).forEach(li =>
    li.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentToggleLegendFocus(li.getAttribute('data-region'));
    }));
  (legend.querySelectorAll ? legend.querySelectorAll('[data-rename]') : []).forEach(btn =>
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentRenameRegionMenu(e, btn.getAttribute('data-rename'));
    }));
  const pendingBtn = legend.querySelector ? legend.querySelector('[data-pending]') : null;
  if (pendingBtn) pendingBtn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    _continentPendingPopover(e);
  });
}

// 聚焦：只淡化不删不重排——地图的空间记忆（哪片在哪）是用户的资产
function _continentToggleLegendFocus(key) {
  _continentLegendFocus = (_continentLegendFocus === key) ? '' : String(key || '');
  _continentApplyFocus();
  if (_continentRegionInfo && _continentData) {
    _continentRenderLegend(_continentRegionInfo, _continentData);
  }
}

function _continentApplyFocus() {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  const key = _continentLegendFocus;
  const info = _continentRegionInfo || { bySid: {} };
  world.classList.toggle('is-focused', !!key);
  const regionOf = sid => (info.bySid[sid] || {}).key;
  world.querySelectorAll('.continent-region').forEach(el =>
    el.classList.toggle('is-dim', !!key && el.dataset.region !== key));
  world.querySelectorAll('.continent-cluster').forEach(el =>
    el.classList.toggle('is-dim', !!key && regionOf(el.dataset.sessionId) !== key));
  world.querySelectorAll('.continent-node').forEach(el =>
    el.classList.toggle('is-dim', !!key && regionOf(el.dataset.sessionId) !== key));
  const dimBySids = el => {
    const sids = String(el.getAttribute('data-sids') || '').split(',').filter(Boolean);
    el.classList.toggle('is-dim', !!key && !sids.some(sid => regionOf(sid) === key));
  };
  world.querySelectorAll('.continent-city').forEach(dimBySids);
  world.querySelectorAll('.continent-spoke').forEach(dimBySids);
}

// 归到哪个领域：25 个领域 + 不归类，一步落笔（不做拖拽——画布平移已占用 pointerdown，
// v2 踩过 setPointerCapture 把 pointerup 重定向的坑）
function _continentDomainMenu(ev, sid) {
  const data = _continentData || {};
  const list = (data.domainList || []).slice();
  const override = (_continentRegionOverrides && _continentRegionOverrides.assign) || {};
  const hadOverride = Object.prototype.hasOwnProperty.call(override, sid);
  const current = hadOverride ? override[sid]
    : ((((data.clusters || []).find(c => c.sessionId === sid) || {}).domain) || null);
  const esc = _continentEsc;
  const rows = list.map(d =>
    '<button class="continent-pop-btn' + (d === current ? ' is-current' : '') +
    '" data-assign="' + esc(d) + '">' + esc(d) +
    (d === current ? '（当前）' : '') + '</button>').join('');
  const html =
    '<div class="continent-pop-title">这座岛归到哪个领域？</div>' +
    '<div class="continent-pop-desc">你的指派优先于机器判断（Φ 归类 / 概念族推断），写进大陆记忆；Ctrl+Z 可撤销。</div>' +
    '<div class="continent-pop-actions is-wrap">' + rows +
    '<button class="continent-pop-btn is-danger" data-assign="">不归类</button></div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-assign]').forEach(btn => btn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const domain = btn.getAttribute('data-assign') || null;
    _continentClosePopover();
    _continentAssignRegion(sid, domain, hadOverride ? current : undefined);
  }));
}

async function _continentAssignRegion(sid, domain, before) {
  const next = _continentCopyRegionOverrides();
  if (domain) next.assign[sid] = domain;
  else next.assign[sid] = null;   // 「不归类」也是一条用户决定（盖过机器）
  try {
    await _continentCommitRegionOverrides(next,
      { type: 'region', kind: 'assign', sid: sid, before: before });
    _continentToast(domain ? '已归到「' + domain + '」（Ctrl+Z 可撤销）' : '已改为不归类（Ctrl+Z 可撤销）');
  } catch (err) {
    _continentToast('保存失败：' + (err && err.message || err));
  }
}

// 海域名修改：只改显示名，色槽与归类键不变（颜色跟规范名走，改名不换色）
function _continentRenameRegionMenu(ev, key) {
  const renames = (_continentRegionOverrides && _continentRegionOverrides.renames) || {};
  const before = Object.prototype.hasOwnProperty.call(renames, key) ? renames[key] : undefined;
  const esc = _continentEsc;
  const html =
    '<div class="continent-pop-title">海域改名</div>' +
    '<div class="continent-pop-row"><input class="continent-pop-input" data-rename-input' +
    ' value="' + esc(renames[key] || key) + '" maxlength="16" placeholder="' + esc(key) + '"></div>' +
    '<div class="continent-pop-actions">' +
      '<button class="continent-pop-btn" data-rename-save>保存</button>' +
      (before !== undefined ? '<button class="continent-pop-btn is-quiet" data-rename-reset>还原默认名</button>' : '') +
    '</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  const input = el.querySelector('[data-rename-input]');
  if (input && input.focus) { try { input.focus(); } catch (e) { /* 容忍 */ } }
  const save = async name => {
    _continentClosePopover();
    const next = _continentCopyRegionOverrides();
    if (name) next.renames[key] = name;
    else delete next.renames[key];
    try {
      await _continentCommitRegionOverrides(next,
        { type: 'region', kind: 'rename', key: key, before: before });
      _continentToast('海域已改名（Ctrl+Z 可撤销）');
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  };
  const saveBtn = el.querySelector('[data-rename-save]');
  if (saveBtn) saveBtn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    save(input ? String(input.value || '').trim().slice(0, 16) : '');
  });
  const resetBtn = el.querySelector('[data-rename-reset]');
  if (resetBtn) resetBtn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    save('');
  });
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save(String(input.value || '').trim().slice(0, 16));
  });
}

// 待确认清单（低置信岛）：每行「岛名 → 最优猜测（置信度）」+ 快捷指派——「不确定也
// 要可见」的落点，机器不确定的事交给人一锤定音。v7.1b 起，Φ 归类跑出的建议（新领域
// 提名 / 归并组）也落在这里等确认——模型只建议，落笔权永远在用户
function _continentPendingPopover(ev) {
  const info = _continentRegionInfo || {};
  const pending = info.pending || [];
  const esc = _continentEsc;
  const rows = pending.map(p =>
    '<div class="continent-pop-row">' +
    '<span class="continent-pop-row-text">' + esc(p.title || p.sid) +
    ' <span class="continent-pop-reason">' + esc(p.domain) + '（' +
    Math.round((Number(p.conf) || 0) * 100) + '%）</span></span>' +
    '<button class="continent-pop-btn is-quiet" data-pending-sid="' + esc(p.sid) + '">指派领域</button>' +
    '</div>').join('');
  const sug = _continentGateSuggestions;
  let sugHtml = '';
  if (sug) {
    const mergeRows = (sug.merges || []).map((m, i) =>
      '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">Φ 说这几张是一回事：<b>' + esc(m.name) + '</b>' +
      ' <span class="continent-pop-reason">' + (m.titles || []).map(esc).join(' / ') + '</span></span>' +
      '<button class="continent-pop-btn" data-adopt="' + i + '">采纳进族表</button>' +
      '</div>').join('');
    const newRows = (sug.newDomains || []).length
      ? '<div class="continent-pop-desc">名单缺领域：' + sug.newDomains.map(esc).join('、') +
        '——领域名单是固定的，可在数据面板的概念族表里补（补完旧打标自动作废重打）。</div>'
      : '';
    sugHtml = '<div class="continent-pop-title" style="margin-top:6px">Φ 的建议（待你确认）</div>' + mergeRows + newRows;
  }
  const html =
    '<div class="continent-pop-title">待确认 ' + pending.length + ' 座岛</div>' +
    '<div class="continent-pop-desc">这些岛的领域归属置信度低于 40%——机器拿不准的，你一锤定音（指派后进对应海域、Ctrl+Z 可撤销）。</div>' +
    (rows || '<div class="continent-pop-desc">暂时没有待确认的岛。</div>') +
    sugHtml;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-pending-sid]').forEach(btn =>
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentDomainMenu(e, btn.getAttribute('data-pending-sid'));
    }));
  el.querySelectorAll('[data-adopt]').forEach(btn =>
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const m = (_continentGateSuggestions && _continentGateSuggestions.merges || [])
        [Number(btn.getAttribute('data-adopt'))];
      if (m) _continentAdoptGateMerge(m);
    }));
}

function _continentCopyRegionOverrides() {
  const src = _continentRegionOverrides || {};
  const renames = {}, assign = {};
  Object.keys(src.renames || {}).forEach(k => { renames[k] = src.renames[k]; });
  Object.keys(src.assign || {}).forEach(k => { assign[k] = src.assign[k]; });
  return { renames: renames, assign: assign };
}

async function _continentLoadRegionOverrides() {
  try {
    const resp = await fetch(CONTINENT_REGIONS_API, { cache: 'no-cache' });
    if (!resp.ok) return;
    const data = await resp.json();
    const v = (data && data.value) || {};
    _continentRegionOverrides = {
      renames: (v && typeof v.renames === 'object' && !Array.isArray(v.renames)) ? v.renames : {},
      assign: (v && typeof v.assign === 'object' && !Array.isArray(v.assign)) ? v.assign : {},
    };
  } catch (e) { /* 查空是正常路径：没写过就是空覆盖 */ }
}

async function _continentCommitRegionOverrides(next, undoEntry) {
  const resp = await fetch(CONTINENT_REGIONS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: next }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  if (undoEntry) _continentEdgeUndo.push(undoEntry);
  _continentRegionOverrides = next;
  _continentLegendFocus = '';  // 分组可能变了，聚焦态不作数
  if (_continentOpen && _continentData) _continentRender(_continentData);  // 归属变了 → 重排重渲
  _continentUpdateTools();
}

// 撤销「海域操作」：assign 的 before=undefined 表示原本没有覆盖（撤销=删键）；
// rename 的 before=undefined 表示原本用默认名（撤销=删改名）
async function _continentUndoRegionOp(op) {
  const next = _continentCopyRegionOverrides();
  if (op.kind === 'assign') {
    if (op.before === undefined || op.before === null) delete next.assign[op.sid];
    else next.assign[op.sid] = op.before;
  } else if (op.kind === 'rename') {
    if (op.before === undefined || op.before === null) delete next.renames[op.key];
    else next.renames[op.key] = op.before;
  }
  await _continentCommitRegionOverrides(next);
}

// ---------- v7.1b MoE 门控：Φ 批量归类（读内容，补「查词典」做不到的两类） ----------
// 本地词面门控（评分核心）零成本永远可用，但救不了两类：词表没列的新术语（康普顿
// 散射）、泛名/上位词（质能关系）——Φ 读「标题+摘要+公式」补这层。铁律：
// 触发不自动（打开大陆不烧调用，点了才跑）；名单固定（模型只能从给定名单选，想加
// 领域只能进「建议」待用户确认）；产物落盘带版本与内容 hash（增量重打）；判读失败
// 不写脏数据。通道复用 /api/models/chat 的 stream:false（与「问 Φ」同口径）。
const CONTINENT_GATE_API = '/api/kv/continent_gate';
const CONTINENT_GATE_BATCH = 40;
const CONTINENT_GATE_DOMINANT_SHARE = 0.35;  // 负载均衡提示线（不是硬拆）
let _continentGateCtrl = null;               // 在途批量归类的中止器（关大陆即中止）
let _continentGateSuggestions = null;        // 上次跑完的建议 {newDomains:[], merges:[{name,ids,titles}]}

// 卡片内容指纹：标题+摘要+公式变了才重打（缓存三层的 hash 一环）
function _continentGateHash(card) {
  const key = [card && card.title || '', card && card.summary || '', card && card.formula || '']
    .join('\u0001');
  return _continentStrHash(key).toString(36);
}

// 批量归类的提示词（system+user 两条都写契约——模型对最后一条更敏感，v5.3 的教训）
function _continentGateMessages(cards, domainList) {
  const list = (domainList || []).join('、');
  const lines = (cards || []).map(c =>
    '- ' + c.id + '｜' + c.title + (c.summary ? '｜' + c.summary : '') +
    (c.formula ? '｜' + c.formula : ''));
  const user = [
    '给下面每张知识卡片选 1–2 个领域（只能从给定名单里选），并给 0 到 1 的置信度。',
    '领域名单：' + list,
    '卡片：',
  ].concat(lines).concat([
    '',
    '输出严格的 JSON 数组，每项形如：{"id":"卡片id","domains":[{"name":"名单里的领域","conf":0.9}],"new":[]}',
    '某张卡在名单里找不到合适领域时：它的 domains 留空，把建议的新领域名（不超过 6 个字）放进 new 数组。',
    '如果发现几张卡讲的是同一个概念（同义或译名变体），另加一项：{"merge":{"name":"规范名","ids":["id1","id2"]}}。',
    '宁缺毋滥：拿不准就给低置信度或留空。只输出 JSON，不要任何其他文字。',
  ]).join('\n');
  return [
    { role: 'system',
      content: '你是知识大陆的门控路由器：只从给定的领域名单里选择，输出严格 JSON 数组，不要任何其他文字。' },
    { role: 'user', content: user },
  ];
}

// 判读（纯函数）：剥思考块与代码围栏 → 取首个 [ 到末个 ] 的片段 → JSON.parse →
// 名单外领域丢弃、conf 夹取、每卡至多 2 个领域、merge 组的 ids 必须都在本批内。
// 任何一步失败都返回空产物（该批保持本地归属，不写脏数据）
function _continentGateParse(raw, cardIds, domainList) {
  const out = { labels: {}, newDomains: [], merges: [] };
  const ids = new Set(cardIds || []);
  const allowed = new Set(domainList || []);
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch (e) { return out; }
  if (!Array.isArray(arr)) return out;
  arr.forEach(row => {
    if (row && typeof row === 'object' && row.merge && row.merge.name
        && Array.isArray(row.merge.ids)) {
      const mIds = row.merge.ids.map(String).filter(id => ids.has(id));
      if (mIds.length >= 2) {
        out.merges.push({ name: String(row.merge.name).trim().slice(0, 16), ids: mIds });
      }
      return;
    }
    if (!row || typeof row !== 'object' || !ids.has(String(row.id))) return;
    const doms = Array.isArray(row.domains) ? row.domains : [];
    const good = [];
    doms.slice(0, 2).forEach(d => {
      if (!d || typeof d !== 'object') return;
      const name = String(d.name || '').trim();
      if (!allowed.has(name)) return;
      let conf = Number(d.conf);
      if (!Number.isFinite(conf)) conf = 0;
      conf = Math.min(1, Math.max(0, conf));
      if (conf > 0 && !good.some(g => g.name === name)) good.push({ name: name, conf: conf });
    });
    if (good.length) out.labels[String(row.id)] = good;
    (Array.isArray(row.new) ? row.new : []).forEach(n => {
      const s = String(n || '').trim().slice(0, 16);
      if (s && !allowed.has(s) && out.newDomains.indexOf(s) < 0) out.newDomains.push(s);
    });
  });
  return out;
}

// 待打标卡片：归属缺失（domain=null）或低置信（<0.4）的岛上的卡；内容 hash 没变的
// 跳过（增量）。已有可靠归属的岛不烧调用——Φ 只补本地门控做不到的那部分
function _continentGatePendingCards(clusters, entries) {
  const out = [];
  (clusters || []).forEach(c => {
    const conf = Number(c.domainConf) || 0;
    if (c.domain && conf >= CONTINENT_CONF_LIGHT) return;
    (c.items || []).forEach(it => {
      if (!it || !it.itemId) return;
      const e = entries && entries[it.itemId];
      if (e && e.hash === _continentGateHash(it)) return;
      out.push({ id: it.itemId, title: it.title || '', summary: it.summary || '',
                 formula: String(it.formula || '').slice(0, 80) });
    });
  });
  return out;
}

// 批量归类主流程：分批（40/批）→ 每批判读 → **每批落盘**（中断不丢已完成的）→
// 全部结束刷新投影（后端把 gate KV 合进同一层分区，来源标记变「Φ 归类」）
async function _continentGateClassify() {
  const data = _continentData;
  if (!data) return;
  const model = (typeof getActiveModelForRole === 'function')
    ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
  if (!model) { _continentToast('先在「模型设置」里配置主模型，Φ 才能归类'); return; }
  if (typeof proxyChatWithModel !== 'function') { _continentToast('模型代理通道不可用'); return; }
  const btn = document.getElementById('continentGateBtn');
  const setBtn = txt => { if (btn) { btn.disabled = true; btn.textContent = txt; } };
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  _continentGateCtrl = ctrl;
  try {
    // 读现有 gate KV：版本一致才沿用条目（名单/权重变了整批作废重打）
    let entries = {};
    try {
      const r = await fetch(CONTINENT_GATE_API, { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const v = j && j.value;
        if (v && typeof v === 'object' && v.version === data.gateVersion
            && v.entries && typeof v.entries === 'object') entries = v.entries;
      }
    } catch (e) { /* 读不到就当全新跑 */ }
    const pending = _continentGatePendingCards(data.clusters, entries);
    if (!pending.length) { _continentToast('没有需要 Φ 归类的卡片'); return; }
    const domainList = data.domainList || [];
    const kv = { version: data.gateVersion, entries: entries };
    const newDomains = [], merges = [];
    let done = 0, failed = 0;
    for (let i = 0; i < pending.length; i += CONTINENT_GATE_BATCH) {
      if (ctrl && ctrl.signal.aborted) break;
      const batch = pending.slice(i, i + CONTINENT_GATE_BATCH);
      setBtn('Φ 归类中 ' + Math.min(i + batch.length, pending.length) + '/' + pending.length);
      try {
        const resp = await proxyChatWithModel(model, {
          messages: _continentGateMessages(batch, domainList), stream: false,
        }, ctrl ? ctrl.signal : undefined);
        const j = await resp.json();
        const raw = j && j.choices && j.choices[0] && j.choices[0].message
          ? j.choices[0].message.content : '';
        const parsed = _continentGateParse(raw, batch.map(c => c.id), domainList);
        Object.keys(parsed.labels).forEach(id => {
          const card = batch.find(c => c.id === id) || {};
          kv.entries[id] = { hash: _continentGateHash(card),
                             domains: parsed.labels[id], at: Date.now() };
          done++;
        });
        parsed.newDomains.forEach(n => { if (newDomains.indexOf(n) < 0) newDomains.push(n); });
        parsed.merges.forEach(m => {
          m.titles = m.ids.map(id => {
            const card = (data.clusters || []).flatMap(c => c.items || [])
              .find(it => it.itemId === id);
            return card ? String(card.title || '') : '';
          }).filter(Boolean);
          merges.push(m);
        });
        // 每批落盘：中断后已完成的批照常保留（部分成果不丢，下次接着跑）
        await fetch(CONTINENT_GATE_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: kv }),
        });
      } catch (err) {
        if (err && err.name === 'AbortError') break;
        failed += batch.length;
      }
    }
    // 刷新投影：后端把 gate KV 合进分区，图例来源标记变「Φ 归类」
    try {
      const fresh = await _continentFetchData();
      _continentData = fresh;
      if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
    } catch (e) { /* 刷新失败不丢已落盘的产物，下次打开自然生效 */ }
    _continentGateSuggestions = (newDomains.length || merges.length)
      ? { newDomains: newDomains, merges: merges } : null;
    let msg = 'Φ 已归类 ' + done + ' 张';
    if (failed) msg += '，' + failed + ' 张失败（可再点一次重试）';
    if (_continentGateSuggestions) msg += '；有建议待你确认（图例 · 待确认）';
    _continentToast(msg);
  } finally {
    _continentGateCtrl = null;
    if (btn) { btn.disabled = false; }
    _continentUpdateTools();
  }
}

// 采纳归并建议：写进 continent_families（与内置族同一条汇聚通道——从此会积累）。
// terms 用这几张卡的标题：族匹配跑标题，同款/子串变体今后自动归族
async function _continentAdoptGateMerge(m) {
  const terms = [];
  (m.titles || []).forEach(t => {
    const s = String(t || '').trim().slice(0, 24);
    if (s.length >= 2 && terms.indexOf(s) < 0) terms.push(s);
  });
  if (!terms.length) { _continentToast('这条建议没有可用的术语'); return; }
  let families = [];
  try {
    const r = await fetch('/api/kv/continent_families', { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      const v = j && j.value;
      families = (v && Array.isArray(v.families)) ? v.families : (Array.isArray(v) ? v : []);
    }
  } catch (e) { /* 读不到就当空表 */ }
  const next = families.filter(f => !f || f.canonical !== m.name);
  next.push({ canonical: m.name, terms: terms, source: 'user' });
  try {
    await fetch('/api/kv/continent_families', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { families: next } }),
    });
    // 建议从清单里划掉（其余保留）
    if (_continentGateSuggestions && _continentGateSuggestions.merges) {
      _continentGateSuggestions.merges =
        _continentGateSuggestions.merges.filter(x => x !== m);
      if (!_continentGateSuggestions.merges.length && !_continentGateSuggestions.newDomains.length) {
        _continentGateSuggestions = null;
      }
    }
    const fresh = await _continentFetchData();
    _continentData = fresh;
    if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
    _continentToast('已采纳归并「' + m.name + '」——写进概念族表，从此会积累');
  } catch (err) {
    _continentToast('保存失败：' + (err && err.message || err));
  }
}

// 该岛命中这条共享概念的全部卡（服务端未给 owners 时退回代表卡一张）
function _continentIslandCards(entry, sessionId, fallbackItemId, idx) {
  const owners = (entry && entry.owners) || [];
  const itemSession = (idx && idx.itemSession) || {};
  const mine = owners.filter(iid => itemSession[iid] === sessionId);
  if (!mine.length) return fallbackItemId ? [fallbackItemId] : [];
  const rep = mine.indexOf(fallbackItemId);
  if (rep > 0) { mine.splice(rep, 1); mine.unshift(fallbackItemId); }  // 代表卡排最前（辐条连的就是它）
  return mine;
}

// 重逢清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentReunionRows(city, idx) {
  const items = (idx && idx.items) || {};
  const clusterTitles = (idx && idx.clusterTitles) || {};
  const itemCreated = (idx && idx.itemCreated) || {};
  const rel = (idx && idx.rel) || _continentRelTime;
  const rows = [];
  ((city && city.reps) || []).forEach(r => {
    const sid = r.sessionId;
    const cards = _continentIslandCards(city && city.entry, sid, r.itemId, idx);
    cards.forEach((iid, k) => {
      const when = rel(itemCreated[iid]);
      const head = k === 0
        ? '<span class="continent-pop-place">' + _continentEsc(clusterTitles[sid] || '已删除的画布') + '</span> · '
        : '<span class="continent-pop-sub">同岛还有</span> ';
      rows.push('<div class="continent-pop-row' + (k === 0 ? '' : ' is-sub') + '">' +
        '<span class="continent-pop-row-text">' + head + _continentEsc(items[iid] || '（概念已不在）') +
        (when ? '<span class="continent-pop-when">' + _continentEsc(when) + '</span>' : '') +
        '</span>' +
        '<button class="continent-pop-btn" data-go="' + _continentEsc(sid) + '"' +
        ' data-item="' + _continentEsc(iid) + '">去看</button>' +
        '</div>');
    });
  });
  return rows.join('');
}

function _continentCityPopover(city, ev) {
  const idx = _continentItemIndex();
  const s = (city && city.entry) || {};
  const reps = (city && city.reps) || [];
  const rows = _continentReunionRows(city, idx);
  // 「画成大陆边」= v3 起的用户确认落笔口（Φ 只会口头建议，真要写边得你点）。
  // 一枚芯片 = 一条链路（两块画布的代表卡之间）；已连过的只标「已连线」。
  const links = (s.links || []).slice(0, 6);
  const userEdges = (_continentData && _continentData.userEdges) || [];
  const chips = links.map((link, i) => {
    const already = userEdges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(idx.clusterTitles[link.fromSession] || '已删除的画布');
    const b = _continentEsc(idx.clusterTitles[link.toSession] || '已删除的画布');
    return '<button class="continent-pop-btn is-quiet" data-link="' + i + '"' +
      ' title="把这两块画布的代表卡连成一条我的大陆边">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  const html =
    '<div class="continent-pop-title">' + _continentKindPrefix(s.kind) + _continentEsc(s.label || '') +
    '<span class="continent-pop-count">' + reps.length + ' 块画布</span></div>' +
    (rows || '<div class="continent-pop-desc">这座城市的卡片已不在大陆上了。</div>') +
    '<div class="continent-pop-desc">' +
    (s.kind === 'formula'
      ? '这几块画布的公式共享结构「' + _continentEsc(s.label || '') + '」'
      : (s.kind === 'family'
        ? '这几块画布同属概念族「' + _continentEsc(s.label || '') + '」（领域知识层认出的同族关系）'
        : '这几块画布的概念标题共享「' + _continentEsc(s.label || '') + '」')) +
    '——机器检出的共享点不会自动连线。</div>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '');
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-go]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const sid = btn.getAttribute('data-go');
    const iid = btn.getAttribute('data-item');
    _continentClosePopover();
    enterContinentSession(sid, iid);   // 复用下钻转场 + goToKnowledgeNode 直达定位
  }));
  el.querySelectorAll('[data-link]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const link = links[Number(btn.getAttribute('data-link'))];
    if (!link) return;
    try {
      const ok = await _continentAddUserEdge(link.from, link.to, s.label);
      if (ok) { _continentClosePopover(); _continentToast('已画上这条大陆边'); }
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
}

// v4 折叠清单：没画到地图上的那些在这里照报，逐条可确认并亲手落笔。
// 原因口径见 CONTINENT_FOLD_REASON（v5.1 起四种，v5.5 加第五种「已被更具体的城市
// 覆盖」：弱证据 / 覆盖 / 超每对上限 / 超全图上限 / 无位可放）。地图负责概览，
// 清单负责穷尽——谁也不伪装成对方，更不许静默消失。

// ---------- v5.3 问 Φ：机器没把握的，交给 Φ 说一句人话，落笔权永远在用户 ----------
// 通道取舍：走 /api/models/chat 的 stream:false（与知识摘要优化同一口径），模型选
// Φ 助手槽位（graph，未配置回退主模型）——/api/harness 的评审协议是改图导向
// （messages 按评审/扩展/应用四套固定模板组装、输出走操作白名单），没有裸问答口，
// 折叠行的「两条知识点是否真相关」判断用它反而要绕开整套操作协议。
// 提示词、判读、判断块拼装都是纯函数（无 DOM），单独抽出来给 smoke 断言。

// Φ 必须以「值得连：」或「不建议连：」开头——输出契定了，判读才不是猜谜。
// 格式约定在 system 与 user 两条消息里都写（模型对最后一条更敏感）。
function _continentPhiMessages(left, right, label) {
  const lines = [
    '用户在知识大陆的折叠清单里看到一条机器没把握的跨画布联系，请你判断这两条知识点是否真的相关（值得在地图上画一条连线），还是只是字面相撞。',
    '',
    '共享词：' + (label || '（无）'),
    '第一条：' + ((left && left.title) || '（无标题）') + ((left && left.summary) ? '——' + left.summary : ''),
    '第二条：' + ((right && right.title) || '（无标题）') + ((right && right.summary) ? '——' + right.summary : ''),
    '',
    '注意：共享词可能是「表达」「坐标」这类通用词，判断依据是两条知识的实质内容，不是共享词本身。',
    '只输出一行：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。',
  ].join('\n');
  return [
    { role: 'system', content: '你是知识大陆的助手 Φ。只输出一行判断：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。不要输出任何其他内容。' },
    { role: 'user', content: lines },
  ];
}

// 判读：只认第一行的开头两个约定词；判不出给中性档——判读只影响徽标与语气，
// 芯片（用户落笔口）两种档位都照给。
function _continentPhiVerdict(raw) {
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/<[^>]+>/g, ' ').replace(/\*\*/g, '');
  const firstLine = (text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
  let verdict = 'unknown';
  if (firstLine.indexOf('值得连') === 0) verdict = 'worth';
  else if (firstLine.indexOf('不建议连') === 0) verdict = 'not';
  const reason = firstLine.replace(/^[「『"']?(值得连|不建议连)[」』"']?[：:、]?\s*/, '').trim();
  return { verdict: verdict, text: (reason || firstLine).slice(0, 120) };
}

// 判断块 HTML：徽标（三档）+ 理由 + 每条链路一枚「画成大陆边」芯片（已连线只标注）。
// userEdges 由调用方传入（smoke 不依赖模块状态）。
function _continentPhiBlockHtml(entry, verdict, idx, userEdges) {
  const items = (idx && idx.items) || {};
  const edges = userEdges || [];
  const worth = verdict && verdict.verdict === 'worth';
  const not = verdict && verdict.verdict === 'not';
  const badge = worth ? '值得连' : not ? '不建议连' : 'Φ 的判断';
  const links = ((entry && entry.links) || []).slice(0, 6);
  const chips = links.map((link, i) => {
    const already = edges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(items[link.from] || '？');
    const b = _continentEsc(items[link.to] || '？');
    return '<button class="continent-pop-btn is-quiet" data-phi-link="' + i + '"' +
      ' title="把这两条概念连成一条我的大陆边（Ctrl+Z 可撤销）">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  return '<div class="continent-pop-phi">' +
    '<span class="continent-pop-phi-badge' + (worth ? ' is-worth' : '') + (not ? ' is-not' : '') + '">' + badge + '</span> ' +
    '<span class="continent-pop-phi-text">' + _continentEsc((verdict && verdict.text) || '') + '</span>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '') +
    '</div>';
}

// 芯片点击 = 走 v2 既有落笔通道（KV continent_edges）；清单不关——折叠清单是
// 工作清单，用户要连着过好几条，这行就地变「已连线」。绑定按 dataset 防重：
// 新判断块插入后按整个弹层查询绑定，上一块的芯片不能被二次挂 handler。
function _continentBindPhiChips(scope, entry) {
  if (!scope || !scope.querySelectorAll) return;
  const links = ((entry && entry.links) || []).slice(0, 6);
  scope.querySelectorAll('[data-phi-link]').forEach(btn => {
    if (btn.dataset) {
      if (btn.dataset.phiBound) return;
      btn.dataset.phiBound = '1';
    }
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const link = links[Number(btn.getAttribute('data-phi-link'))];
      if (!link) return;
      try {
        const ok = await _continentAddUserEdge(link.from, link.to, entry.label || '');
        if (ok) {
          const span = document.createElement('span');
          span.className = 'continent-pop-note-inline';
          span.textContent = '已连线';
          if (btn.replaceWith) btn.replaceWith(span); else btn.textContent = '已连线';
          _continentToast('已画上这条大陆边（Ctrl+Z 可撤销）');
        }
      } catch (err) {
        _continentToast('保存失败：' + (err && err.message || err));
      }
    });
  });
}

// 单行「问 Φ」：按钮进忙碌态 → /api/models/chat（stream:false）→ 判断块插到该行
// 下方。弹层已换页/关闭时回包静默丢弃（判断没处落）；失败恢复按钮可重问。
async function _continentAskPhi(f, rowIndex, btn) {
  const entry = (f && f.entry) || {};
  const link = (entry.links || [])[0] || {};
  const idx = _continentItemIndex();
  const model = (typeof getActiveModelForRole === 'function')
    ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
  if (!model) { _continentToast('先在「模型设置」里配置主模型，才能问 Φ'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Φ 看着…'; }
  const popover = _continentPopover;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (ctrl) _continentPhiInflight.add(ctrl);
  try {
    const left = { title: idx.items[link.from] || '', summary: idx.itemSummary[link.from] || '' };
    const right = { title: idx.items[link.to] || '', summary: idx.itemSummary[link.to] || '' };
    if (typeof proxyChatWithModel !== 'function') throw new Error('模型代理通道不可用');
    const resp = await proxyChatWithModel(model, {
      messages: _continentPhiMessages(left, right, entry.label || ''),
      stream: false,
    }, ctrl ? ctrl.signal : undefined);
    const data = await resp.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    if (!popover || _continentPopover !== popover) return;  // 弹层已关/换页
    const v = _continentPhiVerdict(raw);
    const row = popover.querySelector ? popover.querySelector('[data-fold="' + rowIndex + '"]') : null;
    const html = _continentPhiBlockHtml(entry, v, idx, (_continentData && _continentData.userEdges) || []);
    if (row && row.insertAdjacentHTML) {
      row.insertAdjacentHTML('afterend', html);
    } else if (popover.insertAdjacentHTML) {
      popover.insertAdjacentHTML('beforeend', html);
    }
    _continentBindPhiChips(popover, entry);
    if (btn) { btn.textContent = 'Φ 已答'; btn.disabled = true; }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    _continentToast('Φ 判断失败：' + (err && err.message || err));
    if (btn) { btn.disabled = false; btn.textContent = '问 Φ'; }
  } finally {
    if (ctrl) _continentPhiInflight.delete(ctrl);
  }
}

// 折叠清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentFoldedRows(folded, idx) {
  const items = (idx && idx.items) || {};
  return (folded || []).map((f, i) => {
    const s = f.entry || {};
    const link = (s.links || [])[0] || {};
    return '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">' + _continentKindPrefix(s.kind) + _continentEsc(s.label) +
      ' · ' + _continentEsc(items[link.from] || '？') + ' ↔ ' + _continentEsc(items[link.to] || '？') +
      ' <span class="continent-pop-reason">' + (CONTINENT_FOLD_REASON[f.reason] || '折叠') + '</span></span>' +
      '<button class="continent-pop-btn is-quiet" data-phi="' + i + '" title="让 Φ 判断这两条是否真的相关">问 Φ</button>' +
      '<button class="continent-pop-btn" data-fold="' + i + '">看两边</button>' +
      '</div>';
  }).join('');
}

function _continentFoldedPopover(ev) {
  const idx = _continentItemIndex();
  const folded = _continentFolded || [];
  const rows = _continentFoldedRows(folded, idx);
  const html =
    '<div class="continent-pop-title">折叠 ' + folded.length + ' 条</div>' +
    '<div class="continent-pop-desc">「弱证据」是 2 字共享串（「表达」「坐标」级）与泛后缀，' +
    '单独立不住——但它照旧参与岛屿摆位；「已被更具体的城市覆盖」是这条共享串只出现在' +
    '更具体的那几个概念名中间（如两条「…守恒定律」之间的「量守恒定律」），地图交给更' +
    '具体的那几座城；「超出每对上限」「超出全图上限」是地图已经画满；「无位可放」是岛之间挤不出' +
    '放得下一座城市的位置（城市绝不叠在岛上）。都不上地图，但照报——' +
    '拿不准就「问 Φ」，它给一句人话判断，要不要连仍由你点「画成大陆边」；' +
    '想让弱证据彻底消失，得修那两条标题本身。</div>' +
    rows;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-fold]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const f = folded[Number(btn.getAttribute('data-fold'))];
    if (f && f.entry) _continentSharedPopover(f.entry, ev);
  }));
  el.querySelectorAll('[data-phi]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const rowIndex = Number(btn.getAttribute('data-phi'));
    const f = folded[rowIndex];
    if (f) _continentAskPhi(f, rowIndex, btn);
  }));
}

// ---------- v7.2 航线操作：单条可调（线型/颜色/粗细/走线/锚点/显隐/备注） ----------
// 用户反馈「大陆边鸡肋：影响视觉、又不能手动调整」——调整面板就是主答。备注改成
// 内联输入（顺手收编方向候选 U1：大陆边的两处 window.prompt 清场）。

const CONTINENT_ROUTE_PREFS_KEY = 'phymathia_continent_routes'; // 非会话键（全局显示偏好）
const CONTINENT_ROUTE_DASH = { solid: '', dashed: '7 5', dotted: '2 4' };
const CONTINENT_ROUTE_WIDTH = { thin: 1.2, normal: 2, thick: 3.2 };

function _continentRoutePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTINENT_ROUTE_PREFS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return { on: raw.on !== false,
               opacity: Number.isFinite(Number(raw.opacity)) ? Math.min(1, Math.max(0.15, Number(raw.opacity))) : 1 };
    }
  } catch (e) { /* 容忍 */ }
  return { on: true, opacity: 1 };
}

function _continentSaveRoutePrefs(prefs) {
  try { localStorage.setItem(CONTINENT_ROUTE_PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 容忍 */ }
}

// 样式解析（纯函数）：颜色三档——region 跟出海域色相、gold 暖金（用户认定的重色）、
// neutral 中性。旧边无 style 字段走默认（实线/normal/region）
function _continentRouteStroke(style, edge, regionInfo) {
  const s = style || {};
  const colorKey = s.color || 'region';
  let color = 'rgba(74, 158, 255, 0.85)';
  if (colorKey === 'gold') color = 'rgba(217, 164, 65, 0.9)';
  else if (colorKey === 'neutral') color = 'rgba(150, 156, 170, 0.8)';
  else if (regionInfo && edge && regionInfo.bySid) {
    const info = regionInfo.bySid[edge.fromSession];
    const hue = info && info.key !== null && info.key !== undefined
      ? _continentRegionHue(info.key, null) : null;
    if (hue !== null && hue !== undefined) color = 'hsla(' + hue + ', 62%, 64%, 0.85)';
  }
  return {
    color: color,
    width: CONTINENT_ROUTE_WIDTH[s.width] || CONTINENT_ROUTE_WIDTH.normal,
    dash: CONTINENT_ROUTE_DASH[s.dash] || '',
  };
}

// 通用编辑（样式/锚点/备注/隐藏共用）：改前留全量快照进撤销栈（type:'edit'）
async function _continentEditEdge(edgeId, patch) {
  const edges = _continentEdgeList();
  const target = edges.find(e => e.id === edgeId);
  if (!target) return;
  const before = JSON.parse(JSON.stringify(target));
  const next = edges.map(e => e.id === edgeId ? Object.assign({}, e, patch) : e);
  await _continentCommit(next, { type: 'edit', id: edgeId, before: before });
}

function _continentEdgePopover(e, ev) {
  const idx = _continentItemIndex();
  const s = e.style || {};
  const esc = _continentEsc;
  const option = (list, val) => list.map(o =>
    '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const dashOpts = option([['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']], s.dash || 'solid');
  const colorOpts = option([['region', '跟海域色'], ['gold', '暖金'], ['neutral', '中性']], s.color || 'region');
  const widthOpts = option([['thin', '细'], ['normal', '中'], ['thick', '粗']], s.width || 'normal');
  const routeOpts = option([['detour', '绕行（默认）'], ['straight', '直连'], ['lane', '沿边缘车道']], s.route || 'detour');
  // 换锚点卡：两端各列自己岛上的卡（学习顺序），代表卡口径不变
  const itemsOf = sid => (( _continentData && _continentData.clusters) || [])
    .filter(c => c.sessionId === sid)
    .flatMap(c => c.items || []);
  const anchorOpts = (sid, cur) => option(
    itemsOf(sid).map(it => [it.itemId, it.title || it.itemId]), cur);
  const html =
    '<div class="continent-pop-title">我的航线' + (e.label ? ' · ' + esc(e.label) : '') + '</div>' +
    '<div class="continent-pop-line">' + esc(idx.items[e.fromItem] || '？') +
    ' ↔ ' + esc(idx.items[e.toItem] || '？') + '</div>' +
    '<div class="continent-route-form">' +
      '<div class="continent-pop-row"><input class="continent-pop-input" data-label-input' +
        ' value="' + esc(e.label || '') + '" maxlength="40" placeholder="备注（如：同为波动现象）"></div>' +
      '<div class="continent-route-grid">' +
        '<label>线型<select data-style="dash">' + dashOpts + '</select></label>' +
        '<label>颜色<select data-style="color">' + colorOpts + '</select></label>' +
        '<label>粗细<select data-style="width">' + widthOpts + '</select></label>' +
        '<label>走线<select data-style="route">' + routeOpts + '</select></label>' +
      '</div>' +
      '<div class="continent-route-grid">' +
        '<label>这端卡<select data-anchor="from">' + anchorOpts(e.fromSession, e.fromItem) + '</select></label>' +
        '<label>那端卡<select data-anchor="to">' + anchorOpts(e.toSession, e.toItem) + '</select></label>' +
      '</div>' +
    '</div>' +
    '<div class="continent-pop-actions is-wrap">' +
      '<button class="continent-pop-btn" data-act="save-label">存备注</button>' +
      '<button class="continent-pop-btn is-quiet" data-act="toggle-label">' + (s.noLabel ? '显示备注标签' : '隐藏备注标签') + '</button>' +
      '<button class="continent-pop-btn is-quiet" data-act="hide">' + (s.hidden ? '取消隐藏' : '隐藏（留数据）') + '</button>' +
      '<button class="continent-pop-btn is-danger" data-act="remove">删除航线</button>' +
    '</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-style]').forEach(sel => sel.addEventListener('change', async () => {
    const patch = { style: Object.assign({}, s) };
    patch.style[sel.getAttribute('data-style')] = sel.value;
    try { await _continentEditEdge(e.id, patch); } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
  el.querySelectorAll('[data-anchor]').forEach(sel => sel.addEventListener('change', async () => {
    const patch = sel.getAttribute('data-anchor') === 'from'
      ? { fromItem: sel.value } : { toItem: sel.value };
    try { await _continentEditEdge(e.id, patch); } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
  const labelInput = el.querySelector('[data-label-input]');
  const saveLabel = async () => {
    const v = labelInput ? String(labelInput.value || '').slice(0, 40) : '';
    try {
      await _continentEditEdge(e.id, { label: v });
      _continentClosePopover();
    } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
  };
  const saveBtn = el.querySelector('[data-act="save-label"]');
  if (saveBtn) saveBtn.addEventListener('pointerdown', e2 => { e2.stopPropagation(); saveLabel(); });
  if (labelInput) labelInput.addEventListener('keydown', ev2 => {
    if (ev2.key === 'Enter') saveLabel();
  });
  el.querySelectorAll('[data-act]').forEach(btn => {
    const act = btn.getAttribute('data-act');
    if (act === 'save-label') return;
    btn.addEventListener('pointerdown', async e2 => {
      e2.stopPropagation();
      if (act === 'remove') {
        _continentClosePopover();
        try {
          await _continentRemoveUserEdges([e.id]);
          _continentToast('已删除（Ctrl+Z 可撤销）');
        } catch (err) { _continentToast('删除失败：' + (err && err.message || err)); }
      } else if (act === 'hide') {
        try {
          await _continentEditEdge(e.id, { style: Object.assign({}, s, { hidden: !s.hidden }) });
          _continentClosePopover();
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      } else if (act === 'toggle-label') {
        try {
          await _continentEditEdge(e.id, { style: Object.assign({}, s, { noLabel: !s.noLabel }) });
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      }
    });
  });
}

// 全局航线面板（顶栏「航线」按钮）：总开关 + 透明度——关了数据还在，再开就回来
function _continentRoutePrefsPopover(ev) {
  const prefs = _continentRoutePrefs();
  const html =
    '<div class="continent-pop-title">航线显示</div>' +
    '<div class="continent-pop-row"><label class="continent-route-check">' +
      '<input type="checkbox" data-route-on' + (prefs.on ? ' checked' : '') + '> 显示我的航线</label></div>' +
    '<div class="continent-pop-row"><label class="continent-route-check">透明度' +
      '<input type="range" min="0.15" max="1" step="0.05" value="' + prefs.opacity + '" data-route-opacity></label></div>' +
    '<div class="continent-pop-desc">悬停一座岛可单独看它的航线（其余淡出）。单条的样式点线本身调。</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  const apply = next => {
    _continentSaveRoutePrefs(next);
    if (_continentOpen && _continentData) _continentRender(_continentData);
  };
  const onBox = el.querySelector('[data-route-on]');
  if (onBox) onBox.addEventListener('change', () => {
    apply({ on: onBox.checked, opacity: _continentRoutePrefs().opacity });
  });
  const range = el.querySelector('[data-route-opacity]');
  if (range) range.addEventListener('input', () => {
    apply({ on: _continentRoutePrefs().on, opacity: Number(range.value) });
  });
}

// 悬停隔离（「只看选中岛的航线」，零点击零模式）：悬停岛 → 不相关的航线淡出。
// 岛牌点击仍是下钻，两者不冲突
function _continentSetRouteIso(sid) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  if (!sid) {
    world.classList.remove('route-iso');
    world.querySelectorAll('.continent-route, .continent-route-stub').forEach(el =>
      el.classList.remove('is-dim', 'is-lit'));
    return;
  }
  world.classList.add('route-iso');
  world.querySelectorAll('.continent-route, .continent-route-stub').forEach(el => {
    const sids = String(el.getAttribute('data-sids') || '').split(',');
    const mine = sids.indexOf(sid) >= 0;
    el.classList.toggle('is-lit', mine);
    el.classList.toggle('is-dim', !mine);
  });
}

// ---------- v2 簇间边：KV 读写 + 撤销栈（只记边操作） ----------
function _continentEdgeList() {
  const d = _continentData || {};
  return ((d.userEdges || []).concat(d.danglingEdges || []));
}

async function _continentCommit(edges, undoEntry) {
  const resp = await fetch(CONTINENT_EDGES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: edges.slice(0, CONTINENT_USER_EDGE_LIMIT) }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  if (undoEntry) _continentEdgeUndo.push(undoEntry);
  const data = await _continentFetchData();
  _continentData = data;
  if (_continentOpen) _continentRender(data);  // 布局与边无关，重渲不动视口
  _continentUpdateTools();
}

async function _continentAddUserEdge(fromItem, toItem, label) {
  const dup = (((_continentData && _continentData.userEdges) || []).some(e =>
    (e.fromItem === fromItem && e.toItem === toItem) ||
    (e.fromItem === toItem && e.toItem === fromItem)));
  if (dup) { _continentToast('这两条概念已经连过线了'); return false; }
  const edge = {
    id: 'ce_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fromItem: String(fromItem), toItem: String(toItem),
    label: String(label || '').slice(0, 40),
    createdAt: Date.now(),
  };
  await _continentCommit(_continentEdgeList().concat([edge]), { type: 'add', edge });
  return true;
}

async function _continentRemoveUserEdges(removeIds) {
  const ids = new Set(removeIds);
  const removed = _continentEdgeList().filter(e => ids.has(e.id));
  if (!removed.length) return;
  await _continentCommit(
    _continentEdgeList().filter(e => !ids.has(e.id)),
    removeIds.length === 1 ? { type: 'remove', edge: removed[0] } : { type: 'bulk', edges: removed });
}

async function _continentUndoEdgeOp() {
  if (!_continentEdgeUndo.length) { _continentToast('没有可撤销的边操作'); return; }
  const op = _continentEdgeUndo.pop();
  _continentUpdateTools();
  try {
    if (op.type === 'add') {
      await _continentCommit(_continentEdgeList().filter(e => e.id !== op.edge.id));
    } else if (op.type === 'edit') {
      // v7.2 单条编辑（样式/锚点/备注/隐藏）：恢复改前快照
      const edges = _continentEdgeList().map(e => e.id === op.id ? op.before : e);
      await _continentCommit(edges);
    } else if (op.type === 'region') {
      // v7.1a 海域操作（挪岛/改名）与边操作共用同一条 Ctrl+Z 栈（大陆打开时截获的约定不变）
      await _continentUndoRegionOp(op);
    } else {
      const restore = op.type === 'bulk' ? op.edges : [op.edge];
      const have = new Set(_continentEdgeList().map(e => e.id));
      await _continentCommit(_continentEdgeList().concat(restore.filter(e => !have.has(e.id))));
    }
    _continentToast('已撤销上一条边操作');
  } catch (err) {
    _continentToast('撤销失败：' + (err && err.message || err));
  }
}

async function _continentCleanDangling() {
  const dangling = ((_continentData && _continentData.danglingEdges) || []);
  if (!dangling.length) return;
  if (typeof window.confirm === 'function' &&
      !window.confirm('大陆上有 ' + dangling.length + ' 条连线的一端已不在（画布被清空或概念被删除），确定移除这些断线吗？')) return;
  try {
    await _continentRemoveUserEdges(dangling.map(e => e.id));
    _continentToast('已清理 ' + dangling.length + ' 条断线（Ctrl+Z 可撤销）');
  } catch (err) {
    _continentToast('清理失败：' + (err && err.message || err));
  }
}

function _continentUpdateTools() {
  const undoBtn = document.getElementById('continentUndoBtn');
  if (undoBtn) undoBtn.hidden = _continentEdgeUndo.length === 0;
  const cleanBtn = document.getElementById('continentCleanBtn');
  if (cleanBtn) {
    const n = ((_continentData && _continentData.danglingEdges) || []).length;
    cleanBtn.hidden = n === 0;
    cleanBtn.textContent = n ? '清理断线 ' + n : '清理断线';
  }
  // v4 折叠清单入口：有折叠才有按钮（没有就不占位）
  const weakBtn = document.getElementById('continentWeakBtn');
  if (weakBtn) {
    const n = (_continentFolded || []).length;
    weakBtn.hidden = n === 0;
    weakBtn.textContent = '折叠 ' + n + ' 条';
  }
  // v7.1b Φ 归类入口：有「归属缺失」的卡才出现（有可靠归属的不烧调用）
  const gateBtn = document.getElementById('continentGateBtn');
  if (gateBtn && !gateBtn.disabled) {
    const unclassified = (( _continentData && _continentData.clusters) || [])
      .filter(c => !c.domain)
      .reduce((acc, c) => acc + (c.itemCount || 0), 0);
    gateBtn.hidden = unclassified === 0;
    gateBtn.textContent = 'Φ 归类 ' + unclassified + ' 张';
  }
  // v7.2 航线入口：有航线才有全局显示开关
  const routeBtn = document.getElementById('continentRouteBtn');
  if (routeBtn) {
    const n = (((_continentData && _continentData.userEdges) || []).length)
      + (((_continentData && _continentData.danglingEdges) || []).length);
    routeBtn.hidden = n === 0;
  }
}

// ---------- 连接模式（v2 画边入口） ----------
function _continentSetLinkMode(on) {
  _continentLinkMode = !!on;
  _continentLinkSource = null;
  _continentIslandLinkSource = null;
  _continentMarkIslandLinkSource(null);
  const layer = document.getElementById('continentLayer');
  if (layer && layer.classList) layer.classList.toggle('is-linking', _continentLinkMode);
  const btn = document.getElementById('continentLinkBtn');
  if (btn && btn.classList) btn.classList.toggle('active', _continentLinkMode);
  const hint = document.getElementById('continentHint');
  if (hint) {
    hint.hidden = !_continentLinkMode;
    hint.textContent = '连接模式：点两个概念，或点两座岛的岛牌连成岛级航线（Esc 退出）';
  }
  // v5.4 空态引导与连接模式提示互斥（同一条顶栏位置）
  const guide = document.getElementById('continentGuide');
  if (guide) guide.hidden = _continentLinkMode || !_continentGuideText;
  _continentMarkLinkSource(null);
  _continentClosePopover();
}

function _continentMarkLinkSource(itemId) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  world.querySelectorAll('.continent-node.is-link-source').forEach(el => el.classList.remove('is-link-source'));
  if (itemId) {
    const el = _continentNodeEl(itemId);
    if (el && el.classList) el.classList.add('is-link-source');
  }
}

async function _continentLinkPick(itemId, sessionId) {
  if (!_continentLinkSource) {
    _continentLinkSource = { itemId: itemId, sessionId: sessionId };
    _continentMarkLinkSource(itemId);
    const hint = document.getElementById('continentHint');
    if (hint) hint.textContent = '再点另一个区域的概念完成连线（再点自己取消，Esc 退出）';
    return;
  }
  if (_continentLinkSource.itemId === itemId) {
    _continentMarkLinkSource(null);          // 再点自己 = 取消首选
    _continentLinkSource = null;
    return;
  }
  if (_continentLinkSource.sessionId === sessionId) {
    _continentToast('大陆连线要连接两个不同区域的概念');
    return;
  }
  // v7.2：落笔不再弹 window.prompt 拦路（方向候选 U1）——备注与样式连线后点线可调
  try {
    const ok = await _continentAddUserEdge(_continentLinkSource.itemId, itemId, '');
    if (ok) {
      _continentSetLinkMode(false);
      _continentToast('已连成航线（点线可加备注、调样式，Ctrl+Z 可撤销）');
    }
  } catch (err) {
    _continentToast('连线保存失败：' + (err && err.message || err));
  }
}

// v7.2 岛级落笔：连接模式点两座**岛牌**也能落笔——两端取各岛最早学的卡当锚点
// （与代表卡同口径），渲染仍是岛框到岛框的航线
let _continentIslandLinkSource = null;

function _continentMarkIslandLinkSource(sid) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  world.querySelectorAll('.continent-cluster.is-link-source').forEach(el =>
    el.classList.remove('is-link-source'));
  if (sid) {
    const el = world.querySelector('.continent-cluster[data-session-id="' +
      String(sid).replace(/"/g, '\\"') + '"]');
    if (el && el.classList) el.classList.add('is-link-source');
  }
}

async function _continentLinkPickIsland(sessionId) {
  if (!_continentIslandLinkSource) {
    _continentIslandLinkSource = sessionId;
    _continentMarkIslandLinkSource(sessionId);
    const hint = document.getElementById('continentHint');
    if (hint) hint.textContent = '再点另一座岛的岛牌完成岛级航线（再点自己取消，Esc 退出）';
    return;
  }
  if (_continentIslandLinkSource === sessionId) {
    _continentMarkIslandLinkSource(null);
    _continentIslandLinkSource = null;
    return;
  }
  const clusters = (_continentData && _continentData.clusters) || [];
  const from = clusters.find(c => c.sessionId === _continentIslandLinkSource);
  const to = clusters.find(c => c.sessionId === sessionId);
  const fromItem = from && from.items && from.items[0] && from.items[0].itemId;
  const toItem = to && to.items && to.items[0] && to.items[0].itemId;
  if (!fromItem || !toItem) { _continentToast('两座岛都要有概念才能连航线'); return; }
  try {
    const ok = await _continentAddUserEdge(fromItem, toItem, '');
    if (ok) {
      _continentIslandLinkSource = null;
      _continentMarkIslandLinkSource(null);
      _continentSetLinkMode(false);
      _continentToast('已连成岛级航线（点线可加备注、调样式，Ctrl+Z 可撤销）');
    }
  } catch (err) {
    _continentToast('连线保存失败：' + (err && err.message || err));
  }
}

// ---------- 视口：平移缩放（缩放锚点保持光标下的世界点不动） ----------
// v5.6 备注标签「固定字号」：标签在世界层里，会随地图缩放一起放大缩小（2.5 倍时 10px
// 变 25px）。乘 1/zoom 抵消即可当路牌用——缩放只该改变地图，不该改变文字大小。
// 纯函数：夹在 [0.4, 4] 防极端倍率把字缩没或撑爆。
function _continentEdgeLabelScale(zoom) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(4, Math.max(0.4, 1 / z));
}

function _continentSyncEdgeLabels() {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return 0;
  const k = _continentEdgeLabelScale(_continentZoom);
  const labels = world.querySelectorAll('.continent-user-link-label');
  labels.forEach(el => {
    if (el && el.style) el.style.transform = 'translate(-50%,-50%) scale(' + k + ')';
  });
  return labels.length;
}

function _continentApplyTransform() {
  const world = document.getElementById('continentWorld');
  if (world && world.style) {
    world.style.transform = 'translate(' + _continentPan.x + 'px,' + _continentPan.y + 'px) scale(' + _continentZoom + ')';
  }
  // v7.3 渐进披露：三档细节只切一个 CSS 类（零重建 DOM）——世界档只画海域板+岛牌+
  // 城市+航线，区域档加卡片标题，细节档加公式行与锚点短接。一次性全量渲染 + CSS
  // 显隐，不动既有 DOM 契约
  if (world && world.classList) {
    const tier = _continentZoom < CONTINENT_LOD_WORLD ? 'lod-world'
      : _continentZoom < CONTINENT_LOD_DETAIL ? 'lod-region' : 'lod-detail';
    world.classList.toggle('lod-world', tier === 'lod-world');
    world.classList.toggle('lod-region', tier === 'lod-region');
    world.classList.toggle('lod-detail', tier === 'lod-detail');
  }
  _continentSyncEdgeLabels();
}

function _continentZoomAt(factor, cx, cy) {
  const next = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, _continentZoom * factor));
  const ratio = next / _continentZoom;
  // pan' = c − (c − pan)·ratio：世界点 (c − pan)/zoom 在缩放前后都落在屏幕 c 处
  _continentPan.x = cx - (cx - _continentPan.x) * ratio;
  _continentPan.y = cy - (cy - _continentPan.y) * ratio;
  _continentZoom = next;
  _continentApplyTransform();
}

function _continentCenter() {
  const vp = document.getElementById('continentViewport');
  const w = (vp && typeof vp.clientWidth === 'number' && vp.clientWidth) || 900;
  const h = (vp && typeof vp.clientHeight === 'number' && vp.clientHeight) || 600;
  return { x: w / 2, y: h / 2 };
}

function _continentFitView() {
  const world = document.getElementById('continentWorld');
  if (!world) return;
  const vp = document.getElementById('continentViewport');
  const vw = (vp && typeof vp.clientWidth === 'number' && vp.clientWidth) || 900;
  const vh = (vp && typeof vp.clientHeight === 'number' && vp.clientHeight) || 600;
  // world 尺寸是内联 '1858px' 这样的字符串：Number('1858px') 是 NaN，会让适配永远走
  // 800×600 兜底（地图一开就是放大的半屏，看不到岛之间有没有城市）——必须 parseFloat
  const ww = parseFloat(world.style.width) || 800;
  const wh = parseFloat(world.style.height) || 600;
  _continentZoom = Math.min(CONTINENT_ZOOM_MAX,
    Math.max(CONTINENT_ZOOM_MIN, Math.min(vw / ww, vh / wh) * 0.92));
  _continentPan.x = (vw - ww * _continentZoom) / 2;
  _continentPan.y = (vh - wh * _continentZoom) / 2;
  _continentApplyTransform();
}

function _continentRestoreOrFitView() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CONTINENT_VIEW_KEY) || 'null'); } catch (e) { saved = null; }
  if (saved && typeof saved.zoom === 'number' && saved.pan
      && isFinite(saved.pan.x) && isFinite(saved.pan.y)) {
    _continentZoom = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, saved.zoom));
    _continentPan = { x: saved.pan.x, y: saved.pan.y };
    _continentApplyTransform();
  } else {
    _continentFitView();
  }
}

function _continentPersistView() {
  try {
    localStorage.setItem(CONTINENT_VIEW_KEY,
      JSON.stringify({ pan: { x: _continentPan.x, y: _continentPan.y }, zoom: _continentZoom }));
  } catch (e) { /* 存储不可用就只留在内存，不阻断 */ }
}

function _continentBindViewport(viewport) {
  if (!viewport || !viewport.addEventListener) return;
  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; // 右键留给浏览器原生菜单
    // 记下按下时的目标：setPointerCapture 会把 pointerup 重定目标到 viewport，
    // 那时 e.target 不再是被点的节点——点击判定必须用 down 时的目标
    _continentDragState = {
      x: e.clientX, y: e.clientY, panX: _continentPan.x, panY: _continentPan.y,
      moved: false, target: e.target,
    };
    try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* 容忍 */ }
  });
  viewport.addEventListener('pointermove', e => {
    const st = _continentDragState;
    if (!st) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.moved && Math.abs(dx) + Math.abs(dy) > 5) st.moved = true;
    if (st.moved) {
      _continentPan.x = st.panX + dx;
      _continentPan.y = st.panY + dy;
      _continentApplyTransform();
    }
  });
  viewport.addEventListener('pointerup', e => {
    const st = _continentDragState;
    _continentDragState = null;
    if (!st || st.moved || _continentDrilling) return;
    const el = st.target && st.target.closest
      ? st.target.closest('.continent-node, .continent-cluster') : null;
    if (!el || !el.dataset) return;
    if (el.classList && el.classList.contains('continent-node')) {
      // v2 连接模式：节点点击是选端点，不下钻
      if (_continentLinkMode) { _continentLinkPick(el.dataset.itemId, el.dataset.sessionId); return; }
      enterContinentSession(el.dataset.sessionId, el.dataset.itemId);
    } else {
      // v7.2：连接模式点岛牌 = 岛级航线端点（点两座岛牌也能落笔）；平时点岛牌仍下钻
      if (_continentLinkMode) { _continentLinkPickIsland(el.dataset.sessionId); return; }
      enterContinentSession(el.dataset.sessionId, '');
    }
  });
  viewport.addEventListener('pointercancel', () => { _continentDragState = null; });
  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    _continentZoomAt(e.deltaY < 0 ? 1.12 : 0.9,
      e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
}

// ---------- 开合与转场 ----------
// 转场统一走「锚点保持不动 + 内联 transition」：不做 CSS 类驱动（类移除时机和
// transition 生效窗口互相打架），层透明度交给 CSS，世界位移缩放全由内联样式驱动。
function _continentAnimateWorld(settle) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.style) { settle(); return; }
  world.style.transition = 'none';
  _continentApplyTransform();
  const kick = () => {
    world.style.transition = 'transform ' + CONTINENT_DIVE_MS + 'ms cubic-bezier(.22,.75,.3,1)';
    settle();
    setTimeout(() => { if (world && world.style) world.style.transition = ''; }, CONTINENT_DIVE_MS + 60);
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(kick));
  } else {
    kick();
  }
}

function _continentWorkspace() { return document.getElementById('graphWorkspace'); }

function _continentUpdateBreadcrumb(data) {
  const bc = document.getElementById('continentBreadcrumb');
  if (!bc) return;
  const has = data && Array.isArray(data.clusters) && data.clusters.length > 0
    && (data.itemCount || 0) > 0;
  bc.hidden = !has;
}

async function openContinentView() {
  const layer = _continentEnsureLayer();
  if (!layer || _continentOpen) return;
  _continentOpen = true;
  layer.classList.remove('continent-diving');
  layer.hidden = false;
  const ws = _continentWorkspace();
  if (ws) ws.classList.add('continent-open');
  _continentKeyHandler = e => {
    if (e.key === 'Escape') {
      if (_continentPopover) { _continentClosePopover(); return; }
      if (_continentLinkMode) { _continentSetLinkMode(false); return; }
      closeContinentView();
    }
    // v2：大陆打开时 Ctrl+Z 只作用于大陆边操作栈，不透传给会话图撤销
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      _continentUndoEdgeOp();
    }
  };
  document.addEventListener('keydown', _continentKeyHandler);

  let data;
  try {
    // v7.1a：海域覆盖（改名/挪岛）先于首次渲染就位——第一次画就是用户纠正过的样子；
    // v7.3：折叠态（收起的岛/海域）同样先就位
    await _continentLoadRegionOverrides();
    _continentLoadCollapsed();
    data = await _continentFetchData();
  } catch (err) {
    closeContinentView();
    if (typeof showToast === 'function') showToast('大陆数据加载失败：' + (err && err.message || err));
    return;
  }
  if (!_continentOpen) return; // 加载途中被关
  _continentData = data;
  _continentRender(data);
  _continentUpdateBreadcrumb(data);
  _continentUpdateTools();
  _continentRestoreOrFitView();

  // 表层转场：世界从 1.14 倍沉到恢复的视口（游戏地图「回来」的落定感）
  layer.classList.add('continent-surfacing');
  const c = _continentCenter();
  _continentZoomAt(CONTINENT_SURFACE_FACTOR, c.x, c.y);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    layer.classList.remove('continent-surfacing');
    _continentAnimateWorld(() => _continentZoomAt(1 / CONTINENT_SURFACE_FACTOR, c.x, c.y));
  }));
}

function closeContinentView() {
  if (!_continentOpen) return; // 未开先关必须幂等
  _continentOpen = false;
  // v7.1b：在途的 Φ 批量归类随大陆关闭中止（已完成的批已落盘，不丢）
  if (_continentGateCtrl) {
    try { _continentGateCtrl.abort(); } catch (e) { /* 容忍 */ }
    _continentGateCtrl = null;
  }
  if (!_continentSkipViewPersist) _continentPersistView();
  _continentSkipViewPersist = false;
  _continentSetLinkMode(false);
  _continentClosePopover();
  const layer = document.getElementById('continentLayer');
  if (layer) {
    layer.classList.remove('continent-diving', 'continent-surfacing');
    layer.hidden = true;
  }
  const world = document.getElementById('continentWorld');
  if (world && world.style) world.style.transition = '';
  const ws = _continentWorkspace();
  if (ws) ws.classList.remove('continent-open');
  if (_continentKeyHandler) {
    document.removeEventListener('keydown', _continentKeyHandler);
    _continentKeyHandler = null;
  }
}

// 下钻：镜头向点击处推进（点击的世界点在屏上不动，其余世界向外涌出）→
// 整层切换 → 进会话；概念节点再经 goToKnowledgeNode 直达定位（它自带
// 「切会话 + 定位 + 失败 toast」全流程，这里不复述其职责）。
async function enterContinentSession(sessionId, itemId) {
  if (!sessionId || _continentDrilling) return;
  if (typeof switchToSession !== 'function') { closeContinentView(); return; }
  _continentDrilling = true;
  // 留给回程的「离开时视口」是用户此刻的浏览态——下钻动画会把镜头推到 2.6 倍，
  // 那是跳转动作不是浏览位置，close 时的持久化要跳过，别让它覆盖
  _continentPersistView();
  _continentSkipViewPersist = true;
  const layer = document.getElementById('continentLayer');
  const key = String(itemId || '');
  const focus = key && _continentPlacements[key];
  const rect = !focus
    ? _continentClusterRects.find(r => r.sessionId === sessionId) || null : null;
  const origin = focus || rect;
  if (layer && origin) {
    // 点击处的屏幕坐标：pan + worldPos·zoom——缩放锚点放这里，节点原地不动
    const sx = _continentPan.x + origin.cx * _continentZoom;
    const sy = _continentPan.y + origin.cy * _continentZoom;
    if (layer.classList) layer.classList.add('continent-diving');
    _continentAnimateWorld(() => _continentZoomAt(CONTINENT_DIVE_FACTOR, sx, sy));
    await new Promise(r => setTimeout(r, CONTINENT_DIVE_MS));
  }
  closeContinentView();
  _continentDrilling = false;
  try { await switchToSession(sessionId); } catch (e) { /* 会话切换失败不阻断定位 */ }
  if (key && typeof goToKnowledgeNode === 'function') {
    try { await goToKnowledgeNode(itemId); } catch (e) { /* 定位失败自带 toast */ }
  }
}

window.openContinentView = openContinentView;
window.closeContinentView = closeContinentView;
window.enterContinentSession = enterContinentSession;
window._continentLayoutClusters = _continentLayoutClusters;
// v4/v5.1 画什么的纯函数（无 DOM），smoke 直接断言：弱证据不上图 / 每对与全图上限 /
// 城市选位（不撞岛不撞城）/ 折叠原因可分辨 / 重逢清单行可跳转
window._continentDrawPlan = _continentDrawPlan;
window._continentFoldedRows = _continentFoldedRows;
window._continentReunionRows = _continentReunionRows;
window._continentPlaceCity = _continentPlaceCity;
window._continentCityBox = _continentCityBox;
window._continentFits = _continentFits;
window._continentLinkMid = _continentLinkMid;
window._continentKindPrefix = _continentKindPrefix;
window._continentEdgeLabelScale = _continentEdgeLabelScale;
window._continentSyncEdgeLabels = _continentSyncEdgeLabels;
// v5.2 群岛布局 / v5.3 问 Φ / v5.4 岛牌：纯函数（无 DOM），smoke 直接断言
window._continentKinship = _continentKinship;
window._continentClusterOrder = _continentClusterOrder;
window._continentPhiMessages = _continentPhiMessages;
window._continentPhiVerdict = _continentPhiVerdict;
window._continentPhiBlockHtml = _continentPhiBlockHtml;
window._continentIslandTagline = _continentIslandTagline;
window._continentEmptyCanvasCount = _continentEmptyCanvasCount;
// v7.1a 海域层：纯函数（无 DOM），smoke 直接断言（分组/配色确定性/两级布局罩住海域板）
window._continentRegionHue = _continentRegionHue;
window._continentRegions = _continentRegions;
window._continentRegionLayout = _continentRegionLayout;
window._continentLayoutGrid = _continentLayoutGrid;
window._continentRegionSourceLabel = _continentRegionSourceLabel;
window._continentSecondaryDot = _continentSecondaryDot;
window._continentRegionInfoOf = () => _continentRegionInfo;  // 验收/调试用（只读当前归属解析）
// v7.1b 门控：纯函数（无 DOM），smoke 直接断言（提示词契约/判读防御/哈希增量）
window._continentGateMessages = _continentGateMessages;
window._continentGateParse = _continentGateParse;
window._continentGateHash = _continentGateHash;
window._continentGatePendingCards = _continentGatePendingCards;
// v7.2 航线：纯函数（无 DOM），smoke 直接断言（出岛框/绕行不穿岛/标签落点 finite）
window._continentRoute = _continentRoute;
window._continentBorderPoint = _continentBorderPoint;
window._continentRouteStroke = _continentRouteStroke;

// 预热面包屑：启动后拉一次投影，有内容才亮「‹ 大陆」入口（失败静默——
// 查空是正常路径，不弹错）。?continent=1 直开大陆视图（演示/验收捷径）。
// 沙箱里 setTimeout 是桩，此段只在真浏览器跑。
setTimeout(() => {
  _continentFetchData().then(data => {
    _continentUpdateBreadcrumb(data);
    try {
      if (String(location.search || '').indexOf('continent=1') >= 0) openContinentView();
    } catch (e) { /* location 不可用就忽略 */ }
  }).catch(() => {});
}, 2500);
