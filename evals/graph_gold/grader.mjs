// 改图金样集评分器（零依赖纯函数）。
//
// 与 scripts/harness_battery.mjs 的分工：battery 断言「operations 的形状」，
// 本评分器断言「改完之后的结果图」——同一批操作各自合法、合起来没达成指令，
// battery 全绿而这里必须红。失败按四桶归因，供优化排优先级。
//
// 四桶优先级（从最硬到最软）：protocol > scope > action > target。
// 一条用例可同时命中多桶，primary 取优先级最高者，报告另给全部失败原因分布。

export const BUCKETS = ['protocol', 'scope', 'action', 'target'];
export const BUCKET_LABELS = {
  protocol: '协议丢字段',
  scope: '范围过大',
  action: '动作选错',
  target: '目标选错',
};

const eq = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
const sub = (a, b) => String(a ?? '').includes(String(b ?? ''));

export function indexSnapshot(snap) {
  const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
  const edges = Array.isArray(snap?.edges) ? snap.edges : [];
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const byLabel = new Map();
  for (const n of nodes) {
    const k = String(n.label ?? '').trim();
    if (!k) continue;
    if (!byLabel.has(k)) byLabel.set(k, []);
    byLabel.get(k).push(n);
  }
  return { nodes, edges, byId, byLabel };
}

// 引用既可以是 id、label，也可以是 {id} / {label}；返回节点数组（同名节点全给）。
export function resolveNodes(idx, ref) {
  if (ref == null) return [];
  let id = ref;
  let label = ref;
  if (typeof ref === 'object') {
    id = ref.id;
    label = ref.label;
  }
  const out = [];
  if (id != null && idx.byId.has(String(id))) out.push(idx.byId.get(String(id)));
  const l = String(label ?? '').trim();
  if (l && idx.byLabel.has(l)) {
    for (const n of idx.byLabel.get(l)) if (!out.includes(n)) out.push(n);
  }
  return out;
}

function nodeIds(idx, ref) {
  return new Set(resolveNodes(idx, ref).map((n) => String(n.id)));
}

function edgeMatches(idx, ref, relation) {
  const from = ref?.from ?? ref?.source;
  const to = ref?.to ?? ref?.target;
  const fromIds = nodeIds(idx, from);
  const toIds = nodeIds(idx, to);
  return idx.edges.filter((e) => {
    if (fromIds.size && !fromIds.has(String(e.from))) return false;
    if (toIds.size && !toIds.has(String(e.to))) return false;
    if (relation != null && !eq(e.relation, relation)) return false;
    return true;
  });
}

function opName(op) {
  return String(op?.op ?? op?.type ?? op?.name ?? '');
}

function touchedIds(ops) {
  const ids = new Set();
  for (const op of ops) {
    for (const k of ['id', 'node_id', 'from', 'to', 'target_node_id', 'target']) {
      if (op[k] != null) ids.add(String(op[k]));
    }
    // edge_key 形如 "B:out-0->A:in-0"，两端也是被触及的节点
    if (op.edge_key) {
      const m = String(op.edge_key).match(/^([^:]+):[^>]*->([^:]+):/);
      if (m) { ids.add(m[1]); ids.add(m[2]); }
    }
  }
  return ids;
}

const fail = (bucket, msg) => ({ bucket, msg });

