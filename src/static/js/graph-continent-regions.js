// ===== 知识大陆 · 海域与族表（图例与聚焦/领域指派与改名/海域覆盖 KV/批量归类 gate/族表编辑/纠正信号/新族候选）=====
// 自 graph-continent.js 拆出（2026-10-04，T36）。顶层经典脚本共享全局，顺序见 scripts/build_frontend.mjs。
const CONTINENT_REGION_SOURCE_LABEL = {
  family: '按概念族推断',
  gate: 'Φ 归类',
  user: '你指定',
};

function _continentRegionSourceLabel(source) {
  return CONTINENT_REGION_SOURCE_LABEL[source] || CONTINENT_REGION_SOURCE_LABEL.family;
}

// 混合岛次要领域色点（岛牌主导领域徽标旁）：后端 domains[1] 概率 ≥ 0.25 才有——
// 「多标签」的可见形态，悬停显示分布
function _continentSecondaryDot(cluster, domainList) {
  const second = cluster && cluster.domains && cluster.domains[1];
  if (!second || !(Number(second.p) >= CONTINENT_CONF_LIGHT - 0.15)) return '';
  const hue = _continentRegionHue(second.name, domainList);
  return '<span class="continent-domain-dot" style="--region-h:' + hue + '"' +
    ' title="次要领域：' + _continentEsc(second.name) + '（' + Math.round(Number(second.p) * 100) + '%）"></span>';
}

// 图例本体（#continentLegend，挂在视口左下角——不与顶栏 #continentGuide/连接模式提示
// 争位，那是 v5.4 踩过的互斥坑）。自身可折叠（不许变成新的复杂度）。
// 图例折叠的查阅态内存影子：跳过落盘时保当次切换不弹回（重渲从这里读）；非查阅恒 null
let _continentLegendMem = null;

function _continentRenderLegend(regionInfo, data) {
  const legend = document.getElementById('continentLegend');
  if (!legend) return;
  const regions = (regionInfo && regionInfo.regions) || [];
  const pending = (regionInfo && regionInfo.pending) || [];
  if (!regions.length && !pending.length) { legend.hidden = true; legend.innerHTML = ''; return; }
  legend.hidden = false;
  let collapsed = false;
  // 查阅态：优先读内存影子（切换不落盘也能在重渲间存活）；非查阅恒 null 走 localStorage
  if (_continentLegendMem !== null) collapsed = _continentLegendMem;
  else try { collapsed = localStorage.getItem('phymathia_continent_legend') === '1'; } catch (e) { /* 容忍 */ }
  const esc = _continentEsc;
  const items = regions.map(r => {
    const hueAttr = (r.hue !== null && r.hue !== undefined) ? ' style="--region-h:' + r.hue + '"' : '';
    const over = r.sessions.length > CONTINENT_REGION_CAPACITY
      ? '<span class="continent-region-over" title="这片海域超过 ' + CONTINENT_REGION_CAPACITY +
        ' 座岛，地图还能画，但可以考虑拆成子海域">超容量</span>' : '';
    return '<li class="continent-legend-item' + (_continentLegendFocus === r.key ? ' is-active' : '') + '"' +
      hueAttr + ' data-region="' + esc(r.key) + '" title="点一下聚焦这片海域（其他海域淡出，再点恢复）">' +
      '<span class="continent-legend-chip"></span>' +
      '<span class="continent-legend-name">' + esc(r.name) + '</span>' +
      '<span class="continent-legend-count">' + r.sessions.length + ' 岛 · ' + r.itemCount + ' 卡</span>' +
      over +
      '<span class="continent-legend-src">' + esc(_continentRegionSourceLabel(r.source)) + '</span>' +
      (r.merged ? '' : '<button class="continent-legend-rename" data-rename="' + esc(r.key) +
        '" title="给这片海域改个名（只改显示名，颜色与归类不变）">改名</button>') +
      '</li>';
  }).join('');
  const totalIslands = ((data && data.clusters) || []).length;
  const pendingRatio = totalIslands ? Math.round(pending.length * 100 / totalIslands) : 0;
  // 负载均衡提示（MoE 的 aux loss 位：只提示不硬拆——均衡不是目标，可读才是）：
  // 某领域吃掉 >35% 的卡且库 ≥30 卡时提一句「可拆子海域」，拆不拆用户说了算
  let shareHint = '';
  const totalCards = (data && data.itemCount) || 0;
  if (totalCards >= 30) {
    const biggest = regions.reduce((a, b) => (!a || b.itemCount > a.itemCount) ? b : a, null);
    if (biggest && biggest.itemCount / totalCards > CONTINENT_GATE_DOMINANT_SHARE) {
      shareHint = '「' + biggest.name + '」占了 ' +
        Math.round(biggest.itemCount * 100 / totalCards) + '% 的卡片——海域过大可拆子海域';
    }
  }
  const footBits = [];
  if (pending.length) {
    footBits.push('低置信 ' + pending.length + '/' + totalIslands + '（' + pendingRatio +
      '%）——占比高说明领域名单或词表该补了');
  }
  if (shareHint) footBits.push(shareHint);
  // v8 纠正信号可见（缺失要可见）：记了几笔在图例照报，族表弹层里可清空
  if (_continentCorrectionCount > 0) {
    footBits.push('归类纠正已记录 ' + _continentCorrectionCount + ' 次（族表弹层可清空）');
  }
  legend.innerHTML =
    '<div class="continent-legend-head">' +
      '<span class="continent-legend-title">图例' + (collapsed ? ' ▸' : ' ▾') + '</span>' +
      (pending.length
        ? '<button class="continent-legend-pending" data-pending>待确认 ' + pending.length + ' 座岛</button>'
        : '') +
    '</div>' +
    (collapsed ? '' :
      '<ul class="continent-legend-list">' + items + '</ul>' +
      // T139 符号说明：三种前缀/三种线/布局语义不解释＝没画（前缀语义此前只有代码注释知道）
      '<div class="continent-legend-syms">' +
        '<span>联运港前缀：◈ 标题共享 · ∑ 公式共享 · ❖ 概念族</span>' +
        '<span>细线＝联运线（联运港↔岛，机器取证）；粗线＝你画的航线；虚线断桥＝一端已失效（工具条可清理）</span>' +
        '<span>相邻的岛＝学过共同概念——排布即亲缘</span>' +
      '</div>' +
      (footBits.length ? '<div class="continent-legend-foot">' + esc(footBits.join('；')) + '</div>' : ''));
  const toggle = legend.querySelector ? legend.querySelector('.continent-legend-head') : null;
  if (toggle) toggle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    // 查阅态：切换写内存影子不落盘（写经账号垫片会进对方命名空间），浏览交互保留
    if (phyIsReadonly()) {
      const cur = _continentLegendMem !== null ? _continentLegendMem
        : (function () {
            try { return localStorage.getItem('phymathia_continent_legend') === '1'; }
            catch (err) { return false; }
          })();
      _continentLegendMem = !cur;
      _continentReadonlyNudge();
    } else {
      try {
        localStorage.setItem('phymathia_continent_legend',
          localStorage.getItem('phymathia_continent_legend') === '1' ? '0' : '1');
      } catch (err) { /* 容忍 */ }
    }
    _continentRenderLegend(_continentRegionInfo, data);
  });
  if (toggle) _kact(toggle);  // T143 键盘可达
  (legend.querySelectorAll ? legend.querySelectorAll('[data-region]') : []).forEach(li => {
    li.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentToggleLegendFocus(li.getAttribute('data-region'));
    });
    _kact(li);  // T143 键盘可达
  });
  (legend.querySelectorAll ? legend.querySelectorAll('[data-rename]') : []).forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentRenameRegionMenu(e, btn.getAttribute('data-rename'));
    });
    _kact(btn);  // T143 键盘可达
  });
  const pendingBtn = legend.querySelector ? legend.querySelector('[data-pending]') : null;
  if (pendingBtn) {
    pendingBtn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentPendingPopover(e);
    });
    _kact(pendingBtn);  // T143 键盘可达
  }
}

// 聚焦：只淡化不删不重排——地图的空间记忆（哪片在哪）是用户的资产
function _continentToggleLegendFocus(key) {
  _continentLegendFocus = (_continentLegendFocus === key) ? '' : String(key || '');
  _continentApplyFocus();
  if (_continentRegionInfo && _continentData) {
    _continentRenderLegend(_continentRegionInfo, _continentData);
  }
}

