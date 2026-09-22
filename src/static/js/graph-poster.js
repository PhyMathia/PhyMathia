// ===== PhyMathia 探索网「缩略知识海报」导出 =====
// 与 graph-export.js 的「屏幕所见」克隆管线并列的第二种 PNG：海报不克隆 DOM，
// 而是从 graphView 数据出发用 canvas 2D 直绘——每个节点压成紧凑缩略卡
// （类型色条 + 标题 + 两行摘要 +「全文 N 字」角标），连线重画、分组照描，
// 配纸头（标题/统计/日期）与纸脚，成一张可分享的「知识地图」。
// 背景：屏幕所见 PNG 里长回答只能看到顶部一截（节点内滚动不入图）；海报干脆
// 明确放弃装全文（全文走 .pmu 快照），每张卡只承诺「这是什么 + 讲什么」。
// 两包共用：主应用与 Utopia 查看器都进（查看器里再导出同样可选海报）。

(function () {
  var POSTER_W_BASE = 2200;   // 逻辑画布宽（× 倍数出像素）；小图放大上限 1.6
  var POSTER_MARGIN = 64;     // 四周留白（逻辑 px）
  var POSTER_HEADER_H = 168;  // 纸头（大标题 + 副题）
  var POSTER_FOOTER_H = 76;   // 纸脚
  var POSTER_MAX_SIDE = 16384;
  var POSTER_MAX_AREA = 134217728;

  var POSTER_FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';

  function _toast(msg) { if (typeof showToast === 'function') showToast(msg, 3200); }

  // ---------- 纯函数（smoke 断言 / 布局复用） ----------

  // 原始内容（markdown + XML 模块标签 + 公式定界符）→ 海报纯文本。
  // 代码块整块换成占位词；$/$$ 公式保留 LaTeX 源（学生读得懂），只剥定界符。
  function posterPlainText(content) {
    var s = String(content || '');
    s = s.replace(/```[\s\S]*?```/g, '「交互内容」');
    if (typeof stripXmlTags === 'function') s = stripXmlTags(s);
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, function (_, m) { return m; });
    s = s.replace(/\\?\$([^$\n]+?)\\?\$/g, function (_, m) { return m; });
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
    s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/[*_`~>|]{1,3}/g, '');
    s = s.replace(/^-{3,}$/gm, ' ');
    return s.replace(/[ \t\u3000]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  // 标题与摘要：标题取首行（跳过空行），摘要取剩余文本压成一串。
  function posterTitleSummary(raw, maxTitleChars, maxSummaryChars) {
    var plain = posterPlainText(raw);
    if (!plain) return { title: '', summary: '', more: 0 };
    var parts = plain.split('\n');
    var title = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].trim()) { title = parts[i].trim(); parts = parts.slice(i + 1); break; }
    }
    if (title.length > maxTitleChars) title = title.slice(0, maxTitleChars - 1) + '…';
    var summary = parts.join(' ').replace(/\s+/g, ' ').trim();
    var more = summary.length;
    if (summary.length > maxSummaryChars) summary = summary.slice(0, maxSummaryChars - 1) + '…';
    return { title: title || '（无标题）', summary: summary, more: more };
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
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function _theme() {
    var light = (document.documentElement.getAttribute('data-theme') === 'light');
    return {
      light: light,
      bg: _var('--bg-panel', light ? '#f4f7fb' : '#101828'),
      dot: light ? 'rgba(15,23,42,.07)' : 'rgba(230,235,245,.06)',
      text: _var('--text-primary', light ? '#1c2434' : '#e6ebf5'),
      sub: _var('--text-secondary', light ? '#5b6478' : '#93a1bd'),
      accent: _var('--accent', '#4a9eff'),
      border: light ? 'rgba(15,23,42,.16)' : 'rgba(255,255,255,.16)',
      card: light ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.055)',
      cardBorder: light ? 'rgba(15,23,42,.14)' : 'rgba(255,255,255,.14)',
      edge: light ? 'rgba(71,85,105,.5)' : 'rgba(148,163,189,.5)',
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
    return { key: 'question', label: '节点', color: '#4a9eff' };
  }

  // ---------- 布局（纯数据，不碰 canvas） ----------

  function posterLayout(opts) {
    var nodes = (opts && opts.nodes) || [];
    var groups = (opts && opts.groups) || [];
    var baseW = (opts && opts.baseW) || POSTER_W_BASE;
    var margin = (opts && opts.margin != null) ? opts.margin : POSTER_MARGIN;

    var vis = nodes.filter(function (n) {
      return n && n.kind !== 'draft' && !n.hidden;
    });
    if (!vis.length) return null;

    // 包围盒（节点 + 分组），与 graph-export 的口径一致
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    vis.forEach(function (n) {
      var w = n.w || n.customWidth || 260, h = n.h || n.customHeight || 140;
      minX = Math.min(minX, n.x - w / 2); maxX = Math.max(maxX, n.x + w / 2);
      minY = Math.min(minY, n.y - h / 2); maxY = Math.max(maxY, n.y + h / 2);
    });
    groups.forEach(function (g) {
      if (!g) return;
      minX = Math.min(minX, g.x); minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + (g.width || 0)); maxY = Math.max(maxY, g.y + (g.height || 0));
    });
    var bw = Math.max(240, maxX - minX), bh = Math.max(180, maxY - minY);

    var k = Math.min(1.6, (baseW - margin * 2) / bw);
    var kf = Math.min(1.25, Math.max(0.55, k)); // 字号缩放（夹住，防超大图字小如蚁）
    var width = Math.round(bw * k + margin * 2);
    var top = POSTER_HEADER_H + margin;

    var cards = vis.map(function (n) {
      var minimized = !!n.minimized;
      var root = !!n.isRoot;
      var w = Math.min(340, Math.max(112, (n.w || 260) * k));
      var h = minimized ? 46 : (root ? 96 : 84);
      var cx = margin + (n.x - minX) * k;
      var cy = top + (n.y - minY) * k;
      var raw = String(n.label || '') || '';
      if (!raw) {
        var msg = null;
        try { msg = (typeof _getChatHistory === 'function' ? _getChatHistory() : [])[n.messageIndex]; } catch (e) {}
        if (typeof _nodeContent === 'function') { try { raw = _nodeContent(msg, n) || ''; } catch (e2) { raw = ''; } }
        else raw = (msg && msg.content) || n.content || '';
      }
      var attr = _attrOf(n);
      var meta = minimized
        ? posterTitleSummary(raw, 16, 0)
        : posterTitleSummary(raw, root ? 26 : 22, 96);
      return {
        id: n.id,
        x: cx - w / 2, y: cy - h / 2, w: w, h: h, cx: cx, cy: cy,
        attrLabel: attr.label || '节点',
        attrColor: attr.color || '#4a9eff',
        attrKey: attr.key || 'question',
        kind: n.kind, moduleKey: n.moduleKey || '',
        isRoot: root, minimized: minimized,
        title: meta.title, summary: meta.summary,
        chars: posterPlainText(raw).length,
        fontSize: kf,
      };
    });

    var byId = {};
    cards.forEach(function (c) { byId[c.id] = c; });

    var edges = [];
    ((opts && opts.edges) || []).forEach(function (e) {
      if (!e) return;
      var a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      var p1 = posterRectAnchor(a.cx, a.cy, a.w, a.h, b.cx, b.cy);
      var p2 = posterRectAnchor(b.cx, b.cy, b.w, b.h, a.cx, a.cy);
      edges.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, custom: !!e.custom });
    });

    var laidGroups = groups.map(function (g) {
      if (!g) return null;
      return {
        x: margin + ((g.x || 0) - minX) * k,
        y: top + ((g.y || 0) - minY) * k,
        w: (g.width || 0) * k, h: (g.height || 0) * k,
        name: g.name || '分组', color: g.color || '#38bdf8',
      };
    }).filter(Boolean);

    // 高度按「卡片/分组实际占位」收口：缩略卡比原节点矮得多，按原包围盒算高度
    // 会让海报下半页大片空白（bounds 的角色只是估 k 与水平排布）
    var contentBottom = 0;
    cards.forEach(function (c) { contentBottom = Math.max(contentBottom, c.y + c.h); });
    laidGroups.forEach(function (g) { contentBottom = Math.max(contentBottom, g.y + g.h); });
    var height = Math.round(Math.max(
      POSTER_HEADER_H + margin + contentBottom + margin + POSTER_FOOTER_H,
      POSTER_HEADER_H + margin * 2 + POSTER_FOOTER_H + 240
    ));
    return { k: k, kFont: kf, width: width, height: height, cards: cards, edges: edges, groups: laidGroups };
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

  function _drawPoster(ctx, layout, meta, theme, scale) {
    var W = layout.width, H = layout.height;
    ctx.save();
    ctx.scale(scale, scale);

    // 背景 + 点阵
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
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

    // 卡片
    layout.cards.forEach(function (c) {
      var col = _resolveColor(c.attrColor, theme);
      ctx.save();
      _roundRect(ctx, c.x, c.y, c.w, c.h, 10);
      ctx.fillStyle = theme.card;
      ctx.fill();
      ctx.lineWidth = c.isRoot ? 1.8 : 1.1;
      ctx.strokeStyle = c.isRoot ? theme.accent : theme.cardBorder;
      ctx.stroke();
      // 左侧类型色条
      ctx.save();
      _roundRect(ctx, c.x, c.y, 5, c.h, 2.5);
      ctx.clip();
      ctx.fillStyle = col;
      ctx.fillRect(c.x, c.y, 5, c.h);
      ctx.restore();

      var padX = 16, padY = 11;
      var innerW = c.w - padX * 2 - 4;
      var y = c.y + padY;
      var fAttr = Math.max(10, Math.round(11 * c.fontSize));
      var fTitle = Math.max(11.5, Math.round((c.isRoot ? 17 : 15) * c.fontSize));
      var fSub = Math.max(10, Math.round(12.5 * c.fontSize));

      // 类型标签
      _font(ctx, fAttr, '600');
      ctx.fillStyle = col;
      ctx.fillText(c.attrLabel, c.x + padX + 2, y + fAttr - 2);
      y += fAttr + 6;

      // 标题（最多 2 行）
      var meaT = function (t) { _font(ctx, fTitle, '600'); return ctx.measureText(t).width; };
      var titleLines = posterWrapLines(meaT, c.title, innerW, 2);
      ctx.fillStyle = theme.text;
      titleLines.forEach(function (line) {
        _font(ctx, fTitle, '600');
        y += fTitle;
        ctx.fillText(line, c.x + padX + 2, y);
        y += 3;
      });

      // 摘要（最小化卡不放摘要）
      if (!c.minimized && c.summary) {
        var meaS = function (t) { _font(ctx, fSub, '400'); return ctx.measureText(t).width; };
        var sumLines = posterWrapLines(meaS, c.summary, innerW, 2);
        ctx.fillStyle = theme.sub;
        sumLines.forEach(function (line) {
          _font(ctx, fSub, '400');
          y += fSub;
          ctx.fillText(line, c.x + padX + 2, y);
          y += 2;
        });
      }

      // 「全文 N 字」角标（右下）
      if (!c.minimized && c.chars > 120) {
        var tag = '全文 ' + c.chars + ' 字';
        _font(ctx, Math.max(9, Math.round(10 * c.fontSize)), '400');
        var tw = ctx.measureText(tag).width;
        ctx.fillStyle = theme.sub;
        ctx.globalAlpha = 0.85;
        ctx.fillText(tag, c.x + c.w - tw - 10, c.y + c.h - 8);
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
    var foot = '缩略概览：每张卡片只显示标题与开头——完整回答、公式与交互可视化请用 Utopia 快照（.pmu / 单文件网页）打开';
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

  function exportGraphPoster(scale) {
    if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
      _toast('画布还没有内容，先提问生成一张探索网吧');
      return false;
    }
    var layout = posterLayout({
      nodes: graphView.nodes,
      edges: graphView.edges || [],
      groups: (graphView.groups || []),
    });
    if (!layout) { _toast('画布还没有内容'); return false; }

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

    try {
      _drawPoster(ctx, layout, meta, theme, s);
    } catch (err) {
      console.error('[graph-poster]', err);
      _toast('海报绘制失败：' + (err && err.message ? err.message : err));
      return false;
    }

    var done = false;
    try {
      canvas.toBlob(function (blob) {
        if (!blob) { _toast('PNG 编码失败'); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var safe = String(meta.title).replace(/[\\/:*?"<>|\n\r]/g, '_');
        a.href = url;
        a.download = 'PhyMathia知识海报_' + safe + '_' + outW + 'x' + outH + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        _toast('已导出缩略知识海报 ' + outW + '×' + outH + '（' + Math.round(blob.size / 1024) + ' KB）——卡片式概览，全文走 .pmu');
      }, 'image/png');
      done = true;
    } catch (err) {
      _toast('导出失败：' + (err && err.message ? err.message : err));
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
    layout: posterLayout,
  };
})();