// 每个断言：(value, ctx) => null | failure | failure[]
const ASSERTIONS = {
  status(want, ctx) {
    const list = Array.isArray(want) ? want.map(String) : [String(want)];
    if (!list.includes(String(ctx.result?.status ?? ''))) {
      return fail('protocol', `status 期望 ${list.join('/')}，实际 ${ctx.result?.status ?? '(缺失)'}`);
    }
    return null;
  },
  ops_count(want, ctx) {
    const n = ctx.ops.length;
    const out = [];
    if (want?.min != null && n < want.min) {
      out.push(fail('protocol', `期望至少 ${want.min} 条操作，实际 ${n} 条（空输出/协议丢字段）`));
    }
    if (want?.max != null && n > want.max) {
      out.push(fail('scope', `期望至多 ${want.max} 条操作，实际 ${n} 条（范围过大）`));
    }
    return out;
  },
  op_types(want, ctx) {
    const allow = new Set(want.map(String));
    const bad = [...new Set(ctx.ops.map(opName).filter((n) => n && !allow.has(n)))];
    if (bad.length) return fail('action', `出现了不允许的操作类型：${bad.join(', ')}`);
    return null;
  },
  scope_allow(want, ctx) {
    const allowed = new Set();
    for (const ref of want) for (const id of nodeIds(ctx.beforeIdx, ref)) allowed.add(id);
    // 本批新建的节点（temp_id）不算越界
    for (const op of ctx.ops) if (opName(op) === 'create_node' && op.temp_id) allowed.add(String(op.temp_id));
    const bad = [...touchedIds(ctx.ops)].filter(
      (id) => ctx.beforeIdx.byId.has(id) && !allowed.has(id),
    );
    if (bad.length) return fail('scope', `改动触及了允许范围外的节点：${bad.join(', ')}`);
    return null;
  },
  no_destructive(want, ctx) {
    if (!want) return null;
    const banned = new Set(['delete_node', 'remove_edge', 'delete_recipe']);
    const bad = [...new Set(ctx.ops.map(opName).filter((n) => banned.has(n)))];
    if (bad.length) return fail('scope', `不该做破坏性操作，却出现：${bad.join(', ')}`);
    return null;
  },
  summary_contains(want, ctx) {
    const out = [];
    for (const s of want) if (!sub(ctx.result?.summary, s)) out.push(fail('target', `说明里缺「${s}」`));
    return out;
  },
  field_equals(want, ctx) {
    const out = [];
    for (const a of want) {
      const nodes = resolveNodes(ctx.afterIdx, a.label ?? a.id ?? a);
      const hit = nodes.some((n) => eq(n[a.field], a.value));
      if (!hit) out.push(fail('target', `「${a.label ?? a.id}」的 ${a.field} 期望 ${JSON.stringify(a.value)}，实际 ${JSON.stringify(nodes.map((n) => n[a.field]))}`));
    }
    return out;
  },
  field_contains(want, ctx) {
    const out = [];
    for (const a of want) {
      const nodes = resolveNodes(ctx.afterIdx, a.label ?? a.id ?? a);
      const hit = nodes.some((n) => sub(n[a.field], a.value));
      if (!hit) out.push(fail('target', `「${a.label ?? a.id}」的 ${a.field} 未包含 ${JSON.stringify(a.value)}`));
    }
    return out;
  },
  field_unchanged(want, ctx) { return ASSERTIONS.field_equals(want, ctx); },
  node_exists(want, ctx) {
    const out = [];
    for (const ref of want) if (!resolveNodes(ctx.afterIdx, ref).length) out.push(fail('target', `结果图里缺节点「${typeof ref === 'object' ? ref.label ?? ref.id : ref}」`));
    return out;
  },
  node_absent(want, ctx) {
    const out = [];
    for (const ref of want) if (resolveNodes(ctx.afterIdx, ref).length) out.push(fail('target', `结果图里仍存在节点「${typeof ref === 'object' ? ref.label ?? ref.id : ref}」`));
    return out;
  },
  edge_exists(want, ctx) {
    const out = [];
    for (const e of want) if (!edgeMatches(ctx.afterIdx, e, e.relation).length) out.push(fail('target', `缺连线 ${e.from} → ${e.to}${e.relation ? '（' + e.relation + '）' : ''}`));
    return out;
  },
  edge_absent(want, ctx) {
    const out = [];
    for (const e of want) if (edgeMatches(ctx.afterIdx, e).length) out.push(fail('target', `连线 ${e.from} → ${e.to} 不该存在`));
    return out;
  },
  edge_relation_equals(want, ctx) { return ASSERTIONS.edge_exists(want, ctx); },
  edge_count(want, ctx) {
    const n = edgeMatches(ctx.afterIdx, want).length;
    if (n !== want.count) return fail('target', `${want.from} → ${want.to} 连线数期望 ${want.count}，实际 ${n}`);
    return null;
  },
  node_connected(want, ctx) {
    const out = [];
    for (const ref of want) {
      const ids = nodeIds(ctx.afterIdx, ref);
      const hit = ctx.afterIdx.edges.some((e) => ids.has(String(e.from)) || ids.has(String(e.to)));
      if (!hit) out.push(fail('target', `节点「${ref}」没有任何连线（孤立节点）`));
    }
    return out;
  },
};

export const ASSERTION_KEYS = Object.keys(ASSERTIONS);

export function gradeCase(caseDef, result) {
  const beforeIdx = indexSnapshot(caseDef.snapshot);
  const afterIdx = indexSnapshot(result?.next_snapshot);
  const ops = Array.isArray(result?.operations) ? result.operations : [];
  const ctx = { caseDef, beforeIdx, afterIdx, ops, result };
  const failures = [];

  if (!result || typeof result !== 'object') {
    failures.push(fail('protocol', '响应不是对象（发送/解析失败）'));
  } else if (!Array.isArray(result.operations)) {
    failures.push(fail('protocol', '响应缺 operations 数组'));
  }

  for (const [key, val] of Object.entries(caseDef.expect || {})) {
    const fn = ASSERTIONS[key];
    if (!fn) { failures.push(fail('protocol', `未知断言类型 ${key}`)); continue; }
    const r = fn(val, ctx);
    if (Array.isArray(r)) failures.push(...r.filter(Boolean));
    else if (r) failures.push(r);
  }

  const primary = BUCKETS.find((b) => failures.some((f) => f.bucket === b)) || null;
  return {
    pass: failures.length === 0,
    failures,
    primary,
    buckets: [...new Set(failures.map((f) => f.bucket))],
  };
}