function _continentApplyFocus() {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  const key = _continentLegendFocus;
  const info = _continentRegionInfo || { bySid: {} };
  world.classList.toggle('is-focused', !!key);
  const regionOf = sid => (info.bySid[sid] || {}).key;
  world.querySelectorAll('.continent-region').forEach(el =>
    el.classList.toggle('is-dim', !!key && el.dataset.region !== key));
  world.querySelectorAll('.continent-cluster').forEach(el =>
    el.classList.toggle('is-dim', !!key && regionOf(el.dataset.sessionId) !== key));
  world.querySelectorAll('.continent-node').forEach(el =>
    el.classList.toggle('is-dim', !!key && regionOf(el.dataset.sessionId) !== key));
  const dimBySids = el => {
    const sids = String(el.getAttribute('data-sids') || '').split(',').filter(Boolean);
    el.classList.toggle('is-dim', !!key && !sids.some(sid => regionOf(sid) === key));
  };
  world.querySelectorAll('.continent-city').forEach(dimBySids);
  world.querySelectorAll('.continent-spoke').forEach(dimBySids);
}

// 归到哪个领域：25 个领域 + 不归类，一步落笔（不做拖拽——画布平移已占用 pointerdown，
// v2 踩过 setPointerCapture 把 pointerup 重定向的坑）
function _continentDomainMenu(ev, sid) {
  const data = _continentData || {};
  const list = (data.domainList || []).slice();
  const override = (_continentRegionOverrides && _continentRegionOverrides.assign) || {};
  const hadOverride = Object.prototype.hasOwnProperty.call(override, sid);
  const current = hadOverride ? override[sid]
    : ((((data.clusters || []).find(c => c.sessionId === sid) || {}).domain) || null);
  const esc = _continentEsc;
  const rows = list.map(d =>
    '<button class="continent-pop-btn' + (d === current ? ' is-current' : '') +
    '" data-assign="' + esc(d) + '">' + esc(d) +
    (d === current ? '（当前）' : '') + '</button>').join('');
  const html =
    '<div class="continent-pop-title">这座岛归到哪个领域？</div>' +
    '<div class="continent-pop-desc">你的指派优先于机器判断（Φ 归类 / 概念族推断），写进大陆记忆；Ctrl+Z 可撤销。</div>' +
    '<div class="continent-pop-actions is-wrap">' + rows +
    '<button class="continent-pop-btn is-danger" data-assign="">不归类</button></div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-assign]').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const domain = btn.getAttribute('data-assign') || null;
      _continentClosePopover();
      _continentAssignRegion(sid, domain, hadOverride ? current : undefined);
    });
    _kact(btn);  // T143 键盘可达
  });
}

async function _continentAssignRegion(sid, domain, before) {
  // 纠正方向（「从纠正中学习」的信号）：改前的**生效归属** = 用户覆盖优先，没有覆盖
  // 才看机器判断（domain）；与改后相同就不算纠正（改了个寂寞不记一笔）
  const overrides = _continentRegionOverrides || {};
  const hadOverride = Object.prototype.hasOwnProperty.call(overrides.assign || {}, sid);
  const cluster = ((_continentData && _continentData.clusters) || []).find(c => c.sessionId === sid) || {};
  const fromDomain = hadOverride ? (overrides.assign[sid] || null) : (cluster.domain || null);
  const next = _continentCopyRegionOverrides();
  if (domain) next.assign[sid] = domain;
  else next.assign[sid] = null;   // 「不归类」也是一条用户决定（盖过机器）
  try {
    await _continentCommitRegionOverrides(next,
      { type: 'region', kind: 'assign', sid: sid, before: before });
    if (fromDomain !== domain) _continentRecordCorrection(sid, fromDomain, domain);
    _continentToast(domain ? '已归到「' + domain + '」（Ctrl+Z 可撤销）' : '已改为不归类（Ctrl+Z 可撤销）');
  } catch (err) {
    _continentToast('保存失败：' + (err && err.message || err));
  }
}

// 海域名修改：只改显示名，色槽与归类键不变（颜色跟规范名走，改名不换色）
function _continentRenameRegionMenu(ev, key) {
  const renames = (_continentRegionOverrides && _continentRegionOverrides.renames) || {};
  const before = Object.prototype.hasOwnProperty.call(renames, key) ? renames[key] : undefined;
  const esc = _continentEsc;
  const html =
    '<div class="continent-pop-title">海域改名</div>' +
    '<div class="continent-pop-row"><input class="continent-pop-input" data-rename-input' +
    ' value="' + esc(renames[key] || key) + '" maxlength="16" placeholder="' + esc(key) + '"></div>' +
    '<div class="continent-pop-actions">' +
      // 次操作（还原默认名）在左、主操作（保存）在右，且「保存」由 CSS 顶到行尾——
      // 于是只有「保存」一个按钮时（没改过名就没有还原按钮）它也停在同一个位置，
      // 不会一会儿左一会儿右。两个按钮都吃 pointerdown，DOM 顺序不影响可点性。
      (before !== undefined ? '<button class="continent-pop-btn is-quiet" data-rename-reset>还原默认名</button>' : '') +
      '<button class="continent-pop-btn" data-rename-save>保存</button>' +
    '</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  const input = el.querySelector('[data-rename-input]');
  if (input && input.focus) { try { input.focus(); } catch (e) { /* 容忍 */ } }
  const save = async name => {
    _continentClosePopover();
    const next = _continentCopyRegionOverrides();
    if (name) next.renames[key] = name;
    else delete next.renames[key];
    try {
      await _continentCommitRegionOverrides(next,
        { type: 'region', kind: 'rename', key: key, before: before });
      _continentToast('海域已改名（Ctrl+Z 可撤销）');
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  };
  const saveBtn = el.querySelector('[data-rename-save]');
  if (saveBtn) {
    saveBtn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      save(input ? String(input.value || '').trim().slice(0, 16) : '');
    });
    _kact(saveBtn);  // T143 键盘可达
  }
  const resetBtn = el.querySelector('[data-rename-reset]');
  if (resetBtn) {
    resetBtn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      save('');
    });
    _kact(resetBtn);  // T143 键盘可达
  }
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save(String(input.value || '').trim().slice(0, 16));
  });
}

// 待确认清单（低置信岛）：每行「岛名 → 最优猜测（置信度）」+ 快捷指派——「不确定也
// 要可见」的落点，机器不确定的事交给人一锤定音。v7.1b 起，Φ 归类跑出的建议（新领域
// 提名 / 归并组）也落在这里等确认——模型只建议，落笔权永远在用户
function _continentPendingPopover(ev) {
  const info = _continentRegionInfo || {};
  const pending = info.pending || [];
  const esc = _continentEsc;
  const rows = pending.map(p =>
    '<div class="continent-pop-row">' +
    '<span class="continent-pop-row-text">' + esc(p.title || p.sid) +
    ' <span class="continent-pop-reason">' + esc(p.domain) + '（' +
    Math.round((Number(p.conf) || 0) * 100) + '%）</span></span>' +
    '<button class="continent-pop-btn is-quiet" data-pending-sid="' + esc(p.sid) + '">指派领域</button>' +
    '</div>').join('');
  const sug = _continentGateSuggestions;
  let sugHtml = '';
  if (sug) {
    const mergeRows = (sug.merges || []).map((m, i) =>
      '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">Φ 说这几张是一回事：<b>' + esc(m.name) + '</b>' +
      ' <span class="continent-pop-reason">' + (m.titles || []).map(esc).join(' / ') + '</span></span>' +
      '<button class="continent-pop-btn" data-adopt="' + i + '">采纳进族表</button>' +
      '</div>').join('');
    const newRows = (sug.newDomains || []).length
      ? '<div class="continent-pop-desc">名单缺领域：' + sug.newDomains.map(esc).join('、') +
        '——领域名单是固定的，可在顶栏「族表」里补（补完旧打标自动作废重打）。</div>'
      : '';
    sugHtml = '<div class="continent-pop-title" style="margin-top:6px">Φ 的建议（待你确认）</div>' + mergeRows + newRows;
  }
  const html =
    '<div class="continent-pop-title">待确认 ' + pending.length + ' 座岛</div>' +
    '<div class="continent-pop-desc">这些岛的领域归属置信度低于 40%——机器拿不准的，你一锤定音（指派后进对应海域、Ctrl+Z 可撤销）。</div>' +
    (rows || '<div class="continent-pop-desc">暂时没有待确认的岛。</div>') +
    sugHtml;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-pending-sid]').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentDomainMenu(e, btn.getAttribute('data-pending-sid'));
    });
    _kact(btn);  // T143 键盘可达
  });
  el.querySelectorAll('[data-adopt]').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const m = (_continentGateSuggestions && _continentGateSuggestions.merges || [])
        [Number(btn.getAttribute('data-adopt'))];
      if (m) _continentAdoptGateMerge(m);
    });
    _kact(btn);  // T143 键盘可达
  });
}

