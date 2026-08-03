// ====== HTML 转义（供渲染使用） ======
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ====== 可视化卡片 (iframe sandbox) ======
const _vizStore = {};  // vizId -> htmlContent

function _escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _decodeHTMLEntities(str) {
  const ta = document.createElement('textarea');
  ta.innerHTML = str;
  return ta.value;
}

function _sanitizeMarkdownHtml(html) {
  const protectPlaceholders = (marker, attr) => {
    const re = new RegExp(`<!--${marker}_(\\d+)-->`, 'g');
    html = html.replace(re, `<span data-phymathia-${attr}="$1"></span>`);
  };
  protectPlaceholders('MATH_PLACEHOLDER', 'math');
  protectPlaceholders('MERMAID_PLACEHOLDER', 'mermaid');

  if (window.DOMPurify) {
    html = DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'data-phymathia-math', 'data-phymathia-mermaid'],
    });
  } else {
    html = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
      .replace(/<embed\b[^>]*>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1="#"');
  }

  html = html.replace(/<span data-phymathia-math="(\d+)"><\/span>/g, '<!--MATH_PLACEHOLDER_$1-->');
  html = html.replace(/<span data-phymathia-mermaid="(\d+)"><\/span>/g, '<!--MERMAID_PLACEHOLDER_$1-->');
  return html;
}

