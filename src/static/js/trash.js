// ====== 回收站（2026-10-07）：防误删 —— 删掉的画布在保留期内可整体恢复 ======
// 服务端在删除路由里先把会话整体快照进 data/users/<账号>/trash/（捕获集与
// 拍板见 server/trash.py 模块注释）；本面板只管站内：列表 / 恢复 / 彻底删除 /
// 清空 / 保留天数设置。条目两类（T182）：整删画布（kind=session，key==id）与
// 清空单画布消息（kind=messages，目录名 <sid>__m<时刻>，恢复/删除按 key 寻址、
// 行上带「清空的消息」徽标）；恢复＝服务端把数据写回原位后整页 reload——会话
// 名单是 localStorage+服务端双源合并，reload 是唯一不漏的刷新方式（同账号切换
// 拍板）。保留天数按账号存服务端注册表（trashRetentionDays 字段，默认 7）；
// 磁贴副行用 localStorage 缓存显示（经垫片自然分账号），打开面板时以服务端为
// 准校正。查阅态：列表可看，恢复/删除/设置全被 _trashReadonlyGuard + fetch 包装
// + 服务端只读中间件三层拦下。

function _trashRetentionLocal() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY_TRASH_RETENTION), 10);
    if (Number.isFinite(v) && v >= 0 && v <= 365) return v;
  } catch (e) {}
  return 7;
}

// 副行文案纯函数（冒烟测试直接调用）：0＝不保留，其余「留N天」
function _trashRetentionLabel(days) {
  const n = parseInt(days, 10);
  return (Number.isFinite(n) && n > 0) ? ('留' + n + '天') : '不保留';
}

function _trashSetTileSub(days) {
  const sub = document.getElementById('trashTileSub');
  if (sub) sub.textContent = _trashRetentionLabel(days);
}

_trashSetTileSub(_trashRetentionLocal());

function _trashReadonlyGuard() {
  if (typeof window !== 'undefined' && window.PHYMATHIA_READONLY) {
    toastMsg('查阅模式：回收站只读，请先退出查阅', 2500);
    return true;
  }
  return false;
}

function openTrashPanel() {
  document.getElementById('trashDialog').classList.add('show');
  renderTrashList();
}

function closeTrashPanel() {
  document.getElementById('trashDialog').classList.remove('show');
}

// 剩余天数纯函数（冒烟测试直接调用）：purgeAt 缺失/<=0 视为「不自动清除」
function _trashDaysLeft(purgeAt) {
  const t = parseInt(purgeAt, 10);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
}

// 行渲染纯函数（冒烟测试直接调用）：item = {id, key, kind, title, deletedAt,
// purgeAt, counts}。key 是站内寻址键＝条目目录名（服务端 list_items 附；清空
// 消息条目是 <sid>__m<时刻>，≠画布 id），恢复/彻底删除接口按它寻址，缺失回落
// id。查阅态下整行只展示不操作（服务端兜底闸门同拦写操作）。id 是会话 id
// （服务端白名单 [A-Za-z0-9_-]），入 HTML 前再同款消毒一道，杜绝注入 onclick。
function _trashRowHtml(item) {
  if (!item || !item.id) return '';
  const ref = String(item.key || item.id).replace(/[^A-Za-z0-9_-]/g, '');
  if (!ref) return '';
  const title = escapeHtml(String(item.title || '未命名画布'));
  // 种类徽标（T182）：清空消息条目与整画布条目一眼区分
  const kindTag = item.kind === 'messages' ? '<span class="trash-kind-tag">清空的消息</span>' : '';
  const meta = [];
  const delStr = _accountsDateStr(item.deletedAt);
  if (delStr) meta.push('删除于 ' + delStr);
  const left = _trashDaysLeft(item.purgeAt);
  if (left != null) meta.push(left > 0 ? ('剩 ' + left + ' 天') : '已到期，待清除');
  const counts = item.counts || {};
  const parts = [];
  if (counts.messages) parts.push(counts.messages + ' 条消息');
  if (counts.knowledge) parts.push(counts.knowledge + ' 个知识点');
  if (counts.formulas) parts.push(counts.formulas + ' 条公式');
  if (parts.length) meta.push(parts.join(' · '));
  const ro = (typeof window !== 'undefined' && window.PHYMATHIA_READONLY);
  const actions = ro ? '' : '<div class="accounts-row-actions">'
    + '<button class="accounts-act" onclick="restoreTrashItem(\'' + ref + '\')">恢复</button>'
    + '<button class="accounts-act accounts-act-danger" onclick="purgeTrashItem(\'' + ref + '\')">彻底删除</button>'
    + '</div>';
  return '<div class="accounts-row trash-row" data-trash-item="' + ref + '">'
    + '<div class="accounts-row-main">'
    + '<div class="accounts-row-name trash-row-title">' + title + kindTag + '</div>'
    + (meta.length ? '<div class="accounts-row-meta">' + meta.join(' · ') + '</div>' : '')
    + '</div>'
    + actions
    + '</div>';
}

