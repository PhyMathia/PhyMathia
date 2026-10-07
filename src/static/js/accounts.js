// ====== 本地多账号（P2 2026-10-07）：侧栏「账号」磁贴与管理面板 ======
// 服务端路由：GET /api/accounts（列表）、POST /api/accounts（新建）、
// POST /api/accounts/{rename,allow_browse,delete}（main.py）。切换账号＝写
// 账号指针元键后整页 reload：config.js 装载期据此算 localStorage 键前缀、
// 给所有 /api/ 请求补 account_id，整棵应用树无感换域——不做热切换是有意的：
// 内存里的会话/画布/面板状态太多，reload 是唯一不漏的隔离方式。
//
// ★ 元键纪律：phymathia_account / phymathia_account_name 绝不能走垫片后的
// localStorage（非 default 账号下会被加前缀写到别处），一律用 config.js 留的
// _RAW_LS（垫片安装前的原生存储引用）。

function _accountsCurrentName() {
  // 昵称缓存是元键：读也走 _RAW_LS——非 default 账号下垫片会把
  // localStorage.getItem(STORAGE_KEY_ACCOUNT_NAME) 重定向到账号命名空间里
  // 一个不存在的键，静默回落「我的」，磁贴昵称就永远不更新了
  try {
    const raw = (typeof _RAW_LS !== 'undefined' && _RAW_LS) ? _RAW_LS : localStorage;
    return (raw.getItem(STORAGE_KEY_ACCOUNT_NAME) || '').trim() || '我的';
  } catch (e) { return '我的'; }
}

// 磁贴副行与悬浮提示同步当前账号昵称（同时把缓存写回元键，供下次启动零请求显示）
function _accountsSetTile(name) {
  try {
    if (typeof _RAW_LS !== 'undefined' && _RAW_LS) _RAW_LS.setItem(STORAGE_KEY_ACCOUNT_NAME, name);
  } catch (e) {}
  const sub = document.getElementById('accountTileSub');
  if (sub) sub.textContent = name;
  const tile = document.getElementById('accountTile');
  if (tile) tile.title = '当前账号：' + name + '（点击管理与切换账号）';
}
_accountsSetTile(_accountsCurrentName());

// ====== 只读查阅（P3 2026-10-07）：进入/退出他人空间 ======
// 进入＝重查一遍注册表确认对方仍开放（面板缓存可能过期）→ 劫持账号指针 +
// 写两枚浏览元键（config.js 装载期据此置 PHYMATHIA_READONLY）→ reload。
// 退出＝指针还原 + 清元键 → reload。状态落 localStorage 元键：关标签页/崩溃
// 后重开仍在只读查阅，不会以写模式留在对方账号（拍板见当日日志）。
async function enterBrowse(id) {
  if (typeof window !== 'undefined' && window.PHYMATHIA_READONLY) {
    toastMsg('已在查阅模式，请先退出再换', 2500);
    return;
  }
  if (!id || id === ACCOUNT_ID) return;
  try {
    const resp = await fetch('/api/accounts');
    const data = await resp.json();
    const hit = ((data && data.accounts) || []).find(a => a && a.id === id);
    if (!hit || !hit.allowBrowse) {
      toastMsg('该账号未开放查阅', 2500);
      renderAccountsList();
      return;
    }
  } catch (e) {
    toastMsg('进入查阅失败：无法确认查阅权限', 3000);
    return;
  }
  try {
    _RAW_LS.setItem(STORAGE_KEY_BROWSE_RETURN, String(ACCOUNT_ID || 'default'));
    _RAW_LS.setItem(STORAGE_KEY_BROWSE_RETURN_NAME, _accountsCurrentName());
    _RAW_LS.setItem(STORAGE_KEY_BROWSE_ACTIVE, String(id));
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT, String(id));
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT_NAME, _accountsNameOf(id));
  } catch (e) {
    toastMsg('进入查阅失败：浏览器本地存储不可用', 3000);
    return;
  }
  location.reload();
}

function exitBrowse() {
  const back = String((typeof window !== 'undefined' && window.PHY_BROWSE_RETURN) || 'default');
  const backOk = ACCOUNT_ID_RE.test(back);
  // 昵称还原：优先用进查阅时定格的名字，面板缓存兜底，最后回落「我的」——
  // 不还原的话磁贴副行会一直挂着被查阅账号的昵称
  const backName = ((typeof window !== 'undefined' && window.PHY_BROWSE_RETURN_NAME) || _accountsNameOf(back) || '我的');
  try {
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT, backOk ? back : 'default');
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT_NAME, backOk ? backName : '我的');
    _RAW_LS.removeItem(STORAGE_KEY_BROWSE_ACTIVE);
    _RAW_LS.removeItem(STORAGE_KEY_BROWSE_RETURN);
    _RAW_LS.removeItem(STORAGE_KEY_BROWSE_RETURN_NAME);
  } catch (e) {}
  location.reload();
}

