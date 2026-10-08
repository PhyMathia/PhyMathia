// ====== Token 用量统计（2026-10-08）：AI 调用记账的只读可视化面板 ======
// 数据源＝GET /api/usage/stats?days=N（server/usage_stats.summarize，记账点在
// record_usage 的七个调用点：聊天流式/非流式、知识提取/描述、文档解析、记忆摘要、
// Φ 智能体）。面板只读不写；图表零依赖——趋势线手写 SVG 单调三次平滑曲线、圆环
// conic-gradient＋radial mask 挖孔、条形 div 宽度百分比（先例 quiz-render.js 的
// _quizPieHtml/_quizLineHtml 与 memory-bar）。2026-10-08 借鉴 ZCode 控制台三件：
// 平滑曲线（防过冲取单调插值）、圆环＋中心总量、数字万/亿中文口径。
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

let _tokenUsageDays = 30;     // 当前统计范围（7/30/90），与服务端 days 参数同源
let _tokenUsageSplit = false; // 折线图是否按模型分线
let _tokenUsageCache = null;  // 最近一次拉到的 summarize 结果（切分线不重拉）

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

// 趋势图（冒烟测试直接调用）：手写 SVG 平滑曲线 path，split=false 总量单线、
// true 按模型分线（前 6 名＋其他）。横轴按 _tokenUsageDateList 补零填满整天；
// 每个数据点铺透明命中圆＋<title>，鼠标悬停可读当日数值。
function _tokenUsageLineHtml(data, days, split) {
  const dateList = _tokenUsageDateList(days);
  let defs;
  if (split) {
    defs = _tokenUsageLineSeries(data, dateList);
  } else {
    defs = [{
      label: '总 token',
      color: 'var(--node-question)',
      values: dateList.map(d => {
        const b = (data.days || {})[d];
        return (b && b.totalTokens) || 0;
      }),
    }];
  }
  if (!defs.length) return '<div class="token-chart-empty">范围内没有 AI 调用记录</div>';
  const width = 640;
  const height = 210;
  const padLeft = 48;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 24;
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

// 圆环图（冒烟测试直接调用）：conic-gradient 角度编码 token 占比，环孔与中心总量
// 由 CSS mask/叠加层负责（styles-panels.css）；图例为行式布局（色点＋模型名＋数值、
// 百分比右对齐，≥10% 取整、不足 10% 保留一位小数，对齐 ZCode）。
function _tokenUsagePieHtml(segments) {
  if (!segments || !segments.length) return '<div class="token-chart-empty">暂无用量记录</div>';
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (!total) return '<div class="token-chart-empty">暂无用量记录</div>';
  let acc = 0;
  const stops = segments.map(segment => {
    const start = Math.round(acc / total * 100);
    acc += segment.value;
    const end = Math.round(acc / total * 100);
    return segment.color + ' ' + start + '% ' + end + '%';
  }).join(', ');
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

// 用途分布横向条形（冒烟测试直接调用）：kinds 桶 → 降序条形行，条长按最大值归一
function _tokenUsageKindBarsHtml(data) {
  const entries = Object.entries((data && data.kinds) || {})
    .map(([kind, bucket]) => ({
      label: TOKEN_USAGE_KIND_LABELS[kind] || kind,
      value: (bucket && bucket.totalTokens) || 0,
      requests: (bucket && bucket.requests) || 0,
    }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value);
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

async function renderTokenUsage() {
  const body = document.getElementById('tokenUsageBody');
  if (!body) return;
  body.innerHTML = '<div class="token-chart-empty">统计中…</div>';
  let data = null;
  try {
    const resp = await fetch('/api/usage/stats?days=' + _tokenUsageDays, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error('http ' + resp.status);
    data = await resp.json();
  } catch (e) {
    body.innerHTML = '<div class="token-chart-empty">读取失败，请稍后重试</div>';
    toastMsg('用量统计读取失败：' + (e && e.message ? e.message : '网络异常'), 3000);
    return;
  }
  _tokenUsageCache = (data && typeof data === 'object') ? data : null;
  body.innerHTML = _tokenUsageDashboardHtml(_tokenUsageCache, _tokenUsageDays, _tokenUsageSplit);
}

function openTokenUsagePanel() {
  const dlg = document.getElementById('tokenDialog');
  if (dlg) dlg.classList.add('show');
  renderTokenUsage();
}

function closeTokenUsagePanel() {
  const dlg = document.getElementById('tokenDialog');
  if (dlg) dlg.classList.remove('show');
}

function setTokenUsageDays(value) {
  const n = parseInt(value, 10);
  if (n !== 7 && n !== 30 && n !== 90) return;
  if (n === _tokenUsageDays) return;
  _tokenUsageDays = n;
  renderTokenUsage();
}

// 「按模型分线」勾选框在 index.html 静态工具栏里（重渲染只换 body，勾选态不丢），
// 切换只用缓存重画、不重拉接口；缓存未就绪时兜底走一次完整渲染。
function toggleTokenUsageSplit() {
  const chk = document.getElementById('tokenUsageSplitChk');
  _tokenUsageSplit = !!(chk && chk.checked);
  const body = document.getElementById('tokenUsageBody');
  if (_tokenUsageCache && body) {
    body.innerHTML = _tokenUsageDashboardHtml(_tokenUsageCache, _tokenUsageDays, _tokenUsageSplit);
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
}