function _sanitizeVizHtml(html) {
  // 移除对 parent/top/window.open 的危险引用，保留正常脚本
  return html
    .replace(/\bparent\s*\./g, '/* removed */.')
    .replace(/\btop\s*\./g, '/* removed */.')
    .replace(/\bwindow\[["']parent["']\]/g, '/* removed */')
    .replace(/\bwindow\[["']top["']\]/g, '/* removed */')
    .replace(/\bwindow\.open\s*\(/g, '/* removed */(')
    .replace(/\bwindow\.close\s*\(/g, '/* removed */(');
}

function buildVizCard(htmlContent, vizId) {
  const safe = _sanitizeVizHtml(htmlContent);
  // 注入主题桥接脚本（在 sanitize 之后，避免被清理）：
  // 监听父页面主题切换消息 + 加载时读取父主题，设置 data-theme 并尝试调用页面内主题机制
  let finalHtml = safe.replace(/<\/head>/i, _VIZ_THEME_BRIDGE + '</head>');
  if (finalHtml === safe) {
    finalHtml = safe.replace(/<\/body>/i, _VIZ_THEME_BRIDGE + '</body>');
  }
  if (finalHtml === safe) {
    finalHtml = safe + _VIZ_THEME_BRIDGE;
  }
  _vizStore[vizId] = finalHtml;  // 保存（含桥接脚本）供全屏/复制/新标签页使用

  const isTall = safe.length > 8000 || /canvas|svg|three|chart|d3/i.test(safe);
  const heightClass = isTall ? ' viz-iframe-tall' : '';

  // 使用占位 iframe，通过 JS 动态设置 srcdoc 避免属性转义问题
  return '<div class="viz-card" id="' + vizId + '">'
    + '<div class="viz-toolbar">'
    + '<span class="viz-label"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v18"/></svg> 交互式可视化</span>'
    + '<div class="viz-actions">'
    + '<button class="viz-btn viz-dontget" onclick="dontUnderstandViz()" title="没看懂，请求解释">' + UI_ICON_SVG.question + ' 没看懂</button>'
    + '<button class="viz-btn" onclick="toggleVizFullscreen(\'' + vizId + '\')" title="全屏查看">' + UI_ICON_SVG.expand + ' 全屏</button>'
    + '<button class="viz-btn" onclick="copyVizCode(\'' + vizId + '\')" title="复制源码">' + UI_ICON_SVG.copy + ' 复制</button>'
    + '<button class="viz-btn" onclick="openVizNewTab(\'' + vizId + '\')" title="新标签页打开">' + UI_ICON_SVG.external + ' 新窗口</button>'
    + '</div></div>'
    + '<iframe class="viz-iframe' + heightClass + '" sandbox="allow-scripts" data-viz-id="' + vizId + '" loading="lazy"></iframe>'
    + '</div>';
}

// ====== 可视化 iframe 主题桥接 ======
// 注入到 AI 生成的 HTML 中：应用父页面主题（data-theme 属性 + 按钮点击兜底 + setter 函数），
// 并检测页面是否自带主题机制（有则通知父页面走原生切换，无则父页面用滤镜兜底深色化）。
const _VIZ_THEME_BRIDGE = '<script>(function(){'
  + 'try{var st=document.createElement("style");'
  + 'st.textContent="html[data-theme] *,html[data-theme] *::before,html[data-theme] *::after{transition:background-color .4s ease,color .4s ease,border-color .4s ease,fill .4s ease,stroke .4s ease!important}";'
  + 'document.head.appendChild(st);}catch(e){}'
  + 'function applyT(t){'
  + 'try{'
  + 'document.documentElement.setAttribute("data-theme",t);'
  + 'document.body.setAttribute("data-theme",t);'
  + 'var btns=document.querySelectorAll("button,[class*=\\"theme\\" i],[id*=\\"theme\\" i]");'
  + 'for(var i=0;i<btns.length;i++){'
  + 'var b=btns[i],txt=(b.textContent||"")+(b.title||"");'
  + 'if(t==="light"&&/🌙|暗|深色/.test(txt)){b.click();return;}'
  + 'if(t==="dark"&&/☀️|亮|浅色/.test(txt)){b.click();return;}'
  + '}'
  + 'if(typeof window.applyTheme==="function"){window.applyTheme(t);return;}'
  + 'if(typeof window.setTheme==="function"){window.setTheme(t);return;}'
  + '}catch(e){}}'
  + 'try{var p=window["parent"];if(p&&p.document&&p.document.documentElement){'
  + 'var pt=p.document.documentElement.getAttribute("data-theme");'
  + 'if(pt==="light"||pt==="dark")applyT(pt);}}catch(e){}'
  + 'window.addEventListener("message",function(e){var d=e.data;'
  + 'if(d&&d.type==="phymathia-theme"&&(d.theme==="light"||d.theme==="dark"))applyT(d.theme);});'
  + 'try{var has=false,nodes=document.querySelectorAll("button,[class*=\\"theme\\" i],[id*=\\"theme\\" i]");'
  + 'for(var i=0;i<nodes.length;i++){var txt=(nodes[i].textContent||"")+(nodes[i].title||"");'
  + 'if(/🌙|☀️|深色|浅色|暗色|亮色|dark|light/i.test(txt)){has=true;break;}}'
  + 'if(!has&&(typeof window.applyTheme==="function"||typeof window.setTheme==="function"||typeof window.toggleTheme==="function"))has=true;'
  + 'window["parent"].postMessage({type:"phymathia-theme-native",has:has},"*");'
  + '}catch(e){window["parent"]&&window["parent"].postMessage({type:"phymathia-theme-native",has:false},"*");}'
  + '})();<\/script>';

// 父页面主题切换时，向所有可视化 iframe（含全屏 iframe）广播
function syncVizThemes(theme) {
  const frames = document.querySelectorAll('.viz-iframe, #vizFullscreenIframe');
  frames.forEach(f => {
    try { f.contentWindow.postMessage({ type: 'phymathia-theme', theme: theme }, '*'); } catch (e) {}
  });
}

// 接收 iframe 的原生主题检测结果：
// 有原生主题机制的走原生切换（不加滤镜）；没有的加滤镜兜底深色化
window.addEventListener('message', function(e) {
  const d = e.data;
  if (!d || d.type !== 'phymathia-theme-native') return;
  const frames = document.querySelectorAll('.viz-iframe, #vizFullscreenIframe');
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].contentWindow === e.source) {
      frames[i].classList.toggle('viz-theme-filtered', !d.has);
      break;
    }
  }
});

// 延迟设置 srcdoc（DOM 插入后调用）
function _initVizIframes(container) {
  const iframes = (container || document).querySelectorAll('iframe[data-viz-id]');
  iframes.forEach(function(iframe) {
    const vizId = iframe.getAttribute('data-viz-id');
    const html = _vizStore[vizId];
    if (html) {
      iframe.srcdoc = html;
      iframe.removeAttribute('data-viz-id');
    }
  });
}

function toggleVizFullscreen(vizId) {
  const html = _vizStore[vizId];
  if (!html) return;
  const overlay = document.getElementById('vizFullscreenOverlay');
  const iframe = document.getElementById('vizFullscreenIframe');
  iframe.srcdoc = html;
  overlay.classList.add('active');
}

function closeVizFullscreen() {
  const overlay = document.getElementById('vizFullscreenOverlay');
  const iframe = document.getElementById('vizFullscreenIframe');
  overlay.classList.remove('active');
  iframe.srcdoc = '';
}

function copyVizCode(vizId) {
  const html = _vizStore[vizId];
  if (!html) return;
  navigator.clipboard.writeText(html).then(() => {
    // 简易提示
    const btn = document.querySelector('#' + vizId + ' .viz-btn[title="复制源码"]');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ 已复制';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  });
}

function openVizNewTab(vizId) {
  const html = _vizStore[vizId];
  if (!html) return;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  // 延迟释放，确保新标签页已加载
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ====== Markdown + KaTeX + Mermaid 渲染 ======
function renderMarkdown(text) {
  if (!text) return '';
  // 苏格拉底状态标签只用于后端/知识过滤，不显示给用户
  text = text
    .replace(/<socratic_meta\b[^>]*>[\s\S]*?<\/socratic_meta>/gi, '')
    .replace(/<socratic_meta\b[^>]*\/?>/gi, '');
  // 兼容 AI 将 <formula> 包在 $$..$$ 或 $..$ 内的输出，避免双层定界符
  text = text.replace(/\${1,2}\s*<formula>([\s\S]*?)<\/formula>\s*\${1,2}/gi, (match, latex) => {
    return '$$' + latex.trim() + '$$';
  });
  // AI 按规范标注的 <formula> 标签 → 转换为 $..$（KaTeX 正常渲染，标签本身不显示）
  text = text.replace(/<formula>([\s\S]*?)<\/formula>/gi, (match, latex) => {
    return '$$' + latex.trim() + '$$';
  });
  // <summary> 摘要标签仅用于知识库/公式描述，不渲染给用户
  text = text.replace(/<summary>[\s\S]*?<\/summary>/gi, '');
  const mermaidBlocks = [];
  let processed = text.replace(/```mermaid\s*\n([\s\S]*?)```/g, (match, code) => {
    const idx = mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return `<!--MERMAID_PLACEHOLDER_${idx}-->`;
  });
  // 公式占位符保护：marked 遵循 CommonMark 会把 \( 的反斜杠当转义符剥掉，
  // 导致 KaTeX 找不到公式边界。先提取公式为占位符，marked 解析后还原。
  const mathBlocks = [];
  const extractMath = (match) => {
    const idx = mathBlocks.length;
    mathBlocks.push(match);
    return `<!--MATH_PLACEHOLDER_${idx}-->`;
  };
  processed = processed
    .replace(/\$\$[\s\S]+?\$\$/g, extractMath)        // display: $$..$$
    .replace(/\\\[[\s\S]+?\\\]/g, extractMath)        // display: \[..\]
    .replace(/\$[^$\n]+?\$/g, extractMath)            // inline: $..$（不跨行，避免贪婪误匹配）
    .replace(/\\\([\s\S]+?\\\)/g, extractMath);       // inline: \(..\)
  let html = _sanitizeMarkdownHtml(marked.parse(processed));
  // 还原公式占位符（HTML 转义防 < > & 被当作标签；KaTeX auto-render 在文本节点中识别）
  // 同时匹配 marked 转义后的形式（&lt;!--...--&gt;），覆盖代码块内的占位符
  html = html.replace(/&lt;!--MATH_PLACEHOLDER_(\d+)--&gt;|<!--MATH_PLACEHOLDER_(\d+)-->/g, (match, escapedIdx, rawIdx) => {
    return escapeHtml(mathBlocks[parseInt(escapedIdx != null ? escapedIdx : rawIdx)]);
  });
  html = html.replace(/<!--MERMAID_PLACEHOLDER_(\d+)-->/g, (match, idx) => {
    const id = 'mermaid_' + Math.random().toString(36).substr(2, 9);
    return `<div class="mermaid-container"><pre class="mermaid-source" data-mermaid-src="${encodeURIComponent(mermaidBlocks[parseInt(idx)])}" style="display:none"></pre><div class="mermaid" id="${id}"></div><div class="mermaid-scroll-hint">← 左右滑动查看完整图谱 →</div></div>`;
  });
  // 识别 HTML 代码块，替换为 iframe 可视化卡片
  html = html.replace(/<pre><code class="language-html">([\s\S]*?)<\/code><\/pre>/gi, function(match, codeContent) {
    const decodedHtml = _decodeHTMLEntities(codeContent);
    // 过滤太短的片段（不是完整的可视化页面）
    if (decodedHtml.trim().length < 100 || !/<html[\s>]|<!doctype|<body[\s>]/i.test(decodedHtml)) {
      return match;  // 非完整 HTML 页面，保留代码块
    }
    const vizId = 'viz_' + Math.random().toString(36).substr(2, 9);
    return buildVizCard(decodedHtml, vizId);
  });
  // 为 .html 链接添加 target="_blank" 和 download 属性
  // 先处理已存在 target 的链接（替换 target 值）
  html = html.replace(/<a\b([^>]*?)href="([^"]*\.html[^"]*)"([^>]*?)>/gi, function(match, before, url, after) {
    // 如果已经有 target，替换它；否则添加
    let attrs = before + 'href="' + url + '"' + after;
    if (/\btarget=/.test(attrs)) {
      attrs = attrs.replace(/\btarget="[^"]*"/, 'target="_blank"');
    } else {
      attrs += ' target="_blank"';
    }
    if (!/\bdownload\b/.test(attrs)) attrs += ' download';
    if (!/\brel=/.test(attrs)) attrs += ' rel="noopener noreferrer"';
    return '<a' + attrs + '>';
  });
  // 处理单引号的情况
  html = html.replace(/<a\b([^>]*?)href='([^']*\.html[^']*)'([^>]*?)>/gi, function(match, before, url, after) {
    let attrs = before + "href='" + url + "'" + after;
    if (/\btarget=/.test(attrs)) {
      attrs = attrs.replace(/\btarget='[^']*'/, "target='_blank'");
    } else {
      attrs += " target='_blank'";
    }
    if (!/\bdownload\b/.test(attrs)) attrs += ' download';
    if (!/\brel=/.test(attrs)) attrs += ' rel="noopener noreferrer"';
    return '<a' + attrs + '>';
  });
  html = convertLearnDirections(html);
  html = convertSocraticQuestions(html);
  return html;
}

// ====== XML 标签处理（流式&最终渲染） ======
function stripXmlTags(text) {
  return text.replace(/<\/?(physics|math|graph|extend)>/gi, '');
}

function parseXmlSections(content) {
  var tags = ['physics', 'math', 'graph', 'extend'];
  var sections = {};
  for (var i = 0; i < tags.length; i++) {
    var tag = tags[i];
    var re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i');
    var m = content.match(re);
    if (m) sections[tag] = m[1].trim();
  }
  return sections;
}

function renderModuleSections(container, sections) {
  var config = [
    { key: 'physics', icon: (ICON_OPTIONS.find(o => o.id === 'mechanics') || {}).svg, label: '物理视角', colorClass: 'physics-section', collapsible: true },
    { key: 'math', icon: (ICON_OPTIONS.find(o => o.id === 'function') || {}).svg, label: '数学视角', colorClass: 'math-section', collapsible: true },
    { key: 'graph', icon: (ICON_OPTIONS.find(o => o.id === 'graph') || {}).svg, label: '知识图谱', colorClass: 'graph-section', collapsible: true },
    { key: 'extend', icon: UI_ICON_SVG.lightbulb, label: '延伸思考', colorClass: 'extend-section', collapsible: true },
  ];
  var html = '';
  for (var i = 0; i < config.length; i++) {
    var cfg = config[i];
    if (!sections[cfg.key]) continue;
    var sid = cfg.key + '_' + Math.random().toString(36).substr(2, 9);
    html += '<div class="dual-domain-section ' + cfg.colorClass + '" id="' + sid + '">'
      + '<div class="dual-domain-header" onclick="toggleDualDomain(\'' + sid + '\')">'
      + '<span class="header-left"><span class="section-icon">' + cfg.icon + '</span> ' + cfg.label + '</span>'
      + '<span class="header-right">'
      + (cfg.collapsible && (cfg.key === 'physics' || cfg.key === 'math') ? '<button class="dual-domain-followup" onclick="event.stopPropagation(); followUpDomain(\'' + cfg.key + '\')">\u8FFD\u95EE</button><button class="dual-domain-dontget" onclick="event.stopPropagation(); dontUnderstandDomain(\'' + cfg.key + '\')">\u2753 \u6CA1\u770B\u61C2</button>' : '')
      + '<span class="dual-domain-chevron">\u25BC</span>'
      + '</span></div>'
      + '<div class="dual-domain-body">' + renderMarkdown(sections[cfg.key]) + '</div>'
      + '</div>';
  }
  container.innerHTML = html;
  _initVizIframes(container);
  renderMath(container);
}

// ====== 双域折叠区域渲染（heading 正则兜底） ======
function wrapDualDomainSections(element) {
  const html = element.innerHTML;
  
  // 定义四个可识别的域标题：物理视角、数学视角为可折叠区域；知识图谱、延伸思考为独立区块
  const domainDefs = [
    { key: 'physics', icon: (ICON_OPTIONS.find(o => o.id === 'mechanics') || {}).svg, label: '物理视角', colorClass: 'physics-section', regex: /<h[1-6][^>]*>[^<]*(?:🔭|🔬)[^<]*(?:物理直觉|物理视角)[^<]*<\/h[1-6]>/i, collapsible: true },
    { key: 'math', icon: (ICON_OPTIONS.find(o => o.id === 'function') || {}).svg, label: '数学视角', colorClass: 'math-section', regex: /<h[1-6][^>]*>[^<]*(?:🧮|📐)[^<]*(?:数学本质|数学视角)[^<]*<\/h[1-6]>/i, collapsible: true },
    { key: 'graph', icon: (ICON_OPTIONS.find(o => o.id === 'graph') || {}).svg, label: '知识图谱', colorClass: 'graph-section', regex: /<h[1-6][^>]*>[^<]*(?:🧠|🗺️|知识图谱)[^<]*<\/h[1-6]>/i, collapsible: true },
    { key: 'extend', icon: UI_ICON_SVG.lightbulb, label: '延伸思考', colorClass: 'extend-section', regex: /<h[1-6][^>]*>[^<]*(?:💡|延伸思考)[^<]*<\/h[1-6]>/i, collapsible: true },
  ];
  
  // 找到所有匹配的标题位置
  const matches = [];
  for (const def of domainDefs) {
    const m = html.match(def.regex);
    if (m) {
      matches.push({ ...def, match: m[0], idx: html.indexOf(m[0]) });
    }
  }
  
  if (matches.length === 0) return; // 没有域标题则不处理
  
  // 按位置排序
  matches.sort((a, b) => a.idx - b.idx);
  
  // 切分内容：每个标题到下一个标题之间的内容属于当前域
  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const startIdx = matches[i].idx;
    const endIdx = (i + 1 < matches.length) ? matches[i + 1].idx : html.length;
    const content = html.substring(startIdx + matches[i].match.length, endIdx);
    sections.push({ ...matches[i], content });
  }
  
  // 标题之前的内容（如开头引言）
  const beforeContent = html.substring(0, matches[0].idx);
  
  // 重建 HTML
  let newHtml = beforeContent;
  for (const sec of sections) {
    const sid = sec.key + '_' + Math.random().toString(36).substr(2, 9);
    newHtml += `<div class="dual-domain-section ${sec.colorClass}" id="${sid}">
      <div class="dual-domain-header" onclick="toggleDualDomain('${sid}')">
        <span class="header-left"><span class="section-icon">${sec.icon}</span> ${sec.label}</span>
        <span class="header-right">
      ${sec.collapsible && (sec.key === 'physics' || sec.key === 'math') ? `<button class="dual-domain-followup" onclick="event.stopPropagation(); followUpDomain('${sec.key}')">追问</button><button class="dual-domain-dontget" onclick="event.stopPropagation(); dontUnderstandDomain('${sec.key}')">${UI_ICON_SVG.question} 没看懂</button>` : ''}
          <span class="dual-domain-chevron">▼</span>
        </span>
      </div>
      <div class="dual-domain-body">${sec.match}${sec.content}</div>
    </div>`;
  }
  
  element.innerHTML = newHtml;
}

function toggleDualDomain(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  section.classList.toggle('collapsed');
  scrollToBottom();
}

function followUpDomain(domain) {
  // 找到当前消息中的上一个用户消息，构建追问
  const prompt = domain === 'physics'
    ? '请从物理视角进一步深入讲解：'
    : '请从数学视角进一步深入讲解：';
  
  // 获取原始用户问题
  let originalQuestion = '';
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].role === 'user') {
      originalQuestion = chatHistory[i].content;
      break;
    }
  }
  
  const followUpText = prompt + originalQuestion;
  document.getElementById('userInput').value = followUpText;
  sendMessage();
}

// ====== 没看懂（填入输入框，用户确认后发送） ======
function dontUnderstandDomain(domain) {
  let originalQuestion = '';
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].role === 'user') {
      originalQuestion = chatHistory[i].content;
      break;
    }
  }
  const prompt = domain === 'physics'
    ? '你刚才从「物理视角」讲解的部分我没看懂，请换一种更简单、更生活化的方式重新讲解：' + originalQuestion
    : '你刚才从「数学视角」讲解的部分我没看懂，请放慢推导步骤，逐一解释每个符号的含义：' + originalQuestion;
  const input = document.getElementById('userInput');
  input.value = prompt;
  autoResize(input);
  input.focus();
}

function dontUnderstandViz() {
  let originalQuestion = '';
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].role === 'user') {
      originalQuestion = chatHistory[i].content;
      break;
    }
  }
  const prompt = '你生成的交互式可视化演示我没看懂，请逐步讲解图表/动画中的每个元素如何对应物理现象和公式：' + originalQuestion;
  const input = document.getElementById('userInput');
  input.value = prompt;
  autoResize(input);
  input.focus();
}

