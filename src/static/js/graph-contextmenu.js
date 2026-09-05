// ===== PhyMathia 知识网络画布：右键菜单（空白画布 + 节点） =====
// 仿 graph-export.js 的单例弹层模式：同一时刻至多一个菜单实例；DOM 挂 document.body
// （renderGraphCanvas() 会 graphCanvas.innerHTML='' 整体重建，挂在画布里会被重渲摧毁）。
// 菜单零新业务逻辑：每一项都复用既有动作函数，本文件只做目标定位、按节点能力裁剪与弹层生命周期。
// 依赖：运行期用到 graph*/chat-features/knowledge/utils 的全局函数与 showToast；全部惰性调用。
// 联系线（.graph-edge-link）菜单属第二期：本期右键联系线只抑制原生菜单，不弹自绘菜单。

// ---------- 单例弹层状态 ----------
let _graphCtxMenuEl = null;
let _graphCtxOutsideCloser = null;
let _graphCtxEscCloser = null;

function _graphCtxToast(msg) {
  if (typeof showToast === 'function') showToast(String(msg || ''));
}

// ---------- 单例生命周期 ----------

function closeGraphContextMenu() {
  if (_graphCtxMenuEl && _graphCtxMenuEl.parentNode) _graphCtxMenuEl.parentNode.removeChild(_graphCtxMenuEl);
  _graphCtxMenuEl = null;
  if (_graphCtxOutsideCloser) {
    document.removeEventListener('pointerdown', _graphCtxOutsideCloser, true);
    _graphCtxOutsideCloser = null;
  }
  if (_graphCtxEscCloser) {
    document.removeEventListener('keydown', _graphCtxEscCloser, true);
    _graphCtxEscCloser = null;
  }
}

// ---------- 菜单项构造（纯描述，供弹层渲染与静态回归） ----------
// item: { key, label, danger?, disabled?, title?, run? }；{ key: 'sep' } 为分隔线。

// 目标三分支分类：'node' | 'link' | 'canvas'。
// 空态「新问题」卡等带 .graph-node 类但查不到数据的元素按画布菜单处理。
function _graphContextTargetKind(target) {
  if (!target || typeof target.closest !== 'function') return 'canvas';
  if (target.closest('.graph-edge-link, .graph-edge-link-label')) return 'link';
  const nodeEl = target.closest('.graph-node');
  const nodeId = nodeEl && nodeEl.dataset ? nodeEl.dataset.nodeId : '';
  if (nodeId && typeof _findGraphNode === 'function' && _findGraphNode(nodeId)) return 'node';
  return 'canvas';
}

// A 类节点菜单：按节点能力白名单裁剪（门控复用渲染层与动作函数的同一判定）
function _graphContextItemsForNode(node) {
  const items = [];
  if (!node || !node.id) return items;
  const content = typeof _nodeStoredContent === 'function'
    ? _nodeStoredContent(node)
    : (node.content || node.summary || '');
  const hasContent = String(content || '').trim().length > 0;

  if (hasContent && node.kind !== 'draft') {
    items.push({ key: 'bookmark', label: '收藏为知识点', run: () => _graphCtxBookmarkNode(node, content) });
  }
  if (hasContent) {
    items.push({ key: 'copy', label: '复制全文', run: () => _graphCtxCopyText(String(content || '')) });
  }
  if (typeof _canMinimizeGraphNode === 'function' && _canMinimizeGraphNode(node)) {
    items.push({
      key: 'minimize',
      label: node.minimized ? '展开' : '折叠',
      run: () => { if (typeof _toggleGraphNodeMinimize === 'function') _toggleGraphNodeMinimize(node); },
    });
  }
  // 输出端口白名单与 graphAddOutputPort 的守卫一致；输入端口白名单与 graphAddInputPort 一致
  const canOutput = (typeof _moduleCanExpandOutputs === 'function' && _moduleCanExpandOutputs(node))
    || node.kind === 'source' || node.kind === 'knowledge';
  const canInput = node.kind === 'user' || node.kind === 'hub' || node.kind === 'relation'
    || node.kind === 'module' || node.kind === 'blank';
  if (canInput) {
    items.push({ key: 'add-input-port', label: '添加输入端口', run: () => graphAddInputPort(node.id) });
  }
  if (canOutput) {
    items.push({ key: 'add-output-port', label: '添加输出端口', run: () => graphAddOutputPort(node.id) });
  }
  items.push({ key: 'sep' });
  // 删除沿用 _deleteSelectedGraphNodes 的确认路径（消息节点 confirm、blank/draft/自定义静默）
  items.push({
    key: 'delete',
    label: '删除节点',
    danger: true,
    run: () => { if (typeof _deleteSelectedGraphNodes === 'function') _deleteSelectedGraphNodes([node.id]); },
  });
  return items;
}

