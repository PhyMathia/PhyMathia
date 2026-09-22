// ===== PhyMathia 知识网络画布：超高清 PNG 导出 =====
// 思路：探索网是 DOM 渲染的，直接截图会糊。这里把画布世界层(graphInner)克隆后内联全部
// 样式与字体(data URI)，包进 SVG foreignObject，按目标倍数一次性栅格化到离屏 canvas——
// 文字按输出分辨率重新排版渲染（非放大位图），因此任意倍数下字迹都锐利可读。
// 依赖：运行期用到 utils/render/graph-* 的全局函数与 showToast；全部同源资源可 fetch。

(function () {
  // 主流浏览器 canvas 单边 / 面积硬上限（保守值，超出会被浏览器静默拒绝）
  var EXPORT_MAX_SIDE = 16384;
  var EXPORT_MAX_AREA = 134217728; // 128M 像素
  var EXPORT_PADDING = 64;         // 世界坐标四周留白

  var SCALES = [
    { s: 1, label: '1× 标准' },
    { s: 2, label: '2× 高清' },
    { s: 3, label: '3× 清晰' },
    { s: 4, label: '4× 超清（推荐）' },
  ];

  var _menuEl = null;
  var _exporting = false;
  var _transparentBg = false;
  var _dataUrlCache = {};   // 绝对 url -> dataURL（跨导出复用，字体只抓一次）
  var _outsideCloser = null;
  var _escCloser = null;

  // ---------- 工具 ----------

  function _toast(msg) {
    if (typeof showToast === 'function') showToast(msg, 3200);
  }

  function _normFamily(name) {
    return String(name || '').replace(/["']/g, '').trim().toLowerCase();
  }

  // 画布上实际用到的字体族（用于裁剪 @font-face，避免嵌入几十个用不到的 KaTeX 字体文件）
  function _collectUsedFamilies() {
    var set = {};
    if (!graphInner) return set;
    var els = graphInner.querySelectorAll('*');
    var cap = Math.min(els.length, 6000);
    for (var i = 0; i < cap; i++) {
      var ff = '';
      try { ff = getComputedStyle(els[i]).fontFamily || ''; } catch (e) {}
      if (!ff) continue;
      ff.split(',').forEach(function (f) {
        var k = _normFamily(f);
        if (k) set[k] = true;
      });
    }
    return set;
  }

  function _arrayBufferToDataUrl(buf, mime) {
    var bytes = new Uint8Array(buf);
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return 'data:' + (mime || 'application/octet-stream') + ';base64,' + btoa(binary);
  }

  function _extMime(url) {
    var m = String(url).split('?')[0].match(/\.(woff2|woff|ttf|otf|png|jpe?g|gif|svg|webp)$/i);
    var table = {
      woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', webp: 'image/webp',
    };
    return m ? (table[m[1].toLowerCase()] || 'application/octet-stream') : 'application/octet-stream';
  }

  function _fetchAsDataUrl(absUrl) {
    if (_dataUrlCache[absUrl] !== undefined) return Promise.resolve(_dataUrlCache[absUrl]);
    return fetch(absUrl, { cache: 'force-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var mime = res.headers.get('content-type') || _extMime(absUrl);
      return res.arrayBuffer().then(function (buf) {
        var dataUrl = _arrayBufferToDataUrl(buf, mime);
        _dataUrlCache[absUrl] = dataUrl;
        return dataUrl;
      });
    }).catch(function () {
      _dataUrlCache[absUrl] = null; // 失败也缓存，避免反复请求
      return null;
    });
  }

  // 把一段 cssText 里出现的 url(...) 全部替换为 data URI（base 为所在样式表的地址）
  function _inlineCssUrls(cssText, baseUrl) {
    var seen = {};
    var re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    var m;
    while ((m = re.exec(cssText))) {
      var raw = m[2].trim();
      if (!raw || raw.indexOf('data:') === 0 || raw.charAt(0) === '#') continue;
      seen[raw] = true;
    }
    var keys = Object.keys(seen);
    if (!keys.length) return Promise.resolve(cssText);
    return Promise.all(keys.map(function (raw) {
      var abs = raw;
      try { abs = new URL(raw, baseUrl || location.href).href; } catch (e) { return null; }
      return _fetchAsDataUrl(abs);
    })).then(function (results) {
      var map = {};
      keys.forEach(function (k, i) { map[k] = results[i]; });
      return cssText.replace(re, function (whole, q, u) {
        var raw = String(u).trim();
        if (Object.prototype.hasOwnProperty.call(map, raw) && map[raw]) return 'url("' + map[raw] + '")';
        return whole; // 抓取失败保持原样（外部资源在图片上下文里加载不出，但不致命）
      });
    });
  }

  function _sheetCssText(sheet) {
    // 同源样式表可直接读 cssRules；跨源或受限时抛错由调用方回退到 fetch
    var rules = sheet.cssRules;
    if (!rules) throw new Error('blocked');
    var text = '';
    for (var i = 0; i < rules.length; i++) text += rules[i].cssText + '\n';
    return text;
  }

  function _fetchSheetText(href) {
    return fetch(href, { cache: 'force-cache' }).then(function (r) { return r.text(); }).catch(function () { return ''; });
  }

  // 只保留画布用得到的 @font-face（正则级过滤，media/keyframes 原样保留）
  function _filterFontFaces(cssText, usedFamilies) {
    return cssText.replace(/@font-face\s*\{[^{}]*\}/g, function (block) {
      var count = 0;
      for (var k in usedFamilies) count++;
      if (!count) return block; // 收集失败则全保留
      var fam = block.match(/font-family\s*:\s*([^;}]+)/i);
      return fam && usedFamilies[_normFamily(fam[1])] ? block : '';
    });
  }

  // 出口兜底：SVG 图片是不透明源，任何残存的 http(s)/相对 url() 都会被浏览器拉取并把画布污染成
  // "Tainted"。无论上面哪一步漏抓/失败，这里强制清场——非 data:/# 的引用一律替换为空资源。
  var EMPTY_ASSET = 'data:,';

  function _scrubExternalCssRefs(cssText) {
    var blocked = [];
    var out = String(cssText || '').replace(/@import[^;{}]*(;|(?=[}\n$]))/gi, function (m) {
      blocked.push(m.trim().slice(0, 60));
      return '';
    });
    out = out.replace(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (whole, q, u) {
      var raw = String(u).trim();
      if (!raw || /^data:/i.test(raw) || raw.charAt(0) === '#') return whole;
      blocked.push(('url(' + raw).slice(0, 70));
      return 'url("' + EMPTY_ASSET + '")';
    });
    if (blocked.length) {
      console.warn('[graph-export] 已拦截无法内联的外部引用（替换为空资源）:', blocked.length, blocked.slice(0, 6));
    }
    return out;
  }

  // 汇总页面全部样式表（含 vendor KaTeX 等）并内联网址
  function _buildExportCss(usedFamilies) {
    var jobs = [];
    var sheets = [];
    try {
      for (var i = 0; i < document.styleSheets.length; i++) sheets.push(document.styleSheets[i]);
    } catch (e) {}
    sheets.forEach(function (sheet) {
      var href = sheet.href || null;
      var textPromise;
      try {
        textPromise = Promise.resolve(_sheetCssText(sheet));
      } catch (e) {
        textPromise = href ? _fetchSheetText(href) : Promise.resolve('');
      }
      jobs.push(textPromise.then(function (text) {
        return _filterFontFaces(text, usedFamilies);
      }).then(function (text) {
        return _inlineCssUrls(text, href);
      }));
    });
    // 页面动态注入的 <style>
    var inlineStyles = document.querySelectorAll('style');
    Array.prototype.forEach.call(inlineStyles, function (el) {
      var text = el.textContent || '';
      if (text.trim()) {
        jobs.push(Promise.resolve(text).then(function (t) { return _filterFontFaces(t, usedFamilies); })
          .then(function (t) { return _inlineCssUrls(t, location.href); }));
      }
    });
    return Promise.all(jobs).then(function (parts) { return parts.join('\n'); });
  }

  // ---------- 几何 ----------

  // 纯函数：把 [{x,y,w,h}] 并成包围盒（节点与分组共用；供画框计算与 smoke 断言）
  function _unionRects(rects) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    (rects || []).forEach(function (r) {
      if (!r) return;
      var l = Number(r.x), t = Number(r.y);
      if (!isFinite(l) || !isFinite(t)) return;
      var w = Number(r.w) || 0, h = Number(r.h) || 0;
      minX = Math.min(minX, l); minY = Math.min(minY, t);
      maxX = Math.max(maxX, l + w); maxY = Math.max(maxY, t + h);
    });
    if (!isFinite(minX)) return null;
    return {
      x: minX, y: minY,
      w: Math.max(200, maxX - minX),
      h: Math.max(160, maxY - minY),
    };
  }

  function _exportBounds() {
    var rects = [];
    (graphView.nodes || []).forEach(function (n) {
      var w = n.w || n.customWidth || 260;
      var h = n.h || n.customHeight || 140;
      rects.push({ x: n.x - w / 2, y: n.y - h / 2, w: w, h: h });
    });
    (graphView.groups || []).forEach(function (g) {
      rects.push({ x: g.x, y: g.y, w: g.width, h: g.height });
    });
    return _unionRects(rects);
  }

  // 浏览器上限内实际可达的输出像素
  function _resolveOutput(bounds, scale) {
    var w = bounds.w + EXPORT_PADDING * 2;
    var h = bounds.h + EXPORT_PADDING * 2;
    var eff = scale;
    eff = Math.min(eff, EXPORT_MAX_SIDE / w, EXPORT_MAX_SIDE / h);
    eff = Math.min(eff, Math.sqrt(EXPORT_MAX_AREA / (w * h)));
    eff = Math.max(1, eff);
    var outW = Math.min(EXPORT_MAX_SIDE, Math.round(w * eff));
    var outH = Math.min(EXPORT_MAX_SIDE, Math.round(h * eff));
    return { outW: outW, outH: outH, worldW: w, worldH: h };
  }

  // ---------- 克隆世界层 ----------

  function _buildExportClone() {
    // 先记录活体 iframe 尺寸（克隆脱离文档后量不到）
    var liveFrames = [];
    if (graphInner) {
      graphInner.querySelectorAll('iframe').forEach(function (f) {
        liveFrames.push({ w: f.clientWidth, h: f.clientHeight });
      });
    }
    var clone = graphInner.cloneNode(true);
    clone.classList.add('graph-export-root');
    clone.classList.remove('linking', 'panning');
    clone.classList.add('graph-heavy-zoom'); // 关闭重型特效（光晕/大阴影），既省显存又更“纸面”
    clone.style.transform = 'none';
    clone.style.left = '0';
    clone.style.top = '0';
    clone.style.willChange = 'auto';
    clone.querySelectorAll('.selected').forEach(function (el) { el.classList.remove('selected'); });
    clone.querySelectorAll('.dimmed').forEach(function (el) { el.classList.remove('dimmed'); });
    // 拖拽中的临时元素不进画面
    clone.querySelectorAll(
      '.graph-link-drag,.graph-edge-hit,.graph-edge-guide,.graph-edge-handle,.graph-curve-knob-hit'
    ).forEach(function (el) { el.remove(); });
    // 连线描边随倍数放大（去掉 non-scaling-stroke，否则高倍图里线细如发丝）
    clone.querySelectorAll('path,line,circle,polygon').forEach(function (el) {
      if (el.hasAttribute('vector-effect')) el.removeAttribute('vector-effect');
    });
    // 克隆树兜底：内联样式里的外部 url() 与外链图片同样会污染画布，一并清场
    clone.querySelectorAll('[style]').forEach(function (el) {
      var s = el.getAttribute('style') || '';
      if (/url\s*\(/i.test(s)) {
        el.setAttribute('style', s.replace(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (whole, q, u) {
          var raw = String(u).trim();
          if (!raw || /^data:/i.test(raw) || raw.charAt(0) === '#') return whole;
          return 'url("' + EMPTY_ASSET + '")';
        }));
      }
    });
    clone.querySelectorAll('img,image,use').forEach(function (el) {
      var src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      // 仅移除外链资源；data URI 与文档内 # 锚点引用（如箭头 marker）保留
      if (src && !/^data:/i.test(src) && src.charAt(0) !== '#') el.remove();
    });
    // 可视化 iframe 无法进图片：换成等尺寸占位卡
    var frames = clone.querySelectorAll('iframe');
    frames.forEach(function (frame, idx) {
      var size = liveFrames[idx] || { w: frame.getAttribute('width') || 320, h: frame.getAttribute('height') || 220 };
      var ph = document.createElement('div');
      ph.className = 'graph-export-iframe-ph';
      ph.style.width = (size.w || 320) + 'px';
      ph.style.height = (size.h || 220) + 'px';
      ph.textContent = '交互可视化（图片为静态占位）';
      frame.replaceWith(ph);
    });
    // 内嵌样式清洗：mermaid 图谱等会在自己的 <svg> 里注入私有 <style>，随克隆进图、
    // 绕过页面级样式表清洗——这里对克隆树内每个 <style> 再过一遍兜底规则
    clone.querySelectorAll('style').forEach(function (st) {
      st.textContent = _scrubExternalCssRefs(st.textContent || '');
    });
    // 其余可能携带外部引用的元素在图片上下文里也无法渲染，直接移除
    clone.querySelectorAll('video,audio,embed,object,link').forEach(function (el) { el.remove(); });
    clone.querySelectorAll('[srcset]').forEach(function (el) { el.removeAttribute('srcset'); });
    clone.querySelectorAll('[background]').forEach(function (el) {
      var bg = el.getAttribute('background') || '';
      if (bg && !/^data:/i.test(bg)) el.removeAttribute('background');
    });
    return clone;
  }

  // 导出快照专用规则：随页面样式一起被内联进 SVG
  var EXPORT_CSS_EXTRA = [
    '.graph-export-root *,.graph-export-root *::before,.graph-export-root *::after{transition:none !important;animation:none !important;backdrop-filter:none !important;}'
,    '.graph-export-root .graph-node-delete-toggle'
,    '.graph-export-root .graph-node-minimize-toggle'
,    '.graph-export-root .graph-node-edit-toggle'
,    '.graph-export-root .graph-port-remove'
,    '.graph-export-root .graph-add-port-btn'
,    '.graph-export-root .graph-add-input-btn'
,    '.graph-export-root .graph-resize-handle'
,    '.graph-export-root .graph-group-resize-handle'
,    '.graph-export-root .graph-group-color-input'
,    '.graph-export-root .graph-group-delete-btn'
,    '.graph-export-root .graph-group-add-btn'
,    '.graph-export-root .graph-regen-btn'
,    '.graph-export-root .graph-hub-connect-btn'
,    '.graph-export-root .graph-draft-close'
,    '.graph-export-root .graph-draft-actions'
,    '.graph-export-root .graph-node-actions'
,    '.graph-export-root .graph-source-file-btn'
,    '.graph-export-root .graph-source-paste-btn'
,    '.graph-export-root .graph-source-controls'
,    '.graph-export-root .graph-source-file-input'
,    '.graph-export-root .graph-knowledge-actions'
,    '.graph-export-root .graph-relation-actions'
,    '.graph-export-root .graph-ai-eval-accept'
,    '.graph-export-root .graph-ai-eval-ignore{visibility:hidden !important;}'
,    '.graph-export-root textarea,.graph-export-root .graph-group-name-input{border:none !important;background:transparent !important;box-shadow:none !important;resize:none !important;outline:none !important;appearance:none !important;-webkit-appearance:none !important;overflow:hidden !important;}'
,    '.graph-export-root .graph-edge,.graph-export-root .graph-edge-link{vector-effect:none !important;}'
  ].join('');

  // ---------- 栅格化 ----------

  function _rasterize(clone, css, bounds, out, mode) {
    var effW = out.outW / out.worldW;
    var effH = out.outH / out.worldH;
    var stageShiftX = EXPORT_PADDING - bounds.x;
    var stageShiftY = EXPORT_PADDING - bounds.y;

    var outer = document.createElement('div');
    outer.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    outer.style.cssText = 'position:relative;width:' + out.outW + 'px;height:' + out.outH + 'px;overflow:hidden;margin:0;padding:0;';
    var scaler = document.createElement('div');
    scaler.style.cssText = 'position:absolute;left:0;top:0;width:' + out.worldW + 'px;height:' + out.worldH + 'px;'
      + 'transform:scale(' + effW + ',' + effH + ');transform-origin:0 0;';
    var stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;left:' + stageShiftX + 'px;top:' + stageShiftY + 'px;width:20px;height:20px;';
    stage.appendChild(clone);
    scaler.appendChild(stage);
    outer.appendChild(scaler);

    var svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgEl.setAttribute('width', String(out.outW));
    svgEl.setAttribute('height', String(out.outH));
    var styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = _scrubExternalCssRefs(css + '\n' + EXPORT_CSS_EXTRA);
    var fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', '0');
    fo.setAttribute('y', '0');
    fo.setAttribute('width', String(out.outW));
    fo.setAttribute('height', String(out.outH));
    fo.appendChild(outer);
    svgEl.appendChild(styleEl);
    svgEl.appendChild(fo);

    var svgStr = new XMLSerializer().serializeToString(svgEl);

    // SecurityError 时的取证输出：UA / 输出尺寸 / CSS 外链残留审计，便于精确定位污染源
    function _dumpForensics(usedMode) {
      try {
        var badUrls = String(css || '').match(/url\(\s*['"]?(?!data:|#)[^)]*\)/gi) || [];
        console.warn('[graph-export] 诊断: 模式=' + usedMode,
          '| 输出=' + out.outW + 'x' + out.outH,
          '| css外链残留=' + badUrls.length, badUrls.slice(0, 3),
          '| UA=', navigator.userAgent);
      } catch (e) {}
    }

    return new Promise(function (resolve, reject) {
      var finish = function (img, usedMode) {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = out.outW;
          canvas.height = out.outH;
          var ctx = canvas.getContext('2d');
          if (!_transparentBg) {
            var bg = '#ffffff';
            try {
              bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim() || '#ffffff';
            } catch (e) {}
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          // 双绘一次：个别浏览器首帧嵌入字体未就绪，第二遍确保文字字形正确
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try {
            canvas.toBlob(function (pngBlob) {
              if (pngBlob) resolve(pngBlob);
              else reject(new Error('PNG 编码失败（图片可能超出浏览器上限）'));
            }, 'image/png');
          } catch (secErr) {
            if (secErr && secErr.name === 'SecurityError') {
              secErr.security = true; // 交给上层切换备用通道重试
              _dumpForensics(usedMode);
              reject(secErr);
            } else {
              reject(secErr);
            }
          }
        } catch (err) {
          reject(err);
        }
      };
      if (mode === 'data') {
        // 备用通道：data URL 加载（绕开个别内核对 blob 源 SVG 的来源判定差异）
        var dataImg = new Image();
        dataImg.onload = function () { finish(dataImg, 'data'); };
        dataImg.onerror = function () { reject(new Error('离屏渲染失败（data URL 通道）')); };
        dataImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
        return;
      }
      var blobUrl = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(blobUrl);
        finish(img, 'blob');
      };
      img.onerror = function () {
        URL.revokeObjectURL(blobUrl);
        reject(new Error('离屏渲染失败'));
      };
      img.src = blobUrl;
    });
  }

  function _download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function _fileTitle() {
    var fallback = (function () {
      var d = new Date();
      var p = function (n) { return String(n).padStart(2, '0'); };
      return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
    })();
    try {
      var sid = localStorage.getItem('phymathia_current_session');
      var s = sid && typeof window.getSessionById === 'function' ? window.getSessionById(sid) : null;
      var t = s && (s.title || '').trim();
      return t ? t.slice(0, 40) : fallback;
    } catch (e) { return fallback; }
  }

  // ---------- 主流程 ----------

  function exportGraphImage(scale) {
    if (_exporting) { _toast('正在导出上一张，请稍候…'); return; }
    if (!graphInner || !(graphView.nodes || []).length) {
      _toast('画布还没有内容，先提问生成一张探索网吧');
      return;
    }
    _exporting = true;
    _closeGraphExportMenu();
    _toast('正在收集样式与字体…');
    try { if (typeof _measureNodes === 'function') _measureNodes(); } catch (e) {}
    var bounds = _exportBounds();
    if (!bounds) { _exporting = false; _toast('无法计算画布范围'); return; }
    var out = _resolveOutput(bounds, scale);
    var used = _collectUsedFamilies();

    _buildExportCss(used).then(function (css) {
      var clone = _buildExportClone();
      _toast('正在以 ' + out.outW + '×' + out.outH + ' 渲染，大图需要几秒…');
      return _rasterize(clone, css, bounds, out, 'blob').catch(function (err) {
        if (err && err.security) {
          // blob 通道被判污染：换 data URL 通道再试一次（排除内核对 blob 来源的判定差异）
          _toast('安全策略拦截，正在切换备用通道重试…');
          return _rasterize(clone, css, bounds, out, 'data');
        }
        throw err;
      });
    }).then(function (pngBlob) {
      var safe = _fileTitle().replace(/[\\/:*?"<>|\n\r]/g, '_');
      _download(pngBlob, 'PhyMathia探索网_' + safe + '_' + out.outW + 'x' + out.outH + '.png');
      _toast('已导出超高清图片 ' + out.outW + '×' + out.outH + '（' + Math.round(pngBlob.size / 1024) + ' KB）');
      _exporting = false;
    }).catch(function (err) {
      _exporting = false;
      console.error('[graph-export]', err);
      _toast('导出失败：' + (err && err.message ? err.message : err));
    });
  }

  // ---------- 工具栏菜单 ----------

  function _closeGraphExportMenu() {
    if (_menuEl && _menuEl.parentNode) _menuEl.parentNode.removeChild(_menuEl);
    _menuEl = null;
    if (_outsideCloser) { document.removeEventListener('pointerdown', _outsideCloser, true); _outsideCloser = null; }
    if (_escCloser) { document.removeEventListener('keydown', _escCloser, true); _escCloser = null; }
  }

  function _fmtPx(n) {
    n = Math.round(n);
    if (n >= 10000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
    return String(n);
  }

  // anchor（可选）：{ x, y } 视口坐标（如右键菜单传入的光标位置）。
  // 无参调用 = 工具栏入口现状不变（CSS 右下角 right:16px / bottom:66px 定位）；
  // 有参 = 菜单改在锚点附近弹出并做视口钳制（口径参考 graph-contextmenu.js 的边缘翻转）。
  // 菜单挂在 graphCanvas 内（absolute），锚点须从视口坐标换算画布局部坐标。
  function toggleGraphExportMenu(anchor) {
    if (_menuEl) { if (_menuEl.isConnected) { _closeGraphExportMenu(); return; } _menuEl = null; }
    if (!graphCanvas) graphCanvas = document.getElementById('graphCanvas');
    if (!graphCanvas) return;
    if (!(graphView.nodes || []).length) { _toast('画布还没有内容，先提问生成一张探索网吧'); return; }
    try { if (typeof _measureNodes === 'function') _measureNodes(); } catch (e) {}
    var bounds = _exportBounds();
    if (!bounds) { _toast('无法计算画布范围'); return; }

    // 海报预览尺寸：跑一次纯布局（不碰 canvas，开销可忽略）
    var posterLayout = null;
    try {
      posterLayout = (window.graphPosterDebug && window.graphPosterDebug.layout)
        ? window.graphPosterDebug.layout({
            nodes: graphView.nodes, edges: graphView.edges || [], groups: graphView.groups || [],
          })
        : null;
    } catch (e) {}

    var menu = document.createElement('div');
    menu.className = 'graph-export-menu aurora-glass aurora-glass--dialog';
    var html = '<div class="graph-export-menu-title">导出图片与快照</div>'
      + '<div class="graph-export-section-title">缩略知识海报 <span class="graph-export-sec-tag">推荐</span></div>'
      + '<div class="graph-export-menu-sub">每张节点压成小卡片（类型色 + 标题 + 摘要开头），连线分组照画——一眼看清整张网，不再有看一半的长文。</div>'
      + '<div class="graph-export-grid">';
    SCALES.forEach(function (item) {
      var pw = posterLayout ? Math.round(posterLayout.width * item.s) : 0;
      var ph = posterLayout ? Math.round(posterLayout.height * item.s) : 0;
      html += '<button type="button" class="graph-export-scale-row" data-poster-scale="' + item.s + '">'
        + '<b>' + item.label.replace('（推荐）', '') + '</b>'
        + (posterLayout ? '<span class="graph-export-res">' + _fmtPx(pw) + ' × ' + _fmtPx(ph) + '</span>' : '')
        + '</button>';
    });
    html += '</div>'
      + '<div class="graph-export-section-title">屏幕所见整图（原样克隆画布）</div>'
      + '<div class="graph-export-menu-sub">按屏幕所见逐像素重排渲染，文字按输出分辨率重排。当前内容约 '
      + Math.round(bounds.w) + ' × ' + Math.round(bounds.h) + '；节点内滚动的内容不入图。</div>'
      + '<div class="graph-export-grid">';
    SCALES.forEach(function (item) {
      var r = _resolveOutput(bounds, item.s);
      var expectedW = Math.round((bounds.w + EXPORT_PADDING * 2) * item.s);
      var expectedH = Math.round((bounds.h + EXPORT_PADDING * 2) * item.s);
      var capped = r.outW < expectedW * 0.99 || r.outH < expectedH * 0.99;
      html += '<button type="button" class="graph-export-scale-row" data-scale="' + item.s + '"'+ (capped ? ' title="已按浏览器上限自动收敛倍数"' : '') + '>'
        + '<b>' + item.label.replace('（推荐）', '') + '</b>'
        + '<span class="graph-export-res">' + (capped ? '≈' : '') + _fmtPx(r.outW) + ' × ' + _fmtPx(r.outH) + '</span>'
        + '</button>';
    });
    html += '</div>'
      + '<label class="graph-export-menu-opt"><input type="checkbox" id="graphExportTransparent"'
      + (_transparentBg ? ' checked' : '') + '>透明背景（仅屏幕所见模式，不填充面板底色）</label>'
      + '<div class="graph-export-section-title">可交互产物</div>'
      + '<button type="button" class="graph-export-scale-row" id="graphExportUtopia">'
      + '<b>Utopia 快照 ' + UTOPIA_EXT + '</b>'
      + '<span class="graph-export-res">完整会话 · 可滚动 · 可导回</span>'
      + '</button>';
    if (typeof window.exportUtopiaStandaloneHtml === 'function') {
      html += '<button type="button" class="graph-export-scale-row" id="graphExportHtml">'
        + '<b>单文件网页 .html</b>'
        + '<span class="graph-export-res">内嵌查看器 · 双击即看 · 可外发</span>'
        + '</button>';
    }
    html += '<div class="graph-export-menu-foot">海报是<b>卡片式概览</b>（标题+摘要开头，长文有「全文 N 字」角标）；'
      + '屏幕所见含 KaTeX 公式、Mermaid 图谱与分组框，可视化 iframe 以占位卡出现。'
      + '要看长回答全文请用 <b>Utopia 快照 .pmu</b>（导出后可一键在查看器打开，也能拖回 PhyMathia 恢复成新画布）。'
      + '单文件网页把查看器与数据打进一个 .html，发给没装 PhyMathia 的人也能双击打开。</div>';
    menu.innerHTML = html;

    menu.addEventListener('click', function (event) {
      var utopiaBtn = event.target.closest ? event.target.closest('#graphExportUtopia') : null;
      if (utopiaBtn) {
        _closeGraphExportMenu();
        if (typeof window.exportUtopiaSnapshot === 'function') window.exportUtopiaSnapshot();
        else _toast('快照模块未加载（请硬刷新页面）');
        return;
      }
      var htmlBtn = event.target.closest ? event.target.closest('#graphExportHtml') : null;
      if (htmlBtn) {
        _closeGraphExportMenu();
        window.exportUtopiaStandaloneHtml();
        return;
      }
      var row = event.target.closest ? event.target.closest('.graph-export-scale-row') : null;
      if (row) {
        var ps = parseFloat(row.getAttribute('data-poster-scale'));
        if (ps > 0) {
          if (typeof window.exportGraphPoster === 'function') exportGraphPoster(ps);
          else _toast('海报模块未加载（请硬刷新页面）');
          return;
        }
        var s = parseFloat(row.getAttribute('data-scale'));
        if (s > 0) exportGraphImage(s);
      }
    });
    menu.addEventListener('change', function (event) {
      if (event.target && event.target.id === 'graphExportTransparent') {
        _transparentBg = !!event.target.checked;
      }
    });

    graphCanvas.appendChild(menu);
    _menuEl = menu;

    // 锚点模式（M2）：视口钳制后换算画布局部坐标，并清掉 CSS 的 right/bottom 定位
    if (anchor && isFinite(anchor.x) && isFinite(anchor.y)) {
      var vw = window.innerWidth || 1280;
      var vh = window.innerHeight || 800;
      var mw = menu.offsetWidth || 300;
      var mh = menu.offsetHeight || 200;
      var px = anchor.x;
      var py = anchor.y;
      if (px + mw > vw - 8) px = Math.max(8, vw - mw - 8);
      if (py + mh > vh - 8) py = Math.max(8, vh - mh - 8);
      var rect = graphCanvas.getBoundingClientRect();
      menu.style.left = (px - rect.left) + 'px';
      menu.style.top = (py - rect.top) + 'px';
      menu.style.right = 'auto';
      menu.style.bottom = 'auto';
    }

    _outsideCloser = function (event) {
      if (_menuEl && !_menuEl.contains(event.target)) _closeGraphExportMenu();
    };
    _escCloser = function (event) {
      if (event.key === 'Escape') _closeGraphExportMenu();
    };
    setTimeout(function () {
      document.addEventListener('pointerdown', _outsideCloser, true);
      document.addEventListener('keydown', _escCloser, true);
    }, 0);
  }

  // 全局暴露（onclick 内联调用）
  window.toggleGraphExportMenu = toggleGraphExportMenu;
  window.exportGraphImage = exportGraphImage;
  // 调试/测试钩子（画框纯函数；smoke 与浏览器实测复用）
  window.graphExportDebug = {
    unionRects: _unionRects,
    bounds: _exportBounds,
  };
})();