// 查阅态常驻悬浮条：告知「在谁的space里」＋唯一出口（boot 时渲染，非查阅态不动）
(function _renderBrowseBar() {
  const bar = document.getElementById('browseBar');
  if (!bar) return;
  if (!(typeof window !== 'undefined' && window.PHYMATHIA_READONLY)) { bar.hidden = true; return; }
  const txt = document.getElementById('browseBarText');
  if (txt) txt.textContent = '正在只读查阅「' + _accountsCurrentName() + '」的会话与知识';
  bar.hidden = false;
})();

// 查阅态下面板自身也是只读的（服务端兜底同拦），账号管理类操作先礼后兵
function _accountsReadonlyGuard() {
  if (typeof window !== 'undefined' && window.PHYMATHIA_READONLY) {
    toastMsg('查阅模式：不能修改账号设置，请先退出查阅', 2500);
    return true;
  }
  return false;
}

function openAccountsPanel() {
  document.getElementById('accountsDialog').classList.add('show');
  renderAccountsList();
}

function closeAccountsPanel() {
  document.getElementById('accountsDialog').classList.remove('show');
}

// ----- 列表渲染 -----

let _accountsCache = null; // 最近一次拉到的账号条目（handler 按 id 反查昵称，避免把用户输入拼进 onclick）

async function renderAccountsList() {
  const box = document.getElementById('accountsList');
  if (!box) return;
  box.innerHTML = '<div class="accounts-row-loading">读取中…</div>';
  try {
    const resp = await fetch('/api/accounts');
    const data = await resp.json();
    _accountsCache = (data && Array.isArray(data.accounts)) ? data.accounts : null;
  } catch (e) {
    _accountsCache = null;
  }
  if (!_accountsCache) {
    box.innerHTML = '<div class="accounts-row-loading">读取失败，请稍后重试</div>';
    return;
  }
  const current = (typeof ACCOUNT_ID !== 'undefined') ? ACCOUNT_ID : 'default';
  // 每次打开面板顺手校正磁贴昵称：当前账号改名可能发生在另一台设备
  const cur = _accountsCache.find(a => a && a.id === current);
  if (cur && cur.name) _accountsSetTile(String(cur.name));
  box.innerHTML = _accountsCache.map(a => _accountRowHtml(a, a.id === current)).join('')
    || '<div class="accounts-row-loading">（暂无账号）</div>';
}

function _accountsDateStr(ms) {
  try {
    const d = new Date(ms || 0);
    return (ms && !isNaN(d.getTime())) ? d.toLocaleDateString() : '';
  } catch (e) { return ''; }
}

// 行渲染纯函数（冒烟测试直接调用）：a = {id, name, allowBrowse, createdAt}
// 查阅态（window.PHYMATHIA_READONLY）下整行只展示不操作：无开关无按钮，
// 当前徽标改「查阅中」——面板自身也被兜底闸门拦写，按钮给了也点不动。
function _accountRowHtml(a, isCurrent) {
  if (!a || !a.id) return '';
  const id = String(a.id);
  const name = escapeHtml(String(a.name || id));
  const dateStr = _accountsDateStr(a.createdAt);
  const ro = (typeof window !== 'undefined' && window.PHYMATHIA_READONLY);
  const meta = [];
  if (isCurrent) meta.push(ro ? '查阅中' : '当前使用');
  if (dateStr) meta.push('创建于 ' + dateStr);
  const browse = ro
    ? '<span class="accounts-browse" title="查阅模式下不可更改">允许查阅：' + (a.allowBrowse ? '开' : '关') + '</span>'
    : '<label class="accounts-browse" title="开启后，其他账号可只读查阅此账号的会话与知识">'
      + '<input type="checkbox"' + (a.allowBrowse ? ' checked' : '') + ' onchange="toggleAccountBrowse(\'' + id + '\', this.checked)">允许查阅</label>';
  let actions = '';
  if (!ro) {
    // 对方开了「允许查阅」才出查阅钮（进门前 enterBrowse 还会重查一遍注册表）
    if (!isCurrent && a.allowBrowse) {
      actions += '<button class="accounts-act accounts-act-browse" onclick="enterBrowse(\'' + id + '\')">查阅</button>';
    }
    if (!isCurrent) actions += '<button class="accounts-act" onclick="switchAccount(\'' + id + '\')">切换</button>';
    actions += '<button class="accounts-act" onclick="renameAccountPrompt(\'' + id + '\')">改名</button>';
    // default 是无账号标识请求的兜底落点，拒删（服务端同款防线）；其余账号都可删——
    // 当前账号删除成功后由 deleteAccountPrompt 切回 default 并刷新（旧设计「当前账号
    // 须先切走再删」导致唯一的非 default 账号在任何行都看不到删除钮，等于没这功能）
    if (id !== 'default') {
      actions += '<button class="accounts-act accounts-act-danger" onclick="deleteAccountPrompt(\'' + id + '\')">删除</button>';
    }
  }
  return '<div class="accounts-row" data-account="' + id + '">'
    + '<div class="accounts-row-main">'
    + '<div class="accounts-row-name"><span class="acct-name-text">' + name + '</span>'
    + (isCurrent ? '<span class="accounts-badge">当前</span>' : '')
    + '</div>'
    + (meta.length ? '<div class="accounts-row-meta">' + meta.join(' · ') + '</div>' : '')
    + '</div>'
    + browse
    + '<div class="accounts-row-actions">' + actions + '</div>'
    + '</div>';
}

