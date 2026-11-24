// ===== PhyMathia Utopia 单文件网页导出（主应用侧，不进 viewer 包） =====
// 把「查看器 + 快照数据」打进一个自包含 .html：内联 viewer.html 模板引用的全部
// CSS/JS/字体，快照 JSON 以 window.__UTOPIA_EMBEDDED__ 内嵌——双击即看（file:// 离线
// 可开）、可发给没装 PhyMathia 的人。查看器 boot 优先读内嵌快照（见 viewer-main.js）。
// 管线复刻 graph-export 的 CSS url() 内联策略：字体必内联（KaTeX 只留 woff2 源减重）。
// file:// 三件套（用户实测）：① 壁纸照片深浅两张内联进包，随主题按钮一起切换；② 可视化
// 节点的 KaTeX 走「现取现转」引导脚本——外发页本身已为会话记录面板内联了整套 KaTeX
//（css+katex.min.js+auto-render），引导脚本在运行时把这三样转成 data URI 答给公式桥，
// 不再重复内联第二份（2026-11-23 前：齿轮会话光这一项就多背 859KB）；③ pmu 通道残留界面
//（打开快照/拖拽卡/.pmu 文案）打包时剔除，viewer.html 模板本身不动——恢复 pmu 时无需回滚本文件。
// 交付一律落下载文件（用户拍板 2026-09-26：要的是文件不是弹窗），window.open 通道已拆除。
// 成品自检（2026-11-23，backlog 574）：坏文件不交出去。打包时哪个样式/脚本/字体没取到
// 一律记名；交付前过两道核对——① 结构核对（成品文本按浏览器的方式重新解析一遍），
// ② 真打开核对（成品先在隐藏窗口里装载、数节点）。任一不过就不出文件，把原因告诉用户。
// 起因：11-02 调整构建目录后入口脚本没被认出，导出页空白了 21 天，期间一直提示「已导出」。

