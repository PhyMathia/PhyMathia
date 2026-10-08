// ====== Token 用量统计（2026-10-08）：AI 调用记账的只读可视化面板 ======
// 数据源＝GET /api/usage/stats?days=N（server/usage_stats.summarize，记账点在
// record_usage 的七个调用点：聊天流式/非流式、知识提取/描述、文档解析、记忆摘要、
// Φ 智能体）。面板只读不写；图表零依赖——趋势线手写 SVG 单调三次平滑曲线、圆环
// conic-gradient＋radial mask 挖孔、条形 div 宽度百分比（先例 quiz-render.js 的
// _quizPieHtml/_quizLineHtml 与 memory-bar）。2026-10-08 借鉴 ZCode 控制台三件：
// 平滑曲线（防过冲取单调插值）、圆环＋中心总量、数字万/亿中文口径。
// 同日二轮（对齐 ZCode 手感）：①统计范围自绘下拉（原生 <select> 弹出列表不吃
// 页面 CSS，深色主题里弹系统亮色列表）；②刷新改环形箭头图标钮（拉取在途旋转）；
// ③切范围/切分线不再整块跳变——折线重采样后逐帧 morph、圆环逐段边界插值、
// 条宽与汇总数字滚动，轴标交叉淡入淡出（_runTokenMorph，rAF 驱动 520ms）。
// 同日三轮（用户反馈两则）：①旧图降亮延迟 300ms 才生效——本地拉取毫秒级返回，
// 「立即降亮→马上摘掉」在 150ms opacity 过渡下就是整板闪一下；②圆环在行内顶
// 对齐不垂直居中：图例行数随统计范围变（7 天常只有两三个模型、30/90 天满
// 7＋其他），居中让圆环跟着图例高度上下挪位＝两档之间看起来「不同心」。
// 口径全局共享（backlog T180 拍板）：不按账号分账，所有账号共用。

const TOKEN_USAGE_KIND_LABELS = {
  chat: '聊天问答',
  legacy: '旧版聊天',
  summary: '记忆摘要',
  extract: '知识提取',
  describe: '知识描述',
  docs: '文档解析',
  harness: 'Φ 智能体',
  unknown: '其他',
};

// 与 quiz-render.js 的 _quizSessionChartSegments 同一套配色变量，主题自动适配
const TOKEN_USAGE_PALETTE = ['var(--node-question)', 'var(--node-physics)', 'var(--node-answer)', 'var(--node-learn)',
  'var(--chart-seg-cyan)', 'var(--node-socratic)', 'var(--node-knowledge)', 'var(--chart-seg-warm)'];

// 趋势图几何常量：绘制（_tokenUsageLineHtml）与 morph（_tokenUsageMorphPoints）
// 必须同一份，否则动画终点和静态渲染对不上。改一处必同步另一处已由共引用保证。
const TOKEN_LINE_GEOMETRY = { w: 640, h: 210, padL: 48, padR: 12, padT: 12, padB: 24 };

let _tokenUsageDays = 30;     // 当前统计范围（7/30/90），与服务端 days 参数同源
let _tokenUsageSplit = false; // 折线图是否按模型分线
let _tokenUsageCache = null;  // 最近一次拉到的 summarize 结果（切分线不重拉）
let _tokenUsageLive = null;   // 当前画布上的图表状态快照（morph 起点；空态为 null）
let _tokenUsageFetchSeq = 0;  // 拉取序号：快速连点范围只让最后一次落画
let _tokenUsageInflight = 0;  // 在途拉取数：>0 时刷新图标旋转
let _tokenUsageAnimSeq = 0;   // 动画序号：新一轮 morph 让上一轮逐帧回调立即失效
let _tokenRangeDismissBound = false; // 文档级「点外部/Esc 收下拉」只绑一次

// 旧图降亮的延迟阈值（ms）：低于它的拉取只靠刷新图标表态、不降亮——本地毫秒级
// 返回时「降亮刚上就摘」，在 150ms opacity 过渡下观感是整板闪一下（三轮用户反馈）
const TOKEN_REFRESH_DIM_DELAY = 300;

// 数字缩写纯函数（冒烟测试直接调用）：中文单位口径（对齐 ZCode 控制台）——
// 999 → 999、25000 → 2.5万、820000000 → 8.2亿，万以下不缩写，空值 → —
function _tokenFormatNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e8) return (Math.round(v / 1e7) / 10) + '亿';
  if (abs >= 1e4) return (Math.round(v / 1e3) / 10) + '万';
  return String(Math.round(v));
}

// 最近 N 天日期列表纯函数（冒烟测试直接调用）：[今天-N+1 … 今天]，YYYY-MM-DD。
// 服务端 days 桶只含有调用的日期，折线图横轴必须补零填满整天，趋势才不失真。
function _tokenUsageDateList(n) {
  const list = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    list.push(d.getFullYear() + '-' + m + '-' + day);
  }
  return list;
}

// Y 轴上限取整纯函数：向上取到 1/2/5/10×10^k，刻度数字才读得顺
function _tokenUsageNiceMax(v) {
  const val = Number(v);
  if (!Number.isFinite(val) || val <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(val)));
  for (const u of [1, 2, 5, 10]) {
    if (val <= u * pow) return u * pow;
  }
  return 10 * pow;
}