// ----- 动作（切换/新建/改名/删除/允许查阅）-----

function _accountsNameOf(id) {
  const hit = (_accountsCache || []).find(a => a && a.id === id);
  return hit ? String(hit.name || id) : id;
}

function switchAccount(id) {
  if (id === ACCOUNT_ID) return;
  try {
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT, String(id));
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT_NAME, _accountsNameOf(id));
    // 任何显式切换都同时退出查阅态：只读旗标不能残留到下一个账号
    _RAW_LS.removeItem(STORAGE_KEY_BROWSE_ACTIVE);
    _RAW_LS.removeItem(STORAGE_KEY_BROWSE_RETURN);
  } catch (e) {
    toastMsg('切换失败：浏览器本地存储不可用', 3000);
    return;
  }
  location.reload();
}

async function createAccount() {
  if (_accountsReadonlyGuard()) return;
  const input = document.getElementById('accountNewName');
  const btn = document.getElementById('accountCreateBtn');
  if (btn && btn.disabled) return; // 回车与点击同触发，防重入双建
  const name = (input && input.value || '').trim();
  if (!name) {
    toastMsg('先给新账号起个昵称吧', 2500);
    if (input) input.focus();
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!resp.ok) {
      // 405＝前端已更新而后端还是旧进程（改 src/main.py 后忘了重启的典型症状：
      // POST 落进旧后端的静态文件 GET 路由），报明白话别让人对着 405 猜
      throw new Error(resp.status === 405 ? '服务端还是旧版，请重启 PhyMathia 服务后再试' : 'http ' + resp.status);
    }
    const entry = await resp.json();
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT, String(entry.id));
    _RAW_LS.setItem(STORAGE_KEY_ACCOUNT_NAME, String(entry.name || name));
    location.reload();
  } catch (e) {
    toastMsg('新建账号失败：' + (e && e.message ? e.message : '服务未响应'), 3000);
    if (btn) btn.disabled = false;
  }
}

function renameAccountPrompt(id) {
  if (_accountsReadonlyGuard()) return;
  const old = _accountsNameOf(id);
  const next = (prompt('账号新昵称：', old) || '').trim();
  if (!next || next === old) return;
  fetch('/api/accounts/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: id, name: next })
  }).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .then(entry => {
      toastMsg('已改名为「' + (entry.name || next) + '」', 2500);
      if (id === ACCOUNT_ID) _accountsSetTile(String(entry.name || next));
      renderAccountsList();
    })
    .catch(() => toastMsg('改名失败，请稍后重试', 3000));
}

function deleteAccountPrompt(id) {
  if (_accountsReadonlyGuard()) return;
  const name = _accountsNameOf(id);
  const isSelf = (id === ACCOUNT_ID);
  const msg = isSelf
    ? '确定删除当前账号「' + name + '」？\n\n该账号的全部会话、知识、公式与检测记录将一并从这台电脑上删除，不可恢复。删除后将回到「我的」账号。'
    : '确定删除账号「' + name + '」？\n\n该账号的全部会话、知识、公式与检测记录将一并从这台电脑上删除，不可恢复。';
  const ok = confirm(msg);
  if (!ok) return;
  fetch('/api/accounts/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: id, delete_data: true })
  }).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .then(() => {
      if (isSelf) {
        // 删除的是当前账号：指针元键切回 default 再刷新（垫片按新指针换命名空间）
        try {
          _RAW_LS.setItem(STORAGE_KEY_ACCOUNT, 'default');
          _RAW_LS.setItem(STORAGE_KEY_ACCOUNT_NAME, _accountsNameOf('default') || '我的');
        } catch (e) {}
        location.reload();
        return;
      }
      toastMsg('账号「' + name + '」已删除', 2500);
      renderAccountsList();
    })
    .catch(() => toastMsg('删除失败，请稍后重试', 3000));
}

function toggleAccountBrowse(id, allow) {
  if (_accountsReadonlyGuard()) { renderAccountsList(); return; }
  fetch('/api/accounts/allow_browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: id, allow: !!allow })
  }).then(r => { if (!r.ok) throw new Error('http ' + r.status); })
    .catch(() => {
      toastMsg('「允许查阅」设置失败，已还原', 3000);
      renderAccountsList();
    });
}

// 冒烟测试导出（与 graph-continent 等模块的 window.* 导出惯例一致）
if (typeof window !== 'undefined') {
  window._accountRowHtml = _accountRowHtml;
  window._accountsCurrentName = _accountsCurrentName;
  window._accountsDateStr = _accountsDateStr;
}