function _continentCopyRegionOverrides() {
  const src = _continentRegionOverrides || {};
  const renames = {}, assign = {};
  Object.keys(src.renames || {}).forEach(k => { renames[k] = src.renames[k]; });
  Object.keys(src.assign || {}).forEach(k => { assign[k] = src.assign[k]; });
  return { renames: renames, assign: assign };
}

async function _continentLoadRegionOverrides() {
  try {
    const resp = await fetch(CONTINENT_REGIONS_API, { cache: 'no-cache' });
    if (!resp.ok) return;
    const data = await resp.json();
    const v = (data && data.value) || {};
    _continentRegionOverrides = {
      renames: (v && typeof v.renames === 'object' && !Array.isArray(v.renames)) ? v.renames : {},
      assign: (v && typeof v.assign === 'object' && !Array.isArray(v.assign)) ? v.assign : {},
    };
  } catch (e) { /* 查空是正常路径：没写过就是空覆盖 */ }
}

async function _continentCommitRegionOverrides(next, undoEntry) {
  // 查阅态：跳过落盘（会被 fetch 闸 403），继续走本地镜像——挪岛/改名在内存生效、
  // 撤销栈照常，刷新即失；_continentAssignRegion 的纠正信号随后自行短路
  if (!phyIsReadonly()) {
    const resp = await fetch(CONTINENT_REGIONS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
  } else {
    _continentReadonlyNudge('查阅模式：海域调整只在本次浏览内生效，不会保存');
  }
  if (undoEntry) _continentEdgeUndo.push(undoEntry);
  _continentRegionOverrides = next;
  _continentLegendFocus = '';  // 分组可能变了，聚焦态不作数
  if (_continentOpen && _continentData) _continentRender(_continentData);  // 归属变了 → 重排重渲
  _continentUpdateTools();
}

// 撤销「海域操作」：assign 的 before=undefined 表示原本没有覆盖（撤销=删键）；
// rename 的 before=undefined 表示原本用默认名（撤销=删改名）
async function _continentUndoRegionOp(op) {
  const next = _continentCopyRegionOverrides();
  if (op.kind === 'assign') {
    if (op.before === undefined || op.before === null) delete next.assign[op.sid];
    else next.assign[op.sid] = op.before;
  } else if (op.kind === 'rename') {
    if (op.before === undefined || op.before === null) delete next.renames[op.key];
    else next.renames[op.key] = op.before;
  }
  await _continentCommitRegionOverrides(next);
}

// ---------- v7.1b MoE 门控：Φ 批量归类（读内容，补「查词典」做不到的两类） ----------
// 本地词面门控（评分核心）零成本永远可用，但救不了两类：词表没列的新术语（康普顿
// 散射）、泛名/上位词（质能关系）——Φ 读「标题+摘要+公式」补这层。铁律：
// 触发不自动（打开大陆不烧调用，点了才跑）；名单固定（模型只能从给定名单选，想加
// 领域只能进「建议」待用户确认）；产物落盘带版本与内容 hash（增量重打）；判读失败
// 不写脏数据。通道复用 /api/models/chat 的 stream:false（与「问 Φ」同口径）。
const CONTINENT_GATE_API = '/api/kv/continent_gate';
const CONTINENT_GATE_BATCH = 40;
const CONTINENT_GATE_DOMINANT_SHARE = 0.35;  // 负载均衡提示线（不是硬拆）
let _continentGateCtrl = null;               // 在途批量归类的中止器（关大陆即中止）
let _continentGateSuggestions = null;        // 上次跑完的建议 {newDomains:[], merges:[{name,ids,titles}]}

// 卡片内容指纹：标题+摘要+公式变了才重打（缓存三层的 hash 一环）
function _continentGateHash(card) {
  const key = [card && card.title || '', card && card.summary || '', card && card.formula || '']
    .join('\u0001');
  return _continentStrHash(key).toString(36);
}

// 批量归类的提示词（system+user 两条都写契约——模型对最后一条更敏感，v5.3 的教训）
function _continentGateMessages(cards, domainList) {
  const list = (domainList || []).join('、');
  const lines = (cards || []).map(c =>
    '- ' + c.id + '｜' + c.title + (c.summary ? '｜' + c.summary : '') +
    (c.formula ? '｜' + c.formula : ''));
  const user = [
    '给下面每张知识卡片选 1–2 个领域（只能从给定名单里选），并给 0 到 1 的置信度。',
    '领域名单：' + list,
    '卡片：',
  ].concat(lines).concat([
    '',
    '输出严格的 JSON 数组，每项形如：{"id":"卡片id","domains":[{"name":"名单里的领域","conf":0.9}],"new":[]}',
    '某张卡在名单里找不到合适领域时：它的 domains 留空，把建议的新领域名（不超过 6 个字）放进 new 数组。',
    '如果发现几张卡讲的是同一个概念（同义或译名变体），另加一项：{"merge":{"name":"规范名","ids":["id1","id2"]}}。',
    '宁缺毋滥：拿不准就给低置信度或留空。只输出 JSON，不要任何其他文字。',
  ]).join('\n');
  return [
    { role: 'system',
      content: '你是知识大陆的门控路由器：只从给定的领域名单里选择，输出严格 JSON 数组，不要任何其他文字。' },
    { role: 'user', content: user },
  ];
}

// 判读（纯函数）：剥思考块与代码围栏 → 取首个 [ 到末个 ] 的片段 → JSON.parse →
// 名单外领域丢弃、conf 夹取、每卡至多 2 个领域、merge 组的 ids 必须都在本批内。
// 任何一步失败都返回空产物（该批保持本地归属，不写脏数据）
function _continentGateParse(raw, cardIds, domainList) {
  const out = { labels: {}, newDomains: [], merges: [] };
  const ids = new Set(cardIds || []);
  const allowed = new Set(domainList || []);
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch (e) { return out; }
  if (!Array.isArray(arr)) return out;
  arr.forEach(row => {
    if (row && typeof row === 'object' && row.merge && row.merge.name
        && Array.isArray(row.merge.ids)) {
      const mIds = row.merge.ids.map(String).filter(id => ids.has(id));
      if (mIds.length >= 2) {
        out.merges.push({ name: String(row.merge.name).trim().slice(0, 16), ids: mIds });
      }
      return;
    }
    if (!row || typeof row !== 'object' || !ids.has(String(row.id))) return;
    const doms = Array.isArray(row.domains) ? row.domains : [];
    const good = [];
    doms.slice(0, 2).forEach(d => {
      if (!d || typeof d !== 'object') return;
      const name = String(d.name || '').trim();
      if (!allowed.has(name)) return;
      let conf = Number(d.conf);
      if (!Number.isFinite(conf)) conf = 0;
      conf = Math.min(1, Math.max(0, conf));
      if (conf > 0 && !good.some(g => g.name === name)) good.push({ name: name, conf: conf });
    });
    if (good.length) out.labels[String(row.id)] = good;
    (Array.isArray(row.new) ? row.new : []).forEach(n => {
      const s = String(n || '').trim().slice(0, 16);
      if (s && !allowed.has(s) && out.newDomains.indexOf(s) < 0) out.newDomains.push(s);
    });
  });
  return out;
}

// 待打标卡片：归属缺失（domain=null）或低置信（<0.4）的岛上的卡；内容 hash 没变的
// 跳过（增量）。已有可靠归属的岛不烧调用——Φ 只补本地门控做不到的那部分
function _continentGatePendingCards(clusters, entries) {
  const out = [];
  (clusters || []).forEach(c => {
    const conf = Number(c.domainConf) || 0;
    if (c.domain && conf >= CONTINENT_CONF_LIGHT) return;
    (c.items || []).forEach(it => {
      if (!it || !it.itemId) return;
      const e = entries && entries[it.itemId];
      if (e && e.hash === _continentGateHash(it)) return;
      out.push({ id: it.itemId, title: it.title || '', summary: it.summary || '',
                 formula: String(it.formula || '').slice(0, 80) });
    });
  });
  return out;
}

// 批量归类主流程：分批（40/批）→ 每批判读 → **每批落盘**（中断不丢已完成的）→
// 全部结束刷新投影（后端把 gate KV 合进同一层分区，来源标记变「Φ 归类」）
async function _continentGateClassify() {
  // 查阅态：归类会烧模型调用并写对方的 gate KV，入口直接拦（比 fetch 闸 403 更早、提示更明白）
  if (phyIsReadonly()) { _continentToast('查阅模式：Φ 归类会写对方的归类结果，查阅态不可用'); return; }
  const data = _continentData;
  if (!data) return;
  const model = (typeof getActiveModelForRole === 'function')
    ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
  if (!model) { _continentToast('先在「模型设置」里配置主模型，Φ 才能归类'); return; }
  if (typeof proxyChatWithModel !== 'function') { _continentToast('模型代理通道不可用'); return; }
  const btn = document.getElementById('continentGateBtn');
  const setBtn = txt => { if (btn) { btn.disabled = true; btn.textContent = txt; } };
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  _continentGateCtrl = ctrl;
  try {
    // 读现有 gate KV：版本一致才沿用条目（名单/权重变了整批作废重打）
    let entries = {};
    try {
      const r = await fetch(CONTINENT_GATE_API, { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const v = j && j.value;
        if (v && typeof v === 'object' && v.version === data.gateVersion
            && v.entries && typeof v.entries === 'object') entries = v.entries;
      }
    } catch (e) { /* 读不到就当全新跑 */ }
    const pending = _continentGatePendingCards(data.clusters, entries);
    if (!pending.length) { _continentToast('没有需要 Φ 归类的卡片'); return; }
    const domainList = data.domainList || [];
    const kv = { version: data.gateVersion, entries: entries };
    const newDomains = [], merges = [];
    let done = 0, failed = 0;
    for (let i = 0; i < pending.length; i += CONTINENT_GATE_BATCH) {
      if (ctrl && ctrl.signal.aborted) break;
      const batch = pending.slice(i, i + CONTINENT_GATE_BATCH);
      setBtn('Φ 归类中 ' + Math.min(i + batch.length, pending.length) + '/' + pending.length);
      try {
        const resp = await proxyChatWithModel(model, {
          messages: _continentGateMessages(batch, domainList), stream: false,
          session_bucket: 'phymathia-continent',
        }, ctrl ? ctrl.signal : undefined);
        const j = await resp.json();
        const raw = j && j.choices && j.choices[0] && j.choices[0].message
          ? j.choices[0].message.content : '';
        const parsed = _continentGateParse(raw, batch.map(c => c.id), domainList);
        Object.keys(parsed.labels).forEach(id => {
          const card = batch.find(c => c.id === id) || {};
          kv.entries[id] = { hash: _continentGateHash(card),
                             domains: parsed.labels[id], at: Date.now() };
          done++;
        });
        parsed.newDomains.forEach(n => { if (newDomains.indexOf(n) < 0) newDomains.push(n); });
        parsed.merges.forEach(m => {
          m.titles = m.ids.map(id => {
            const card = (data.clusters || []).flatMap(c => c.items || [])
              .find(it => it.itemId === id);
            return card ? String(card.title || '') : '';
          }).filter(Boolean);
          merges.push(m);
        });
        // 每批落盘：中断后已完成的批照常保留（部分成果不丢，下次接着跑）
        await fetch(CONTINENT_GATE_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: kv }),
        });
      } catch (err) {
        if (err && err.name === 'AbortError') break;
        failed += batch.length;
      }
    }
    // 刷新投影：后端把 gate KV 合进分区，图例来源标记变「Φ 归类」
    try {
      const fresh = await _continentFetchData();
      _continentData = fresh;
      if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
    } catch (e) { /* 刷新失败不丢已落盘的产物，下次打开自然生效 */ }
    _continentGateSuggestions = (newDomains.length || merges.length)
      ? { newDomains: newDomains, merges: merges } : null;
    let msg = 'Φ 已归类 ' + done + ' 张';
    if (failed) msg += '，' + failed + ' 张失败（可再点一次重试）';
    if (_continentGateSuggestions) msg += '；有建议待你确认（图例 · 待确认）';
    _continentToast(msg);
  } finally {
    _continentGateCtrl = null;
    if (btn) { btn.disabled = false; }
    _continentUpdateTools();
  }
}

