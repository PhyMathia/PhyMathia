// ===== 知识大陆 · 细节探索（城市重逢清单/问 Φ/折叠清单/搜索与跳转）=====
// 自 graph-continent.js 拆出（2026-10-04，T36）。顶层经典脚本共享全局，顺序见 scripts/build_frontend.mjs。
// 该岛命中这条共享概念的全部卡（服务端未给 owners 时退回代表卡一张）
function _continentIslandCards(entry, sessionId, fallbackItemId, idx) {
  const owners = (entry && entry.owners) || [];
  const itemSession = (idx && idx.itemSession) || {};
  const mine = owners.filter(iid => itemSession[iid] === sessionId);
  if (!mine.length) return fallbackItemId ? [fallbackItemId] : [];
  const rep = mine.indexOf(fallbackItemId);
  if (rep > 0) { mine.splice(rep, 1); mine.unshift(fallbackItemId); }  // 代表卡排最前（辐条连的就是它）
  return mine;
}

// 重逢清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentReunionRows(city, idx) {
  const items = (idx && idx.items) || {};
  const clusterTitles = (idx && idx.clusterTitles) || {};
  const itemCreated = (idx && idx.itemCreated) || {};
  const rel = (idx && idx.rel) || _continentRelTime;
  const rows = [];
  ((city && city.reps) || []).forEach(r => {
    const sid = r.sessionId;
    const cards = _continentIslandCards(city && city.entry, sid, r.itemId, idx);
    cards.forEach((iid, k) => {
      const when = rel(itemCreated[iid]);
      const head = k === 0
        ? '<span class="continent-pop-place">' + _continentEsc(clusterTitles[sid] || '已删除的画布') + '</span> · '
        : '<span class="continent-pop-sub">同岛还有</span> ';
      rows.push('<div class="continent-pop-row' + (k === 0 ? '' : ' is-sub') + '">' +
        '<span class="continent-pop-row-text">' + head + _continentEsc(items[iid] || '（概念已不在）') +
        (when ? '<span class="continent-pop-when">' + _continentEsc(when) + '</span>' : '') +
        '</span>' +
        '<button class="continent-pop-btn" data-go="' + _continentEsc(sid) + '"' +
        ' data-item="' + _continentEsc(iid) + '">去看</button>' +
        '</div>');
    });
  });
  return rows.join('');
}

