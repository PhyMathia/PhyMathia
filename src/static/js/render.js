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
function renderMarkdown(text, renderCtx = {}) {
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
  html = convertLearnDirections(html, renderCtx);
  html = convertSocraticQuestions(html, renderCtx);
  return html;
}

// ====== XML 标签处理（流式&最终渲染） ======
function stripXmlTags(text) {
  return text.replace(/<\/?(physics|math|graph|viz|extend)>/gi, '');
}

function parseXmlSections(content) {
  var tags = ['physics', 'math', 'graph', 'viz', 'extend'];
  var sections = {};
  for (var i = 0; i < tags.length; i++) {
    var tag = tags[i];
    var re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i');
    var m = content.match(re);
    if (m) sections[tag] = m[1].trim();
  }
  return sections;
}

const MODULE_BUBBLE_META = {
  physics: { label: '物理视角', colorClass: 'physics-bubble', icon: (ICON_OPTIONS.find(o => o.id === 'mechanics') || {}).svg },
  math: { label: '数学视角', colorClass: 'math-bubble', icon: (ICON_OPTIONS.find(o => o.id === 'function') || {}).svg },
  graph: { label: '知识图谱', colorClass: 'graph-bubble', icon: (ICON_OPTIONS.find(o => o.id === 'graph') || {}).svg },
  viz: { label: '交互可视化', colorClass: 'viz-bubble', icon: UI_ICON_SVG.monitor },
  extend: { label: '延伸思考', colorClass: 'extend-bubble', icon: UI_ICON_SVG.lightbulb },
  socratic: { label: '苏格拉底追问', colorClass: 'socratic-bubble', icon: UI_ICON_SVG.question },
  learn: { label: '进阶学习', colorClass: 'learn-bubble', icon: UI_ICON_SVG.cap },
};