// 平滑曲线路径纯函数（冒烟测试直接调用）：单调三次插值（Fritsch–Carlson 限幅，
// d3 curveMonotoneX 同族）——曲线过每个数据点、贝塞尔控制点不越出相邻数据值范围。
// 普通 Catmull-Rom 会在尖峰过冲：token 图会冲破纵轴上限或插进 0 以下，趋势就失真了。
// 入参 pts 为 [x, y] 数值对，返回 SVG path 的 d 串。
function _tokenUsageSmoothPath(pts) {
  const n = pts.length;
  if (!n) return '';
  if (n === 1) return 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
  if (n === 2) {
    return 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1)
      + 'L' + pts[1][0].toFixed(1) + ' ' + pts[1][1].toFixed(1);
  }
  const dx = [], slope = [], tang = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  tang[0] = slope[0];
  tang[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tang[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { tang[i] = 0; tang[i + 1] = 0; continue; }
    const a = tang[i] / slope[i], b = tang[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const f = 3 / Math.sqrt(s);
      tang[i] = f * a * slope[i];
      tang[i + 1] = f * b * slope[i];
    }
  }
  let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += 'C' + (pts[i][0] + h).toFixed(1) + ' ' + (pts[i][1] + tang[i] * h).toFixed(1)
      + ' ' + (pts[i + 1][0] - h).toFixed(1) + ' ' + (pts[i + 1][1] - tang[i + 1] * h).toFixed(1)
      + ' ' + pts[i + 1][0].toFixed(1) + ' ' + pts[i + 1][1].toFixed(1);
  }
  return d;
}