// 已删账号行渲染纯函数（冒烟测试直接调用）：item = {stone, id, name, deletedAt,
// purgeAt}。stone 是墓碑目录名（恢复/彻底删除接口用），id 是账号 id（仅展示）；
// 与画布行同款消毒与查阅态只展示口径。
function _trashAccountRowHtml(item) {
  if (!item || !item.stone) return '';
  const stone = String(item.stone).replace(/[^A-Za-z0-9_-]/g, '');
  if (!stone) return '';
  const name = escapeHtml(String(item.name || item.id || '已删账号'));
  const meta = [];
  const delStr = _accountsDateStr(item.deletedAt);
  if (delStr) meta.push('删除于 ' + delStr);
  const left = _trashDaysLeft(item.purgeAt);
  if (left != null) meta.push(left > 0 ? ('剩 ' + left + ' 天') : '已到期，待清除');
  const ro = (typeof window !== 'undefined' && window.PHYMATHIA_READONLY);
  const actions = ro ? '' : '<div class="accounts-row-actions">'
    + '<button class="accounts-act" onclick="restoreDeletedAccount(\'' + stone + '\')">恢复</button>'
    + '<button class="accounts-act accounts-act-danger" onclick="purgeDeletedAccount(\'' + stone + '\')">彻底删除</button>'
    + '</div>';
  return '<div class="accounts-row trash-account-row" data-trash-account="' + stone + '">'
    + '<div class="accounts-row-main">'
    + '<div class="accounts-row-name trash-row-title">' + name + '</div>'
    + (meta.length ? '<div class="accounts-row-meta">' + meta.join(' · ') + '</div>' : '')
    + '</div>'
    + actions
    + '</div>';
}

let _trashCache = null; // 最近一次拉到的站内条目（与账号面板同款缓存惯例）

async function renderTrashList() {
  const box = document.getElementById('trashList');
  if (!box) return;
  box.innerHTML = '<div class="accounts-row-loading">读取中…</div>';
  let retention = null;
  let accountItems = [];
  try {
    const resp = await fetch('/api/trash');
    const data = await resp.json();
    _trashCache = (data && Array.isArray(data.items)) ? data.items : null;
    retention = data ? data.retentionDays : null;
    accountItems = (data && Array.isArray(data.deletedAccounts)) ? data.deletedAccounts : [];
  } catch (e) {
    _trashCache = null;
  }
  if (retention != null && Number.isFinite(parseInt(retention, 10))) {
    try { localStorage.setItem(STORAGE_KEY_TRASH_RETENTION, String(parseInt(retention, 10))); } catch (e) {}
    _trashSetTileSub(retention);
    const sel = document.getElementById('trashRetentionSelect');
    if (sel && sel.value !== String(retention)) sel.value = String(retention);
  }
  if (!_trashCache) {
    box.innerHTML = '<div class="accounts-row-loading">读取失败，请稍后重试</div>';
    return;
  }
  // 「已删账号」小节（2026-10-07 删账号回收站化）：没有条目就不渲染标题
  const sessionRows = _trashCache.map(item => _trashRowHtml(item)).join('');
  const accountRows = accountItems.map(item => _trashAccountRowHtml(item)).join('');
  const accountSection = accountRows
    ? '<div class="trash-section-title">已删账号（保留期内可恢复）</div>' + accountRows
    : '';
  box.innerHTML = (sessionRows || accountSection)
    ? sessionRows + accountSection
    : '<div class="accounts-row-loading">回收站是空的。删除的画布与清空的消息会先到这里暂存，超过保留天数自动清除。</div>';
}