// C 类空白画布菜单
function _graphContextItemsForCanvas(point) {
  const pt = point || { x: 0, y: 0 };
  const canReadClipboard = typeof navigator !== 'undefined'
    && navigator.clipboard && typeof navigator.clipboard.readText === 'function';
  const items = [];
  items.push({
    key: 'add-node',
    label: '新建节点…',
    run: () => { if (typeof openAddBlankNodeModal === 'function') openAddBlankNodeModal(pt.x, pt.y); },
  });
  items.push({
    key: 'paste-node',
    label: '粘贴为节点',
    disabled: !canReadClipboard,
    title: canReadClipboard ? '把剪贴板文本粘贴为空白节点' : '当前环境不可读取剪贴板',
    run: () => _graphCtxPasteNode(pt),
  });
  items.push({ key: 'sep' });
  items.push({ key: 'fit', label: '适配画布', run: () => fitGraph() });
  items.push({ key: 'arrange', label: '自动整理', run: () => autoArrangeGraph() });
  items.push({ key: 'sep' });
  items.push({
    key: 'export',
    label: '导出超高清 PNG…',
    run: () => { if (typeof window.toggleGraphExportMenu === 'function') window.toggleGraphExportMenu(); },
  });
  items.push({ key: 'sep' });
  items.push({
    key: 'undo',
    label: '撤销',
    run: () => { if (typeof window.undoGraphAction === 'function') window.undoGraphAction(); },
  });
  items.push({
    key: 'redo',
    label: '重做',
    run: () => { if (typeof window.redoGraphAction === 'function') window.redoGraphAction(); },
  });
  return items;
}

// 去掉首尾与连续的分隔线（裁剪后可能只剩分隔线相邻）
function _graphCtxCleanSeparators(items) {
  const out = [];
  for (const item of items) {
    if (item && item.key === 'sep') {
      if (!out.length || out[out.length - 1].key === 'sep') continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].key === 'sep') out.pop();
  return out;
}

// ---------- 动作适配（均只组合既有函数，零新业务逻辑） ----------

function _graphCtxNodeTitle(node) {
  const raw = String((node && (node.label || node.title)) || '').trim();
  if (raw) return raw.slice(0, 24);
  const meta = (typeof GRAPH_MODULE_META === 'object' && GRAPH_MODULE_META)
    ? GRAPH_MODULE_META[node.moduleKey] : null;
  if (meta && meta.label) return String(meta.label).slice(0, 24);
  const content = typeof _nodeStoredContent === 'function'
    ? _nodeStoredContent(node) : (node.content || '');
  const plain = String(content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.slice(0, 24) || '节点';
}

// 复制全文
function _graphCtxCopyText(text) {
  if (!text) return;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => {
      _graphCtxToast('已复制节点全文');
    }).catch(() => {
      _graphCtxToast('复制失败：浏览器拒绝了剪贴板写入');
    });
  } else {
    _graphCtxToast('当前环境不支持复制到剪贴板');
  }
}

// 收藏为知识点：持久化路径 100% 复用消息卡收藏流程（书签弹窗表单 → 既有 saveBookmark）。
// 这里只做节点语境的表单预填：标题=节点标题、摘要=内容纯文本前 100 字、
// 公式复用 extractLocalFormulas 过滤链；「保存并替换 AI 提取」在节点语境下不提供。
function _graphCtxBookmarkNode(node, content) {
  const modal = document.getElementById('bookmarkModal');
  if (!modal || typeof saveBookmark !== 'function') {
    _graphCtxToast('收藏组件未就绪');
    return;
  }
  const text = String(content || '');
  const stripped = typeof stripXmlTags === 'function' ? stripXmlTags(text) : text.replace(/<[^>]+>/g, ' ');
  const plainText = String(stripped || '').replace(/\s+/g, ' ').trim();
  const moduleKey = String(node.moduleKey || '');

  const titleEl = document.getElementById('bmTitle');
  if (titleEl) titleEl.value = String(node.label || node.title || '').trim() || plainText.slice(0, 40);
  const categoryEl = document.getElementById('bmCategory');
  if (categoryEl) categoryEl.value = moduleKey === 'math' ? 'math' : moduleKey === 'physics' ? 'physics' : 'other';
  const summaryEl = document.getElementById('bmSummary');
  if (summaryEl) summaryEl.value = plainText.slice(0, 100);
  const tagsEl = document.getElementById('bmTags');
  if (tagsEl) tagsEl.value = moduleKey === 'math' ? '数学' : moduleKey === 'physics' ? '物理' : '';
  const formulasEl = document.getElementById('bmFormulas');
  if (formulasEl) {
    formulasEl.value = (typeof extractLocalFormulas === 'function' && node.kind !== 'draft')
      ? extractLocalFormulas(text).join('\n')
      : '';
  }
  const contentEl = document.getElementById('bmContent');
  if (contentEl) contentEl.value = text;
  const sessionEl = document.getElementById('bmSessionId');
  if (sessionEl) {
    sessionEl.value = (typeof window.getCurrentSessionId === 'function'
      ? window.getCurrentSessionId() : '') || '';
  }
  const messageEl = document.getElementById('bmMessageId');
  if (messageEl) messageEl.value = node.messageIndex >= 0 ? String(node.timestamp || '') : '';
  const replaceEl = document.getElementById('bmReplaceIds');
  if (replaceEl) replaceEl.value = '';
  const replaceBtn = document.getElementById('bmBtnReplace');
  if (replaceBtn) replaceBtn.style.display = 'none';

  modal.classList.add('active');
}