function _continentCityPopover(city, ev) {
  const idx = _continentItemIndex();
  const s = (city && city.entry) || {};
  const reps = (city && city.reps) || [];
  const rows = _continentReunionRows(city, idx);
  // 「画成航线」= v3 起的用户确认落笔口（Φ 只会口头建议，真要写边得你点）。
  // 一枚芯片 = 一条链路（两块画布的代表卡之间）；已连过的只标「已连线」。
  const links = (s.links || []).slice(0, 6);
  const userEdges = (_continentData && _continentData.userEdges) || [];
  const chips = links.map((link, i) => {
    const already = userEdges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(idx.clusterTitles[link.fromSession] || '已删除的画布');
    const b = _continentEsc(idx.clusterTitles[link.toSession] || '已删除的画布');
    return '<button class="continent-pop-btn is-quiet" data-link="' + i + '"' +
      ' title="把两座岛的代表卡连成一条我的航线">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  const html =
    '<div class="continent-pop-title">' + _continentKindPrefix(s.kind) + _continentEsc(s.label || '') +
    '<span class="continent-pop-count">' + reps.length + ' 块画布</span></div>' +
    (rows || '<div class="continent-pop-desc">这座联运港连通的聚落已不在大陆上了。</div>') +
    '<div class="continent-pop-desc">' +
    (s.kind === 'formula'
      ? '这几块画布的公式共享结构「' + _continentEsc(s.label || '') + '」'
      : (s.kind === 'family'
        ? '这几块画布同属概念族「' + _continentEsc(s.label || '') + '」（领域知识层认出的同族关系）'
        : '这几块画布的概念标题共享「' + _continentEsc(s.label || '') + '」')) +
    '——机器检出的共享点不会自动连线。</div>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '');
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-go]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const sid = btn.getAttribute('data-go');
    const iid = btn.getAttribute('data-item');
    _continentClosePopover();
    enterContinentSession(sid, iid);   // 复用下钻转场 + goToKnowledgeNode 直达定位
  }));
  el.querySelectorAll('[data-link]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const link = links[Number(btn.getAttribute('data-link'))];
    if (!link) return;
    try {
      const ok = await _continentAddUserEdge(link.from, link.to, s.label);
      if (ok) { _continentClosePopover(); _continentToast('已画上这条航线'); }
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
}

// v4 折叠清单：没画到地图上的那些在这里照报，逐条可确认并亲手落笔。
// 原因口径见 CONTINENT_FOLD_REASON（v5.1 起四种，v5.5 加第五种「已被更具体的城市
// 覆盖」：弱证据 / 覆盖 / 超每对上限 / 超全图上限 / 无位可放）。地图负责概览，
// 清单负责穷尽——谁也不伪装成对方，更不许静默消失。

// ---------- v5.3 问 Φ：机器没把握的，交给 Φ 说一句人话，落笔权永远在用户 ----------
// 通道取舍：走 /api/models/chat 的 stream:false（与知识摘要优化同一口径），模型选
// Φ 助手槽位（graph，未配置回退主模型）——/api/harness 的评审协议是改图导向
// （messages 按评审/扩展/应用四套固定模板组装、输出走操作白名单），没有裸问答口，
// 折叠行的「两条知识点是否真相关」判断用它反而要绕开整套操作协议。
// 提示词、判读、判断块拼装都是纯函数（无 DOM），单独抽出来给 smoke 断言。

// Φ 必须以「值得连：」或「不建议连：」开头——输出契定了，判读才不是猜谜。
// 格式约定在 system 与 user 两条消息里都写（模型对最后一条更敏感）。
function _continentPhiMessages(left, right, label) {
  const lines = [
    '用户在知识大陆的折叠清单里看到一条机器没把握的跨画布联系，请你判断这两条知识点是否真的相关（值得在地图上画一条连线），还是只是字面相撞。',
    '',
    '共享词：' + (label || '（无）'),
    '第一条：' + ((left && left.title) || '（无标题）') + ((left && left.summary) ? '——' + left.summary : ''),
    '第二条：' + ((right && right.title) || '（无标题）') + ((right && right.summary) ? '——' + right.summary : ''),
    '',
    '注意：共享词可能是「表达」「坐标」这类通用词，判断依据是两条知识的实质内容，不是共享词本身。',
    '只输出一行：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。',
  ].join('\n');
  return [
    { role: 'system', content: '你是知识大陆的助手 Φ。只输出一行判断：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。不要输出任何其他内容。' },
    { role: 'user', content: lines },
  ];
}

// 判读：只认第一行的开头两个约定词；判不出给中性档——判读只影响徽标与语气，
// 芯片（用户落笔口）两种档位都照给。
function _continentPhiVerdict(raw) {
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/<[^>]+>/g, ' ').replace(/\*\*/g, '');
  const firstLine = (text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
  let verdict = 'unknown';
  if (firstLine.indexOf('值得连') === 0) verdict = 'worth';
  else if (firstLine.indexOf('不建议连') === 0) verdict = 'not';
  const reason = firstLine.replace(/^[「『"']?(值得连|不建议连)[」』"']?[：:、]?\s*/, '').trim();
  return { verdict: verdict, text: (reason || firstLine).slice(0, 120) };
}

// 判断块 HTML：徽标（三档）+ 理由 + 每条链路一枚「画成航线」芯片（已连线只标注）。
// userEdges 由调用方传入（smoke 不依赖模块状态）。
function _continentPhiBlockHtml(entry, verdict, idx, userEdges) {
  const items = (idx && idx.items) || {};
  const edges = userEdges || [];
  const worth = verdict && verdict.verdict === 'worth';
  const not = verdict && verdict.verdict === 'not';
  const badge = worth ? '值得连' : not ? '不建议连' : 'Φ 的判断';
  const links = ((entry && entry.links) || []).slice(0, 6);
  const chips = links.map((link, i) => {
    const already = edges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(items[link.from] || '？');
    const b = _continentEsc(items[link.to] || '？');
    return '<button class="continent-pop-btn is-quiet" data-phi-link="' + i + '"' +
      ' title="把这两个概念连成一条我的航线（Ctrl+Z 可撤销）">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  return '<div class="continent-pop-phi">' +
    '<span class="continent-pop-phi-badge' + (worth ? ' is-worth' : '') + (not ? ' is-not' : '') + '">' + badge + '</span> ' +
    '<span class="continent-pop-phi-text">' + _continentEsc((verdict && verdict.text) || '') + '</span>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '') +
    '</div>';
}

// 芯片点击 = 走 v2 既有落笔通道（KV continent_edges）；清单不关——折叠清单是
// 工作清单，用户要连着过好几条，这行就地变「已连线」。绑定按 dataset 防重：
// 新判断块插入后按整个弹层查询绑定，上一块的芯片不能被二次挂 handler。
function _continentBindPhiChips(scope, entry) {
  if (!scope || !scope.querySelectorAll) return;
  const links = ((entry && entry.links) || []).slice(0, 6);
  scope.querySelectorAll('[data-phi-link]').forEach(btn => {
    if (btn.dataset) {
      if (btn.dataset.phiBound) return;
      btn.dataset.phiBound = '1';
    }
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const link = links[Number(btn.getAttribute('data-phi-link'))];
      if (!link) return;
      try {
        const ok = await _continentAddUserEdge(link.from, link.to, entry.label || '');
        if (ok) {
          const span = document.createElement('span');
          span.className = 'continent-pop-note-inline';
          span.textContent = '已连线';
          if (btn.replaceWith) btn.replaceWith(span); else btn.textContent = '已连线';
          _continentToast('已画上这条航线（Ctrl+Z 可撤销）');
        }
      } catch (err) {
        _continentToast('保存失败：' + (err && err.message || err));
      }
    });
  });
}

// 单行「问 Φ」：按钮进忙碌态 → /api/models/chat（stream:false）→ 判断块插到该行
// 下方。弹层已换页/关闭时回包静默丢弃（判断没处落）；失败恢复按钮可重问。
async function _continentAskPhi(f, rowIndex, btn) {
  const entry = (f && f.entry) || {};
  const link = (entry.links || [])[0] || {};
  const idx = _continentItemIndex();
  const model = (typeof getActiveModelForRole === 'function')
    ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
  if (!model) { _continentToast('先在「模型设置」里配置主模型，才能问 Φ'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Φ 看着…'; }
  const popover = _continentPopover;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (ctrl) _continentPhiInflight.add(ctrl);
  try {
    const left = { title: idx.items[link.from] || '', summary: idx.itemSummary[link.from] || '' };
    const right = { title: idx.items[link.to] || '', summary: idx.itemSummary[link.to] || '' };
    if (typeof proxyChatWithModel !== 'function') throw new Error('模型代理通道不可用');
    const resp = await proxyChatWithModel(model, {
      messages: _continentPhiMessages(left, right, entry.label || ''),
      stream: false,
      session_bucket: 'phymathia-continent',
    }, ctrl ? ctrl.signal : undefined);
    const data = await resp.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    if (!popover || _continentPopover !== popover) return;  // 弹层已关/换页
    const v = _continentPhiVerdict(raw);
    const row = popover.querySelector ? popover.querySelector('[data-fold="' + rowIndex + '"]') : null;
    const html = _continentPhiBlockHtml(entry, v, idx, (_continentData && _continentData.userEdges) || []);
    if (row && row.insertAdjacentHTML) {
      row.insertAdjacentHTML('afterend', html);
    } else if (popover.insertAdjacentHTML) {
      popover.insertAdjacentHTML('beforeend', html);
    }
    _continentBindPhiChips(popover, entry);
    if (btn) { btn.textContent = 'Φ 已答'; btn.disabled = true; }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    _continentToast('Φ 判断失败：' + (err && err.message || err));
    if (btn) { btn.disabled = false; btn.textContent = '问 Φ'; }
  } finally {
    if (ctrl) _continentPhiInflight.delete(ctrl);
  }
}

// 折叠清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentFoldedRows(folded, idx) {
  const items = (idx && idx.items) || {};
  return (folded || []).map((f, i) => {
    const s = f.entry || {};
    const link = (s.links || [])[0] || {};
    return '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">' + _continentKindPrefix(s.kind) + _continentEsc(s.label) +
      ' · ' + _continentEsc(items[link.from] || '？') + ' ↔ ' + _continentEsc(items[link.to] || '？') +
      ' <span class="continent-pop-reason">' + (CONTINENT_FOLD_REASON[f.reason] || '折叠') + '</span></span>' +
      '<button class="continent-pop-btn is-quiet" data-phi="' + i + '" title="让 Φ 判断这两条是否真的相关">问 Φ</button>' +
      '<button class="continent-pop-btn" data-fold="' + i + '">看两边</button>' +
      '</div>';
  }).join('');
}

function _continentFoldedPopover(ev) {
  const idx = _continentItemIndex();
  const folded = _continentFolded || [];
  const rows = _continentFoldedRows(folded, idx);
  const html =
    '<div class="continent-pop-title">折叠 ' + folded.length + ' 条</div>' +
    '<div class="continent-pop-desc">「弱证据」是 2 字共享串（「表达」「坐标」级）与泛后缀，' +
    '单独立不住——但它照旧参与岛屿摆位；「已被更具体的联运港覆盖」是这条共享串只出现在' +
    '更具体的那几个概念名中间（如两条「…守恒定律」之间的「量守恒定律」），地图交给更' +
    '具体的那几座联运港；「超出每对上限」「超出全图上限」是地图已经画满；「无位可放」是岛之间挤不出' +
    '放得下一座联运港的位置（联运港绝不叠在岛上）。都不上地图，但照报——' +
    '拿不准就「问 Φ」，它给一句人话判断，要不要连仍由你点「画成航线」；' +
    '想让弱证据彻底消失，得修那两条标题本身。</div>' +
    rows;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-fold]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const f = folded[Number(btn.getAttribute('data-fold'))];
    if (f && f.entry) _continentSharedPopover(f.entry, ev);
  }));
  el.querySelectorAll('[data-phi]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const rowIndex = Number(btn.getAttribute('data-phi'));
    const f = folded[rowIndex];
    if (f) _continentAskPhi(f, rowIndex, btn);
  }));
}