(function () {
  var IMAGE_INLINE_LIMIT = 96 * 1024; // 图片内联上限（背景照片等大图不进包）

  var _resCache = {}; // url -> dataURL | ''（大图不进包时也是 ''）| Promise（在途，同 url 并发去重）
  var _resErrors = {}; // url -> 失败原因，只给自检点名用。失败不进 _resCache：下次导出会重试

  function _utopiaErrText(e) {
    return e && e.message ? e.message : String(e);
  }

  // 资源名给自检点名用：去掉源站和缓存指纹，只留认得出的路径（/dist/viewer.js?v=87d2… → /dist/viewer.js）
  function _utopiaResName(url) {
    return String(url || '').trim().replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?&]v=[0-9A-Za-z]+$/, '')
      .replace(/\?$/, '') || '未知文件';
  }

  // 返回 Promise（dataURL 或 ''）。并发安全：同一 url 的在途请求直接复用（backlog 578，
  // 2026-11-23——此前这里缓存结果、逐个 await，脚本/KaTeX/壁纸全程串行排队）
  function _fetchDataUrl(url, mustInline) {
    if (_resCache[url] !== undefined) return Promise.resolve(_resCache[url]);
    var job = fetch(url, { cache: 'force-cache' }).then(function (r) {
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
    }).catch(function (e) {
      _resErrors[url] = _utopiaErrText(e);
      return '';
    });
    _resCache[url] = job;
    // 落定后把缓存槽从 Promise 换成终值（内存里不留悬挂的 Promise 链）
    job.then(function (v) { if (_resCache[url] === job) _resCache[url] = v; });
    return job;
  }

  // CSS 里的 url(...) 全部换成 data URI（字体必内联，图片按大小）。
  // fontMisses（可选数组）：字体取不到时逐个记进来——取不到的字体只会被换成一个空地址，
  // 页面上公式静默退回系统字体，自检要靠这份名单点名拦下；图片取不到按原设计静默置空。
  // data URI 先整块护住再处理其余：手写/压缩后的 SVG 噪点这类 URI 内部常带 url(%23filter)
  // 的「伪 url()」——直接全局正则会把它当真资源抓取（404）并把成品里的 SVG 改坏
  // （continent-grain 噪点纹理实测被改成 url("data:,")，外发页里一直是坏的）。
  function _inlineCssAssets(cssText, baseUrl, fontMisses) {
    var parts = String(cssText).split(/(url\(\s*(?:["'])data:[\s\S]*?(?:["'])\s*\))/);
    var seen = {};
    var re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    parts.forEach(function (seg, i) {
      if (i % 2 === 1) return; // 奇数位＝data URI 整块，一个字都不动
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(seg))) {
        var raw = m[2].trim();
        if (!raw || raw.indexOf('data:') === 0 || raw.charAt(0) === '#' || raw.indexOf('%23') === 0) continue;
        seen[raw] = true;
      }
    });
    var keys = Object.keys(seen);
    if (!keys.length) return Promise.resolve(cssText);
    return Promise.all(keys.map(function (raw) {
      var abs;
      try { abs = new URL(raw, baseUrl || location.href).href; } catch (e) { return Promise.resolve(null); }
      var isFont = /\.(woff2?|ttf|otf)(\?|$)/i.test(abs);
      return _fetchDataUrl(abs, isFont).then(function (data) {
        if (isFont && !data && fontMisses) {
          fontMisses.push({ name: raw.split('/').pop(), error: _resErrors[abs] || '原因不明' });
        }
        return data;
      });
    })).then(function (results) {
      var map = {};
      keys.forEach(function (k, i) { map[k] = results[i]; });
      return parts.map(function (seg, i) {
        if (i % 2 === 1) return seg;
        re.lastIndex = 0;
        return seg.replace(re, function (whole, q, u) {
          var raw = String(u).trim();
          if (!Object.prototype.hasOwnProperty.call(map, raw)) return whole;
          var data = map[raw];
          return data ? 'url("' + data + '")' : 'url("data:,")';
        });
      }).join('');
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
      // T166：色值收在 styles.css「Utopia 单文件导出页配色」令牌区；导出包会内联全部
      // CSS（含 :root），包内 var() 直接可用，旧的行内 fallback 一并删除。
      + 'body::after{content:"";position:fixed;inset:0;z-index:-1;background:var(--overlay-bg);pointer-events:none;}'
      + '[data-theme="light"] body::after{background:' + (wpLight === 'night' ? 'var(--utopia-veil-night)' : 'none') + ';}'
      + 'body{background:linear-gradient(165deg, var(--bg-dark) 0%, var(--utopia-grad-mid) 55%, var(--utopia-grad-end) 100%) !important;}'
      + '[data-theme="light"] body{background:linear-gradient(165deg, var(--utopia-grad-light-from) 0%, var(--utopia-grad-light-mid) 55%, var(--utopia-grad-light-to) 100%) !important;}';
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
      + 'border-radius:50%;border:1px solid var(--border);'
      + 'background:var(--bg-panel);color:var(--text-primary);'
      + 'cursor:pointer;backdrop-filter:blur(12px);'
      + 'box-shadow:var(--utopia-btn-shadow);display:flex;align-items:center;justify-content:center;';
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

  // 可视化节点的 KaTeX 资产供给（backlog 578①，2026-11-23 改「现取现转」）：
  // 外发页为会话记录面板本来就内联了整套 KaTeX（katex.min.css + katex.min.js + auto-render）。
  // 桥接协议照旧（render.js 注入的公式桥 postMessage 向宿主要 {css,katex,auto} 三个 data URI，
  // file:// 下绝对路径全被拦）——但不再打包时重复内联第二份字节，而是埋一段引导脚本：
  // 打包后运行时把页面自己的 <style>/<script> 字节现转成 data URI 再应答。
  //   js：innerHTML 正是原始源码（内联脚本无 textContent 转义损益）；
  //   css：textContent 是文本值，引号/&#39; 等字符引用会被解码——但 KaTeX css 不含引号/&)，
  //       base64 层各引一半，双方拼回的都是合法 data URI，等价处可安全汇合。
  // 没有可视化节点的图：整个 <script> 都不注入，零开销。真机回归 file:// 步骤会等
  // 可视化卡里 .katex 真渲出来——「转化没跑/缺资产」这类运行期故障由它兜住。
  // 返回值是纯 JS（不含 <script> 外壳——调用方创建 script 元素、textContent 塞入）：
  // 内容里绝不能出现 </script 序列，否则成品序列化时会把元素提前截断。
  // 必须同步应答（2026-11-24）：查看器包 render.js 自带的应答器也在监听同一请求——
  // 它读 window.__PM_VIZ_ASSETS__，外发页已不打包这份资产，它会「立即回空」；本引导脚本
  // 是更早注册的监听器（插在 viewer.js 入口之前），同步应答必先到，对方的那次回空会被
  // 公式桥的 got 闸门丢掉。曾用 setTimeout(100) 异步应答，实测被同步空应答抢跑，
  // file:// 下公式全裸奔（真机回归「公式真渲」当场抓包）。
  function _utopiaVizBridgeScript() {
    return '(function(){'
      + 'function toData(mime,text){try{return "data:"+mime+";base64,"+btoa(unescape(encodeURIComponent(text)));}'
      + 'catch(e){return "data:"+mime+";charset=utf-8,"+encodeURIComponent(text);}}'
      + 'function nodeOf(sel){var n=document.querySelector(sel);return n||null;}'
      // 找齐三样：带 data-pm-katex 标记的 KaTeX 样式表、katex.min.js（UMD 头、大、无
      // renderMathInElement——那个词只属于 auto-render 与查看器包）、auto-render（小）。
      + 'function answer(ev){'
      + 'var css=nodeOf("style[data-pm-katex]");'
      + 'var katex=null,auto=null;'
      + 'var scripts=document.getElementsByTagName("script");'
      + 'for(var i=scripts.length-1;i>=0;i--){'
      + 'var s=scripts[i];if(s.getAttribute("src"))continue;'
      // 必须 hasAttribute：setAttribute(x,'') 的空值让 getAttribute 返回 ''（falsy），跳过失效
      + 'if(s.hasAttribute("data-pm-skip"))continue;'
      + 'var t=s.textContent||"";'
      + 'if(!katex&&t.indexOf("!function(e,t)")===0&&t.indexOf("katex")>=0&&t.length>100000'
      + '&&t.indexOf("renderMathInElement")<0)katex=t;'
      + 'else if(!auto&&t.indexOf("renderMathInElement")>=0&&t.length<20000)auto=t;'
      + '}'
      + 'if(!css||!katex||!auto)return false;'
      + 'try{ev.source.postMessage({__pmVizAssets:true,'
      + 'css:toData("text/css",css.textContent),'
      + 'katex:toData("text/javascript",katex),'
      + 'auto:toData("text/javascript",auto)},"*");}catch(e){return false;}'
      + 'return true;}'
      + 'window.addEventListener("message",function(ev){'
      + 'var d=ev&&ev.data||{};'
      + 'if(d.__pmVizAssetsRequest!==true)return;'
      + 'if(document.readyState==="loading"){'
      + 'document.addEventListener("DOMContentLoaded",function(){answer(ev);});'
      + 'return;'
      + '}'
      + 'answer(ev);'
      + '});'
      + '})();';
  }

  // ===== 成品自检 =====

  var EMBED_PREFIX = 'window.__UTOPIA_EMBEDDED__ = ';
  var EMBED_KEY = '__UTOPIA_EMBEDDED__';
  // 可视化公式资源的认记号（2026-11-23 起）：不再打包第二份 KaTeX 字节，改埋「现取现转」
  // 引导脚本，样式表自带 data-pm-katex 标记——有可视化节点的成品里必须找得到它
  var VIZ_MARKER = 'data-pm-katex';
  var ENTRY_RE = /(^|\/)viewer\.js(?:\?|$)/;

  // ① 结构核对（纯函数，回归脚本直接调）：把成品文本按浏览器的方式重新解析一遍，对照快照
  // 逐项验。problems 是给用户看的原因——第一条进 toast，全量进控制台。
  // opts.failed：收集阶段取不到的资源 [{kind, name, error}]；opts.entrySeen：认出的入口脚本份数；
  // opts.hasViz：本该带上可视化公式资源。
  function utopiaHtmlVerifyPacked(html, snapshot, opts) {
    opts = opts || {};
    var problems = [];
    var snap = snapshot || {};
    var expected = (snap.nodes || []).length;
    var doc;
    try { doc = new DOMParser().parseFromString(String(html), 'text/html'); } catch (e) {
      return { ok: false, problems: ['成品没法按网页解析（' + _utopiaErrText(e) + '）'] };
    }
    if (!doc || !doc.documentElement || !doc.body) return { ok: false, problems: ['成品不是一张完整网页'] };

    (opts.failed || []).forEach(function (f) {
      var line = (f.kind || '资源') + '没取到：' + (f.name || '未知文件') + '（' + (f.error || '原因不明') + '）';
      if (problems.indexOf(line) < 0) problems.push(line);
    });

    // 外链一个都不许留：file:// 下取不到，留了就是半张页
    Array.prototype.forEach.call(doc.querySelectorAll('link[rel="stylesheet"]'), function (link) {
      problems.push('样式表没打进文件：' + (link.getAttribute('href') || '未知地址'));
    });
    Array.prototype.forEach.call(doc.querySelectorAll('script[src]'), function (sc) {
      problems.push('脚本没打进文件：' + (sc.getAttribute('src') || '未知地址'));
    });
    if (opts.entrySeen === 0) problems.push('没认出查看器入口脚本（viewer.js）');

    // 内嵌快照：恰好一份、能原样读回、排在入口脚本之前、入口脚本真读它
    var scripts = Array.prototype.slice.call(doc.querySelectorAll('script'));
    var embedCount = 0, embedAt = -1, entryAt = -1, payload = '', hasVizBlock = false;
    scripts.forEach(function (sc, i) {
      var text = sc.textContent || '';
      if (text.indexOf(EMBED_PREFIX) === 0) {
        embedCount++;
        if (embedAt < 0) { embedAt = i; payload = text.slice(EMBED_PREFIX.length); }
      } else if (text.indexOf(EMBED_KEY) >= 0 && entryAt < 0) {
        entryAt = i; // 入口脚本＝会读内嵌快照的那一段（查看器包）
      }
      if (text.indexOf(VIZ_MARKER) >= 0) hasVizBlock = true;
    });
    if (embedCount === 0) problems.push('内嵌快照没打进文件（打开会是空白）');
    else if (embedCount > 1) problems.push('内嵌快照打进了 ' + embedCount + ' 份');
    if (entryAt < 0) problems.push('查看器入口脚本不读内嵌快照（多半是认错了入口）');
    else if (embedAt > entryAt) problems.push('内嵌快照排到了查看器脚本后面');
    if (embedCount === 1) {
      var parsed = null;
      try { parsed = JSON.parse(payload.replace(/;\s*$/, '')); } catch (e) { parsed = null; }
      var same = false;
      try { same = !!parsed && JSON.stringify(parsed) === JSON.stringify(snap); } catch (e) { same = false; }
      if (!parsed) problems.push('内嵌快照不完整（多半是被截断）');
      else if (!same) {
        problems.push('内嵌快照与画布对不上（节点应有 ' + expected + ' 个，读回 '
          + ((parsed.nodes || []).length) + ' 个）');
      }
    }
    if (opts.hasViz && !hasVizBlock) problems.push('可视化公式资源没打进文件');
    return { ok: problems.length === 0, problems: problems };
  }

  // ② 真打开核对：成品先在隐藏窗口里装载一遍，数节点。结构核对查不出的运行期故障
  // （入口脚本自己抛错、渲染中途断掉）由它兜——那种页面上一个节点都没有。
  var RENDER_CHECK_MS = 15000; // 装载总时限：慢机器上 4MB 的页也要几秒
  var RENDER_GRACE_MS = 2500;  // 装载完成后留给渲染收敛的时间；过了还数不齐就判不过，不空等总时限

  function _utopiaRenderCheck(url, expected) {
    return new Promise(function (resolve) {
      var result = { ok: false, loaded: false, domNodes: 0, snapNodes: 0, error: '', scriptError: '' };
      var frame = document.createElement('iframe');
      var startedAt = Date.now(), loadedAt = 0, settled = false, timer = null;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      // 留在视口内只藏不挪：挪出屏外的窗口会被浏览器节流，装载和渲染都不按正常节奏走。
      // 尺寸照主窗口来，适配画布之类的布局计算与对方真实打开时同口径。
      frame.setAttribute('style', 'position:fixed;left:0;top:0;width:100%;height:100%;border:0;'
        + 'visibility:hidden;pointer-events:none;z-index:-1;');
      frame.addEventListener('load', function () { loadedAt = Date.now(); result.loaded = true; });
      function probe() {
        var w = null, d = null;
        try { w = frame.contentWindow; d = w && w.document; } catch (e) { d = null; }
        if (!d) return false;
        // 查看器把载入的快照挂在 window.__UTOPIA__ 上，从这里数「数据到了多少个节点」
        // （graphView 是顶层 const、不在 window 上，跨窗口读不到）
        try {
          var U = w.__UTOPIA__;
          result.snapNodes = U && U.snapshot && U.snapshot.nodes ? U.snapshot.nodes.length : 0;
        } catch (e) { result.snapNodes = 0; }
        try { result.domNodes = d.querySelectorAll('.graph-node').length; } catch (e) { result.domNodes = 0; }
        try {
          var box = d.getElementById('utopiaError');
          result.error = box && !box.hidden ? String(box.textContent || '').trim() : '';
        } catch (e) { result.error = ''; }
        // 脚本报错再兜一个来源：查看器自己的异常提示条（窗口监听器没接住时还有它）
        if (!result.scriptError) {
          try {
            var mm = String((d.getElementById('phymathia_toast') || {}).textContent || '')
              .match(/脚本异常[:：]\s*([^\n（(]+)/);
            if (mm) result.scriptError = mm[1].trim().slice(0, 120);
          } catch (e) {}
        }
        return result.domNodes >= expected;
      }
      function finish() {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        frame.remove();
        resolve(result);
      }
      document.body.appendChild(frame);
      // 首次导航会沿用这个 window 对象，装载期的脚本报错在这里接得住——只给自检报原因用
      try {
        frame.contentWindow.addEventListener('error', function (ev) {
          if (ev && ev.message && !result.scriptError) result.scriptError = String(ev.message).slice(0, 120);
        });
      } catch (e) {}
      timer = setInterval(function () {
        if (probe()) { result.ok = true; finish(); return; }
        var now = Date.now();
        if ((loadedAt && now - loadedAt > RENDER_GRACE_MS) || now - startedAt > RENDER_CHECK_MS) finish();
      }, 100);
      frame.src = url;
    });
  }

  // 自检不过：不出文件，把第一条原因告诉用户（全量进控制台）；报告留在 window 上供排查与回归脚本读取
  function _utopiaSelfCheckFail(report) {
    window.__utopiaLastSelfCheck = report;
    console.error('[utopia-html] 自检未通过，已拦下不出文件：', report.problems, report.render || '');
    var more = report.problems.length - 1;
    toastMsg('单文件网页导出失败——自检发现：' + report.problems[0] + (more > 0 ? '（另有 ' + more + ' 项）' : ''),
      TOAST_MS_LONG);
  }

  var _exporting = false; // 进行中标记：导出菜单与浮卡的「再存网页版」连点时不并发打两份

  async function exportUtopiaStandaloneHtml() {
    if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
      toastMsg('画布还没有内容，先提问生成一张探索网吧');
      return false;
    }
    if (typeof window.buildUtopiaSnapshot !== 'function') { toastMsg('快照模块未加载（请硬刷新页面）'); return false; }
    if (_exporting) { toastMsg('单文件网页正在导出，请稍候'); return false; }
    _exporting = true;
    try {
      var snapshot;
      try {
        // 外发只读：不带节点旧版本账本（.pmu 存档不受影响），这是 579 的体积大头
        snapshot = window.buildUtopiaSnapshot({ stripVersions: true });
      } catch (e) {
        toastMsg('快照生成失败：' + (e && e.message ? e.message : e));
        return false;
      }

      toastMsg('正在收集查看器资源…');
      // 取不到/内联不了的资源逐个记名，交给自检点名（2026-11-23 前是悄悄剔掉、照常「已导出」）
      var failures = [];
      var tplText = await fetch('/viewer.html', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('viewer.html HTTP ' + r.status);
        return r.text();
      });
      var doc = new DOMParser().parseFromString(tplText, 'text/html');

      // pmu 残留剔除 + 主题按钮显眼化（只动产物 DOM，模板不动）
      _stripPmuUi(doc);

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

      // ===== 并行收集（backlog 578，2026-11-23 前是逐个 await 串行排队）=====
      // 模板里的样式表、全部脚本、深浅壁纸一次并发取齐，Promise.all 汇合后再统一回填 DOM。
      // CSS 里的字体必内联、@font-face 只留 woff2 源；取不到的逐个记名给自检拦下。
      var cssJobs = Array.prototype.map.call(doc.querySelectorAll('link[rel="stylesheet"]'), function (link) {
        var href = link.getAttribute('href') || '';
        var abs;
        try { abs = new URL(href, location.origin + '/viewer.html').href; } catch (e) { abs = href; }
        return fetch(abs, { cache: 'force-cache' }).then(function (r) {
          if (!r.ok) throw new Error('CSS HTTP ' + r.status);
          return r.text();
        }).then(function (text) {
          if (!text || !text.trim()) throw new Error('内容为空');
          var fontMisses = [];
          return _inlineCssAssets(_woff2OnlyCss(text), abs, fontMisses).then(function (inlined) {
            fontMisses.forEach(function (f) {
              failures.push({ kind: '样式表字体', name: f.name, error: f.error });
            });
            return inlined;
          });
        }).then(
          function (inlined) { return { link: link, inlined: inlined }; },
          function (e) {
            // 样式表取不到：移除引用，不携带外链（离线打不开更糟）；记名后自检会拦下交付
            failures.push({ kind: '样式表', name: _utopiaResName(href), error: _utopiaErrText(e) });
            return { link: link, failed: true };
          }
        );
      });
      var jsJobs = Array.prototype.map.call(doc.querySelectorAll('script[src]'), function (sc) {
        var scName = _utopiaResName(sc.getAttribute('src'));
        var sAbs;
        try { sAbs = new URL(sc.getAttribute('src'), location.origin + '/viewer.html').href; } catch (e) { sAbs = sc.getAttribute('src'); }
        return fetch(sAbs, { cache: 'force-cache' }).then(function (r) {
          if (!r.ok) throw new Error('JS HTTP ' + r.status);
          return r.text();
        }).then(
          function (code) { return { sc: sc, scName: scName, code: code }; },
          function (e) {
            failures.push({ kind: '脚本', name: scName, error: _utopiaErrText(e) });
            return { sc: sc, scName: scName, failed: true };
          }
        );
      });
      var bgDarkJob = _fetchDataUrl(location.origin + bgDarkUrl, true);
      var bgLightJob = _fetchDataUrl(location.origin + bgLightUrl, true);
      var settled = await Promise.all(cssJobs.concat(jsJobs).concat([bgDarkJob, bgLightJob]));
      var cssDone = settled.slice(0, cssJobs.length);
      var jsDone = settled.slice(cssJobs.length, cssJobs.length + jsJobs.length);
      var bgDark = await bgDarkJob;
      var bgLight = await bgLightJob;

      // 回填 CSS：<link rel=stylesheet> → 内联 <style>；主 KaTeX 样式表带 data-pm-katex
      // 标记——可视化引导脚本运行时按它找到这份 css 现转 data URI（backlog 578①）
      cssDone.forEach(function (job) {
        if (job.failed) { job.link.remove(); return; }
        var style = doc.createElement('style');
        style.textContent = job.inlined;
        if (/katex\.min\.css/i.test(job.link.getAttribute('href') || '')) {
          style.setAttribute('data-pm-katex', '');
        }
        job.link.replaceWith(style);
      });

      // 回填 JS：<script src> → 内联；viewer.js 前注入内嵌快照（与可视化引导脚本）
      var hasViz = false;
      try { hasViz = /```html/i.test(JSON.stringify(snapshot)); } catch (e) { hasViz = false; }
      var entrySeen = 0;
      jsDone.forEach(function (job) {
        var sc = job.sc;
        if (job.failed || !job.code || !job.code.trim()) {
          if (job.code) failures.push({ kind: '脚本', name: job.scName, error: '内容为空' });
          sc.remove(); // 脚本取不到：移除引用；记名后自检会拦下交付
          return;
        }
        // 视图入口脚本按「文件名 viewer.js」识别（ENTRY_RE），不钉目录与查询串：
        // T64 起产物住 /dist/、src 带 ?v=<hash>，旧口径 /js/viewer.js 已不存在，
        // 钉死会让内嵌快照整段不注入（导出页永远空白）。
        if (ENTRY_RE.test(sc.getAttribute('src') || '')) {
          entrySeen++;
          if (hasViz) {
            var assets = doc.createElement('script');
            // data-pm-skip：引导脚本自己含「renderMathInElement」特征词且体长 <20K，
            // 不跳过会被下面的识别逻辑当成 auto-render 抓走（真机实踩：公式全裸奔）
            assets.setAttribute('data-pm-skip', '');
            assets.textContent = _utopiaVizBridgeScript();
            sc.parentNode.insertBefore(assets, sc);
          }
          var embed = doc.createElement('script');
          embed.setAttribute('data-pm-skip', ''); // 快照正文是任意文本，不参与脚本识别
          embed.textContent = 'window.__UTOPIA_EMBEDDED__ = ' + _embedJsLiteral(snapshot) + ';';
          sc.parentNode.insertBefore(embed, sc);
        }
        var inline = doc.createElement('script');
        if (sc.hasAttribute('defer')) inline.setAttribute('defer', '');
        inline.textContent = _escapeScriptEnd(job.code);
        sc.replaceWith(inline);
      });
      if (hasViz && entrySeen === 0) {
        // 引导脚本挂在入口前面，入口没认出来＝引导段也没机会注入——让结构核对该点点名
        failures.push({ kind: '可视化公式脚本', name: 'viewer.js（入口没认出，引导脚本无处注入）', error: 'ENTRY_RE 未命中' });
      }

      // 兜底样式收尾（放在 body 末尾的 style：壁纸 + 遮罩 + 渐变兜底底色）；挑选器不可用
      // 时回退 'night'——内联的 /bg_*_landscape.jpg 旧默认图本就是星夜那套
      var ov = doc.createElement('style');
      ov.textContent = _buildOverrideCss({ dark: bgDark, light: bgLight },
        (typeof getWallpaperId === 'function') ? getWallpaperId('light') : 'night');
      doc.body.appendChild(ov);

      var html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

      // ① 结构核对：不过就不往下走，更不出文件
      var report = utopiaHtmlVerifyPacked(html, snapshot, { failed: failures, entrySeen: entrySeen, hasViz: hasViz });
      if (!report.ok) {
        _utopiaSelfCheckFail(report);
        return false;
      }

      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      try {
        // ② 真打开核对：成品先在隐藏窗口里装载一遍、数节点
        toastMsg('正在自检成品…');
        var expected = (snapshot.nodes || []).length;
        var render = await _utopiaRenderCheck(url, expected);
        if (!render.ok) {
          var why = !render.loaded
            ? '成品没能在 ' + Math.round(RENDER_CHECK_MS / 1000) + ' 秒内装载完'
            : '成品打开后只有 ' + render.domNodes + '/' + expected + ' 个节点';
          if (render.scriptError) why += '（脚本报错：' + render.scriptError + '）';
          else if (render.error) why += '（' + render.error + '）';
          _utopiaSelfCheckFail({ ok: false, problems: [why], render: render });
          return false;
        }
        window.__utopiaLastSelfCheck = { ok: true, problems: [], render: render };

        // 交付（2026-11-23 起）：按用户拍板走「导出完成浮卡」——与 .pmu 存档同一张卡
        //（showUtopiaExportCard），网页版只读外发，按钮只剩「复制文件名／知道了」；
        // 浮卡出手前撤掉收集期的进行中提示条（两者都在底部，会互相压）。
        // 落盘用 a[download]：在异步等待之后触发，不经弹窗权限。
        try { _toastDismiss(document.getElementById('phymathia_toast')); } catch (e) {}
        var a = document.createElement('a');
        var fileName = (typeof window.utopiaHtmlFilename === 'function')
          ? window.utopiaHtmlFilename(snapshot.title) // <名>_<日期_时分>.html，重复导出不互相覆盖
          : 'PhyMathia_' + String(snapshot.title || '探索网').replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 40) + '.html';
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        var summary = window.utopiaSnapshotSummary
          ? window.utopiaSnapshotSummary(snapshot)
          : { mode: 'full', nodes: expected, edges: 0, messages: 0 };
        summary.bytes = blob.size;
        summary.fileName = fileName;
        summary.kind = 'html';
        summary.edges = (snapshot.edges || []).length;
        if (typeof showUtopiaExportCard === 'function') showUtopiaExportCard(summary);
        else toastMsg('单文件网页已导出（' + _utopiaFmtSize(blob.size) + '）——双击即可离线打开', TOAST_MS_LONG);
        return true;
      } finally {
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }
    } catch (err) {
      console.error('[utopia-html]', err);
      toastMsg('单文件网页导出失败：' + (err && err.message ? err.message : err));
      return false;
    } finally {
      _exporting = false;
    }
  }

  window.exportUtopiaStandaloneHtml = exportUtopiaStandaloneHtml;
  window.utopiaHtmlVerifyPacked = utopiaHtmlVerifyPacked;
})();