// 采纳归并建议：写进 continent_families（与内置族同一条汇聚通道——从此会积累）。
// terms 用这几张卡的标题：族匹配跑标题，同款/子串变体今后自动归族
async function _continentAdoptGateMerge(m) {
  // 查阅态：采纳会写对方的族表，入口直接拦
  if (phyIsReadonly()) { _continentToast('查阅模式：采纳归并会写对方的族表，查阅态不可用'); return; }
  const terms = [];
  (m.titles || []).forEach(t => {
    const s = String(t || '').trim().slice(0, 24);
    if (s.length >= 2 && terms.indexOf(s) < 0) terms.push(s);
  });
  if (!terms.length) { _continentToast('这条建议没有可用的术语'); return; }
  let families = [];
  try {
    const r = await fetch('/api/kv/continent_families', { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      const v = j && j.value;
      families = (v && Array.isArray(v.families)) ? v.families : (Array.isArray(v) ? v : []);
    }
  } catch (e) { /* 读不到就当空表 */ }
  const next = families.filter(f => !f || f.canonical !== m.name);
  next.push({ canonical: m.name, terms: terms, source: 'user' });
  try {
    await fetch('/api/kv/continent_families', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { families: next } }),
    });
    // 建议从清单里划掉（其余保留）
    if (_continentGateSuggestions && _continentGateSuggestions.merges) {
      _continentGateSuggestions.merges =
        _continentGateSuggestions.merges.filter(x => x !== m);
      if (!_continentGateSuggestions.merges.length && !_continentGateSuggestions.newDomains.length) {
        _continentGateSuggestions = null;
      }
    }
    const fresh = await _continentFetchData();
    _continentData = fresh;
    if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
    _continentToast('已采纳归并「' + m.name + '」——写进概念族表，从此会积累');
  } catch (err) {
    _continentToast('保存失败：' + (err && err.message || err));
  }
}

function _continentFamilySourceLabel(source) {
  if (source === 'builtin') return '内置';
  if (source === 'user') return '你指定';
  return '自定义';
}

// 术语输入解析（纯函数）：顿号/逗号/分号/空白都当分隔——用户不该去想「该用哪个分隔符」
function _continentFamilyParseTerms(text) {
  return String(text || '').split(/[、,，;；\s]+/)
    .map(t => _continentClipText(t, 24))
    .filter(t => t.length >= 2);
}

// KV 族表规范化（纯函数，与服务端 families_from_payload 同口径）：限长、去重、丢
// 无效项、总量封顶。前端先挡一层是体验（立刻报错），服务端兜底同一条尺子是纪律
function _continentFamilyNormalizeList(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach(f => {
    if (!f || typeof f !== 'object' || out.length >= CONTINENT_FAMILY_LIMIT) return;
    const canonical = _continentClipText(f.canonical, 16);
    if (!canonical) return;
    const terms = [];
    (Array.isArray(f.terms) ? f.terms : []).forEach(t => {
      const s = _continentClipText(t, 24);
      if (s.length >= 2 && terms.indexOf(s) < 0 && terms.length < CONTINENT_FAMILY_TERMS_MAX) {
        terms.push(s);
      }
    });
    if (!terms.length) return;
    out.push({ canonical: canonical, terms: terms,
               source: f.source === 'user' ? 'user' : 'custom' });
  });
  return out;
}

async function _continentLoadCorrectionCount() {
  try {
    const r = await fetch(CONTINENT_WEIGHTS_API, { cache: 'no-cache' });
    if (!r.ok) return 0;
    const j = await r.json();
    const v = j && j.value;
    return (v && Array.isArray(v.log)) ? v.log.length : 0;
  } catch (e) { return 0; }
}