// 模型占比分片纯函数（冒烟测试直接调用）：models 桶按总 token 排序取前 cap 名，
// 其余合并为「其他」；与扇形图/折线分线共用，保证两图同名模型同色。
function _tokenUsageTopModels(models, cap) {
  const entries = Object.entries(models || {})
    .map(([model, bucket]) => ({ model, value: (bucket && bucket.totalTokens) || 0 }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value);
  const top = entries.slice(0, cap).map((e, i) => ({
    label: e.model,
    value: e.value,
    color: TOKEN_USAGE_PALETTE[i % TOKEN_USAGE_PALETTE.length],
  }));
  const restValue = entries.slice(cap).reduce((sum, e) => sum + e.value, 0);
  if (restValue > 0) {
    top.push({ label: '其他', value: restValue, color: TOKEN_USAGE_PALETTE[TOKEN_USAGE_PALETTE.length - 1] });
  }
  return top;
}

// 汇总卡行（冒烟测试直接调用）：total 桶 → 4 张数字卡
function _tokenUsageSummaryHtml(total) {
  const t = total || {};
  const hit = (t.hitRate != null) ? Math.round(t.hitRate * 100) + '%' : '—';
  const cards = [
    { label: 'AI 调用', value: String(t.requests || 0), hint: '次' },
    { label: 'Prompt', value: _tokenFormatNum(t.promptTokens), hint: 'tok' },
    { label: 'Completion', value: _tokenFormatNum(t.completionTokens), hint: 'tok' },
    { label: '缓存命中', value: hit, hint: t.hitKnownRequests ? ('样本 ' + t.hitKnownRequests + ' 次') : '无命中字段' },
  ];
  return cards.map(c => '<div class="token-stat-card">'
    + '<div class="token-stat-val">' + escapeHtml(c.value) + '</div>'
    + '<div class="token-stat-label">' + c.label + (c.hint ? ' <em>' + escapeHtml(c.hint) + '</em>' : '') + '</div>'
    + '</div>').join('');
}

// 折线图按模型分线的系列定义（内部）：复用 _tokenUsageTopModels 的取色，
// 「其他」每日值须从 series 交叉表现算（models 桶只有总量，没有逐日）
function _tokenUsageLineSeries(data, dateList) {
  const tops = _tokenUsageTopModels(data.models, 6);
  if (!tops.length) return [];
  const topNames = tops.filter(t => t.label !== '其他').map(t => t.label);
  const defs = tops.filter(t => t.label !== '其他').map(t => ({
    label: t.label,
    color: t.color,
    values: dateList.map(d => {
      const b = ((data.series || {})[d] || {})[t.label];
      return (b && b.totalTokens) || 0;
    }),
  }));
  if (tops.some(t => t.label === '其他')) {
    defs.push({
      label: '其他',
      color: TOKEN_USAGE_PALETTE[TOKEN_USAGE_PALETTE.length - 1],
      values: dateList.map(d => {
        let sum = 0;
        for (const [m, b] of Object.entries((data.series || {})[d] || {})) {
          if (!topNames.includes(m)) sum += (b && b.totalTokens) || 0;
        }
        return sum;
      }),
    });
  }
  return defs;
}

// 折线图系列定义（冒烟测试直接调用）：split=false 总量单线、true 按模型分线
// （前 6 名＋其他）。绘制与 morph 快照共用，保证动画终点＝静态渲染。
function _tokenUsageLineDefs(data, dateList, split) {
  if (split) return _tokenUsageLineSeries(data, dateList);
  return [{
    label: '总 token',
    color: 'var(--node-question)',
    values: dateList.map(d => {
      const b = (data.days || {})[d];
      return (b && b.totalTokens) || 0;
    }),
  }];
}

// 趋势图（冒烟测试直接调用）：手写 SVG 平滑曲线 path，split=false 总量单线、
// true 按模型分线（前 6 名＋其他）。横轴按 _tokenUsageDateList 补零填满整天；
// 每个数据点铺透明命中圆＋<title>，鼠标悬停可读当日数值。
function _tokenUsageLineHtml(data, days, split) {
  const dateList = _tokenUsageDateList(days);
  const defs = _tokenUsageLineDefs(data, dateList, split);
  if (!defs.length) return '<div class="token-chart-empty">范围内没有 AI 调用记录</div>';
  const width = TOKEN_LINE_GEOMETRY.w;
  const height = TOKEN_LINE_GEOMETRY.h;
  const padLeft = TOKEN_LINE_GEOMETRY.padL;
  const padRight = TOKEN_LINE_GEOMETRY.padR;
  const padTop = TOKEN_LINE_GEOMETRY.padT;
  const padBottom = TOKEN_LINE_GEOMETRY.padB;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const maxVal = _tokenUsageNiceMax(Math.max(1, ...defs.flatMap(s => s.values)));
  const n = dateList.length;
  const pointAt = (v, i) => [
    padLeft + (n <= 1 ? 0.5 : i / (n - 1)) * plotWidth,
    padTop + (1 - v / maxVal) * plotHeight,
  ];
  const paths = defs.map(def => '<path d="' + _tokenUsageSmoothPath(def.values.map(pointAt))
    + '" fill="none" style="stroke:' + def.color
    + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>').join('');
  const hits = defs.map(def => '<g class="token-line-hits">' + def.values.map((v, i) => {
    const p = pointAt(v, i);
    return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="7" fill="transparent">'
      + '<title>' + dateList[i] + ' · ' + escapeHtml(def.label) + '：' + _tokenFormatNum(v) + ' tok</title></circle>';
  }).join('') + '</g>').join('');
  const gridlines = [1, 0.5, 0].map(ratio => {
    const y = (padTop + (1 - ratio) * plotHeight).toFixed(1);
    return '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (width - padRight) + '" y2="' + y
      + '" style="stroke:var(--chart-axis)" stroke-width="1" stroke-dasharray="' + (ratio === 0 ? '0' : '3 4') + '"/>'
      + '<text x="' + (padLeft - 6) + '" y="' + (Number(y) + 3) + '" fill="currentColor" font-size="9" text-anchor="end">'
      + _tokenFormatNum(maxVal * ratio) + '</text>';
  }).join('');
  // 短范围（≤10 天）逐日标轴（对齐 ZCode 观感），长范围收成首/中/尾三个免得挤成一团
  const labelIdx = n <= 10 ? dateList.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  const xLabels = labelIdx.map((idx, pos) => {
    const x = padLeft + (n <= 1 ? 0.5 : idx / (n - 1)) * plotWidth;
    const anchor = pos === 0 ? 'start' : (pos === labelIdx.length - 1 ? 'end' : 'middle');
    return '<text x="' + x.toFixed(1) + '" y="' + (height - 8) + '" fill="currentColor" font-size="9" text-anchor="'
      + anchor + '">' + dateList[idx].slice(5) + '</text>';
  }).join('');
  const legend = defs.map(def => '<div class="token-chart-legend-item"><span style="background:' + def.color
    + '"></span>' + escapeHtml(def.label) + '</div>').join('');
  return '<svg class="token-line-chart" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet">'
    + gridlines + paths + hits + xLabels + '</svg>'
    + '<div class="token-chart-legend token-line-legend">' + legend + '</div>';
}

// 圆环分段 stop 串纯函数（冒烟测试直接调用）：segments → 'c1 0% 75%, c2 75% 100%'
// 形态；绘制与 morph 终帧共用，保证动画收尾和静态渲染同串。
function _tokenUsageDonutStops(segments) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let acc = 0;
  return segments.map(segment => {
    const start = Math.round(acc / total * 100);
    acc += segment.value;
    const end = Math.round(acc / total * 100);
    return segment.color + ' ' + start + '% ' + end + '%';
  }).join(', ');
}

// 圆环图（冒烟测试直接调用）：conic-gradient 角度编码 token 占比，环孔与中心总量
// 由 CSS mask/叠加层负责（styles-panels.css）；图例为行式布局（色点＋模型名＋数值、
// 百分比右对齐，≥10% 取整、不足 10% 保留一位小数，对齐 ZCode）。
function _tokenUsagePieHtml(segments) {
  if (!segments || !segments.length) return '<div class="token-chart-empty">暂无用量记录</div>';
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (!total) return '<div class="token-chart-empty">暂无用量记录</div>';
  const stops = _tokenUsageDonutStops(segments);
  const legend = segments.map(segment => {
    const pct = segment.value / total * 100;
    const pctText = pct >= 10 ? Math.round(pct) + '%' : (Math.round(pct * 10) / 10) + '%';
    return '<div class="token-donut-legend-item"><span class="token-donut-dot" style="background:'
      + segment.color + '"></span>'
      + '<span class="token-donut-name" title="' + escapeHtml(segment.label) + '">' + escapeHtml(segment.label) + '</span>'
      + '<span class="token-donut-meta">' + _tokenFormatNum(segment.value) + ' tok</span>'
      + '<span class="token-donut-pct">' + pctText + '</span></div>';
  }).join('');
  return '<div class="token-usage-pie-row"><div class="token-usage-donut">'
    + '<div class="token-usage-pie" style="background:conic-gradient(' + stops + ')"></div>'
    + '<div class="token-usage-donut-center"><b>' + _tokenFormatNum(total) + '</b><span>tokens</span></div>'
    + '</div><div class="token-chart-legend token-donut-legend">' + legend + '</div></div>';
}

// 用途桶整理纯函数（冒烟测试直接调用）：kinds 桶 → 中文映射＋总量降序＋零值过滤，
// 条形绘制与 morph 快照共用同一份行集合。
function _tokenUsageKindEntries(data) {
  return Object.entries((data && data.kinds) || {})
    .map(([kind, bucket]) => ({
      label: TOKEN_USAGE_KIND_LABELS[kind] || kind,
      value: (bucket && bucket.totalTokens) || 0,
      requests: (bucket && bucket.requests) || 0,
    }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value);
}

// 用途分布横向条形（冒烟测试直接调用）：kinds 桶 → 降序条形行，条长按最大值归一
function _tokenUsageKindBarsHtml(data) {
  const entries = _tokenUsageKindEntries(data);
  if (!entries.length) return '<div class="token-chart-empty">暂无用量记录</div>';
  const max = entries[0].value;
  return entries.map(e => {
    const pct = Math.max(2, Math.round(e.value / max * 100));
    return '<div class="token-kind-row"><span class="token-kind-label">' + escapeHtml(e.label) + '</span>'
      + '<span class="token-kind-track"><i style="width:' + pct + '%"></i></span>'
      + '<span class="token-kind-val">' + _tokenFormatNum(e.value) + ' tok · ' + e.requests + ' 次</span></div>';
  }).join('');
}

// 模型明细表（冒烟测试直接调用）：models 桶 → 降序行，命中率沿用服务端口径
function _tokenUsageTableHtml(data) {
  const rows = Object.entries((data && data.models) || {})
    .map(([model, bucket]) => ({ model, bucket: bucket || {} }))
    .sort((a, b) => ((b.bucket.totalTokens || 0) - (a.bucket.totalTokens || 0)));
  if (!rows.length) return '<div class="token-chart-empty">暂无用量记录</div>';
  const head = '<div class="token-table-row token-table-head"><span>模型</span><span>请求</span>'
    + '<span>Prompt</span><span>Completion</span><span>命中率</span></div>';
  const body = rows.map(r => {
    const b = r.bucket;
    const hit = (b.hitRate != null) ? Math.round(b.hitRate * 100) + '%' : '—';
    return '<div class="token-table-row"><span class="token-table-model" title="' + escapeHtml(r.model) + '">'
      + escapeHtml(r.model) + '</span><span>' + (b.requests || 0) + '</span>'
      + '<span>' + _tokenFormatNum(b.promptTokens) + '</span>'
      + '<span>' + _tokenFormatNum(b.completionTokens) + '</span>'
      + '<span>' + hit + '</span></div>';
  }).join('');
  return '<div class="token-usage-table">' + head + body + '</div>';
}

// 面板主体拼装（冒烟测试直接调用）：汇总卡＋四张图表卡；零调用走整体空态
function _tokenUsageDashboardHtml(data, days, split) {
  if (!data || !data.total) return '<div class="token-chart-empty">暂无用量数据</div>';
  if (!data.total.requests) {
    return '<div class="token-chart-empty">最近 ' + days + ' 天内没有 AI 调用记录。'
      + '用量按天记在本机 data/usage/ 下，聊过天、提取过知识这里就会有数。</div>';
  }
  return '<div class="token-summary-row">' + _tokenUsageSummaryHtml(data.total) + '</div>'
    + '<div class="token-chart-card"><div class="token-chart-title">每日 token 趋势'
    + '<span class="token-chart-sub">纵轴 prompt+completion 合计，横轴按自然日补零，悬停数据点可读当日值</span></div>'
    + _tokenUsageLineHtml(data, days, split) + '</div>'
    + '<div class="token-chart-card"><div class="token-chart-title">模型用量占比'
    + '<span class="token-chart-sub">圆环角度编码 prompt+completion 总 token，前 7 名其余并入其他，中心为范围内总量</span></div>'
    + _tokenUsagePieHtml(_tokenUsageTopModels(data.models, 7)) + '</div>'
    + '<div class="token-chart-card"><div class="token-chart-title">用途分布'
    + '<span class="token-chart-sub">条形长度编码各用途总 token，看 token 都花在哪个功能上</span></div>'
    + _tokenUsageKindBarsHtml(data) + '</div>'
    + '<div class="token-chart-card"><div class="token-chart-title">模型明细'
    + '<span class="token-chart-sub">命中率只统计上游回报了缓存字段的请求</span></div>'
    + _tokenUsageTableHtml(data) + '</div>';
}

// ====== 切范围/切分线的平滑过渡（对齐 ZCode 控制台手感）======
// 思路：innerHTML 先落终态（无 DOM/ Reduced-motion / 无旧快照时即所见），然后若
// 存在上一帧快照 _tokenUsageLive，就用 rAF 逐帧从旧状态 morph 到新状态——
// 折线＝两条曲线各自按自身纵轴上限映射到像素后按重采样点线性插值（形状渐变，
// 各自端点严格过点）；圆环＝逐段边界（百分比）按序插值重建 conic-gradient（配色
// 按名次索引，两态同位同色，morph 自然成立）；汇总卡与条形＝数值/宽度滚动；
// 轴标文字不动几何只做交叉淡化（旧轴标以幽灵组原位淡出，网格线位置恒定）。

// 缓动纯函数（冒烟测试直接调用）：easeInOutCubic，端点 0/1、中点 0.5、单调
function _tokenUsageEase(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// 重采样纯函数（冒烟测试直接调用）：点数不等的两条曲线（7 天 ↔ 90 天）要逐帧
// morph，必须先落到同一采样数。采样口径与显示同族——Fritsch–Carlson 单调三次
// Hermite 求值（切线公式与 _tokenUsageSmoothPath 完全一致，dx=1 的数值版），
// 采样点严格落在「过数据点的平滑曲线」上。此前用线性插值：采样点全落在数据点
// 间的直连弦上，把 7↔30/90 天 morph 的中间帧整段拉直成折线、收尾一帧又突然变
// 圆（2026-10-08 实测闪帧根因）。限幅口径保证采样值不越出相邻数据值范围。
function _tokenUsageResample(values, k) {
  const src = Array.isArray(values) ? values : [];
  const n = src.length;
  if (n === 0) return new Array(k).fill(0);
  if (n === 1) return new Array(k).fill(src[0]);
  // Fritsch–Carlson 切线：极值点（相邻斜率异号）切线归零、限幅系数 3 防过冲；
  // 两点序列两切线＝斜率，Hermite 退化为直线（与显示函数 n===2 走 M L 直线一致）
  const slope = [], tang = new Array(n);
  for (let i = 0; i < n - 1; i++) slope.push(src[i + 1] - src[i]);
  tang[0] = slope[0];
  tang[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tang[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { tang[i] = 0; tang[i + 1] = 0; continue; }
    const a = tang[i] / slope[i], b = tang[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const f = 3 / Math.sqrt(s);
      tang[i] = f * a * slope[i];
      tang[i + 1] = f * b * slope[i];
    }
  }
  // 三次 Hermite 求值（dx=1）：贝塞尔控制点取 h/3 的曲线与该多项式逐点相同，
  // 即重采样点＝显示曲线上的点；采样位对齐数据点（t=0）时取原值无舍入
  const out = [];
  for (let j = 0; j < k; j++) {
    if (k <= 1) { out.push(src[n - 1]); continue; }
    const pos = (j / (k - 1)) * (n - 1);
    const lo = Math.min(n - 2, Math.floor(pos));
    const t = pos - lo;
    const t2 = t * t, t3 = t2 * t;
    out.push(
      (2 * t3 - 3 * t2 + 1) * src[lo] + (t3 - 2 * t2 + t) * tang[lo]
      + (-2 * t3 + 3 * t2) * src[lo + 1] + (t3 - t2) * tang[lo + 1]);
  }
  return out;
}

// 折线 morph 采样点纯函数（冒烟测试直接调用）：t=0 完全旧形态（旧轴上限）、t=1
// 完全新形态（新轴上限），像素空间线性插值。oldVals 传 null 表示新系列从基线长出。
function _tokenUsageMorphPoints(oldVals, oldMax, newVals, newMax, t, k) {
  const g = TOKEN_LINE_GEOMETRY;
  const plotW = g.w - g.padL - g.padR;
  const plotH = g.h - g.padT - g.padB;
  const o = _tokenUsageResample(oldVals, k);
  const nw = _tokenUsageResample(newVals, k);
  const pts = [];
  for (let j = 0; j < k; j++) {
    const x = g.padL + (k <= 1 ? 0.5 : j / (k - 1)) * plotW;
    const oy = g.padT + (1 - o[j] / oldMax) * plotH;
    const ny = g.padT + (1 - nw[j] / newMax) * plotH;
    pts.push([x, oy + (ny - oy) * t]);
  }
  return pts;
}

// 折线终态 path 纯函数：与 _tokenUsageLineHtml 的 pointAt 同公式，动画收尾时把
// morph 路径换回真实数据点的精确曲线——重采样已与显示曲线同族逐点重合，此处只
// 消除 d 串 toFixed 的亚像素舍入差（不再有形态跳变）。
function _tokenUsageFinalPath(def, maxVal) {
  const g = TOKEN_LINE_GEOMETRY;
  const plotW = g.w - g.padL - g.padR;
  const plotH = g.h - g.padT - g.padB;
  const n = def.values.length;
  const pts = def.values.map((v, i) => [
    g.padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW,
    g.padT + (1 - v / maxVal) * plotH,
  ]);
  return _tokenUsageSmoothPath(pts);
}

// 圆环累积边界纯函数（冒烟测试直接调用）：segments → [0, …, 100]，长度＝段数+1；
// morph 两态段数可能不同（前 7 名随范围变化），插值时短的一方以末位（100%）补齐，
// 多出的段自然从收口点长出/收回。
function _tokenUsageDonutBounds(segments) {
  const list = segments || [];
  const total = list.reduce((sum, s) => sum + s.value, 0);
  const bounds = [0];
  let acc = 0;
  for (const s of list) {
    acc += s.value;
    bounds.push(total ? acc / total * 100 : 100);
  }
  if (bounds.length === 1) bounds.push(100); // 空分段也保持「0→100 整圆」形态
  return bounds;
}

// 旧轴标幽灵组（内部）：只含文字（y 轴三档＋x 轴日期），几何与网格线恒定不动，
// 叠在新图上原位淡出。公式与 _tokenUsageLineHtml 的轴标段同源。
function _tokenUsageGhostSvg(prev) {
  const g = TOKEN_LINE_GEOMETRY;
  const plotW = g.w - g.padL - g.padR;
  const plotH = g.h - g.padT - g.padB;
  let s = '';
  for (const ratio of [1, 0.5, 0]) {
    const y = g.padT + (1 - ratio) * plotH;
    s += '<text x="' + (g.padL - 6) + '" y="' + (Number(y.toFixed(1)) + 3)
      + '" fill="currentColor" font-size="9" text-anchor="end">' + _tokenFormatNum(prev.maxVal * ratio) + '</text>';
  }
  const n = prev.dateList.length;
  const labelIdx = n <= 10 ? prev.dateList.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  labelIdx.forEach((idx, pos) => {
    const x = g.padL + (n <= 1 ? 0.5 : idx / (n - 1)) * plotW;
    const anchor = pos === 0 ? 'start' : (pos === labelIdx.length - 1 ? 'end' : 'middle');
    s += '<text x="' + x.toFixed(1) + '" y="' + (g.h - 8) + '" fill="currentColor" font-size="9" text-anchor="'
      + anchor + '">' + prev.dateList[idx].slice(5) + '</text>';
  });
  return s;
}

// 当前数据的图表状态快照（内部）：morph 的终点；空态返 null（下次有数据时走
// 「从基线长出」的入场而不是 morph）。
function _captureTokenLive(data) {
  if (!data || !data.total || !data.total.requests) return null;
  const dateList = _tokenUsageDateList(_tokenUsageDays);
  const defs = _tokenUsageLineDefs(data, dateList, _tokenUsageSplit);
  if (!defs.length) return null;
  const donut = _tokenUsageTopModels(data.models, 7);
  const t = data.total;
  const entries = _tokenUsageKindEntries(data);
  const kindMax = entries.length ? entries[0].value : 1;
  const kinds = {};
  for (const e of entries) {
    kinds[e.label] = {
      pct: Math.max(2, Math.round(e.value / kindMax * 100)),
      value: e.value,
      requests: e.requests,
    };
  }
  return {
    dateList,
    defs,
    maxVal: _tokenUsageNiceMax(Math.max(1, ...defs.flatMap(s => s.values))),
    donut,
    centerTotal: donut.reduce((sum, s) => sum + s.value, 0),
    summary: {
      requests: t.requests || 0,
      prompt: t.promptTokens || 0,
      completion: t.completionTokens || 0,
      hitPct: (t.hitRate != null) ? Math.round(t.hitRate * 100) : null,
    },
    kinds,
  };
}

// morph 主驱动（内部）：上一帧快照 prev → 本帧快照 next，520ms easeInOutCubic。
// 折线按 label 配对（切分线/模型换名时无对则从基线长出），圆环按名次索引配对。
function _runTokenMorph(body, prev, next) {
  const seq = ++_tokenUsageAnimSeq;
  const DUR = 520;
  const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const svg = body.querySelector('.token-line-chart');
  const paths = Array.prototype.slice.call(body.querySelectorAll('.token-line-chart path'));
  const pieEl = body.querySelector('.token-usage-pie');
  const centerEl = body.querySelector('.token-usage-donut-center b');
  const statVals = body.querySelectorAll('.token-stat-val');
  const kindRows = body.querySelectorAll('.token-kind-row');
  const oldBounds = _tokenUsageDonutBounds(prev.donut);
  const newBounds = _tokenUsageDonutBounds(next.donut);
  const boundsLen = Math.max(oldBounds.length, newBounds.length);
  const pairs = paths.map((p, i) => {
    const def = next.defs[i];
    if (!def) return null;
    const old = prev.defs.find(o => o.label === def.label) || null;
    return {
      p, def, old,
      k: Math.max(old ? old.values.length : 2, def.values.length, 2),
    };
  }).filter(Boolean);

  // 轴标/图例/明细表交叉淡化；旧轴标以幽灵组叠原位淡出。
  // 顺序必须是「先给现有文字加淡入、后追加幽灵组」——幽灵组自身要走淡出动画，
  // 若在它入树后再扫全 svg 的 text，会把淡入类也加到幽灵文字上抵消淡出。
  let ghost = null;
  if (svg && typeof document !== 'undefined' && document.createElementNS) {
    svg.querySelectorAll('text').forEach(t => { if (t.classList) t.classList.add('token-fade-in'); });
    ghost = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ghost.setAttribute('class', 'token-axis-ghost');
    ghost.innerHTML = _tokenUsageGhostSvg(prev);
    svg.appendChild(ghost);
  }
  body.querySelectorAll('.token-chart-legend, .token-usage-table').forEach(el => {
    if (el.classList) el.classList.add('token-fade-in');
  });

  const exactSummary = [
    String(next.summary.requests),
    _tokenFormatNum(next.summary.prompt),
    _tokenFormatNum(next.summary.completion),
    next.summary.hitPct != null ? next.summary.hitPct + '%' : '—',
  ];

  const applyMorph = (e) => {
    for (const { p, def, old, k } of pairs) {
      p.setAttribute('d', _tokenUsageSmoothPath(_tokenUsageMorphPoints(
        old ? old.values : null, old ? prev.maxVal : next.maxVal, def.values, next.maxVal, e, k)));
    }
    if (pieEl && pieEl.style) {
      const b = [];
      for (let i = 0; i < boundsLen; i++) {
        const ov = oldBounds[Math.min(i, oldBounds.length - 1)];
        const nv = newBounds[Math.min(i, newBounds.length - 1)];
        b.push(ov + (nv - ov) * e);
      }
      const colors = [];
      for (let i = 0; i < boundsLen - 1; i++) colors.push(((next.donut[i] || prev.donut[i]) || {}).color);
      pieEl.style.background = 'conic-gradient(' + colors.map((c, i) =>
        c + ' ' + Math.round(b[i]) + '% ' + Math.round(b[i + 1]) + '%').join(', ') + ')';
    }
    if (centerEl) {
      centerEl.textContent = _tokenFormatNum(Math.round(
        prev.centerTotal + (next.centerTotal - prev.centerTotal) * e));
    }
    if (statVals && statVals.forEach) {
      const texts = [
        String(Math.round(prev.summary.requests + (next.summary.requests - prev.summary.requests) * e)),
        _tokenFormatNum(Math.round(prev.summary.prompt + (next.summary.prompt - prev.summary.prompt) * e)),
        _tokenFormatNum(Math.round(prev.summary.completion + (next.summary.completion - prev.summary.completion) * e)),
        Math.round((prev.summary.hitPct || 0) + ((next.summary.hitPct || 0) - (prev.summary.hitPct || 0)) * e) + '%',
      ];
      statVals.forEach((el, i) => {
        if (texts[i] != null && el.textContent !== undefined) el.textContent = texts[i];
      });
    }
    if (kindRows && kindRows.forEach) {
      kindRows.forEach(row => {
        const lbl = row.querySelector('.token-kind-label');
        const bar = row.querySelector('.token-kind-track i');
        if (!lbl || !bar || !bar.style) return;
        const nd = next.kinds[lbl.textContent];
        if (!nd) return;
        const od = prev.kinds[lbl.textContent] || { pct: 0, value: 0 };
        bar.style.width = (od.pct + (nd.pct - od.pct) * e) + '%';
        const vEl = row.querySelector('.token-kind-val');
        if (vEl) {
          vEl.textContent = _tokenFormatNum(Math.round(od.value + (nd.value - od.value) * e))
            + ' tok · ' + nd.requests + ' 次';
        }
      });
    }
  };

  // 收尾落精确终态：morph(1) 在数学上已等于终值，这里只把有舍入差的三处换精确串
  const applyFinal = () => {
    applyMorph(1);
    for (const { p, def } of pairs) p.setAttribute('d', _tokenUsageFinalPath(def, next.maxVal));
    if (pieEl && pieEl.style) pieEl.style.background = 'conic-gradient(' + _tokenUsageDonutStops(next.donut) + ')';
    if (centerEl) centerEl.textContent = _tokenFormatNum(next.centerTotal);
    if (statVals && statVals.forEach) {
      statVals.forEach((el, i) => {
        if (exactSummary[i] != null && el.textContent !== undefined) el.textContent = exactSummary[i];
      });
    }
  };

  const frame = (now) => {
    if (seq !== _tokenUsageAnimSeq) return; // 期间又切了一轮，让位
    const t = Math.min(1, ((typeof now === 'number' ? now : start) - start) / DUR);
    applyMorph(_tokenUsageEase(t));
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      applyFinal();
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }
  };
  requestAnimationFrame(frame);
  if (ghost) setTimeout(() => { if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost); }, DUR + 240);
}

// 落画布（内部）：innerHTML 先给终态字符串，再视条件起 morph。没 DOM（冒烟沙箱）、
// 没旧快照（首开/空态）、用户开了减少动态效果，都直接停在终态。
function _paintTokenDashboard(body, data) {
  const prev = _tokenUsageLive;
  const next = _captureTokenLive(data);
  body.innerHTML = _tokenUsageDashboardHtml(data, _tokenUsageDays, _tokenUsageSplit);
  _tokenUsageLive = next;
  const reduced = (typeof matchMedia === 'function') && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prev || !next || reduced) return;
  if (typeof body.querySelector !== 'function' || typeof requestAnimationFrame !== 'function') return;
  _runTokenMorph(body, prev, next);
}

async function renderTokenUsage() {
  const body = document.getElementById('tokenUsageBody');
  if (!body) return;
  const seq = ++_tokenUsageFetchSeq;
  _tokenUsageInflight++;
  const btn = document.getElementById('tokenRefreshBtn');
  if (btn && btn.classList) btn.classList.add('spinning');
  // 已有图表时保留旧图等新数据 morph 过去；只有首开/空态才显示占位。
  // 降亮必须走 setTimeout 延迟：立即降亮在快返回时刚上就摘＝切范围闪一下。
  let dimTimer = null;
  if (!_tokenUsageLive) {
    body.innerHTML = '<div class="token-chart-empty">统计中…</div>';
  } else if (body.classList) {
    dimTimer = setTimeout(() => {
      if (seq === _tokenUsageFetchSeq && body.classList) body.classList.add('token-refreshing');
    }, TOKEN_REFRESH_DIM_DELAY);
  }
  let data = null;
  try {
    const resp = await fetch('/api/usage/stats?days=' + _tokenUsageDays, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error('http ' + resp.status);
    data = await resp.json();
  } catch (e) {
    // 已有图表就留着旧图只报 toast；空画布才落失败占位
    if (seq === _tokenUsageFetchSeq && !_tokenUsageLive) {
      body.innerHTML = '<div class="token-chart-empty">读取失败，请稍后重试</div>';
    }
    toastMsg('用量统计读取失败：' + (e && e.message ? e.message : '网络异常'), 3000);
    return;
  } finally {
    if (dimTimer) clearTimeout(dimTimer);
    _tokenUsageInflight--;
    if (!_tokenUsageInflight && btn && btn.classList) btn.classList.remove('spinning');
    // 本轮已被更新的拉取顶掉时不摘降亮——那层降亮归属新一轮在途拉取
    if (seq === _tokenUsageFetchSeq && body.classList) body.classList.remove('token-refreshing');
  }
  if (seq !== _tokenUsageFetchSeq) return; // 在途时又切了范围，只让最后一次落画
  _tokenUsageCache = (data && typeof data === 'object') ? data : null;
  _paintTokenDashboard(body, _tokenUsageCache);
}

function openTokenUsagePanel() {
  const dlg = document.getElementById('tokenDialog');
  if (dlg) dlg.classList.add('show');
  renderTokenUsage();
}

function closeTokenUsagePanel() {
  const dlg = document.getElementById('tokenDialog');
  if (dlg) dlg.classList.remove('show');
  _setTokenRangeMenuOpen(false);
}

// ====== 统计范围自绘下拉（二轮）：开合/选中/点外收起 ======
function _setTokenRangeMenuOpen(open) {
  const wrap = document.getElementById('tokenUsageRange');
  const menu = document.getElementById('tokenRangeMenu');
  const btn = document.getElementById('tokenRangeBtn');
  if (!wrap || !menu) return;
  if (wrap.classList) wrap.classList[open ? 'add' : 'remove']('open');
  menu.hidden = !open;
  if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleTokenRangeMenu() {
  const menu = document.getElementById('tokenRangeMenu');
  _bindTokenRangeDismiss();
  _setTokenRangeMenuOpen(!(menu && !menu.hidden));
}

function _bindTokenRangeDismiss() {
  if (_tokenRangeDismissBound || typeof document === 'undefined' || !document.addEventListener) return;
  _tokenRangeDismissBound = true;
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('tokenUsageRange');
    if (wrap && e.target && typeof Node !== 'undefined' && e.target instanceof Node && !wrap.contains(e.target)) {
      _setTokenRangeMenuOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e && e.key === 'Escape') _setTokenRangeMenuOpen(false);
  });
}

function pickTokenRangeDays(n) {
  _setTokenRangeMenuOpen(false);
  const lbl = document.getElementById('tokenRangeLabel');
  if (lbl && 'textContent' in lbl) lbl.textContent = '近 ' + n + ' 天';
  const menu = document.getElementById('tokenRangeMenu');
  if (menu && menu.querySelectorAll) {
    menu.querySelectorAll('.token-range-item').forEach(it => {
      if (it.classList) it.classList.toggle('active', String((it.dataset || {}).days) === String(n));
    });
  }
  setTokenUsageDays(String(n));
}

function setTokenUsageDays(value) {
  const n = parseInt(value, 10);
  if (n !== 7 && n !== 30 && n !== 90) return;
  if (n === _tokenUsageDays) return;
  _tokenUsageDays = n;
  renderTokenUsage();
}

// 「按模型分线」勾选框在 index.html 静态工具栏里（重渲染只换 body，勾选态不丢），
// 切换只用缓存重画＋morph、不重拉接口；缓存未就绪时兜底走一次完整渲染。
function toggleTokenUsageSplit() {
  const chk = document.getElementById('tokenUsageSplitChk');
  _tokenUsageSplit = !!(chk && chk.checked);
  const body = document.getElementById('tokenUsageBody');
  if (_tokenUsageCache && body) {
    _paintTokenDashboard(body, _tokenUsageCache);
  } else {
    renderTokenUsage();
  }
}

// 冒烟测试导出（与 accounts.js/trash.js 等模块的 window.* 导出惯例一致）
if (typeof window !== 'undefined') {
  window._tokenFormatNum = _tokenFormatNum;
  window._tokenUsageDateList = _tokenUsageDateList;
  window._tokenUsageNiceMax = _tokenUsageNiceMax;
  window._tokenUsageTopModels = _tokenUsageTopModels;
  window._tokenUsageSmoothPath = _tokenUsageSmoothPath;
  window._tokenUsageLineDefs = _tokenUsageLineDefs;
  window._tokenUsageDonutStops = _tokenUsageDonutStops;
  window._tokenUsageKindEntries = _tokenUsageKindEntries;
  window._tokenUsageEase = _tokenUsageEase;
  window._tokenUsageResample = _tokenUsageResample;
  window._tokenUsageMorphPoints = _tokenUsageMorphPoints;
  window._tokenUsageDonutBounds = _tokenUsageDonutBounds;
  window._tokenUsageSummaryHtml = _tokenUsageSummaryHtml;
  window._tokenUsageLineHtml = _tokenUsageLineHtml;
  window._tokenUsagePieHtml = _tokenUsagePieHtml;
  window._tokenUsageKindBarsHtml = _tokenUsageKindBarsHtml;
  window._tokenUsageTableHtml = _tokenUsageTableHtml;
  window._tokenUsageDashboardHtml = _tokenUsageDashboardHtml;
  window.renderTokenUsage = renderTokenUsage;
  window.openTokenUsagePanel = openTokenUsagePanel;
  window.closeTokenUsagePanel = closeTokenUsagePanel;
  window.setTokenUsageDays = setTokenUsageDays;
  window.toggleTokenUsageSplit = toggleTokenUsageSplit;
  window.toggleTokenRangeMenu = toggleTokenRangeMenu;
  window.pickTokenRangeDays = pickTokenRangeDays;
}
