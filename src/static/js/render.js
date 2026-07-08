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

function _sanitizeVizHtml(html) {
  // 移除对 parent/top/window.open 的危险引用，保留正常脚本
  return html
    .replace(/\bparent\s*\./g, '/* removed */.')
    .replace(/\btop\s*\./g, '/* removed */.')
    .replace(/\bwindow\.open\s*\(/g, '/* removed */(')
    .replace(/\bwindow\.close\s*\(/g, '/* removed */(');
}

function buildVizCard(htmlContent, vizId) {
  const safe = _sanitizeVizHtml(htmlContent);
  _vizStore[vizId] = safe;  // 保存原始内容供全屏/复制/新标签页使用

  const isTall = safe.length > 8000 || /canvas|svg|three|chart|d3/i.test(safe);
  const heightClass = isTall ? ' viz-iframe-tall' : '';

  // 使用占位 iframe，通过 JS 动态设置 srcdoc 避免属性转义问题
  return '<div class="viz-card" id="' + vizId + '">'
    + '<div class="viz-toolbar">'
    + '<span class="viz-label"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v18"/></svg> 交互式可视化</span>'
    + '<div class="viz-actions">'
    + '<button class="viz-btn" onclick="toggleVizFullscreen(\'' + vizId + '\')" title="全屏查看">⛶ 全屏</button>'
    + '<button class="viz-btn" onclick="copyVizCode(\'' + vizId + '\')" title="复制源码">📋 复制</button>'
    + '<button class="viz-btn" onclick="openVizNewTab(\'' + vizId + '\')" title="新标签页打开">↗ 新窗口</button>'
    + '</div></div>'
    + '<iframe class="viz-iframe' + heightClass + '" sandbox="allow-scripts allow-same-origin" data-viz-id="' + vizId + '" loading="lazy"></iframe>'
    + '</div>';
}

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
  const mermaidBlocks = [];
  let processed = text.replace(/```mermaid\s*\n([\s\S]*?)```/g, (match, code) => {
    const idx = mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return `<!--MERMAID_PLACEHOLDER_${idx}-->`;
  });
  let html = marked.parse(processed);
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

// ====== 双域折叠区域渲染 ======
function wrapDualDomainSections(element) {
  const html = element.innerHTML;
  
  // 定义四个可识别的域标题：物理视角、数学视角为可折叠区域；知识图谱、延伸思考为独立区块
  const domainDefs = [
    { key: 'physics', icon: '🔬', label: '物理视角', colorClass: 'physics-section', regex: /<h[1-6][^>]*>[^<]*🔬[^<]*物理视角[^<]*<\/h[1-6]>/i, collapsible: true },
    { key: 'math', icon: '📐', label: '数学视角', colorClass: 'math-section', regex: /<h[1-6][^>]*>[^<]*📐[^<]*数学视角[^<]*<\/h[1-6]>/i, collapsible: true },
    { key: 'graph', icon: '🧠', label: '知识图谱', colorClass: 'graph-section', regex: /<h[1-6][^>]*>[^<]*(?:🧠|知识图谱)[^<]*<\/h[1-6]>/i, collapsible: true },
    { key: 'extend', icon: '💡', label: '延伸思考', colorClass: 'extend-section', regex: /<h[1-6][^>]*>[^<]*(?:💡|延伸思考)[^<]*<\/h[1-6]>/i, collapsible: true },
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
          ${sec.collapsible && (sec.key === 'physics' || sec.key === 'math') ? `<button class="dual-domain-followup" onclick="event.stopPropagation(); followUpDomain('${sec.key}')">追问</button>` : ''}
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
        const escaped = question.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return `<span class="learn-dir-btn" onclick="sendQuick('${escaped}')">${item}</span>`;
      }).join('');
      return `${header}<div class="learn-dir-section">${buttons}</div>`;
    }
  );
}

function convertSocraticQuestions(html) {
  return html.replace(
    /(<h[1-6][^>]*>.*?(?:延伸思考|追问|苏格拉底|深入思考).*?<\/h[1-6]>)([\s\S]*?)((?:<ul>|<ol>))([\s\S]*?)(<\/ul>|<\/ol>)/gi,
    (match, header, between, openTag, listContent, closeTag) => {
      const items = [];
      const liRegex = /<li>([\s\S]*?)<\/li>/g;
      let liMatch;
      while ((liMatch = liRegex.exec(listContent)) !== null) {
        const text = liMatch[1].replace(/<[^>]+>/g, '').trim();
        if (text) items.push(text);
      }
      if (items.length === 0) return match;
      const buttons = items.map(item => {
        const cleanText = item.replace(/^❓\s*/, '').trim();
        const escaped = cleanText.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        let level = '';
        if (cleanText.includes('基础层')) level = 'level-basic';
        else if (cleanText.includes('进阶层')) level = 'level-advanced';
        else if (cleanText.includes('拓展层')) level = 'level-expand';
        return `<span class="socratic-btn ${level}" onclick="sendQuick('${escaped}')">${item}</span>`;
      }).join('');
      return `${header}${between}<div class="socratic-section">${buttons}</div>`;
    }
  );
}

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