function _extractSummaryFromContent(content) {
  const match = String(content || '').match(/<summary>([\s\S]*?)<\/summary>/i);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function _splitVizFromGraph(graphRaw) {
  let graphContent = String(graphRaw || '');
  let vizContent = '';
  const htmlMatch = graphContent.match(/```html[\s\S]*?```/gi);
  if (htmlMatch) {
    vizContent = htmlMatch.join('\n\n');
    graphContent = graphContent.replace(/```html[\s\S]*?```/gi, '').trim();
  }
  return { graphContent, vizContent };
}

function _cleanModuleContent(content, moduleKey) {
  let text = String(content || '').trim();
  text = text.replace(/^#{1,6}\s*[^\n]*PhyMathia\s*学习卡片\s*[:：]?\s*[^\n]*\n?/i, '').trim();
  const patterns = {
    physics: /^#{1,6}\s*[^\n]*(物理直觉|物理视角)[^\n]*\n?/i,
    math: /^#{1,6}\s*[^\n]*(数学本质|数学视角)[^\n]*\n?/i,
    graph: /^#{1,6}\s*[^\n]*知识图谱[^\n]*\n?/i,
    viz: /^#{1,6}\s*[^\n]*(交互探索|交互式可视化)[^\n]*\n?/i,
    extend: /^#{1,6}\s*[^\n]*延伸思考[^\n]*\n?/i,
    socratic: /^#{1,6}\s*[^\n]*(苏格拉底追问|延伸思考)[^\n]*\n?/i,
    learn: /^#{1,6}\s*[^\n]*(进阶学习方向|进阶学习)[^\n]*\n?/i,
  };
  const pattern = patterns[moduleKey];
  return pattern ? text.replace(pattern, '').trim() : text;
}

function _genBranchId() {
  const sessionPart = (typeof currentSessionId !== 'undefined' ? currentSessionId : 'sess').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 18);
  return 'br_' + (sessionPart || 'sess') + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function _extractBranchTopic(msg, content) {
  const text = String(content || '').trim();
  if (!text) return '';

  if (msg.branchType === 'socratic') {
    const socraticMatch = text.match(/追问问题[：:]\s*([^\n]+)/);
    if (socraticMatch && socraticMatch[1].trim()) return socraticMatch[1].trim();
    return text.replace(/^\[苏格拉底回答\]\s*/i, '').split('\n')[0].trim() || text;
  }

  const promptPatterns = [
    /^请从(?:物理|数学)视角(?:继续深入|进一步深入)?讲解[：:]\s*/,
    /^请围绕延伸思考继续展开讲解[：:]\s*/,
    /^请围绕苏格拉底追问继续展开讲解[：:]\s*/,
    /^苏格拉底追问里的问题我没看懂[^：:]*[：:]\s*/,
    /^请围绕进阶学习方向继续展开讲解[：:]\s*/,
    /^进阶学习方向里的内容我没看懂[^：:]*[：:]\s*/,
    /^请进一步解释(?:知识图谱中的概念关系和箭头含义|交互式可视化中的元素如何对应物理现象和公式)[：:]\s*/,
    /^你刚才从「[^」]+」讲解的部分我没看懂[^：:]*[：:]\s*/,
    /^你生成的「[^」]+」我没看懂[^：:]*[：:]\s*/,
    /^延伸思考里的内容我没看懂[^：:]*[：:]\s*/,
    /^请详细讲解[：:]\s*/,
  ];
  for (const pattern of promptPatterns) {
    if (pattern.test(text)) {
      const topic = text.replace(pattern, '').trim();
      return topic || text;
    }
  }
  return text;
}

function _findOriginalQuestion(messageId) {
  let searchFrom = chatHistory.length - 1;
  const targetId = String(messageId || '');
  if (targetId) {
    const targetIndex = chatHistory.findIndex(msg => String(msg.timestamp || '') === targetId);
    if (targetIndex >= 0) searchFrom = targetIndex;
  }
  for (let i = searchFrom; i >= 0; i--) {
    const msg = chatHistory[i];
    if (msg.role !== 'user') continue;
    const content = String(msg.content || '').trim();
    if (!content) continue;
    if (msg.branchType && msg.branchType !== 'main') return _extractBranchTopic(msg, content);
    return content;
  }
  return '';
}

function _modulePrompt(moduleKey, type, originalQuestion) {
  const question = originalQuestion || '当前问题';
  const prompts = {
    physics: {
      followup: '请从物理视角继续深入讲解：' + question,
      confused: '你刚才从「物理视角」讲解的部分我没看懂，请换一种更简单、更生活化的方式重新讲解：' + question,
    },
    math: {
      followup: '请从数学视角进一步深入讲解：' + question,
      confused: '你刚才从「数学视角」讲解的部分我没看懂，请放慢推导步骤，逐一解释每个符号的含义：' + question,
    },
    graph: {
      followup: '请进一步解释知识图谱中的概念关系和箭头含义：' + question,
      confused: '你生成的「知识图谱」我没看懂，请用更直白的语言解释图中每个节点和关系：' + question,
    },
    viz: {
      followup: '请进一步解释交互式可视化中的元素如何对应物理现象和公式：' + question,
      confused: '你生成的「交互式可视化」我没看懂，请逐步讲解图表或动画中的每个元素：' + question,
    },
    extend: {
      followup: '请围绕延伸思考继续展开讲解：' + question,
      confused: '延伸思考里的内容我没看懂，请换一种更简单的方式解释：' + question,
    },
    socratic: {
      followup: '请围绕苏格拉底追问继续展开讲解：' + question,
      confused: '苏格拉底追问里的问题我没看懂，请换一种更简单的方式解释：' + question,
    },
    learn: {
      followup: '请围绕进阶学习方向继续展开讲解：' + question,
      confused: '进阶学习方向里的内容我没看懂，请换一种更简单的方式解释：' + question,
    },
  };
  const modulePrompts = prompts[moduleKey] || prompts.extend;
  return modulePrompts[type] || modulePrompts.followup;
}

function followUpModule(moduleKey, messageId, event) {
  event?.stopPropagation();
  const meta = MODULE_BUBBLE_META[moduleKey] || MODULE_BUBBLE_META.extend;
  const originalQuestion = _findOriginalQuestion(messageId);
  const anchor = {
    parentId: messageId || '',
    sourceModule: moduleKey,
    branchType: 'followup',
    branchId: _genBranchId(),
    branchLabel: '追问：' + meta.label,
  };
  const question = _modulePrompt(moduleKey, 'followup', originalQuestion);
  if (typeof window.openBranchModal === 'function') {
    window.openBranchModal('追问：' + meta.label, question, anchor);
  } else {
    document.getElementById('userInput').value = question;
    sendQuick(document.getElementById('userInput').value);
  }
}

function dontUnderstandModule(moduleKey, messageId, event) {
  event?.stopPropagation();
  const meta = MODULE_BUBBLE_META[moduleKey] || MODULE_BUBBLE_META.extend;
  const originalQuestion = _findOriginalQuestion(messageId);
  const anchor = {
    parentId: messageId || '',
    sourceModule: moduleKey,
    branchType: 'confused',
    branchId: _genBranchId(),
    branchLabel: '没看懂：' + meta.label,
  };
  const question = _modulePrompt(moduleKey, 'confused', originalQuestion);
  if (typeof window.openBranchModal === 'function') {
    window.openBranchModal('没看懂：' + meta.label, question, anchor);
  } else {
    document.getElementById('userInput').value = question;
    document.getElementById('userInput').focus();
  }
}

function toggleModuleBubble(messageId, moduleKey) {
  const state = typeof window.getGraphState === 'function' ? window.getGraphState() : null;
  const key = String(messageId) + ':' + String(moduleKey);
  const collapsed = state && state.collapsed && state.collapsed[key];
  if (typeof window.setModuleVisibility === 'function') {
    window.setModuleVisibility(messageId, moduleKey, 'collapsed', collapsed);
  }
}

function _refreshMessageBubbles() {
  document.querySelectorAll('.message.assistant .message-content').forEach((el, index) => {
    const body = el.closest('.message-body');
    const messageId = body?.dataset.messageId || '';
    const msg = chatHistory.find(m => String(m.timestamp) === String(messageId));
    if (!msg) return;
    const sections = parseXmlSections(msg.content || '');
    if (Object.keys(sections).length > 0) {
      renderModuleSections(el, sections, msg.content || '');
      _initVizIframes(el);
      renderMath(el);
      setTimeout(() => renderMermaidInElement(el), 0);
    }
  });
}

function renderModuleSections(container, sections, rawContent) {
  const messageId = container.closest('.message-body')?.dataset.messageId || '';
  const graphState = typeof window.getGraphState === 'function' ? window.getGraphState() : { collapsed: {}, hidden: {} };
  const collapsedMap = graphState.collapsed || {};
  const hiddenMap = graphState.hidden || {};
  const summary = _extractSummaryFromContent(rawContent || '');
  const splitGraph = _splitVizFromGraph(sections.graph || '');
  const vizRaw = sections.viz || splitGraph.vizContent || '';
  const configs = [
    { key: 'physics', content: _cleanModuleContent(sections.physics || '', 'physics') },
    { key: 'math', content: _cleanModuleContent(sections.math || '', 'math') },
    { key: 'graph', content: _cleanModuleContent(splitGraph.graphContent || '', 'graph') },
    { key: 'viz', content: _cleanModuleContent(vizRaw, 'viz') },
    { key: 'extend', content: _cleanModuleContent(sections.extend || '', 'extend') },
  ].filter(cfg => cfg.content && cfg.content.trim());

  let html = '<div class="answer-cluster" data-message-id="' + messageId + '">';
  if (summary) {
    html += '<div class="answer-hub"><span class="answer-hub-mark">摘要</span><span class="answer-hub-text">' + escapeHtml(summary) + '</span></div>';
  }
  html += '<div class="module-bubbles">';
  for (const cfg of configs) {
    const meta = MODULE_BUBBLE_META[cfg.key] || MODULE_BUBBLE_META.extend;
    const key = messageId + ':' + cfg.key;
    const collapsed = !!collapsedMap[key];
    const actions = '<button class="module-action" onclick="event.stopPropagation(); followUpModule(\'' + cfg.key + '\',\'' + messageId + '\',event)" title="追问">追问</button>'
      + '<button class="module-action" onclick="event.stopPropagation(); dontUnderstandModule(\'' + cfg.key + '\',\'' + messageId + '\',event)" title="没看懂">没看懂</button>'
      + '<button class="module-action icon-action" onclick="event.stopPropagation(); toggleModuleBubble(\'' + messageId + '\',\'' + cfg.key + '\')" title="' + (collapsed ? '展开' : '折叠') + '">' + (collapsed ? '+' : '−') + '</button>'
    html += '<div class="module-bubble ' + meta.colorClass + (collapsed ? ' collapsed' : '') + '" data-module="' + cfg.key + '" data-message-id="' + messageId + '">'
      + '<div class="module-bubble-header"><span class="module-bubble-icon">' + (meta.icon || '') + '</span><span class="module-bubble-title">' + meta.label + '</span><span class="module-bubble-actions">' + actions + '</span></div>'
      + '<div class="module-bubble-body">' + renderMarkdown(cfg.content, { parentId: messageId, sourceModule: cfg.key }) + '</div>'
      + '</div>';
  }
  html += '</div></div>';
  container.innerHTML = html;
  _initVizIframes(container);
  renderMath(container);
}

window.refreshMessageBubbles = _refreshMessageBubbles;
window.followUpModule = followUpModule;
window.dontUnderstandModule = dontUnderstandModule;
window.toggleModuleBubble = toggleModuleBubble;
window._genBranchId = _genBranchId;

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
  const lastAssistant = [...document.querySelectorAll('.message.assistant')].pop();
  const messageId = lastAssistant?.querySelector('.message-body')?.dataset.messageId || '';
  followUpModule(domain || 'physics', messageId);
}

// ====== 没看懂（填入输入框，用户确认后发送） ======
function dontUnderstandDomain(domain) {
  const lastAssistant = [...document.querySelectorAll('.message.assistant')].pop();
  const messageId = lastAssistant?.querySelector('.message-body')?.dataset.messageId || '';
  dontUnderstandModule(domain || 'physics', messageId);
}

function dontUnderstandViz() {
  const lastAssistant = [...document.querySelectorAll('.message.assistant')].pop();
  const messageId = lastAssistant?.querySelector('.message-body')?.dataset.messageId || '';
  dontUnderstandModule('viz', messageId);
}

function convertLearnDirections(html, renderCtx = {}) {
  const parentId = _escapeAttr(renderCtx.parentId || '');
  const sourceModule = _escapeAttr(renderCtx.sourceModule || 'extend');
  const buildButtons = (listContent) => {
    const items = [];
    const liRegex = /<li>([\s\S]*?)<\/li>/g;
    let liMatch;
    while ((liMatch = liRegex.exec(listContent)) !== null) {
      const text = liMatch[1].replace(/<[^>]+>/g, '').trim();
      if (text) items.push(text);
    }
    if (items.length === 0) return '';
    return items.map(item => {
      const question = '请详细讲解：' + item;
      const encoded = encodeURIComponent(question);
      return `<button class="learn-dir-btn" type="button" data-send="${encoded}" data-parent-msg="${parentId}" data-source-module="${sourceModule}" data-branch-type="learn" data-branch-label="${_escapeAttr('进阶学习：' + item)}">${escapeHtml(item)}</button>`;
    }).join('');
  };

  if (renderCtx.sourceModule === 'learn') {
    return html.replace(/(<ul>|<ol>)([\s\S]*?)(<\/ul>|<\/ol>)/gi, (match, openTag, listContent, closeTag) => {
      const buttons = buildButtons(listContent);
      return buttons ? `<div class="learn-dir-section">${buttons}</div>` : match;
    });
  }

  return html.replace(
    /(<h[1-6][^>]*>.*?进阶学习方向.*?<\/h[1-6]>)(\s*(?:<ul>|<ol>))([\s\S]*?)(<\/ul>|<\/ol>)/gi,
    (match, header, openTag, listContent, closeTag) => {
      const buttons = buildButtons(listContent);
      return buttons ? `${header}<div class="learn-dir-section">${buttons}</div>` : match;
    }
  );
}

function convertSocraticQuestions(html, renderCtx = {}) {
  const parentId = _escapeAttr(renderCtx.parentId || '');
  const sourceModule = _escapeAttr(renderCtx.sourceModule || 'extend');
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
        <button class="socratic-btn socratic-answer level-${level}" type="button" data-socratic-answer="${encoded}" data-socratic-level="${level}" data-parent-msg="${parentId}" data-socratic-source="${sourceModule}">我来回答</button>
        <button class="socratic-btn socratic-ask level-${level}" type="button" data-send="${encoded}" data-parent-msg="${parentId}" data-source-module="${sourceModule}" data-branch-type="continue" data-branch-label="${_escapeAttr('直接问AI：' + question)}">直接问AI</button>
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
      window.startSocraticAnswer(question, level, answerBtn.getAttribute('data-parent-msg') || '', answerBtn.getAttribute('data-socratic-source') || 'extend');
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
    const branchType = quickBtn.getAttribute('data-branch-type');
    const anchor = branchType ? {
      parentId: quickBtn.getAttribute('data-parent-msg') || '',
      sourceModule: quickBtn.getAttribute('data-source-module') || 'extend',
      branchType,
      branchId: _genBranchId(),
      branchLabel: quickBtn.getAttribute('data-branch-label') || question,
    } : null;
    if (anchor && typeof window.sendBranchQuick === 'function') {
      window.sendBranchQuick(question, anchor);
    } else if (typeof window.sendQuick === 'function') {
      window.sendQuick(question);
    }
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