async function restoreTrashItem(id) {
  if (_trashReadonlyGuard()) return;
  if (!id) return;
  try {
    const resp = await fetch('/api/trash/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    if (!resp.ok) {
      let msg = '恢复失败（http ' + resp.status + '）';
      try { const d = await resp.json(); if (d && d.detail) msg = String(d.detail); } catch (e) {}
      throw new Error(msg);
    }
  } catch (e) {
    toastMsg(e && e.message ? e.message : '恢复失败，请稍后重试', 3000);
    return;
  }
  toastMsg('已恢复，正在刷新页面…', 2000);
  location.reload();
}

function purgeTrashItem(id) {
  if (_trashReadonlyGuard()) return;
  if (!id) return;
  if (!confirm('彻底删除后无法恢复，确定吗？')) return;
  fetch('/api/trash/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); })
    .then(() => { toastMsg('已彻底删除', 2000); renderTrashList(); })
    .catch(() => toastMsg('删除失败，请稍后重试', 3000));
}

function emptyTrash() {
  if (_trashReadonlyGuard()) return;
  if (!confirm('清空回收站？站内所有条目将立即彻底删除，无法恢复。')) return;
  fetch('/api/trash', { method: 'DELETE' })
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); })
    .then(() => { toastMsg('回收站已清空', 2000); renderTrashList(); })
    .catch(() => toastMsg('清空失败，请稍后重试', 3000));
}

function saveTrashRetention() {
  if (_trashReadonlyGuard()) { renderTrashList(); return; }
  const sel = document.getElementById('trashRetentionSelect');
  if (!sel) return;
  const days = parseInt(sel.value, 10);
  if (!Number.isFinite(days) || days < 0 || days > 365) return;
  fetch('/api/trash/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days })
  }).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .then(d => {
      const n = (d && d.retentionDays != null) ? d.retentionDays : days;
      try { localStorage.setItem(STORAGE_KEY_TRASH_RETENTION, String(n)); } catch (e) {}
      _trashSetTileSub(n);
      toastMsg(n === 0
        ? '已关闭回收站：以后删除的画布不再保留'
        : '保留天数已设为 ' + n + ' 天（对之后删除的画布生效）', 2500);
    })
    .catch(() => { toastMsg('设置失败，已还原', 3000); renderTrashList(); });
}

// ===== 已删账号（墓碑）：恢复 = 目录移回 + 注册表重登记，账号 id 不变 =====

async function restoreDeletedAccount(stone) {
  if (_trashReadonlyGuard()) return;
  if (!stone) return;
  try {
    const resp = await fetch('/api/trash/accounts/' + encodeURIComponent(stone) + '/restore', { method: 'POST' });
    if (!resp.ok) {
      let msg = '恢复失败（http ' + resp.status + '）';
      try { const d = await resp.json(); if (d && d.detail) msg = String(d.detail); } catch (e) {}
      throw new Error(msg);
    }
  } catch (e) {
    toastMsg(e && e.message ? e.message : '恢复失败，请稍后重试', 3000);
    return;
  }
  toastMsg('账号已恢复，可在「账号」面板切换过去', 2500);
  renderTrashList();
}

function purgeDeletedAccount(stone) {
  if (_trashReadonlyGuard()) return;
  if (!stone) return;
  if (!confirm('彻底删除该账号的全部数据？删除后无法恢复。')) return;
  fetch('/api/trash/accounts/' + encodeURIComponent(stone), { method: 'DELETE' })
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); })
    .then(() => { toastMsg('已彻底删除', 2000); renderTrashList(); })
    .catch(() => toastMsg('删除失败，请稍后重试', 3000));
}

// 冒烟测试导出（与 accounts.js 等模块的 window.* 导出惯例一致）
if (typeof window !== 'undefined') {
  window._trashRowHtml = _trashRowHtml;
  window._trashAccountRowHtml = _trashAccountRowHtml;
  window._trashDaysLeft = _trashDaysLeft;
  window._trashRetentionLabel = _trashRetentionLabel;
  window.openTrashPanel = openTrashPanel;
  window.closeTrashPanel = closeTrashPanel;
  window.renderTrashList = renderTrashList;
  window.restoreTrashItem = restoreTrashItem;
  window.purgeTrashItem = purgeTrashItem;
  window.emptyTrash = emptyTrash;
  window.saveTrashRetention = saveTrashRetention;
  window.restoreDeletedAccount = restoreDeletedAccount;
  window.purgeDeletedAccount = purgeDeletedAccount;
}