function convertLearnDirections(html) {
  return html.replace(
    /(<h[1-6][^>]*>.*?进阶学习方向.*?<\/h[1-6]>)(\s*(?:<ul>|<ol>))([\s\S]*?)(<\/ul>|<\/ol>)/gi,
    (match, header, openTag, listContent, closeTag) => {
      const items = [];
      const liRegex = /<li>([\s\S]*?)<\/li>/g;
      let liMatch;
      while ((liMatch = liRegex.exec(listContent)) !== null) {
        const text = liMatch[1].replace(/<[^>]+>/g, '').trim();
        if (text) items.push(text);
      }
      if (items.length === 0) return match;
      const buttons = items.map(item => {
        const question = '请详细讲解：' + item;
        const encoded = encodeURIComponent(question);
        return `<button class="learn-dir-btn" type="button" data-send="${encoded}">${escapeHtml(item)}</button>`;
      }).join('');
      return `${header}<div class="learn-dir-section">${buttons}</div>`;
    }
  );
}

function convertSocraticQuestions(html) {
  return html.replace(/<li>([\s\S]*?)<\/li>/g, (match, inner) => {
    const rawText = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const levelMatch = rawText.match(/^\s*\[?(基础|进阶|拓展)(?:题|层)?\]?\s*[:：]?\s*(.*)$/);
    if (!levelMatch) return match;
    const levelName = levelMatch[1];
    const question = (levelMatch[2] || rawText).replace(/^❓\s*/, '').trim();
    if (!question) return match;
    const level = levelName === '基础' ? 'basic' : levelName === '进阶' ? 'advanced' : 'expand';
    const encoded = encodeURIComponent(question);
    return `<li class="socratic-item" data-socratic-level="${level}">
      <div class="socratic-question">${escapeHtml(question)}</div>
      <div class="socratic-actions">
        <button class="socratic-btn socratic-answer level-${level}" type="button" data-socratic-answer="${encoded}" data-socratic-level="${level}">我来回答</button>
        <button class="socratic-btn socratic-ask level-${level}" type="button" data-send="${encoded}">直接问AI</button>
      </div>
    </li>`;
  });
}

