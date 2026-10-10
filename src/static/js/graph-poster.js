// ===== PhyMathia 探索网「缩略知识海报」导出 =====
// 与 graph-export.js 的「屏幕所见」克隆管线并列的第二种 PNG：海报不克隆 DOM，
// 而是从 graphView 数据出发用 canvas 2D 直绘——每个节点压成紧凑缩略卡
// （类型色条 + 标题 + 两行摘要 +「全文 N 字」角标），连线重画、分组照描，
// 配纸头（标题/统计/日期）与纸脚，成一张可分享的「知识地图」。
// 背景：屏幕所见 PNG 里长回答只能看到顶部一截（节点内滚动不入图）；海报干脆
// 明确放弃装全文（全文走单文件网页），每张卡只承诺「这是什么 + 讲什么」。
// 两包共用：主应用与 Utopia 查看器都进（查看器里再导出同样可选海报）。

(function () {
  var POSTER_W_BASE = 2200;   // 逻辑画布宽（× 倍数出像素）；小图放大上限 1.6
  var POSTER_MARGIN = 64;     // 四周留白（逻辑 px）
  var POSTER_HEADER_H = 168;  // 纸头（大标题 + 副题）
  var POSTER_FOOTER_H = 76;   // 纸脚
  var POSTER_MAX_SIDE = 16384;
  // T54：与 graph-export.js 同口径降到 64M——134M 档位实测只铺底色还报成功
  var POSTER_MAX_AREA = 67108864;

  var POSTER_FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';

  // ---------- 纯函数（smoke 断言 / 布局复用） ----------

  // LaTeX 轻转换：canvas 画不了公式，把常见命令换成可读符号（读得懂的近似，不求排版）
  var _LATEX_GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε',
    theta: 'θ', Theta: 'Θ', lambda: 'λ', mu: 'μ', omega: 'ω', Omega: 'Ω',
    pi: 'π', rho: 'ρ', sigma: 'σ', phi: 'φ', varphi: 'φ', tau: 'τ', eta: 'η',
  };

  function _latexLite(s) {
    var out = String(s);
    // 定点迭代（上限 4 遍）：先消最内层（上/下标花括号、点修饰符），再转 sqrt/frac，
    // 最后希腊字母兜底——兜底必须排除已知命令（否则 \sqrt 会被当未知命令删掉，√ 丢失）
    var KNOWN = '\\\\(?!sqrt\\b|frac\\b|left\\b|right\\b|ddot\\b|dot\\b|hat\\b|tilde\\b|bar\\b|vec\\b)([A-Za-z]+)';
    for (var pass = 0; pass < 4; pass++) {
      var next = out
        .replace(/([\^_])\{([^{}]*)\}/g, '$1($2)')
        .replace(/\\(ddot|dot|hat|tilde|bar|vec)\s*\{([^{}]*)\}/g, '$2')
        .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
        .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
        .replace(new RegExp(KNOWN, 'g'), function (_, cmd) { return _LATEX_GREEK[cmd] || ' '; });
      if (next === out) break;
      out = next;
    }
    return out.replace(/\\left|\\right/g, '').replace(/\\[,;!]/g, ' ').replace(/\\/g, ' ')
      .replace(/[{}]/g, '').replace(/\s{2,}/g, ' ');
  }

  // 代码块按语言给可读占位：mermaid 提取节点文本（知识图谱卡显示概念词而非源码），
  // html 是交互可视化（图片里本来就不交互），其余当代码。
  function _codeBlockPlaceholder(lang, body) {
    var l = String(lang || '').toLowerCase();
    if (l === 'mermaid' || /(?:^|\n)\s*(?:graph|flowchart|mindmap|sequenceDiagram|classDiagram|erDiagram|gantt|pie)\b/i.test(body)) {
      var labels = [];
      String(body).replace(/\[(?:["']?)([^[\]"'\n]{1,24})(?:["']?)\]|\((?:["']?)([^()"'\n]{1,24})(?:["']?)\)/g, function (_, sq, pq) {
        var t = String(sq || pq || '').trim();
        if (t && labels.indexOf(t) < 0 && labels.length < 8) labels.push(t);
        return '';
      });
      if (labels.length) return '知识图谱：' + labels.join(' · ');
      return '（知识图谱图示）';
    }
    if (l === 'html' || l === 'htm') return '（交互可视化）';
    return '（代码内容）';
  }

  // 原始内容（markdown + XML 模块标签 + 公式定界符）→ 海报纯文本。
  function posterPlainText(content) {
    var s = String(content || '');
    s = s.replace(/```(\w*)[ \t]*([\s\S]*?)```/g, function (_, lang, body) {
      return '\n' + _codeBlockPlaceholder(lang, body) + '\n';
    });
    if (typeof stripXmlTags === 'function') s = stripXmlTags(s);
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, function (_, m) { return _latexLite(m); });
    s = s.replace(/\\?\$([^$\n]+?)\\?\$/g, function (_, m) { return _latexLite(m); });
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
    s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/[*_`~>|]{1,3}/g, '');
    s = s.replace(/^-{3,}$/gm, ' ');
    s = s.replace(/[ \t\u3000]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    // 裸 LaTeX 兜底：AI 经常不包 $ 定界符直接写 \frac{...}{...}（泊松分布画布实测），
    // 对清洗后的全文再过一遍轻转换——正常中文文本无反斜杠命令，原样通过
    if (s.indexOf('\\') >= 0) s = _latexLite(s);
    return s;
  }

  // 节点文本多级回退（画布渲染读什么这里就读什么）：
  // ① _nodeContent（消息节点主路径，模块切片/AI 摘要）
  // ② content / analysis（手工与 Φ 生成节点的正文——问题分析节点内容在 analysis，
  //    _nodeContent 不看它，漏了就整卡空白：用户泊松分布画布实测踩过）
  // ③ summary / label ④ 原始消息
  function posterNodeText(n, msg) {
    var raw = '';
    try { raw = (typeof _nodeContent === 'function' ? _nodeContent(msg, n) : '') || ''; } catch (e) { raw = ''; }
    if (!raw) raw = String(n.content || '');
    if (!raw) raw = String(n.analysis || '');
    if (!raw) raw = String(n.summary || '');
    if (!raw && msg && typeof msg.content === 'string') {
      raw = msg.content;
      if (n.kind === 'answer') {
        if (typeof _graphSummary === 'function') {
          try { raw = _graphSummary(raw) || raw; } catch (e2) {}
        }
      }
    }
    if (!raw) raw = String(n.label || '');
    // 「建议模块：…」内部控制行不进海报：与画布渲染层同一把尺子（utils.js
    // stripSuggestedModulesLine），只作用于 answer 非 manual 节点的取文
    if (n.kind === 'answer' && !n.manual && typeof stripSuggestedModulesLine === 'function') {
      raw = stripSuggestedModulesLine(raw);
    }
    return raw;
  }

  // 标题与摘要：标题取首行前 maxTitleChars 字；**截断余量与后续行都进摘要**——
  // AI 摘要是无换行的整段文本，若摘要只取"剩余行"，整段会被标题吃光、卡片只剩结构。
  function posterTitleSummary(raw, maxTitleChars, maxSummaryChars) {
    var plain = posterPlainText(raw);
    if (!plain) return { title: '', summary: '', more: 0 };
    var parts = plain.split('\n');
    var title = '';
    var restLines = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i].trim()) continue;
      var first = parts[i].trim();
      if (first.length > maxTitleChars) {
        title = first.slice(0, maxTitleChars - 1) + '…';
        restLines = [first.slice(maxTitleChars - 1)].concat(parts.slice(i + 1));
      } else {
        title = first;
        restLines = parts.slice(i + 1);
      }
      break;
    }
    if (!title) return { title: '（无标题）', summary: '', more: 0 };
    var summary = restLines.join(' ').replace(/\s+/g, ' ').trim();
    var more = summary.length;
    if (summary.length > maxSummaryChars) summary = summary.slice(0, maxSummaryChars - 1) + '…';
    return { title: title, summary: summary, more: more };
  }

  // measure(text) -> 宽度；把 text 断成不超过 maxW 的行，最多 maxLines 行（末行超宽截断加 …）
  function posterWrapLines(measure, text, maxW, maxLines) {
    var lines = [];
    var rest = String(text || '').replace(/\s+/g, ' ').trim();
    while (rest && lines.length < maxLines) {
      var isLast = lines.length === maxLines - 1;
      var take = _fitLen(measure, rest, maxW, isLast);
      var piece = rest.slice(0, take);
      if (isLast && take < rest.length) piece += '…';
      lines.push(piece);
      rest = rest.slice(take).trim();
      if (isLast) break;
    }
    return lines;
  }

  function _fitLen(measure, text, maxW, addEllipsis) {
    var budget = maxW - (addEllipsis ? measure('…') : 0);
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (measure(text.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
    }
    return Math.max(1, lo);
  }

  // 从矩形中心指向外部目标的射线与矩形边界的交点（海报连线端点裁剪）
  function posterRectAnchor(cx, cy, w, h, tx, ty) {
    var dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    var hw = w / 2, hh = h / 2;
    var sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    var sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  // ---------- 主题取色 ----------

  function _var(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback || '';
    } catch (e) { return fallback || ''; }
  }

  // T166：色值事实源在 CSS 令牌（--bg-panel/--text-*/--accent/--poster-*），这里只读
  // 计算值——canvas 不认 var()；旧的字面量 fallback 已删（令牌在 :root 必有值）。
  function _theme() {
    var light = (document.documentElement.getAttribute('data-theme') === 'light');
    return {
      light: light,
      bg: _var('--bg-panel'),
      dot: _var('--poster-dot'),
      text: _var('--text-primary'),
      sub: _var('--text-secondary'),
      accent: _var('--accent'),
      border: _var('--poster-border'),
      card: _var('--poster-card'),
      cardBorder: _var('--poster-card-border'),
      edge: _var('--poster-edge'),
    };
  }

  // attr.color 可能是 'var(--ink-human)' 这类引用，canvas 不认——换成解析值
  function _resolveColor(color, theme) {
    var m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(color || '').trim());
    if (m) return _var(m[1], theme.accent);
    return color || theme.accent;
  }

  function _attrOf(node) {
    if (typeof _nodeAttribute === 'function') return _nodeAttribute(node) || {};
    return { key: 'question', label: '节点', color: 'var(--node-question)' };
  }

  // ---------- 布局：拓扑分层紧凑网格 ----------
  // 不照搬画布坐标（画布本来就稀疏，缩放后依旧散）。海报按连线拓扑重新分层：
  // 入度 0 / 根问题在顶层，沿结构边向下逐层展开；同层按原画布 x 排序、每行最多
  // maxPerRow 张、整行居中；联系线（edge.link）不参与分层、孤立节点归末层。
  // 分组框按成员卡片包围盒重算（原矩形在新布局下已无意义）。

  var CARD_W = 272, GAP_X = 40, GAP_Y = 64;
  var SUMMARY_CHARS = 100;   // 摘要预算（最多 4 行 × ~24 字）
  var TITLE_CHARS = 26;      // 标题预算（画的时候按真实宽度折行最多 2 行、超宽截断加 …——
                             // 26 字 × 15px 远超卡内宽，单行画出卡外是用户海报实测的溢出根因）
  var CARD_PAD_TOP = 14, CARD_ATTR_H = 18, CARD_TITLE_H = 22, CARD_LINE_H = 17, CARD_PAD_BOTTOM = 24;

  function posterLayout(opts) {
    var nodes = (opts && opts.nodes) || [];
    var groups = (opts && opts.groups) || [];
    var baseW = (opts && opts.baseW) || POSTER_W_BASE;
    var margin = (opts && opts.margin != null) ? opts.margin : POSTER_MARGIN;

    var vis = nodes.filter(function (n) {
      return n && n.kind !== 'draft' && !n.hidden;
    });
    if (!vis.length) return null;

    var byId = {};
    vis.forEach(function (n) { byId[n.id] = n; });
    var allEdges = ((opts && opts.edges) || []).filter(function (e) {
      return e && byId[e.from] && byId[e.to];
    });
    // 结构边（联系线不参与分层，但仍绘制）
    var structEdges = allEdges.filter(function (e) { return !e.link; });

    // 入度 + BFS 分层（取最长路径层；已访问节点若更深则更新并重放）
    var indeg = {};
    vis.forEach(function (n) { indeg[n.id] = 0; });
    structEdges.forEach(function (e) { indeg[e.to]++; });
    var layerOf = {};
    var frontier = [];
    vis.forEach(function (n) {
      if (n.isRoot || indeg[n.id] === 0) { layerOf[n.id] = 0; frontier.push(n); }
    });
    var maxLayer = 0;
    var head = 0;
    while (head < frontier.length) {
      var cur = frontier[head++];
      var curLayer = layerOf[cur.id];
      for (var ei = 0; ei < structEdges.length; ei++) {
        var e = structEdges[ei];
        if (e.from !== cur.id) continue;
        var down = byId[e.to];
        var next = curLayer + 1;
        if (layerOf[down.id] === undefined || next > layerOf[down.id]) {
          layerOf[down.id] = next;
          if (next > maxLayer) maxLayer = next;
          frontier.push(down);
        }
      }
    }
    var orphanLayer = maxLayer + 1; // 无结构边可达的环成员/孤点统一归末层

    // 折行：每层按原画布 x 排序 → 切成行
    var maxPerRow = Math.max(1, Math.floor((baseW - margin * 2 + GAP_X) / (CARD_W + GAP_X)));
    var width = Math.round(Math.max(baseW, CARD_W + margin * 2));
    var top = POSTER_HEADER_H + margin;
    var history = (typeof _getChatHistory === 'function' ? _getChatHistory() : []) || [];

    var cards = [];
    var rows = [];
    for (var L = 0; L <= orphanLayer; L++) {
      var layerNodes = vis.filter(function (n) { return layerOf[n.id] === L; })
        .sort(function (a, b) { return (a.x || 0) - (b.x || 0); });
      for (var i = 0; i < layerNodes.length; i += maxPerRow) {
        rows.push(layerNodes.slice(i, i + maxPerRow));
      }
    }
    if (!rows.length) return null;

    // 先算内容（标题/摘要/实际行数），卡高按内容自适应——问题这类短卡不空撑；
    // 行高 = 行内最高卡，行内顶对齐（类型标签连成一条线，观感整齐）
    function buildCard(n) {
      var msg = null;
      var mi = Number(n.messageIndex);
      if (mi >= 0) msg = history[mi];
      var raw = posterNodeText(n, msg);
      var attr = _attrOf(n);
      var meta = posterTitleSummary(raw, TITLE_CHARS, n.minimized ? 46 : SUMMARY_CHARS);
      if (!meta.title || meta.title === '（无标题）') meta.title = attr.label || '节点';
      // 标题与类型标签重复时剥前缀（section 正文常以「数学视角：…」开头，标签处已有）
      var prefix = (attr.label || '') + '：';
      if (meta.title.indexOf(prefix) === 0) meta.title = meta.title.slice(prefix.length) || meta.title;
      return {
        id: n.id, w: CARD_W,
        attrLabel: attr.label || '节点',
        attrColor: attr.color || 'var(--node-question)',
        attrKey: attr.key || 'question',
        kind: n.kind, moduleKey: n.moduleKey || '',
        isRoot: !!n.isRoot, minimized: !!n.minimized,
        title: meta.title, summary: meta.summary,
        chars: posterPlainText(raw).length,
      };
    }

    var y = top;
    rows.forEach(function (rowNodes) {
      var rowCards = rowNodes.map(buildCard);
      // 摘要行数按真实断行估（估算宽 ≈ 卡内宽 / 字宽 12.5px；中文为主场景够准）
      // 标题同样按宽折行（最多 2 行）——旧版 26 字预算 × 15px 字宽远超卡内宽，
      // fillText 不裁剪直接画出卡外（用户海报实测：标题横穿邻卡）
      var estW = CARD_W - 34;
      rowCards.forEach(function (c) {
        var maxLines = c.minimized ? 1 : 4;
        var perLine = Math.max(8, Math.floor(estW / 12.5));
        var sumLen = c.summary.length;
        var lines = sumLen ? Math.min(maxLines, Math.ceil(sumLen / perLine)) : 0;
        c.summaryLines = lines;
        var titlePerLine = Math.max(6, Math.floor(estW / (c.isRoot ? 17 : 15)));
        c.titleLines = Math.min(2, Math.max(1, Math.ceil(c.title.length / titlePerLine)));
        c.h = CARD_PAD_TOP + CARD_ATTR_H + c.titleLines * CARD_TITLE_H + lines * CARD_LINE_H + CARD_PAD_BOTTOM;
      });
      var rowH = Math.max.apply(null, rowCards.map(function (c) { return c.h; }));
      var rowW = rowNodes.length * CARD_W + (rowNodes.length - 1) * GAP_X;
      var x0 = (width - rowW) / 2;
      rowCards.forEach(function (c, j) {
        c.x = x0 + j * (CARD_W + GAP_X);
        c.y = y;
        c.cx = c.x + CARD_W / 2;
        c.cy = y + c.h / 2;
        cards.push(c);
      });
      y += rowH + GAP_Y;
    });

    var byCardId = {};
    cards.forEach(function (c) { byCardId[c.id] = c; });

    var edges = [];
    allEdges.forEach(function (e) {
      var a = byCardId[e.from], b = byCardId[e.to];
      if (!a || !b) return;
      var p1 = posterRectAnchor(a.cx, a.cy, a.w, a.h, b.cx, b.cy);
      var p2 = posterRectAnchor(b.cx, b.cy, b.w, b.h, a.cx, a.cy);
      // 只有联系线画虚线——主结构边在真实画布里多经 connections 存储也会带 custom 标记，
      // 按 custom 区分虚实会把整张图画成虚线（用户泊松分布海报实测踩过）
      edges.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, custom: !!e.link });
    });

    // 分组框：按成员卡片新位置重算包围盒
    var laidGroups = [];
    groups.forEach(function (g) {
      if (!g) return;
      var ids = g.nodeIds || [];
      var members = cards.filter(function (c) { return ids.indexOf(c.id) >= 0; });
      if (!members.length) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      members.forEach(function (c) {
        minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
        maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h);
      });
      var pad = 16;
      laidGroups.push({
        x: minX - pad, y: minY - pad,
        w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2,
        name: g.name || '分组', color: g.color || 'var(--graph-group-default)',
      });
    });

    var contentBottom = 0;
    cards.forEach(function (c) { contentBottom = Math.max(contentBottom, c.y + c.h); });
    laidGroups.forEach(function (g) { contentBottom = Math.max(contentBottom, g.y + g.h); });
    var height = Math.round(Math.max(
      contentBottom + margin + POSTER_FOOTER_H,
      POSTER_HEADER_H + margin * 2 + POSTER_FOOTER_H + 120
    ));
    return { width: width, height: height, cards: cards, edges: edges, groups: laidGroups, rows: rows.length };
  }

  // ---------- 绘制 ----------

  function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function _font(ctx, px, weight) {
    ctx.font = (weight || '400') + ' ' + px + 'px ' + POSTER_FONT;
  }

  // 背景图片：与画布同一张壁纸（graph-export 供给，按当前主题/屏幕方向）。
  // 拿不到（加载失败/老包）回 null，调用方退回纯色底。
  function _loadBgPhoto() {
    return new Promise(function (resolve) {
      try {
        if (typeof window.graphExportBgPhoto !== 'function') return resolve(null);
        window.graphExportBgPhoto().then(function (img) { resolve(img || null); }, function () { resolve(null); });
      } catch (e) { resolve(null); }
    });
  }

  function _drawPoster(ctx, layout, meta, theme, scale, bgImg) {
    var W = layout.width, H = layout.height;
    ctx.save();
    ctx.scale(scale, scale);

    // 背景：壁纸铺满 + 主题底色半透明压住（卡片文字要可读），拿不到壁纸走纯色
    if (bgImg && bgImg.width && bgImg.height) {
      var sc = Math.max(W / bgImg.width, H / bgImg.height);
      var dw = bgImg.width * sc, dh = bgImg.height * sc;
      ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.fillStyle = theme.bg;
      ctx.globalAlpha = theme.light ? 0.9 : 0.86;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = theme.dot;
    var gap = 30;
    for (var gx = gap; gx < W; gx += gap) {
      for (var gy = gap; gy < H; gy += gap) {
        ctx.fillRect(gx, gy, 1.4, 1.4);
      }
    }

    // 分组
    layout.groups.forEach(function (g) {
      var col = _resolveColor(g.color, theme);
      ctx.save();
      _roundRect(ctx, g.x, g.y, g.w, g.h, 14);
      ctx.fillStyle = col;
      ctx.globalAlpha = theme.light ? 0.06 : 0.07;
      ctx.fill();
      ctx.globalAlpha = theme.light ? 0.4 : 0.45;
      ctx.setLineDash([7, 6]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      _font(ctx, 15, '600');
      ctx.fillStyle = col;
      ctx.fillText(g.name, g.x + 14, g.y + 24);
      ctx.restore();
    });

    // 连线（先边后卡：端点虽已裁剪，被卡盖住也更干净）
    layout.edges.forEach(function (e) {
      var dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      var ex = e.x2 - ux * 9, ey = e.y2 - uy * 9; // 箭头前留位
      ctx.save();
      ctx.strokeStyle = e.custom ? theme.accent : theme.edge;
      ctx.lineWidth = 1.6;
      if (e.custom) ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = e.custom ? theme.accent : theme.edge;
      ctx.beginPath();
      ctx.moveTo(e.x2, e.y2);
      ctx.lineTo(ex - uy * 5, ey + ux * 5);
      ctx.lineTo(ex + uy * 5, ey - ux * 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });

    // 卡片（高度按内容自适应、行内顶对齐；摘要行数由布局预算好存 summaryLines）
    layout.cards.forEach(function (c) {
      var col = _resolveColor(c.attrColor, theme);
      ctx.save();
      _roundRect(ctx, c.x, c.y, c.w, c.h, 12);
      ctx.fillStyle = theme.card;
      ctx.fill();
      ctx.lineWidth = c.isRoot ? 2 : 1.1;
      ctx.strokeStyle = c.isRoot ? theme.accent : theme.cardBorder;
      ctx.stroke();
      // 左侧类型色条
      ctx.save();
      _roundRect(ctx, c.x, c.y, 5, c.h, 2.5);
      ctx.clip();
      ctx.fillStyle = col;
      ctx.fillRect(c.x, c.y, 5, c.h);
      ctx.restore();

      var padX = 16;
      var innerW = c.w - padX * 2 - 6;
      var fAttr = 11, fTitle = c.isRoot ? 17 : 15, fSub = 12.5;
      var y = c.y + CARD_PAD_TOP;

      // 类型标签 + 折叠标记
      _font(ctx, fAttr, '600');
      ctx.fillStyle = col;
      ctx.fillText(c.attrLabel + (c.minimized ? ' · 已折叠' : ''), c.x + padX + 2, y + fAttr - 2);
      y += CARD_ATTR_H + 4;

      // 标题（按宽折行，最多 2 行；行数由布局预算好存 titleLines，超宽截断加 …）
      ctx.fillStyle = theme.text;
      _font(ctx, fTitle, '600');
      y += fTitle - 2;
      var meaT = function (t) { _font(ctx, fTitle, '400'); return ctx.measureText(t).width; };
      var titleLines = posterWrapLines(meaT, c.title, innerW, c.titleLines || 1);
      titleLines.forEach(function (line, li) {
        ctx.fillText(line, c.x + padX + 2, y + li * CARD_TITLE_H);
      });
      y += (titleLines.length - 1) * CARD_TITLE_H + 10;

      // 摘要正文（行数=布局预算；宽度收窄再断一次，行数只少不多）
      if (c.summary && c.summaryLines > 0) {
        var meaS = function (t) { _font(ctx, fSub, '400'); return ctx.measureText(t).width; };
        var sumLines = posterWrapLines(meaS, c.summary, innerW, c.summaryLines);
        ctx.fillStyle = theme.sub;
        sumLines.forEach(function (line) {
          _font(ctx, fSub, '400');
          y += CARD_LINE_H;
          ctx.fillText(line, c.x + padX + 2, y);
        });
      }

      // 「全文 N 字」角标（右下）
      if (c.chars > 120) {
        var tag = '全文 ' + c.chars + ' 字';
        _font(ctx, 10.5, '400');
        var tw = ctx.measureText(tag).width;
        ctx.fillStyle = theme.sub;
        ctx.globalAlpha = 0.8;
        ctx.fillText(tag, c.x + c.w - tw - 10, c.y + c.h - 9);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    });

    // 纸头
    ctx.fillStyle = theme.text;
    _font(ctx, 44, '700');
    ctx.fillText(meta.title, POSTER_MARGIN, 84);
    ctx.fillStyle = theme.sub;
    _font(ctx, 17, '400');
    ctx.fillText(meta.subtitle, POSTER_MARGIN, 118);
    // 品牌行（右上）
    var brand = 'PhyMathia · 探索网知识海报';
    _font(ctx, 15, '600');
    var bwid = ctx.measureText(brand).width;
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(W - POSTER_MARGIN - bwid - 14, 72, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.sub;
    ctx.fillText(brand, W - POSTER_MARGIN - bwid, 78);
    // 标题下分隔线
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(POSTER_MARGIN, 138);
    ctx.lineTo(W - POSTER_MARGIN, 138);
    ctx.stroke();

    // 纸脚
    ctx.fillStyle = theme.sub;
    _font(ctx, 13.5, '400');
    var foot = '缩略知识地图：按回答结构分层排布，卡片显示标题与摘要开头';
    var fw = ctx.measureText(foot).width;
    ctx.fillText(foot, (W - fw) / 2, H - POSTER_FOOTER_H / 2 + 14);

    ctx.restore();
  }

  // ---------- 主流程 ----------

  function _posterMeta() {
    var title = '探索网';
    try {
      var sid = (typeof window.getCurrentSessionId === 'function') ? window.getCurrentSessionId() : '';
      var s = sid && typeof window.getSessionById === 'function' ? window.getSessionById(sid) : null;
      if (s && (s.title || '').trim()) title = s.title.trim().slice(0, 40);
    } catch (e) {}
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return {
      title: title,
      subtitle: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
    };
  }

  // T54 采样判空白（与 graph-export.js 同款，海报是独立 IIFE 各持一份）：
  // 缩到 64×64 探针画布一次读像素，颜色种类 <2 即整图空白；读不回来不判。
  function _canvasLooksBlank(canvas) {
    try {
      var probe = document.createElement('canvas');
      probe.width = 64; probe.height = 64;
      var pctx = probe.getContext('2d');
      if (!pctx) return false;
      pctx.drawImage(canvas, 0, 0, 64, 64);
      var d = pctx.getImageData(0, 0, 64, 64).data;
      var seen = {};
      var kinds = 0;
      for (var i = 0; i < d.length; i += 16) {
        if (d[i + 3] === 0) {
          if (!seen.__transparent) { seen.__transparent = 1; kinds++; }
          continue;
        }
        var key = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
        if (!seen[key]) { seen[key] = 1; kinds++; }
      }
      return kinds < 2;
    } catch (e) { return false; }
  }

  function exportGraphPoster(scale) {
    if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
      toastMsg('画布还没有内容，先提问生成一张探索网吧');
      return false;
    }
    var layout = posterLayout({
      nodes: graphView.nodes,
      edges: graphView.edges || [],
      groups: (graphView.groups || []),
    });
    if (!layout) { toastMsg('画布还没有内容'); return false; }

    var s = Math.max(1, Number(scale) || 1);
    // 浏览器上限收敛
    s = Math.min(s, POSTER_MAX_SIDE / layout.width, POSTER_MAX_SIDE / layout.height);
    s = Math.min(s, Math.sqrt(POSTER_MAX_AREA / (layout.width * layout.height)));
    s = Math.max(1, s);
    var outW = Math.round(layout.width * s);
    var outH = Math.round(layout.height * s);

    var canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';
    var theme = _theme();
    var meta = _posterMeta();
    var nodesN = layout.cards.length;
    var edgesN = layout.edges.length;
    var groupsN = layout.groups.length;
    meta.subtitle = nodesN + ' 个节点 · ' + edgesN + ' 条连线' + (groupsN ? (' · ' + groupsN + ' 个分组') : '')
      + ' · ' + meta.subtitle;

    var done = false;
    try {
      _loadBgPhoto().then(function (bgImg) {
        try {
          _drawPoster(ctx, layout, meta, theme, s, bgImg);
        } catch (err) {
          console.error('[graph-poster]', err);
          toastMsg('海报绘制失败：' + (err && err.message ? err.message : err));
          return;
        }
        // T54：空白审计——画不出来时 canvas 只剩底色，toBlob 却照常成功。
        // 宁可明说失败，不交一张空白图还报「已导出」。
        if (_canvasLooksBlank(canvas)) {
          toastMsg('海报渲染为空白（超出本浏览器大图上限），请降低倍率重试', TOAST_MS_LONG);
          return;
        }
        canvas.toBlob(function (blob) {
          if (!blob) { toastMsg('PNG 编码失败'); return; }
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          var safe = String(meta.title).replace(/[\\/:*?"<>|\n\r]/g, '_');
          a.href = url;
          a.download = 'PhyMathia知识海报_' + safe + '_' + outW + 'x' + outH + '.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          toastMsg('已导出缩略知识海报 ' + outW + '×' + outH + '（' + Math.round(blob.size / 1024) + ' KB）——卡片式概览', TOAST_MS_LONG);
        }, 'image/png');
      });
      done = true;
    } catch (err) {
      toastMsg('导出失败：' + (err && err.message ? err.message : err));
    }
    return done;
  }

  window.exportGraphPoster = exportGraphPoster;
  // 纯函数暴露（smoke 断言 / 调试）
  window.graphPosterDebug = {
    plainText: posterPlainText,
    titleSummary: posterTitleSummary,
    wrapLines: posterWrapLines,
    rectAnchor: posterRectAnchor,
    nodeText: posterNodeText,
    layout: posterLayout,
  };
})();