// ---------- v7.2 航线操作：单条可调（线型/颜色/粗细/走线/锚点/显隐/备注） ----------
// 用户反馈「大陆边鸡肋：影响视觉、又不能手动调整」——调整面板就是主答。备注改成
// 内联输入（顺手收编方向候选 U1：大陆边的两处 window.prompt 清场）。

// 卡片标题优先、摘要兜底——「能量」要能搜到标题里没这两个字、但摘要讲能量的卡。
function _continentSearchNorm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
}

// T137：extras 可选第四参＝城市/海域候选（{cities:[{label,sessions}], regions:[{key,name,sessions,itemCount}]}）。
// 不传时行为逐字节不变——冻结契约不受扰；传了则城市/海域命中垫在岛/卡之后
function _continentSearchMatches(data, query, limit, extras) {
  const q = _continentSearchNorm(query);
  const out = [];
  if (!q) return out;
  const cap = Math.max(1, Number(limit) || 30);
  ((data && data.clusters) || []).forEach(c => {
    const sid = String(c.sessionId || '');
    if (_continentSearchNorm(c.title).indexOf(q) >= 0) {
      out.push({ type: 'island', sid: sid, itemId: '',
                 title: c.title || '未命名画布', sub: (c.itemCount || 0) + ' 个概念' });
    }
    (c.items || []).forEach(it => {
      const titleHit = _continentSearchNorm(it.title).indexOf(q) >= 0;
      const summaryHit = !titleHit && _continentSearchNorm(it.summary).indexOf(q) >= 0;
      if (!titleHit && !summaryHit) return;
      out.push({ type: 'item', sid: sid, itemId: String(it.itemId || ''),
                 title: it.title || '', sub: c.title || '', viaSummary: summaryHit });
    });
  });
  // 标题命中排前、摘要命中靠后；同档保持投影顺序（sort 稳定）——最重要的行在最上面
  out.sort((a, b) => (a.viaSummary ? 1 : 0) - (b.viaSummary ? 1 : 0));
  // T137：城市/海域垫底（导航目标次优先），与岛/卡一起受 cap 截断
  const x = extras || {};
  (x.cities || []).forEach(c => {
    if (_continentSearchNorm(c && c.label).indexOf(q) >= 0) {
      out.push({ type: 'city', sid: '', itemId: '', title: (c && c.label) || '',
                 sub: '联运港 · ' + ((c && c.sessions) || 0) + ' 座岛共享' });
    }
  });
  (x.regions || []).forEach(r => {
    if (_continentSearchNorm(r && r.name).indexOf(q) >= 0) {
      out.push({ type: 'region', sid: '', itemId: '', key: r.key,
                 title: (r && r.name) || '',
                 sub: '海域 · ' + ((r && r.sessions) || 0) + ' 岛 · ' + ((r && r.itemCount) || 0) + ' 卡' });
    }
  });
  return out.slice(0, cap);
}