// 纠正信号落盘：把岛挪出机器判断 = 一次纠正，方向（从哪个领域→到哪个领域）追加进
// KV。本期只采集 + 图例可见 + 可清空；「≥5 次同向自动微调权重」是二期，攒够真实
// 数据才接（大陆计划动工前优化④的口径）。记录失败不阻断纠正本身（纠正已生效）。
async function _continentRecordCorrection(sid, fromDomain, toDomain) {
  // 查阅态：纠正已在内存生效，只跳过信号落盘（静默——与「记录失败不阻断纠正」同口径）
  if (phyIsReadonly()) return;
  try {
    let log = [];
    try {
      const r = await fetch(CONTINENT_WEIGHTS_API, { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const v = j && j.value;
        if (v && Array.isArray(v.log)) log = v.log.slice(-499);
      }
    } catch (e) { /* 读不到就当空记录 */ }
    log.push({ from: fromDomain || null, to: toDomain || null, sid: String(sid || ''), at: Date.now() });
    const resp = await fetch(CONTINENT_WEIGHTS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { log: log } }),
    });
    if (!resp.ok) return;
    _continentCorrectionCount = log.length;
    if (_continentOpen && _continentRegionInfo) {
      _continentRenderLegend(_continentRegionInfo, _continentData);
    }
  } catch (e) { /* 信号采集失败不影响纠正本身 */ }
}

// 保存 KV 后刷新投影（与 Φ 归类收尾同一口径：刷失败不丢已落盘的产物，下次打开自然生效）
async function _continentRefreshAfterFamilies() {
  try {
    const fresh = await _continentFetchData();
    _continentData = fresh;
    if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
  } catch (e) { /* 刷新失败下次打开自然生效 */ }
}

function _continentFamilyRowHtml(f) {
  const terms = (f && f.terms) || [];
  const preview = terms.slice(0, 6).map(_continentEsc).join('、') + (terms.length > 6 ? ' …' : '');
  return '<div class="continent-family-row" data-family-canonical="' + _continentEsc(f.canonical) + '">' +
    '<div class="continent-family-line">' +
      '<span class="continent-family-name">' + _continentEsc(f.canonical) + '</span>' +
      '<span class="continent-family-src">' + _continentEsc(_continentFamilySourceLabel(f.source)) + '</span>' +
      '<span class="continent-family-terms" title="' + _continentEsc(terms.join('、')) + '">' + preview + '</span>' +
      '<button class="continent-pop-btn is-quiet" data-family-edit>改</button>' +
    '</div>' +
  '</div>';
}

// v10 补词建议行（纯函数）：词条 → 目标族 + 证据卡。机器只建议，落笔是两个按钮——
// 「收下」把词条并进族表 KV，「不要」记进拒绝 KV（证据没长出来不再提）
function _continentSuggestRowHtml(s) {
  if (!s || !s.family || !s.term) return '';
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const preview = cards.slice(0, 3).map(c => _continentEsc((c && c.title) || '')).join('、') +
    (cards.length > 3 ? ' …' : '');
  return '<div class="continent-family-row continent-family-suggest"' +
      ' data-suggest-family="' + _continentEsc(s.family) + '"' +
      ' data-suggest-term="' + _continentEsc(s.term) + '">' +
    '<div class="continent-family-line">' +
      '<span class="continent-family-name">＋' + _continentEsc(s.term) + '</span>' +
      '<span class="continent-family-src">→ ' + _continentEsc(s.family) + '</span>' +
      '<button class="continent-pop-btn" data-suggest-accept>收下</button>' +
      '<button class="continent-pop-btn is-quiet" data-suggest-reject>不要</button>' +
    '</div>' +
    '<div class="continent-family-line continent-suggest-evidence">' +
      (s.regrown ? '<span class="continent-suggest-note">上次你拒过，这次证据更多</span>' : '') +
      '<span class="continent-family-terms" title="' +
        _continentEsc(cards.map(c => (c && c.title) || '').join('、')) + '">来自 ' +
        cards.length + ' 张卡：' + preview + '</span>' +
    '</div>' +
  '</div>';
}

// ---------- v10 第二期 新族候选（无主抱团簇 → Φ 起名 → 用户裁决） ----------
// 与补词建议互斥互补：补词管「像某个已有族」的卡，这里管「哪个族都不像但彼此抱团」
// 的卡。起名是花钱的调用：点「让 Φ 起名」才调（触发不自动），结果缓存 KV，
// 一个簇（含近重复簇）只问一次。

// Φ 起名的输出契约：一行 JSON。格式约定在 system 与 user 两条消息里都写
//（与 v5.3 问 Φ 同一条纪律），判读才不是猜谜。
function _continentNameMessages(cluster, knownNames) {
  const cards = ((cluster && cluster.cards) || []).slice(0, 10);
  const known = Array.isArray(knownNames) ? knownNames : [];
  const list = cards.map((c, i) =>
    (i + 1) + '. ' + ((c && c.title) || '（无标题）') +
    ((c && c.summary) ? '——' + c.summary : '')).join('\n');
  const lines = [
    '用户的知识库里有一批知识卡：它们不属于下面任何已知领域（语义向量都离得很远），' +
    '但彼此语义相近，可能是一个花名册上还没有的新领域。',
    '',
    '已知领域名单：' + (known.length ? known.join('、') : '（空）'),
    '候选卡（共 ' + cards.length + ' 张）：',
    list,
    '',
    '请判断这批卡：',
    '- verdict=new：它们够格成一个新领域——给出规范名 name（2~8 字，像教科书章节名）' +
    '与 terms（3~6 个代表词条，出现在卡片标题里就有意义）。',
    '- verdict=merge：它们其实属于名单中某个已有领域——name 填该领域名（必须从名单里原样选），' +
    'terms 给出应补进该领域的词条。',
    '- verdict=none：证据不足，不建议建。',
    'reason 用不超过 40 字说明依据。',
  ].join('\n');
  return [
    { role: 'system', content: '你是知识大陆的助手 Φ。只输出一行 JSON，不要 markdown 代码围栏，不要解释：' +
      '{"verdict":"new|merge|none","name":"领域名","terms":["词条"],"reason":"一句话理由"}。' },
    { role: 'user', content: lines },
  ];
}