document.addEventListener('click', function(e) {
  const answerBtn = e.target.closest('[data-socratic-answer]');
  if (answerBtn) {
    e.preventDefault();
    const question = decodeURIComponent(answerBtn.getAttribute('data-socratic-answer'));
    const level = answerBtn.getAttribute('data-socratic-level') || 'basic';
    if (typeof window.startSocraticAnswer === 'function') {
      window.startSocraticAnswer(question, level);
    } else {
      document.getElementById('userInput').value = question;
      sendQuick(question);
    }
    return;
  }
  const quickBtn = e.target.closest('[data-send]');
  if (quickBtn) {
    e.preventDefault();
    const question = decodeURIComponent(quickBtn.getAttribute('data-send'));
    if (typeof window.sendQuick === 'function') window.sendQuick(question);
  }
});

function sanitizeMermaidCode(code) {
  // 1. 确保 flowchart 声明存在
  let lines = code.split('\n');
  const firstLine = lines[0].trim().toLowerCase();
  const isFlowchart = firstLine.startsWith('graph') || firstLine.startsWith('flowchart');
  if (!isFlowchart) {
    // 尝试添加 flowchart 声明
    if (firstLine.match(/^[A-Za-z]\s*-->/) || firstLine.match(/^[A-Za-z]\s*-->/)) {
      lines.unshift('graph TD');
    }
  }
  // 2. 修复节点文字中的特殊字符
  // Mermaid 节点中括号()会导致解析错误，用下划线替换
  lines = lines.map(line => {
    // 只处理包含节点定义的行(有 --> 或 --- 等连接符)
    if (line.includes('-->') || line.includes('---') || line.includes('->') || line.includes('-.->')) {
      // 修复方括号内的括号问题: [位移x(t)] → [位移x_t_]
      line = line.replace(/\[([^\]]*?)\]/g, (match, inner) => {
        // 替换圆括号为下划线标记
        const fixed = inner.replace(/\(/g, '_').replace(/\)/g, '_');
        return '[' + fixed + ']';
      });
      // 修复圆括号节点: (text) 中的嵌套括号
      line = line.replace(/\(([^)]*?)\)/g, (match, inner) => {
        if (inner.includes('(') || inner.includes(')')) {
          const fixed = inner.replace(/\(/g, '_').replace(/\)/g, '_');
          return '(' + fixed + ')';
        }
        return match;
      });
    }
    return line;
  });
  // 3. 移除空行（Mermaid 对空行敏感）
  lines = lines.filter((line, idx) => idx === 0 || line.trim() !== '');
  return lines.join('\n');
}