// 命中高亮 + 结果清单（DOM）。渲染重画世界层后 is-search-hit 会丢，_continentRender
// 结尾会用同一份 _continentSearchResults 重放（搜索态跨重渲存活，与视口记忆同精神）
function _continentApplySearchHit(results, hasMore) {
  _continentSearchResults = results || [];
  _continentSearchMore = !!hasMore;
  const pop = document.getElementById('continentSearchPop');
  const world = document.getElementById('continentWorld');
  if (world && world.querySelectorAll) {
    world.querySelectorAll('.is-search-hit').forEach(el => el.classList.remove('is-search-hit'));
  }
  if (pop) {
    if (!_continentSearchResults.length) {
      pop.hidden = true;
      pop.innerHTML = '';
    } else {
      pop.innerHTML = _continentSearchResults.map((r, i) =>
        '<button class="continent-search-row" data-search-idx="' + i + '">' +
          '<span class="continent-search-row-title">' + _continentEsc(r.title) + '</span>' +
          '<span class="continent-search-row-sub">' +
            (r.type === 'item' ? _continentEsc(r.sub) : _continentEsc(r.sub)) + '</span>' +
        '</button>').join('') +
        '<div class="continent-search-foot">' +
        (_continentSearchMore
          ? _continentSearchResults.length + '+ 个结果 · 仅显示前 ' + _continentSearchResults.length +
            ' 条，试试更精确的词'
          : _continentSearchResults.length + ' 个结果 · 点行跳转' +
            (_continentSearchResults.length === 1 ? '，回车直达' : '')) + '</div>';
      pop.hidden = false;
      pop.querySelectorAll('[data-search-idx]').forEach(btn => {
        btn.addEventListener('pointerdown', e => {
          e.stopPropagation();
          const r = _continentSearchResults[Number(btn.getAttribute('data-search-idx'))];
          if (r) _continentSearchJump(r);
        });
        _kact(btn);  // T143 键盘可达
      });
    }
  }
  if (world && world.querySelectorAll) {
    _continentSearchResults.forEach(r => {
      if (r.type === 'item') {
        const el = _continentNodeEl(r.itemId);
        if (el && el.classList) el.classList.add('is-search-hit');
      } else if (r.type === 'city') {
        // T137：城市行点亮城市胶囊本体（元素早已带 data-city-label）
        const el = world.querySelector('.continent-city[data-city-label="' +
          String(r.title).replace(/"/g, '\\"') + '"]');
        if (el && el.classList) el.classList.add('is-search-hit');
      } else if (r.type === 'island') {
        const el = world.querySelector('.continent-cluster[data-session-id="' +
          String(r.sid).replace(/"/g, '\\"') + '"]');
        if (el && el.classList) el.classList.add('is-search-hit');
      }
      // region 行不打高亮：跳转本身就是反馈（镜头飞到海域）
    });
  }
}

function _continentSearchUpdate() {
  const input = document.getElementById('continentSearch');
  if (!input) return;
  const q = String(input.value || '');
  if (!q) { _continentApplySearchHit([]); return; }
  // T137：cap+1 探满（多出 1 条＝被截断，脚注明说，不再静默吞结果）；
  // 城市/海域候选从模块态现取（纯函数只吃参数，不吃模块态）
  const extras = {
    cities: ((_continentData && _continentData.shared) || []).map(s =>
      ({ label: s.label, sessions: (s.sessions || []).length })),
    regions: ((_continentRegionInfo && _continentRegionInfo.regions) || []).map(r =>
      ({ key: r.key, name: r.name, sessions: (r.sessions || []).length, itemCount: r.itemCount })),
  };
  const hits = _continentSearchMatches(_continentData, q, CONTINENT_SEARCH_LIMIT + 1, extras);
  const hasMore = hits.length > CONTINENT_SEARCH_LIMIT;
  _continentApplySearchHit(hits.slice(0, CONTINENT_SEARCH_LIMIT), hasMore);
}

function _continentSearchGo() {
  if (_continentSearchResults.length === 1) _continentSearchJump(_continentSearchResults[0]);
}

function _continentSearchJump(r) {
  _continentSearchClear();
  // T137：城市/海域行不进会话——镜头飞过去（城市点亮胶囊、海域按包围盒适配）
  if (r && r.type === 'city') { _continentSearchFocusCity(r.title); return; }
  if (r && r.type === 'region') { _continentSearchFocusRegion(r.key); return; }
  enterContinentSession(r.sid, r.itemId || '');
}

// 镜头助手（T137）：把世界点 (wx, wy) 摆到视口中心，可选换挡缩放。岛聚焦的既有数学
// 抽出来共用——两处各写一份必然漏一处
function _continentFocusWorldPoint(wx, wy, targetZoom) {
  if (!isFinite(wx) || !isFinite(wy)) return false;
  if (targetZoom !== undefined && targetZoom !== null) {
    _continentZoom = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, targetZoom));
  }
  const c = _continentCenter();
  _continentPan.x = c.x - wx * _continentZoom;
  _continentPan.y = c.y - wy * _continentZoom;
  _continentApplyTransform();
  return true;
}

// 城市直达：坐标读 style.left/top（就是世界坐标，parseFloat 'Npx'）——offsetParent 会
// 因 transform 失效、getBoundingClientRect 又吃缩放，都不如源头可靠；尺寸用常量
function _continentSearchFocusCity(label) {
  const world = document.getElementById('continentWorld');
  const el = world && world.querySelector
    ? world.querySelector('.continent-city[data-city-label="' +
        String(label).replace(/"/g, '\\"') + '"]')
    : null;
  if (!el || !el.style) return false;
  const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
  return _continentFocusWorldPoint(
    x + CONTINENT_CITY_W / 2, y + CONTINENT_CITY_H / 2,
    Math.max(_continentZoom, 0.9));
}

// 海域直达：取海域内全部岛框的包围盒适配视野（下限压在世界档之上，保证岛牌可见）
function _continentSearchFocusRegion(key) {
  const info = _continentRegionInfo;
  const region = info && info.regions ? info.regions.find(r => r.key === key) : null;
  if (!region) return false;
  const rects = (_continentClusterRects || []).filter(rc =>
    (region.sessions || []).indexOf(rc.sessionId) >= 0);
  if (!rects.length) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  rects.forEach(rc => {
    minX = Math.min(minX, rc.x); minY = Math.min(minY, rc.y);
    maxX = Math.max(maxX, rc.x + rc.w); maxY = Math.max(maxY, rc.y + rc.h);
  });
  const vp = document.getElementById('continentViewport');
  const vw = (vp && typeof vp.clientWidth === 'number' && vp.clientWidth) || 900;
  const vh = (vp && typeof vp.clientHeight === 'number' && vp.clientHeight) || 600;
  const z = Math.min(1.1, Math.max(CONTINENT_LOD_WORLD,
    Math.min(vw / (maxX - minX + 160), vh / (maxY - minY + 160))));
  return _continentFocusWorldPoint((minX + maxX) / 2, (minY + maxY) / 2, z);
}

function _continentSearchClear() {
  const input = document.getElementById('continentSearch');
  if (input && input.value) input.value = '';
  _continentApplySearchHit([]);
}

// ---------- v8 概念族表编辑（顶栏「族表」）：汇聚的证据从此可养 ----------
// 族表是 ❖ 城市与海域的证据来源（v6/v7）。此前改表只能手改 KV——编辑入口落在大
// 陆顶栏（数据面板从未存在，v7.1b 待确认清单里那句「数据面板」一并纠正）。语义沿
// v6：KV `continent_families` 覆盖内置同名族，删除 KV 覆盖即恢复内置；保存后投影
// 自动重算，名单变了旧 Φ 打标因 gateVersion 变化作废（服务端既有口径，不用重写）。
// 归类纠正记录（「从纠正中学习」第一期）也在这层清空——它们都是「大陆的自有记忆」。

