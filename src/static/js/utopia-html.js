// ===== PhyMathia Utopia 单文件网页导出（主应用侧，不进 viewer 包） =====
// 把「查看器 + 快照数据」打进一个自包含 .html：内联 viewer.html 模板引用的全部
// CSS/JS/字体，快照 JSON 以 window.__UTOPIA_EMBEDDED__ 内嵌——双击即看（file:// 离线
// 可开）、可发给没装 PhyMathia 的人。查看器 boot 优先读内嵌快照（见 viewer-main.js）。
// 管线复刻 graph-export 的 CSS url() 内联策略：字体必内联；图片小于阈值内联，超大
// 图（页面背景照片）替换为空资源并由追加的兜底底色接管——单文件不必背着几百 KB 的
// 装饰照片跑。

(function () {
  var IMAGE_INLINE_LIMIT = 96 * 1024; // 图片内联上限（背景照片等大图不进包）

  function _toast(msg) { if (typeof showToast === 'function') showToast(msg, 3600); }

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

  // 兜底样式：被跳过的大背景图由渐变底色接管（跟随主题变量），并压掉外部字体请求的回退
  var OVERRIDE_CSS = 'body{background:linear-gradient(165deg, var(--bg-dark, #0a0e1e) 0%, #0d1426 55%, #0a1020 100%) !important;}'
    + '[data-theme="light"] body{background:linear-gradient(165deg, #eef3fb 0%, #e6edf8 55%, #eef2fa 100%) !important;}';

  async function exportUtopiaStandaloneHtml() {
    if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
      _toast('画布还没有内容，先提问生成一张探索网吧');
      return false;
    }
    if (typeof window.buildUtopiaSnapshot !== 'function') { _toast('快照模块未加载（请硬刷新页面）'); return false; }

    var snapshot;
    try { snapshot = window.buildUtopiaSnapshot(); } catch (e) {
      _toast('快照生成失败：' + (e && e.message ? e.message : e));
      return false;
    }

    var win = window.open('', '_blank'); // 预占新窗口句柄（异步收集资源后再写入）
    if (win) { try { win.document.write('<p style="font-family:sans-serif;padding:24px">正在打包单文件网页…</p>'); } catch (e) { win = null; } }

    try {
      _toast('正在收集查看器资源（首次约几秒）…');
      var tplText = await fetch('/viewer.html', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('viewer.html HTTP ' + r.status);
        return r.text();
      });
      var doc = new DOMParser().parseFromString(tplText, 'text/html');

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
          return _inlineCssAssets(text, abs);
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
          var embed = doc.createElement('script');
          embed.textContent = 'window.__UTOPIA_EMBEDDED__ = ' + _embedJsLiteral(snapshot) + ';';
          sc.parentNode.insertBefore(embed, sc);
        }
        var inline = doc.createElement('script');
        if (sc.hasAttribute('defer')) inline.setAttribute('defer', '');
        inline.textContent = _escapeScriptEnd(code);
        sc.replaceWith(inline);
      }

      // 兜底样式收尾（放在 body 末尾的 style，覆盖被跳过的背景图）
      var ov = doc.createElement('style');
      ov.textContent = OVERRIDE_CSS;
      doc.body.appendChild(ov);

      var html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

      // 交付：预开的窗口直接写入（保留用户手势链），否则走下载
      if (win) {
        try {
          win.document.open();
          win.document.write(html);
          win.document.close();
          _toast('单文件网页已在新窗口打开——另存为（Ctrl+S）即可分享');
          return true;
        } catch (e) { /* 写不进去（about:blank 被拦等）→ 落回下载 */ }
      }
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
      _toast('单文件网页已导出（' + Math.round(html.length / 1024) + ' KB）——双击即可离线打开');
      return true;
    } catch (err) {
      if (win) { try { win.close(); } catch (e2) {} }
      console.error('[utopia-html]', err);
      _toast('单文件网页导出失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }

  window.exportUtopiaStandaloneHtml = exportUtopiaStandaloneHtml;
})();