async function renderMermaidInElement(element) {
  const mermaidDivs = element.querySelectorAll('.mermaid:not([data-processed="true"])');
  for (const div of mermaidDivs) {
    try {
      const sourceEl = div.previousElementSibling;
      let code = '';
      if (sourceEl && sourceEl.dataset.mermaidSrc) {
        code = decodeURIComponent(sourceEl.dataset.mermaidSrc);
      } else {
        code = div.textContent.trim();
      }
      if (!code) continue;
      // 预处理 mermaid 代码，修正常见语法问题
      code = sanitizeMermaidCode(code);
      const id = div.id || ('m_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5));
      const { svg } = await mermaid.render(id + '_svg', code);
      div.innerHTML = svg;
      div.setAttribute('data-processed', 'true');
      // 移动端：给知识图谱容器添加捏合缩放
      const container = div.closest('.mermaid-container');
      if (container && 'ontouchstart' in window) {
        let scale = 1;
        let lastDist = 0;
        container.addEventListener('touchstart', (e) => {
          if (e.touches.length === 2) {
            lastDist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
            );
          }
        }, { passive: true });
        container.addEventListener('touchmove', (e) => {
          if (e.touches.length === 2) {
            const dist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
            );
            if (lastDist > 0) {
              scale = Math.min(Math.max(scale * (dist / lastDist), 0.5), 3);
              div.style.transform = `scale(${scale})`;
              div.style.transformOrigin = 'center center';
            }
            lastDist = dist;
          }
        }, { passive: true });
      }
    } catch(e) {
      console.warn('Mermaid render failed:', e);
      const sourceEl = div.previousElementSibling;
      let rawCode = '';
      try {
        rawCode = sourceEl && sourceEl.dataset && sourceEl.dataset.mermaidSrc ? decodeURIComponent(sourceEl.dataset.mermaidSrc) : div.textContent;
      } catch (de) {
        rawCode = div.textContent;
      }
      div.innerHTML = '<div style="color:#ff6b6b;font-size:12px;margin-bottom:6px">图表渲染失败 <button onclick="retryMermaid(this)" style="margin-left:8px;padding:2px 8px;font-size:11px;background:var(--btn-active-bg);border:1px solid var(--btn-active-border);color:var(--accent);border-radius:4px;cursor:pointer">重试</button></div><pre style="font-size:11px;margin-top:4px;white-space:pre-wrap">' + escapeHtml(rawCode) + '</pre>';
      div.setAttribute('data-processed', 'error');
    }
  }
}

async function retryMermaid(btn) {
  const div = btn.closest('.mermaid') || btn.parentElement.parentElement;
  if (!div) return;
  div.removeAttribute('data-processed');
  const container = div.closest('.message-content') || div.parentElement;
  if (container) await renderMermaidInElement(container);
}

// 主题切换时 Mermaid 颜色由 CSS 变量自动过渡，无需重绘
// 此函数仅在新图表需要渲染时使用，现有图表的视觉变化完全由 CSS 变量过渡驱动
async function rerenderAllMermaid() {
  // 不再重新渲染现有图表，CSS 变量过渡已处理颜色变化
}

function renderMath(element) {
  if (window.renderMathInElement) {
    renderMathInElement(element, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false
    });
  }
}

// ====== 智能滚动 ======
let userScrolledUp = false;


function initSmartScroll() {
  const messages = document.getElementById('chatMessages');
  messages.addEventListener('scroll', () => {
    const distFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    userScrolledUp = distFromBottom > SCROLL_THRESHOLD;
  }, { passive: true });
}

function scrollToBottom(force = false) {
  if (!force && userScrolledUp) return;
  const messages = document.getElementById('chatMessages');
  messages.scrollTop = messages.scrollHeight;
}
