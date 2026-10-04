// ===== PhyMathia Utopia 单文件网页导出（主应用侧，不进 viewer 包） =====
// 把「查看器 + 快照数据」打进一个自包含 .html：内联 viewer.html 模板引用的全部
// CSS/JS/字体，快照 JSON 以 window.__UTOPIA_EMBEDDED__ 内嵌——双击即看（file:// 离线
// 可开）、可发给没装 PhyMathia 的人。查看器 boot 优先读内嵌快照（见 viewer-main.js）。
// 管线复刻 graph-export 的 CSS url() 内联策略：字体必内联（KaTeX 只留 woff2 源减重）。
// file:// 三件套（用户实测）：① 壁纸照片深浅两张内联进包，随主题按钮一起切换；② 可视化
// 节点的 KaTeX 资产以 window.__PM_VIZ_ASSETS__ 预内联（桥接走 postMessage 来取，绝对路径在
// file:// 下全被拦）；③ pmu 通道残留界面（打开快照/拖拽卡/.pmu 文案）打包时剔除，
// viewer.html 模板本身不动——恢复 pmu 时无需回滚本文件。
// 交付一律落下载文件（用户拍板 2026-09-26：要的是文件不是弹窗），window.open 通道已拆除。

(function () {
  var IMAGE_INLINE_LIMIT = 96 * 1024; // 图片内联上限（背景照片等大图不进包）

  var _resCache = {}; // url -> dataURL | ''（失败）

  function _fetchDataUrl(url, mustInline) {
    if (_resCache[url] !== undefined) return Promise.resolve(_resCache[url]);
    return fetch(url, { cache: 'force-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer().then(function (buf) {
        if (!mustInline && buf.byteLength > IMAGE_INLINE_LIMIT) return ''; // 大图跳过
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
        }
        var mime = r.headers.get('content-type') || 'application/octet-stream';
        var dataUrl = 'data:' + mime + ';base64,' + btoa(bin);
        _resCache[url] = dataUrl;
        return dataUrl;
      });
    }).catch(function () {
      _resCache[url] = '';
      return '';
    });
  }

  // CSS 里的 url(...) 全部换成 data URI（字体必内联，图片按大小）
  function _inlineCssAssets(cssText, baseUrl) {
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
      var abs;
      try { abs = new URL(raw, baseUrl || location.href).href; } catch (e) { return Promise.resolve(null); }
      var isFont = /\.(woff2?|ttf|otf)(\?|$)/i.test(abs);
      return _fetchDataUrl(abs, isFont);
    })).then(function (results) {
      var map = {};
      keys.forEach(function (k, i) { map[k] = results[i]; });
      return cssText.replace(re, function (whole, q, u) {
        var raw = String(u).trim();
        if (!Object.prototype.hasOwnProperty.call(map, raw)) return whole;
        var data = map[raw];
        return data ? 'url("' + data + '")' : 'url("data:,")';
      });
    });
  }

  // @font-face 只留 woff2 源：woff/ttf 是给老浏览器的双保险，单文件里一份就多几百 KB
  // （KaTeX 全套字体 1.2MB → 296KB）。对没有 woff2 源的规则原样放行。
  function _woff2OnlyCss(cssText) {
    return String(cssText || '').replace(/src\s*:\s*([^;}]+)/gi, function (whole, srcList) {
      if (srcList.indexOf('.woff2') < 0) return whole;
      var kept = srcList.split(',').filter(function (part) {
        return part.indexOf('.woff2') >= 0;
      });
      return kept.length ? 'src:' + kept.join(',') : whole;
    });
  }

  // 安全内嵌 JS 字面量：</script 序列会截断外层 <script>；<!-- 会把解析器切进
  // 「脚本数据转义」状态；U+2028/2029 是合法 JSON 但非法 JS 字符串字面量。三样全转。
  function _embedJsLiteral(value) {
    var json = JSON.stringify(value);
    return json
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '<\\u0021--');
  }

  // 内联脚本防截断：HTML 解析器只认 </script（大小写不敏感）；<\/script 在字符串与
  // 正则里都与原串等价，不会破坏 JS 语法（全量替换 "</" 反而会弄坏除法等词法）。
  function _escapeScriptEnd(code) {
    return String(code).replace(/<\/script/gi, '<\\/script');
  }

  // 兜底样式：壁纸照片深浅两张都内联、随 data-theme 一起切换（用户实测：只内嵌单张
  // 的话切主题壁纸不动，像「主题没生效」）+ 主题遮罩 + 渐变兜底底色（照片没抓到时接管）。
  // 遮罩（::after）与主应用 .bg-overlay 同口径（2026-10-04 拍板）：深色保留藏青纱
  // （--overlay-bg）；浅色按浅色那张壁纸的套 id 分档——星夜 20% 奶白、其余裸壁纸。
  // 导出页壁纸固定为导出时的选择，浅色套 id 由调用方传入。
  function _buildOverrideCss(bgs, wpLight) {
    var dark = bgs && bgs.dark, light = bgs && bgs.light;
    return (dark
      ? 'body::before{content:"";position:fixed;inset:0;z-index:-2;background:url(' + dark + ') center/cover no-repeat;}'
      : '')
      + (light
        ? '[data-theme="light"] body::before{background:url(' + light + ') center/cover no-repeat;}'
        : '')
      + 'body::after{content:"";position:fixed;inset:0;z-index:-1;background:var(--overlay-bg, rgba(5,8,25,.55));pointer-events:none;}'
      + '[data-theme="light"] body::after{background:' + (wpLight === 'night' ? 'rgba(245,240,232,.2)' : 'none') + ';}'
      + 'body{background:linear-gradient(165deg, var(--bg-dark, #0a0e1e) 0%, #0d1426 55%, #0a1020 100%) !important;}'
      + '[data-theme="light"] body{background:linear-gradient(165deg, #eef3fb 0%, #e6edf8 55%, #eef2fa 100%) !important;}';
  }

  // 顶栏整体剔除（用户拍板 2026-09-26：整栏难看，会话/适配/±/展开全部/导出 PNG
  // 都不要；滚轮缩放、拖拽平移、F 适配、/ 搜索等键盘与手势能力全保留）。搜索按钮
  // 用户复评后要求保留——右下角悬浮 🔍 钮（保留原 id 让 viewer-main 绑定照常生效），
  // 与主题钮同款玻璃圆钮。只动单文件产物，viewer.html 模板保持 pmu 兼容。
  function _stripPmuUi(doc) {
    var bar = doc.querySelector('.utopia-bar');
    if (bar) bar.remove();
    var drop = doc.getElementById('utopiaDrop');
    if (drop) drop.remove();
    // 悬浮玻璃圆钮统一样式：🔍 搜索在 🌙 主题上方；图标用与主应用头部一致的
    // 描边 SVG（currentColor 随主题变色，emoji 用户嫌不好看——2026-09-26 复评）
    var floating =
      'position:fixed;right:18px;z-index:9999;width:44px;height:44px;'
      + 'border-radius:50%;border:1px solid var(--border, rgba(100,130,200,.25));'
      + 'background:var(--bg-panel, rgba(16,24,46,.72));color:var(--text-primary, #f0f4f8);'
      + 'cursor:pointer;backdrop-filter:blur(12px);'
      + 'box-shadow:0 4px 18px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;';
    var svg = function (inner) {
      return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"'
        + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    };
    var ICON_MOON = svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>');
    var ICON_SUN = svg('<circle cx="12" cy="12" r="4.4"></circle>'
      + '<line x1="12" y1="2.5" x2="12" y2="4.5"></line><line x1="12" y1="19.5" x2="12" y2="21.5"></line>'
      + '<line x1="2.5" y1="12" x2="4.5" y2="12"></line><line x1="19.5" y1="12" x2="21.5" y2="12"></line>'
      + '<line x1="5.3" y1="5.3" x2="6.7" y2="6.7"></line><line x1="17.3" y1="17.3" x2="18.7" y2="18.7"></line>'
      + '<line x1="5.3" y1="18.7" x2="6.7" y2="17.3"></line><line x1="17.3" y1="6.7" x2="18.7" y2="5.3"></line>');
    var ICON_SEARCH = svg('<circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16" y2="16"></line>');
    var searchBtn = doc.createElement('button');
    searchBtn.id = 'utopiaSearchBtn';
    searchBtn.title = '搜索节点（快捷键 /）';
    searchBtn.setAttribute('style', floating + 'bottom:74px;');
    searchBtn.innerHTML = ICON_SEARCH;
    doc.body.appendChild(searchBtn);
    // 主题按钮自建：固定右下角，保留原 id 让 viewer-main 的点击绑定照常生效
    var themeBtn = doc.createElement('button');
    themeBtn.id = 'utopiaThemeBtn';
    themeBtn.title = '切换深色/浅色（仅本次查看，不改快照）';
    themeBtn.setAttribute('style', floating + 'bottom:18px;');
    themeBtn.innerHTML = ICON_MOON;
    doc.body.appendChild(themeBtn);
    var sync = doc.createElement('script');
    sync.textContent = '(function(){var b=document.getElementById("utopiaThemeBtn");if(!b)return;'
      + 'var MOON=' + JSON.stringify(ICON_MOON) + ',SUN=' + JSON.stringify(ICON_SUN) + ';'
      + 'function s(){b.innerHTML=document.documentElement.getAttribute("data-theme")==="light"?SUN:MOON;}'
      + 's();'
      + 'try{new MutationObserver(s).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});}catch(e){}'
      + 'window.addEventListener("load",s);})();';
    doc.body.appendChild(sync);
  }

  // 文本 → data URI（css 里的 base64 走 utf8 安全转换）
  function _textToDataUrl(text, mime) {
    try {
      return 'data:' + mime + ';base64,' + btoa(unescape(encodeURIComponent(String(text))));
    } catch (e) {
      return 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(String(text));
    }
  }

  // 可视化节点需要的 KaTeX 资产：css（woff2 字体内联）+ 两个 js，全部转 data URI。
  // 桥接在 iframe 里通过 postMessage 向宿主取（render.js 侧监听）——file:// 下绝对路径
  // 全被拦，必须把字节预埋进包。没有可视化节点的图零开销。
  // 注意 css 必须包成 data URI 再交出去：桥接侧是 <link href>，裸 CSS 文本会被当 URL 解析。
  async function _collectVizAssets(snapshot) {
    try {
      var hasViz = false;
      try { hasViz = /```html/i.test(JSON.stringify(snapshot)); } catch (e) { hasViz = false; }
      if (!hasViz) return null;
      var base = location.origin;
      var css = await fetch(base + '/vendor/katex/katex.min.css', { cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (t) { return _inlineCssAssets(_woff2OnlyCss(t), base + '/vendor/katex/katex.min.css'); })
        .then(function (t) { return _textToDataUrl(t, 'text/css'); })
        .catch(function () { return null; });
      var katexJs = await _fetchDataUrl(base + '/vendor/katex/katex.min.js', true);
      var autoJs = await _fetchDataUrl(base + '/vendor/katex/contrib/auto-render.min.js', true);
      if (!css || !katexJs || !autoJs) return null;
      return { css: css, katex: katexJs, auto: autoJs };
    } catch (e) { return null; }
  }

  async function exportUtopiaStandaloneHtml() {
    if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
      toastMsg('画布还没有内容，先提问生成一张探索网吧');
      return false;
    }
    if (typeof window.buildUtopiaSnapshot !== 'function') { toastMsg('快照模块未加载（请硬刷新页面）'); return false; }

    var snapshot;
    try { snapshot = window.buildUtopiaSnapshot(); } catch (e) {
      toastMsg('快照生成失败：' + (e && e.message ? e.message : e));
      return false;
    }

    try {
      toastMsg('正在收集查看器资源（首次约几秒）…');
      var tplText = await fetch('/viewer.html', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('viewer.html HTTP ' + r.status);
        return r.text();
      });
      var doc = new DOMParser().parseFromString(tplText, 'text/html');

      // pmu 残留剔除 + 主题按钮显眼化（只动产物 DOM，模板不动）
      _stripPmuUi(doc);

      // CSS：<link rel=stylesheet> → 内联 <style>
      var cssJobs = [];
      var links = Array.prototype.slice.call(doc.querySelectorAll('link[rel="stylesheet"]'));
      links.forEach(function (link) {
        var href = link.getAttribute('href') || '';
        var abs;
        try { abs = new URL(href, location.origin + '/viewer.html').href; } catch (e) { abs = href; }
        var job = fetch(abs, { cache: 'force-cache' }).then(function (r) {
          if (!r.ok) throw new Error('CSS HTTP ' + r.status);
          return r.text();
        }).then(function (text) {
          return _inlineCssAssets(_woff2OnlyCss(text), abs);
        }).then(function (inlined) {
          var style = doc.createElement('style');
          style.textContent = inlined;
          link.replaceWith(style);
        }).catch(function () {
          link.remove(); // 单个样式表失败：移除引用，不携带外链（离线打不开更糟）
        });
        cssJobs.push(job);
      });
      await Promise.all(cssJobs);

      // 可视化 KaTeX 资产与深浅两张壁纸并行收集（都在模板 CSS/JS 内联之后，与打包正文无关）
      var vizAssets = await _collectVizAssets(snapshot);
      // 壁纸跟随「深浅各自所选」（2026-10-02 挑选器按模式记忆；拿不到挑选器回退内置星夜）
      var bgDarkUrl = '/bg_dark_landscape.jpg';
      var bgLightUrl = '/bg_light_landscape.jpg';
      try {
        if (typeof getWallpaperId === 'function' && typeof WALLPAPER_SETS !== 'undefined') {
          var _bgPick = function (t) {
            var wid = getWallpaperId(t);
            for (var i = 0; i < WALLPAPER_SETS.length; i++) {
              if (WALLPAPER_SETS[i].id !== wid) continue;
              return (t === 'light' ? WALLPAPER_SETS[i].light : WALLPAPER_SETS[i].dark).land;
            }
            return null;
          };
          bgDarkUrl = _bgPick('dark') || bgDarkUrl;
          bgLightUrl = _bgPick('light') || bgLightUrl;
        }
      } catch (eBg) {}
      var bgDark = await _fetchDataUrl(location.origin + bgDarkUrl, true);
      var bgLight = await _fetchDataUrl(location.origin + bgLightUrl, true);

      // JS：<script src> → 内联；viewer.js 前注入内嵌快照
      var scripts = Array.prototype.slice.call(doc.querySelectorAll('script[src]'));
      for (var i = 0; i < scripts.length; i++) {
        var sc = scripts[i];
        var sAbs;
        try { sAbs = new URL(sc.getAttribute('src'), location.origin + '/viewer.html').href; } catch (e) { sAbs = sc.getAttribute('src'); }
        var code = await fetch(sAbs, { cache: 'force-cache' }).then(function (r) {
          if (!r.ok) throw new Error('JS HTTP ' + r.status);
          return r.text();
        }).catch(function () { return null; });
        if (code == null) { sc.remove(); continue; }
        if (/\/js\/viewer\.js/.test(sc.getAttribute('src') || '')) {
          if (vizAssets) {
            var assets = doc.createElement('script');
            assets.textContent = 'window.__PM_VIZ_ASSETS__ = {'
              + 'css:' + _embedJsLiteral(vizAssets.css) + ','
              + 'katex:' + _embedJsLiteral(vizAssets.katex) + ','
              + 'auto:' + _embedJsLiteral(vizAssets.auto) + '};';
            sc.parentNode.insertBefore(assets, sc);
          }
          var embed = doc.createElement('script');
          embed.textContent = 'window.__UTOPIA_EMBEDDED__ = ' + _embedJsLiteral(snapshot) + ';';
          sc.parentNode.insertBefore(embed, sc);
        }
        var inline = doc.createElement('script');
        if (sc.hasAttribute('defer')) inline.setAttribute('defer', '');
        inline.textContent = _escapeScriptEnd(code);
        sc.replaceWith(inline);
      }

      // 兜底样式收尾（放在 body 末尾的 style：壁纸 + 遮罩 + 渐变兜底底色）；挑选器不可用
      // 时回退 'night'——内联的 /bg_*_landscape.jpg 旧默认图本就是星夜那套
      var ov = doc.createElement('style');
      ov.textContent = _buildOverrideCss({ dark: bgDark, light: bgLight },
        (typeof getWallpaperId === 'function') ? getWallpaperId('light') : 'night');
      doc.body.appendChild(ov);

      var html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

      // 交付只落下载文件（用户拍板 2026-09-26：要的是能分享的 .html 文件，不是弹出的页面；
      // 弹窗通道已整体拆除）。a[download] 点击在导出菜单的用户手势链内，不会被拦
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var safe = String(snapshot.title || '探索网').replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 40);
      a.href = url;
      a.download = 'PhyMathia_' + safe + '.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toastMsg('单文件网页已导出（' + Math.round(html.length / 1024) + ' KB）——双击即可离线打开', TOAST_MS_LONG);
      return true;
    } catch (err) {
      console.error('[utopia-html]', err);
      toastMsg('单文件网页导出失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }

  window.exportUtopiaStandaloneHtml = exportUtopiaStandaloneHtml;
})();