// 判读（纯函数）：剥思考块 → 抠出第一段 JSON → 校验。verdict=merge 时 name 必须
// 在已知名单里（模型编造名单外的领域一律降级为 none——专家名单固定，铁律）；
// verdict=new 但 name 与已有族撞名 → 同语义降级为 merge（词条收进已有族）。
// 判不出返回 null，调用方给「Φ 没判出来」的提示，绝不猜。
function _continentParseNameVerdict(raw, knownNames) {
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/```(?:json)?/gi, '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  let verdict = String(obj.verdict || '').trim();
  if (['new', 'merge', 'none'].indexOf(verdict) < 0) return null;
  const reason = String(obj.reason || '').trim().slice(0, 60);
  const known = Array.isArray(knownNames) ? knownNames : [];
  let name = _continentClipText(obj.name, 16);
  let terms = (Array.isArray(obj.terms) ? obj.terms : [])
    .map(t => _continentClipText(t, 24)).filter(t => t.length >= 2);
  terms = terms.filter((t, i) => terms.indexOf(t) === i).slice(0, 6);
  if (verdict === 'merge') {
    if (!name || known.indexOf(name) < 0) {
      // 编造的领域名不可信（专家名单固定）：不整条作废，降级为「证据不足」
      return { verdict: 'none', name: '', terms: [], reason: 'Φ 给的领域不在名单里' };
    }
  } else if (verdict === 'new') {
    if (!name) return null;
    if (known.indexOf(name) >= 0) {  // 撞名：它说的其实是已有族的漏
      verdict = 'merge';
    } else if (!terms.length) {
      verdict = 'none';  // 建新族却不给词条 = 没法落表
    }
  }
  return { verdict: verdict, name: name, terms: terms, reason: reason };
}

// 命名缓存命中（纯函数）：先精确 key；没有再按卡片重叠扫——同一簇长了几张新卡后
// key 会变，但只要与某条已命名簇的重叠 ≥ 六成，就复用旧判读（一个簇一辈子只烧
// 一次 API 钱）。命中返回缓存的判读，未命中 null。
function _continentClusterCacheHit(cluster, named) {
  if (!cluster || !named || typeof named !== 'object') return null;
  const exact = named[cluster.key];
  if (exact && exact.verdict) return exact;
  const ids = ((cluster.cards) || []).map(c => (c && c.id) || '');
  if (!ids.length) return null;
  const idSet = new Set(ids);
  for (const k in named) {
    const entry = named[k];
    const cachedIds = (entry && Array.isArray(entry.cards)) ? entry.cards : null;
    if (!cachedIds || !entry.verdict) continue;
    const shared = cachedIds.filter(cid => idSet.has(cid)).length;
    if (shared * 10 >= Math.min(cachedIds.length, ids.length) * 6) return entry;
  }
  return null;
}

// 新族候选行（纯函数）：三种态——未起名（让 Φ 起名按钮）/ 已判 new（建族/不要）/
// 已判 merge 或 none（处置提示）。全部插值过 _continentEsc。
function _continentClusterRowHtml(cluster, namedEntry, dismissed) {
  if (!cluster || !Array.isArray(cluster.cards) || !cluster.cards.length) return '';
  const preview = cluster.cards.slice(0, 3)
    .map(c => _continentEsc((c && c.title) || '')).join('、') +
    (cluster.size > 3 ? ' …' : '');
  const regrown = dismissed && dismissed.cards != null &&
    cluster.size > Number(dismissed.cards) + 2;
  const head = '<div class="continent-family-line">' +
      '<span class="continent-family-name">疑似新领域 · ' + cluster.size + ' 个聚落</span>' +
      (regrown ? '<span class="continent-suggest-note">上次你拒过，这次证据更多</span>' : '') +
      '<button class="continent-pop-btn is-quiet" data-cluster-dismiss>不要</button>' +
    '</div>' +
    '<div class="continent-family-line continent-suggest-evidence">' +
      '<span class="continent-family-terms" title="' +
        _continentEsc(cluster.cards.map(c => (c && c.title) || '').join('、')) + '">来自：' +
        preview + '</span>' +
    '</div>';
  const body = namedEntry && namedEntry.verdict
    ? (namedEntry.verdict === 'new'
        ? '<div class="continent-family-line">' +
            '<span class="continent-family-name">Φ 提议：' + _continentEsc(namedEntry.name) + '</span>' +
            '<span class="continent-family-terms">' +
              _continentEsc((namedEntry.terms || []).join('、')) + '</span>' +
            '<button class="continent-pop-btn" data-cluster-create>建族</button>' +
          '</div>' +
          '<div class="continent-family-line continent-suggest-evidence">' +
            '<span class="continent-pop-phi-badge is-worth">Φ</span>' +
            '<span class="continent-family-terms">' + _continentEsc(namedEntry.reason || '') + '</span>' +
          '</div>'
        : namedEntry.verdict === 'merge'
          ? '<div class="continent-family-line">' +
              '<span class="continent-family-name">＋' + _continentEsc((namedEntry.terms || []).join('、')) + '</span>' +
              '<span class="continent-family-src">→ ' + _continentEsc(namedEntry.name) + '</span>' +
              '<button class="continent-pop-btn" data-cluster-merge>收下</button>' +
            '</div>' +
            '<div class="continent-family-line continent-suggest-evidence">' +
              '<span class="continent-pop-phi-badge">Φ</span>' +
              '<span class="continent-family-terms">' +
                _continentEsc('Φ 认为这是「' + namedEntry.name + '」的漏：' + (namedEntry.reason || '')) +
              '</span>' +
            '</div>'
          : '<div class="continent-family-line continent-suggest-evidence">' +
              '<span class="continent-pop-phi-badge">Φ</span>' +
              '<span class="continent-family-terms">Φ：证据不足' +
                (namedEntry.reason ? '——' + _continentEsc(namedEntry.reason) : '') + '</span>' +
            '</div>')
    : '<div class="continent-family-line">' +
        '<button class="continent-pop-btn" data-cluster-name>让 Φ 起名</button>' +
        '<span class="continent-family-terms">起名是 AI 调用（一次一条，结果会记住）</span>' +
      '</div>';
  return '<div class="continent-family-row continent-family-suggest"' +
      ' data-cluster-key="' + _continentEsc(cluster.key) + '">' + head + body + '</div>';
}

async function _continentFamilyPopover(ev) {
  let merged = [];
  let limit = CONTINENT_FAMILY_LIMIT;
  try {
    const r = await fetch(CONTINENT_FAMILIES_API, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      merged = (j && Array.isArray(j.families)) ? j.families : [];
      limit = (j && j.limit) || limit;
    }
  } catch (e) { /* 拉不到就只渲染 KV 侧（查空是正常路径） */ }
  let kvList = [];
  try {
    const r = await fetch(CONTINENT_FAMILIES_KV_API, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      const v = j && j.value;
      kvList = _continentFamilyNormalizeList(
        (v && Array.isArray(v.families)) ? v.families : (Array.isArray(v) ? v : []));
    }
  } catch (e) { /* 读不到就当空表 */ }
  const builtinCount = merged.filter(f => f.source === 'builtin').length;
  const esc = _continentEsc;
  const html =
    '<div class="continent-pop-title">概念族表（' + merged.length + ' / 上限 ' + limit + '）</div>' +
    '<div class="continent-pop-desc">族是 ❖ 联运港与海域的证据来源：卡片标题或岛名命中术语、且跨 ≥2 座岛，' +
    '就会设起一座 ❖ 联运港、聚进同一片海域。内置 ' + builtinCount + ' 族是底线；你保存过的族以内表为准。' +
    '保存后地图自动重算（名单变了，旧 Φ 打标自动作废重打）。</div>' +
    '<div class="continent-family-list" data-family-list>' +
      merged.map(f => _continentFamilyRowHtml(f)).join('') +
    '</div>' +
    '<div data-suggest-section></div>' +
    '<div data-cluster-section></div>' +
    '<div class="continent-pop-title" style="margin-top:8px">新增族</div>' +
    '<div class="continent-family-editor">' +
      '<div class="continent-pop-row"><input class="continent-pop-input" data-family-new-name maxlength="16" placeholder="族名（如：分析力学）"></div>' +
      '<div class="continent-pop-row"><input class="continent-pop-input" data-family-new-terms placeholder="术语，用顿号或空格隔开（如：拉格朗日方程、哈密顿）"></div>' +
      '<div class="continent-pop-actions"><button class="continent-pop-btn" data-family-new-save>新增族</button></div>' +
    '</div>' +
    '<div class="continent-pop-title" style="margin-top:8px">归类纠正记录</div>' +
    '<div class="continent-pop-desc">已记录 <b>' + _continentCorrectionCount + '</b> 次纠正（你把岛挪出机器判断的方向）——' +
    '这是将来「自动微调领域判断」的依据；现在只记录，不动地图。</div>' +
    (_continentCorrectionCount
      ? '<div class="continent-pop-actions"><button class="continent-pop-btn is-danger" data-correction-clear>清空记录</button></div>'
      : '');
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;

  const persist = async next => {
    // 查阅态：族表写（新增/编辑/删除/收下建议）一律拦下，抛错让各调用方的 catch
    // 给出对应措辞（保存失败/删除失败），绝不在对方账号落盘
    if (phyIsReadonly()) throw new Error('查阅模式：修改不保存');
    const resp = await fetch(CONTINENT_FAMILIES_KV_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { families: next } }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    await _continentRefreshAfterFamilies();
    _continentToast('族表已保存，地图已重算');
    _continentFamilyPopover(ev);  // 重开弹层：重拉合并视图，行内编辑态归零
  };

  // v10 补词建议（语义找亲）：收下 = 词条并进该族走 persist（与手动加词同一条 KV
  // 通道）；不要 = 记进拒绝 KV——服务端证据没长出来就不再算这条建议（防骚扰）。
  // 记录失败不阻断「收下」本身（词条已落族表），只影响「不再提」的记性。
  const acceptSuggestion = async s => {
    const fam = merged.find(f => f.canonical === s.family);
    const kvIdx = kvList.findIndex(f => f.canonical === s.family);
    let terms;
    if (kvIdx >= 0) terms = kvList[kvIdx].terms.slice();
    else if (fam) terms = (fam.terms || []).slice();
    else { _continentToast('找不到目标族了——地图刷新后重试'); return; }
    if (terms.indexOf(s.term) < 0) terms.push(s.term);
    const entry = { canonical: s.family,
                    terms: terms.slice(0, CONTINENT_FAMILY_TERMS_MAX), source: 'user' };
    let next = kvList.slice();
    if (kvIdx >= 0) next[kvIdx] = entry; else next = next.concat([entry]);
    if (next.length > CONTINENT_FAMILY_LIMIT) { _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return; }
    try { await persist(next); } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
  };
  const rejectSuggestion = async s => {
    // 查阅态：拒绝记录要写对方的 KV，直接拦
    if (phyIsReadonly()) { _continentToast('查阅模式：拒绝记录不会写进对方账号'); return; }
    try {
      let state = {};
      try {
        const r = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, { cache: 'no-cache' });
        if (r.ok) {
          const j = await r.json();
          const v = j && j.value;
          if (v && typeof v === 'object') state = v;
        }
      } catch (e) { /* 读不到就当空记录 */ }
      const rejected = (state.rejected && typeof state.rejected === 'object')
        ? state.rejected : (state.rejected = {});
      const famRej = (rejected[s.family] && typeof rejected[s.family] === 'object')
        ? rejected[s.family] : (rejected[s.family] = {});
      famRej[s.term] = { cards: ((s.cards || []).length), at: Date.now() };
      const resp = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: Object.assign({ version: 1 }, state) }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      _continentToast('已记住：这条建议不再提（证据明显变多时会再问一次）');
      _continentFamilyPopover(ev);  // 重开弹层：建议区按最新拒绝记录重算
    } catch (err) { _continentToast('记录失败：' + (err && err.message || err)); }
  };

  // ---------- v10 第二期：新族候选（无主抱团簇） ----------
  // 状态三件套都落 KV continent_family_suggestions：named=Φ 判读缓存（一个簇只烧
  // 一次 API），dismissed=用户拒过的簇（证据没长出来不再端上来）。命名/建族都是
  // 用户点出来的：触发不自动，落笔不自动。
  const loadSuggestState = async () => {
    try {
      const r = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, { cache: 'no-cache' });
      if (!r.ok) return {};
      const j = await r.json();
      const v = j && j.value;
      return (v && typeof v === 'object') ? v : {};
    } catch (e) { return {}; }
  };
  const saveSuggestState = async state => {
    // 查阅态：候选状态（named/dismissed）落 KV 拦下，抛错走调用方 catch
    if (phyIsReadonly()) throw new Error('查阅模式：修改不保存');
    const resp = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: Object.assign({ version: 1 }, state) }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
  };
  // 族表 KV 的当下快照（写前重读用）：闭包里的 kvList 是弹层打开时的，直接拼会
  // 覆盖期间别处落笔的族。规范化走同一把 _continentFamilyNormalizeList 尺子。
  const _continentFetchKvFamilies = async () => {
    try {
      const r = await fetch(CONTINENT_FAMILIES_KV_API, { cache: 'no-cache' });
      if (!r.ok) return kvList;
      const j = await r.json();
      const v = j && j.value;
      return _continentFamilyNormalizeList(
        (v && Array.isArray(v.families)) ? v.families : (Array.isArray(v) ? v : []));
    } catch (e) { return kvList; }
  };
  const knownNames = merged.map(f => f.canonical);
  const bindClusterRows = box => {
    box.querySelectorAll('.continent-family-suggest[data-cluster-key]').forEach(row => {
      const key = row.getAttribute('data-cluster-key');
      const cluster = clusterList.find(c => c && c.key === key);
      if (!cluster) return;
      const nameBtn = row.querySelector('[data-cluster-name]');
      const createBtn = row.querySelector('[data-cluster-create]');
      const mergeBtn = row.querySelector('[data-cluster-merge]');
      const dismissBtn = row.querySelector('[data-cluster-dismiss]');
      if (nameBtn) nameBtn.addEventListener('click', async e => {
        e.stopPropagation();
        // 查阅态：起名要烧模型调用并写对方的候选缓存，入口直接拦
        if (phyIsReadonly()) { _continentToast('查阅模式：Φ 起名会写对方的候选记录，查阅态不可用'); return; }
        const model = (typeof getActiveModelForRole === 'function')
          ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
        if (!model) { _continentToast('先在「模型设置」里配置主模型，才能让 Φ 起名'); return; }
        nameBtn.disabled = true; nameBtn.textContent = 'Φ 看着…';
        try {
          if (typeof proxyChatWithModel !== 'function') throw new Error('模型代理通道不可用');
          const resp = await proxyChatWithModel(model, {
            messages: _continentNameMessages(cluster, knownNames),
            stream: false,
            session_bucket: 'phymathia-continent',
          });
          const data = await resp.json();
          const raw = data && data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content : '';
          const verdict = _continentParseNameVerdict(raw, knownNames);
          if (!verdict) throw new Error('Φ 的回答没认出来，可再试一次');
          const state = await loadSuggestState();
          const named = (state.named && typeof state.named === 'object')
            ? state.named : (state.named = {});
          named[cluster.key] = Object.assign({}, verdict, {
            at: Date.now(), cards: cluster.cards.map(c => c.id),
          });
          await saveSuggestState(state);
          renderClusterSection(box, state);  // 就地重渲：不重开弹层、不重拉建议
          bindClusterRows(box);  // 重渲换掉了 DOM，落笔按钮必须重新挂 handler
        } catch (err) {
          _continentToast('Φ 起名失败：' + (err && err.message || err));
          nameBtn.disabled = false; nameBtn.textContent = '让 Φ 起名';
        }
      });
      if (createBtn) createBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const state = await loadSuggestState();
        const entry = _continentClusterCacheHit(cluster, state.named);
        if (!entry || entry.verdict !== 'new') return;
        // 写前重读 KV：闭包里的 kvList 是弹层打开时的快照，直接拼会覆盖期间
        // 别处落笔的族（先后两次保存，后者必须以前者为基础）
        const freshKvList = await _continentFetchKvFamilies();
        if (freshKvList.some(f => f.canonical === entry.name)) {
          _continentToast('已有同名族——收下词条走「收下」按钮'); return;
        }
        if (freshKvList.length >= CONTINENT_FAMILY_LIMIT) {
          _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return;
        }
        try {
          await persist(freshKvList.concat([{
            canonical: entry.name,
            terms: (entry.terms || []).slice(0, CONTINENT_FAMILY_TERMS_MAX),
            source: 'user',
          }]));
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      });
      if (mergeBtn) mergeBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const state = await loadSuggestState();
        const entry = _continentClusterCacheHit(cluster, state.named);
        if (!entry || entry.verdict !== 'merge') return;
        const freshKvList = await _continentFetchKvFamilies();
        const kvIdx = freshKvList.findIndex(f => f.canonical === entry.name);
        const fam = merged.find(f => f.canonical === entry.name);
        let terms;
        if (kvIdx >= 0) terms = freshKvList[kvIdx].terms.slice();
        else if (fam) terms = (fam.terms || []).slice();
        else { _continentToast('找不到目标族了——地图刷新后重试'); return; }
        (entry.terms || []).forEach(t => { if (terms.indexOf(t) < 0) terms.push(t); });
        const nextEntry = { canonical: entry.name,
                            terms: terms.slice(0, CONTINENT_FAMILY_TERMS_MAX), source: 'user' };
        let next = freshKvList.slice();
        if (kvIdx >= 0) next[kvIdx] = nextEntry; else next = next.concat([nextEntry]);
        if (next.length > CONTINENT_FAMILY_LIMIT) {
          _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return;
        }
        try { await persist(next); } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      });
      if (dismissBtn) dismissBtn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const state = await loadSuggestState();
          const dismissed = (state.dismissed && typeof state.dismissed === 'object')
            ? state.dismissed : (state.dismissed = {});
          dismissed[cluster.key] = { cards: cluster.size, at: Date.now() };
          await saveSuggestState(state);
          _continentToast('已记住：这个候选不再提（证据明显变多时会再问一次）');
          renderClusterSection(box, state);
          bindClusterRows(box);  // 重渲换掉了 DOM，按钮必须重新挂 handler
        } catch (err) { _continentToast('记录失败：' + (err && err.message || err)); }
      });
    });
  };
  const renderClusterSection = (box, state) => {
    const named = (state && state.named && typeof state.named === 'object') ? state.named : {};
    const dismissed = (state && state.dismissed && typeof state.dismissed === 'object') ? state.dismissed : {};
    const rows = clusterList.filter(c => {
      if (!c || !c.key) return false;
      const d = dismissed[c.key];
      // 拒过的簇闭嘴（防骚扰），证据长出 2+ 张才重新开口（与补词同一记性口径）
      if (d && c.size <= Number(d.cards || 0) + 2) return false;
      return true;
    }).map(c => _continentClusterRowHtml(c, _continentClusterCacheHit(c, named),
                                         dismissed[c.key])).join('');
    box.innerHTML = rows
      ? '<div class="continent-pop-title" style="margin-top:8px">新领域候选</div>' +
        '<div class="continent-pop-desc">这些卡不属于任何已知领域，但彼此抱团——可能是一个' +
        '花名册上还没有的新领域。让 Φ 提个名，你裁决；机器不会自己落笔。</div>' + rows
      : '';
  };

  // 行内编辑：点「改」→ 该行换成词条编辑器（芯片可删 + 输入可加 + 保存/取消/删除）。
  // 绑定按行闭包：取消/保存后行内 HTML 会换掉，bindRow 必须对新内容重绑一次
  const enterEdit = (row, fam) => {
    const kvIdx = kvList.findIndex(f => f.canonical === fam.canonical);
    const working = (kvIdx >= 0 ? kvList[kvIdx].terms.slice() : fam.terms.slice());
    const render = () => {
      row.innerHTML =
        '<div class="continent-family-line">' +
          '<span class="continent-family-name">' + _continentEsc(fam.canonical) + '</span>' +
          '<span class="continent-family-src">' + _continentEsc(_continentFamilySourceLabel(fam.source)) + '</span>' +
        '</div>' +
        '<div class="continent-family-chips">' +
          working.map((t, i) =>
            '<span class="continent-family-chip">' + _continentEsc(t) +
            '<button data-term-del="' + i + '" title="删除这个词条" aria-label="删除词条">×</button></span>').join('') +
        '</div>' +
        (fam.source === 'builtin' && kvIdx < 0
          ? '<div class="continent-pop-desc">内置族：保存后以你改的名单覆盖内置表（源标记变「你指定」）。</div>' : '') +
        '<div class="continent-pop-row"><input class="continent-pop-input" data-term-add maxlength="24" placeholder="加词条（≥2 字，出现在标题里就有意义）"></div>' +
        '<div class="continent-pop-actions">' +
          '<button class="continent-pop-btn" data-term-save>保存</button>' +
          '<button class="continent-pop-btn is-quiet" data-term-cancel>取消</button>' +
          (kvIdx >= 0 ? '<button class="continent-pop-btn is-danger" data-term-remove>删除这个族</button>' : '') +
        '</div>';
      row.querySelectorAll('[data-term-del]').forEach(del =>
        del.addEventListener('click', ev2 => {
          ev2.stopPropagation();
          working.splice(Number(del.getAttribute('data-term-del')), 1);
          render();
        }));
      const addInput = row.querySelector('[data-term-add]');
      const addTerm = () => {
        const terms = _continentFamilyParseTerms(addInput ? addInput.value : '');
        if (!terms.length) { _continentToast('词条至少要 2 个字'); return; }
        terms.forEach(t => { if (working.indexOf(t) < 0) working.push(t); });
        if (working.length > CONTINENT_FAMILY_TERMS_MAX) working.length = CONTINENT_FAMILY_TERMS_MAX;
        render();
      };
      if (addInput) {
        addInput.addEventListener('pointerdown', ev2 => ev2.stopPropagation());
        addInput.addEventListener('keydown', ev2 => { if (ev2.key === 'Enter') addTerm(); });
      }
      row.querySelectorAll('[data-term-save]').forEach(b2 => b2.addEventListener('click', async ev2 => {
        ev2.stopPropagation();
        if (!working.length) { _continentToast('至少要留一个词条'); return; }
        const next = kvList.slice();
        next[(kvIdx >= 0 ? kvIdx : next.length)] =
          { canonical: fam.canonical, terms: working.slice(0, CONTINENT_FAMILY_TERMS_MAX), source: 'user' };
        if (next.length > CONTINENT_FAMILY_LIMIT) { _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return; }
        try { await persist(next); } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      }));
      row.querySelectorAll('[data-term-cancel]').forEach(b2 => b2.addEventListener('click', ev2 => {
        ev2.stopPropagation();
        row.innerHTML = _continentFamilyRowHtml(fam);
        bindRow(row);
      }));
      row.querySelectorAll('[data-term-remove]').forEach(b2 => b2.addEventListener('click', async ev2 => {
        ev2.stopPropagation();
        try {
          await persist(kvList.filter((_, i) => i !== kvIdx));
          _continentToast(fam.source === 'builtin' ? '已删除覆盖，内置词条恢复' : '已删除这个族');
        } catch (err) { _continentToast('删除失败：' + (err && err.message || err)); }
      }));
      const focusAdd = row.querySelector('[data-term-add]');
      if (focusAdd && focusAdd.focus) { try { focusAdd.focus(); } catch (err) { /* 容忍 */ } }
    };
    render();
  };
  const bindRow = row => {
    const btn = row.querySelector('[data-family-edit]');
    if (!btn) return;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fam = merged.find(f => f.canonical === row.getAttribute('data-family-canonical'));
      if (fam) enterEdit(row, fam);
    });
  };
  el.querySelectorAll('.continent-family-row').forEach(bindRow);

  // v10 补词建议区 + 新领域候选区：弹层先开，两者异步补进来（首算可能含模型加载，
  // 别让弹层干等）。embedEnabled=False（缺模型/缺依赖）或没有候选 → 区块保持空白
  // （查空是正常路径）。补词建议拉一次；新领域候选另需 KV 里的命名/拒绝状态。
  const suggBox = el.querySelector('[data-suggest-section]');
  const clusterBox = el.querySelector('[data-cluster-section]');
  let clusterList = [];
  if (suggBox) {
    try {
      const r = await fetch(CONTINENT_FAMILY_SUGGEST_API, { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const sugs = (j && j.embedEnabled && Array.isArray(j.suggestions)) ? j.suggestions : [];
        clusterList = (j && j.embedEnabled && Array.isArray(j.clusters)) ? j.clusters : [];
        if (sugs.length) {
          suggBox.innerHTML =
            '<div class="continent-pop-title" style="margin-top:8px">补词建议</div>' +
            '<div class="continent-pop-desc">这些卡闻起来像某个领域，标题里却没有它的词条——' +
            '多半是族表漏了词。收下后词条进族表，同类卡从此自动归对；不收就一直躺着。</div>' +
            sugs.map(_continentSuggestRowHtml).join('');
          suggBox.querySelectorAll('.continent-family-suggest').forEach(row => {
            const fam = row.getAttribute('data-suggest-family');
            const term = row.getAttribute('data-suggest-term');
            const s = sugs.find(x => x && x.family === fam && x.term === term);
            if (!s) return;
            const acceptBtn = row.querySelector('[data-suggest-accept]');
            const rejectBtn = row.querySelector('[data-suggest-reject]');
            if (acceptBtn) acceptBtn.addEventListener('click', async e => {
              e.stopPropagation();
              await acceptSuggestion(s);
            });
            if (rejectBtn) rejectBtn.addEventListener('click', async e => {
              e.stopPropagation();
              await rejectSuggestion(s);
            });
          });
        }
      }
    } catch (e) { /* 建议拉不到就当没有（查空是正常路径） */ }
  }
  if (clusterBox && clusterList.length) {
    const state = await loadSuggestState();
    renderClusterSection(clusterBox, state);
    bindClusterRows(clusterBox);
  }

  // 新增族
  const newName = el.querySelector('[data-family-new-name]');
  const newTerms = el.querySelector('[data-family-new-terms]');
  const addFamily = async () => {
    const canonical = _continentClipText(newName ? newName.value : '', 16);
    const terms = _continentFamilyParseTerms(newTerms ? newTerms.value : '');
    if (!canonical || !terms.length) { _continentToast('族名和至少一个词条（≥2 字）都要有'); return; }
    if (merged.some(f => f.canonical === canonical)) { _continentToast('已有同名族——点那一行的「改」直接改它'); return; }
    if (kvList.length >= CONTINENT_FAMILY_LIMIT) { _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return; }
    try {
      await persist(kvList.concat([{ canonical: canonical, terms: terms, source: 'user' }]));
    } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
  };
  const newSave = el.querySelector('[data-family-new-save]');
  if (newSave) newSave.addEventListener('click', e => { e.stopPropagation(); addFamily(); });
  [newName, newTerms].forEach(inp => {
    if (inp) {
      inp.addEventListener('pointerdown', e => e.stopPropagation());
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') addFamily(); });
    }
  });

  // 纠正记录清空（一键复位：二期自动档的权重表也在这层）
  const clearBtn = el.querySelector('[data-correction-clear]');
  if (clearBtn) clearBtn.addEventListener('click', async e => {
    e.stopPropagation();
    // 查阅态：清空会删对方的纠正记录，入口直接拦
    if (phyIsReadonly()) { _continentToast('查阅模式：不能清空对方的纠正记录'); return; }
    try {
      const resp = await fetch(CONTINENT_WEIGHTS_API, { method: 'DELETE' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      _continentCorrectionCount = 0;
      _continentToast('纠正记录已清空');
      if (_continentOpen && _continentRegionInfo) _continentRenderLegend(_continentRegionInfo, _continentData);
      _continentFamilyPopover(ev);
    } catch (err) { _continentToast('清空失败：' + (err && err.message || err)); }
  });
}