// 粘贴为节点：复用 createManualNode('blank') 建节点（含撤销栈/持久化/重渲），
// 再用 updateCustomNodeContent 写入剪贴板文本（复用其 summary 提炼与保存）。
function _graphCtxCreateBlankNodeWithText(point, text) {
  if (typeof createManualNode !== 'function') return;
  if (typeof addBlankNodePoint !== 'undefined' && addBlankNodePoint) {
    addBlankNodePoint.x = point.x;
    addBlankNodePoint.y = point.y;
  }
  const before = new Set((graphView.nodes || []).map(n => n.id));
  createManualNode('blank');
  const created = (graphView.nodes || []).find(n => !before.has(n.id));
  if (!created) return;
  if (typeof updateCustomNodeContent === 'function') {
    updateCustomNodeContent(created.id, text);
    if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
  }
}

function _graphCtxPasteNode(point) {
  if (!(navigator.clipboard && typeof navigator.clipboard.readText === 'function')) return;
  navigator.clipboard.readText().then(text => {
    const clean = String(text || '').trim();
    if (!clean) {
      _graphCtxToast('剪贴板没有可用的文本');
      return;
    }
    _graphCtxCreateBlankNodeWithText(point, clean);
  }).catch(() => {
    _graphCtxToast('读取剪贴板失败（浏览器权限限制）');
  });
}

// ---------- 弹层渲染 ----------

function openGraphContextMenu(event) {
  closeGraphContextMenu();
  if (!event) return;
  const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
  const kind = _graphContextTargetKind(target);
  // B 类联系线菜单属第二期（P5）：调用方已 preventDefault，这里静默不弹
  if (kind === 'link') return;

  const point = (typeof _clientToGraphLocal === 'function')
    ? _clientToGraphLocal(event.clientX, event.clientY)
    : { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };

  let title = '画布';
  let items;
  if (kind === 'node') {
    const nodeEl = target.closest('.graph-node');
    const node = _findGraphNode(nodeEl.dataset.nodeId);
    title = _graphCtxNodeTitle(node);
    items = _graphContextItemsForNode(node);
  } else {
    items = _graphContextItemsForCanvas(point);
  }
  items = _graphCtxCleanSeparators((items || []).filter(item => item && (item.key === 'sep' || item.label)));
  if (!items.length) return;

  const menu = document.createElement('div');
  menu.className = 'graph-context-menu';
  menu.setAttribute('role', 'menu');
  const head = document.createElement('div');
  head.className = 'graph-context-menu-title';
  head.textContent = title; // textContent 防注入
  menu.appendChild(head);
  items.forEach((item, index) => {
    if (item.key === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'graph-context-menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'graph-context-menu-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.dataset.itemIndex = String(index);
    if (item.disabled) btn.disabled = true;
    if (item.title) btn.title = item.title;
    menu.appendChild(btn);
  });

  menu.addEventListener('click', ev => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.graph-context-menu-item') : null;
    if (!btn || btn.disabled) return;
    const item = items[Number(btn.dataset.itemIndex)];
    closeGraphContextMenu();
    if (item && typeof item.run === 'function') item.run();
  });
  // 菜单上的右键不应再触发任何 contextmenu 链路
  menu.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    ev.stopPropagation();
  });

  document.body.appendChild(menu);
  _graphCtxMenuEl = menu;

  // 视口边缘翻转定位
  const menuW = menu.offsetWidth || 0;
  const menuH = menu.offsetHeight || 0;
  let x = Number(event.clientX) || 0;
  let y = Number(event.clientY) || 0;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  if (x + menuW > vw - 8) x = Math.max(8, vw - menuW - 8);
  if (y + menuH > vh - 8) y = Math.max(8, vh - menuH - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // 点击外部（捕获）与 Esc 关闭——注册延后一拍，避免打开手势自身误关
  _graphCtxOutsideCloser = ev => {
    if (_graphCtxMenuEl && !_graphCtxMenuEl.contains(ev.target)) closeGraphContextMenu();
  };
  _graphCtxEscCloser = ev => {
    if (ev.key === 'Escape') closeGraphContextMenu();
  };
  setTimeout(() => {
    if (!_graphCtxMenuEl) return;
    document.addEventListener('pointerdown', _graphCtxOutsideCloser, true);
    document.addEventListener('keydown', _graphCtxEscCloser, true);
  }, 0);
}

// 全局暴露（graph-workflow 的 contextmenu 监听与后续 P5 联系线菜单复用）
window.openGraphContextMenu = openGraphContextMenu;
window.closeGraphContextMenu = closeGraphContextMenu;