// 基线与本次的 {id: pass} 对比。新增/删除的题不参与比较但计数提示。
export function diffBaseline(cur, base) {
  const regressions = [], improvements = [], added = [], removed = [];
  for (const [id, pass] of Object.entries(cur)) {
    if (!(id in base)) { added.push(id); continue; }
    if (base[id] && !pass) regressions.push(id);
    if (!base[id] && pass) improvements.push(id);
  }
  for (const id of Object.keys(base)) if (!(id in cur)) removed.push(id);
  return { regressions, improvements, added, removed };
}

// 评分器自检：每类断言好/坏两向、四桶归因、基线 diff、A/B 灵敏度。
// 纯本地零服务，--selftest 跑的就是它。
export function selftest() {
  const passed = [];
  const failed = [];
  const check = (name, cond) => (cond ? passed : failed).push(name);

  const SNAP = {
    version: 1,
    nodes: [
      { id: 'A', kind: 'human_note', label: '导数', content: '旧正文', formula: 'f(x)', status: 'done' },
      { id: 'B', kind: 'human_note', label: '极限', content: '旧极限', formula: '', status: 'done' },
    ],
    edges: [{ key: 'B:out-0->A:in-0', from: 'B', to: 'A', relation: '依赖', label: '先修' }],
  };
  const clone = () => JSON.parse(JSON.stringify(SNAP));
  const good = (over = {}) => ({ status: 'ok', summary: '', operations: [], next_snapshot: clone(), ...over });
  const C = (expect, snapshot = clone()) => ({ id: 'st', snapshot, expect });

  // —— 每类断言：好结果必须 pass，坏结果必须 fail ——
  const pairs = [
    ['field_equals 好', C({ field_equals: [{ label: '导数', field: 'formula', value: 'f(x)' }] }), good()],
    ['field_equals 坏', C({ field_equals: [{ label: '导数', field: 'formula', value: 'F=ma' }] }), good()],
    ['field_contains 好', C({ field_contains: [{ label: '导数', field: 'content', value: '正文' }] }), good()],
    ['field_contains 坏', C({ field_contains: [{ label: '导数', field: 'content', value: '电磁' }] }), good()],
    ['field_unchanged 好', C({ field_unchanged: [{ label: '极限', field: 'label', value: '极限' }] }), good()],
    ['field_unchanged 坏', C({ field_unchanged: [{ label: '极限', field: 'label', value: '极限的定义' }] }), good()],
    ['node_exists 好', C({ node_exists: ['导数'] }), good()],
    ['node_exists 坏', C({ node_exists: ['链式法则'] }), good()],
    ['node_absent 好', C({ node_absent: ['链式法则'] }), good()],
    ['node_absent 坏', C({ node_absent: ['导数'] }), good()],
    ['edge_exists 好', C({ edge_exists: [{ from: '极限', to: '导数' }] }), good()],
    ['edge_exists 坏', C({ edge_exists: [{ from: '导数', to: '极限' }] }), good()],
    ['edge_absent 好', C({ edge_absent: [{ from: '导数', to: '极限' }] }), good()],
    ['edge_absent 坏', C({ edge_absent: [{ from: '极限', to: '导数' }] }), good()],
    ['edge_relation_equals 好', C({ edge_relation_equals: [{ from: '极限', to: '导数', relation: '依赖' }] }), good()],
    ['edge_relation_equals 坏', C({ edge_relation_equals: [{ from: '极限', to: '导数', relation: '前置' }] }), good()],
    ['edge_count 好', C({ edge_count: { from: '极限', to: '导数', count: 1 } }), good()],
    ['edge_count 坏', C({ edge_count: { from: '极限', to: '导数', count: 2 } }), good()],
    ['node_connected 好', C({ node_connected: ['导数'] }), good()],
    ['node_connected 坏', C({ node_connected: ['导数'] }), good({ next_snapshot: { ...clone(), edges: [] } })],
    ['status 好', C({ status: ['ok', 'no_ops'] }), good()],
    ['status 坏', C({ status: ['ok'] }), good({ status: 'no_ops' })],
    ['ops_count 上限 好', C({ ops_count: { max: 2 } }), good()],
    ['ops_count 上限 坏', C({ ops_count: { max: 0 } }), good({ operations: [{ op: 'update_node', id: 'A', reason: 'x' }] })],
    ['ops_count 下限 好', C({ ops_count: { min: 1 } }), good({ operations: [{ op: 'update_node', id: 'A', reason: 'x' }] })],
    ['ops_count 下限 坏', C({ ops_count: { min: 1 } }), good()],
    ['op_types 好', C({ op_types: ['update_node'] }), good({ operations: [{ op: 'update_node', id: 'A', reason: 'x' }] })],
    ['op_types 坏', C({ op_types: ['update_node'] }), good({ operations: [{ op: 'delete_node', id: 'A', reason: 'x' }] })],
    ['scope_allow 好', C({ scope_allow: ['导数'] }), good({ operations: [{ op: 'update_node', id: 'A', reason: 'x' }] })],
    ['scope_allow 坏', C({ scope_allow: ['导数'] }), good({ operations: [{ op: 'update_node', id: 'B', reason: 'x' }] })],
    ['no_destructive 好', C({ no_destructive: true }), good()],
    ['no_destructive 坏', C({ no_destructive: true }), good({ operations: [{ op: 'delete_node', id: 'A', reason: 'x' }] })],
    ['summary_contains 好', C({ summary_contains: ['已完成'] }), good({ summary: '已完成修改' })],
    ['summary_contains 坏', C({ summary_contains: ['已完成'] }), good({ summary: '没什么可说的' })],
  ];
  for (const [name, c, r] of pairs) {
    const g = gradeCase(c, r);
    check(name, name.includes(' 好') ? g.pass : !g.pass);
  }

  // —— 四桶归因各自能命中，且优先级正确 ——
  const bucketCases = [
    ['protocol', C({ status: ['ok'] }), good({ status: 'invalid' })],
    ['scope', C({ scope_allow: ['导数'] }), good({ operations: [{ op: 'update_node', id: 'B', reason: 'x' }] })],
    ['action', C({ op_types: ['update_node'] }), good({ operations: [{ op: 'delete_node', id: 'A', reason: 'x' }] })],
    ['target', C({ field_equals: [{ label: '导数', field: 'formula', value: 'F=ma' }] }), good()],
  ];
  for (const [bucket, c, r] of bucketCases) {
    check(`四桶归因 ${bucket}`, gradeCase(c, r).primary === bucket);
  }
  check('四桶优先级 protocol > scope', gradeCase(
    C({ status: ['ok'], scope_allow: ['导数'] }),
    good({ status: 'invalid', operations: [{ op: 'delete_node', id: 'B', reason: 'x' }] }),
  ).primary === 'protocol');

  // —— 缺 operations / 未知断言必须落 protocol，不静默放行 ——
  check('缺 operations 归 protocol', gradeCase(C({ node_exists: ['导数'] }), { status: 'ok' }).primary === 'protocol');
  check('未知断言归 protocol', gradeCase(C({ typo_assert: 1 }), good()).primary === 'protocol');

  // —— 基线 diff ——
  const d = diffBaseline({ a: true, b: false, c: true, d: false }, { a: false, b: true, c: true, z: true });
  check('diff 退步题', d.regressions.length === 1 && d.regressions[0] === 'b');
  check('diff 进步题', d.improvements.length === 1 && d.improvements[0] === 'a');
  check('diff 新增/删除计数', d.added.includes('d') && d.removed.includes('z'));

  // —— A/B 灵敏度：尺子必须能区分「好模型」与「坏模型」——
  // 10 条同型用例，好结果＝公式被正确改写，坏结果＝空操作（模型没听懂）。
  const goldCases = Array.from({ length: 10 }, (_, i) => ({
    id: 'ab-' + i,
    snapshot: clone(),
    expect: {
      status: ['ok'],
      field_equals: [{ label: '导数', field: 'formula', value: 'F=ma' }],
      ops_count: { min: 1, max: 3 },
    },
  }));
  const goodResult = () => {
    const s = clone();
    s.nodes.find((n) => n.id === 'A').formula = 'F=ma';
    return good({ next_snapshot: s, operations: [{ op: 'update_node', id: 'A', reason: 'x' }] });
  };
  const goodScore = goldCases.filter((c) => gradeCase(c, goodResult()).pass).length / goldCases.length;
  const badScore = goldCases.filter((c) => gradeCase(c, good({ status: 'no_ops' })).pass).length / goldCases.length;
  check('A/B 好模型应满分', goodScore === 1);
  check('A/B 坏模型应显著变红', badScore === 0);
  check('A/B 尺子有区分度（差值 ≥ 0.8）', goodScore - badScore >= 0.8);

  return { passed: passed.length, total: passed.length + failed.length, failed };
}
