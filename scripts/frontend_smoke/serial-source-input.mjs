// 串行边界：输入节点（素材篮，2026-10-22 重做）
// 一条素材 = 一个条目 = 一个出口（out-i ↔ items[i]）。覆盖：三入口渲染、端口=条目、
// 折叠态出口改走输出列（2026-10-22 修复）、删中间条目边重排、两口按口取材不混料、
// 旧数据只读分支、命名/OCR 状态文案、addSourceText 本地建条目与超长走 ingest（fetch 桩）。
// 2026-10-24 追加：加输出端口（附加口＝整篮出口，取材回落全部条目拼接）与
// 附加口随条目增删的边平移/portCounts 记账。
// 本文件有用例会 await 且替换全局 fetch 桩——串行域契约（见 AGENTS.md 硬规则 4），
// 执行顺序由 ../frontend_smoke.mjs 调用序列决定，收口线 drain() 之前注册完毕。
import { readFileSync } from 'node:fs';
import { check, drain, sandbox, vm } from './_runner.mjs';

function seedNode(items, extra) {
  const node = Object.assign({
    id: 'src-test', kind: 'source', x: 10, y: 20, messageIndex: -1,
    timestamp: 1, items: items || [],
  }, extra || {});
  vm.runInContext('graphView.nodes = [' + JSON.stringify(node) + ']; graphView.nodeById = {}; graphView.nodeById["src-test"] = graphView.nodes[0]; graphView.edges = [];', sandbox);
  return node;
}

export async function run() {
// ===== 素材篮（2026-10-22）：渲染骨架 =====
check('素材篮渲染：新节点三入口＋OCR 开关＋条目行；旧数据只读分支', () => {
  seedNode([]);
  vm.runInContext('graphView.selectedNodeIds = new Set(["src-test"]);', sandbox);
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    const html = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    for (const frag of [
      'graph-source-text-input',            // 粘贴文字入口
      'addSourceTextFromCard',              // 「加入」按钮
      'graph-source-file-btn',              // 选择文件/图片入口（两枚）
      'handleSourcePaste',                  // Ctrl+V 粘贴截图
      'handleSourceNodeDrop',               // 拖拽区
      'toggleSourceOcr',                    // 图片自动转文字开关
      'graph-source-empty',                 // 空篮提示
    ]) {
      if (!html.includes(frag)) throw new Error('新节点渲染缺入口：' + frag);
    }
    if (html.includes('graph-source-row')) throw new Error('空篮不应渲染条目行');
    // 2026-10-24 开放加口：新素材篮应有「＋添加输出端口」（附加口＝整篮出口）
    if (!(html.includes('graphAddOutputPort') && html.includes('graph-add-port-btn'))) {
      throw new Error('新素材篮应有「＋添加输出端口」入口');
    }
    // 旧数据（items 知识点形状）：只读分支——不渲染条目行/输入区，保留 AI 整理关系
    seedNode([{ id: 'n1', title: '牛顿定律', summary: 'F=ma' }], { fileName: '讲义.pdf', fileId: 'doc_x' });
    const legacyHtml = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    if (!legacyHtml.includes('graph-source-legacy') || !legacyHtml.includes('openHarnessOrganizeRelations')) {
      throw new Error('旧数据应走只读分支并保留 AI 整理关系');
    }
    if (legacyHtml.includes('addSourceTextFromCard')) throw new Error('旧数据不提供新输入入口');
    if (legacyHtml.includes('解析中')) throw new Error('旧数据只读分支不该有 busy 态');
    if (legacyHtml.includes('graphAddOutputPort')) throw new Error('旧数据不开放加输出端口');
  } finally {
    sandbox.escapeHtml = realEsc;
    vm.runInContext('graphView.selectedNodeIds = new Set();', sandbox);
  }
  return true;
});

check('素材篮折叠：出口改走输出列（折叠卡不再是死节点），每个口恰好一份 DOM', () => {
  // 2026-10-22 修复回归：行内口长在 body 里，折叠卡 body 换占位符 → 行内口没了。
  // 折叠态必须由输出列补上基础口（否则折叠的输入节点一个出口都没有）；两种形态
  // 下每个 out-i 都只能有一份 DOM（隐藏的重复口会让 _graphPortEl 查到 rect 全 0
  // 的那份，边锚点跑飞）。
  const items = [
    { id: 'it1', kind: 'text', name: '题目原文', text: '一道力学题' },
    { id: 'it2', kind: 'image', name: '受力图', text: '' },
  ];
  const count = (s, sub) => s.split(sub).length - 1;
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    seedNode(items, { minimized: true });
    const folded = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    if (folded.includes('graph-source-row-port')) throw new Error('折叠卡不该渲染条目行端口（body 已换占位符）');
    if (!folded.includes('graph-node-body-ph')) throw new Error('折叠卡 body 应为占位符');
    for (const frag of ['data-port-id="out-0"', 'data-port-id="out-1"', 'graph-port graph-output-port']) {
      if (!folded.includes(frag)) throw new Error('折叠态出口应由输出列补上，缺：' + frag);
    }
    if (count(folded, 'data-port-id="out-0"') !== 1) throw new Error('折叠态 out-0 应恰好一份 DOM');
    // 对照：同一份数据展开时回到行内口，输出列不再补基础口（同样只一份）
    seedNode(items);
    const expanded = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    if (!expanded.includes('graph-source-row-port')) throw new Error('展开态应回到条目行端口');
    if (count(expanded, 'data-port-id="out-0"') !== 1) throw new Error('展开态 out-0 应恰好一份 DOM（行内口）');
  } finally {
    sandbox.escapeHtml = realEsc;
  }
  return true;
});

check('素材篮端口＝条目：out-i ↔ items[i]，新条目 type 留空、旧条目不再出口', () => {
  seedNode([
    { id: 'it1', kind: 'text', name: '题目原文', text: '一道力学题' },
    { id: 'it2', kind: 'image', name: '受力图', text: '', ocr: { status: 'running' } },
    { id: 'it3', kind: 'file', name: '讲义', text: '' },
  ]);
  const ports = vm.runInContext('_nodeBaseOutputPorts(graphView.nodeById["src-test"], [])', sandbox);
  if (ports.length !== 3) throw new Error('端口数应等于条目数，实际 ' + ports.length);
  if (ports.map(p => p.label).join('|') !== '题目原文|受力图|讲义') throw new Error('端口名应=素材名');
  for (const p of ports) {
    if (p.type !== '') throw new Error('新条目口 type 应留空（拖空开面板），实际 ' + p.type);
    if (p.attribute !== 'source') throw new Error('新条目口 attribute 应为 source');
    if (!p.item || !p.item.kind) throw new Error('端口应携带条目本体（拖拽与按口取材用）');
  }
  // 条目行内端口 DOM：锚点两属性与拖拽 dataset 全套
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    vm.runInContext('graphView.selectedNodeIds = new Set();', sandbox);
    const html = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    for (const frag of ['data-port-id="out-0"', 'data-port-id="out-1"', 'data-port-id="out-2"',
      'class="graph-port graph-output-port graph-source-row-port"', '转写中…']) {
      if (!html.includes(frag)) throw new Error('条目行端口缺：' + frag);
    }
  } finally {
    sandbox.escapeHtml = realEsc;
  }
  // 旧条目（知识点形状）不再出口：2026-10-23 知识点节点退役，旧输入节点只读保留
  seedNode([{ id: 'n1', title: '牛顿定律' }]);
  const legacyPorts = vm.runInContext('_nodeBaseOutputPorts(graphView.nodeById["src-test"], [])', sandbox);
  if (legacyPorts.length !== 0) throw new Error('旧输入条目不出口（知识点链路已退役）');
  return true;
});

check('素材篮删中间条目：out-i 的边删除、其后端口左移一位、无关边不动', () => {
  seedNode([
    { id: 'itA', kind: 'text', name: 'A', text: '甲' },
    { id: 'itB', kind: 'text', name: 'B', text: '乙' },
    { id: 'itC', kind: 'text', name: 'C', text: '丙' },
  ]);
  let saved = null;
  const realUndo = sandbox._pushGraphUndo;
  const realRender = sandbox.renderGraphCanvas;
  const realSave = sandbox.saveGraphState;
  sandbox._pushGraphUndo = () => {};
  sandbox.renderGraphCanvas = () => {};
  sandbox.saveGraphState = () => {};
  try {
    // 沙箱 window.getGraphState 由 _graphState 消费：stub 一份带 6 条边的 state
    sandbox.window.getGraphState = () => ({
      connections: [
        { from: 'src-test', fromPort: 'out-0', to: 'x1', toPort: 'in-0', custom: true },
        { from: 'src-test', fromPort: 'out-1', to: 'x2', toPort: 'in-0', custom: true },
        { from: 'src-test', fromPort: 'out-2', to: 'x3', toPort: 'in-0', custom: true },
        { from: 'src-test', fromPort: 'out-2', to: 'x4', toPort: 'in-0', custom: true },
        { from: 'x9', fromPort: 'out-0', to: 'src-test', toPort: 'in-0', custom: true },
      ],
      removedEdges: [], portCounts: {}, inputPortCounts: {}, customNodes: [], positions: {},
    });
    sandbox.window.saveGraphState = (sid, state) => { saved = state; };
    sandbox.deleteSourceItem('src-test', 'itB');
  } finally {
    sandbox._pushGraphUndo = realUndo;
    sandbox.renderGraphCanvas = realRender;
    sandbox.saveGraphState = realSave;
    delete sandbox.window.getGraphState;
    delete sandbox.window.saveGraphState;
  }
  if (!saved) throw new Error('删条目必须落盘 state');
  const node = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
  if (node.items.length !== 2 || node.items[0].id !== 'itA' || node.items[1].id !== 'itC') {
    throw new Error('条目删除后应剩 A/C');
  }
  const conns = saved.connections;
  const fromSrc = conns.filter(c => c.from === 'src-test');
  if (fromSrc.length !== 3) throw new Error('out-1 的边应删除（4→3），实际 ' + fromSrc.length);
  const ports = fromSrc.map(c => c.fromPort).sort();
  if (ports.join(',') !== 'out-0,out-1,out-1') {
    throw new Error('out-2 应左移为 out-1、out-0 不动，实际 ' + ports.join(','));
  }
  if (!conns.some(c => c.from === 'x9')) throw new Error('无关边被误删');
  if (!String(node.content || '').includes('甲') || String(node.content || '').includes('乙')) {
    throw new Error('删条目后 node.content 应剔除该条目文本');
  }
  return true;
});

// ===== 素材篮（2026-10-24）：加输出端口＝整篮出口 =====
check('素材篮加输出端口（2026-10-24）：门对新数据开、旧节点关；附加口取材回落整篮拼接', () => {
  // 1. 权限门：新数据（含空篮）开、旧数据（知识点形状）关
  if (!sandbox._nodeCanAddOutputPorts({ kind: 'source', items: [{ id: 'a', kind: 'text', name: 'x', text: 'y' }] })) throw new Error('新素材篮应可加输出口');
  if (!sandbox._nodeCanAddOutputPorts({ kind: 'source', items: [] })) throw new Error('空篮新节点应可加输出口');
  if (sandbox._nodeCanAddOutputPorts({ kind: 'source', items: [{ title: '旧' }] })) throw new Error('旧素材篮不开放加口');
  // 2. 整篮出口取材：out-N 越界回落全部条目拼接；空篮回落 node.content
  const node = {
    id: 'src-test', kind: 'source',
    items: [
      { id: 'i0', kind: 'text', name: '笔记', text: 'AAA文本' },
      { id: 'i1', kind: 'image', name: '受力图', text: '' },
    ],
    content: 'cached-content',
  };
  if (sandbox._nodeOutputContent(node, new Set(), 'out-0') !== 'AAA文本') throw new Error('条目口仍按条目取材');
  const whole = String(sandbox._nodeOutputContent(node, new Set(), 'out-5'));
  if (!whole.includes('AAA文本')) throw new Error('附加口应回落整篮拼接：' + JSON.stringify(whole));
  if (sandbox._nodeOutputContent({ id: 'e', kind: 'source', items: [], content: 'CCC' }, new Set(), 'out-0') !== 'CCC') {
    throw new Error('空篮附加口应回落 node.content');
  }
  // 3. 按素材附加口（2026-10-24 三）：绑定的只送那条素材，无绑定的仍是整篮口
  const node2 = {
    id: 'src2', kind: 'source',
    items: [
      { id: 'i0', kind: 'text', name: '文字A', text: 'AAA' },
      { id: 'i1', kind: 'image', name: '图片B', text: '' },
    ],
    addonPorts: [{ item: 'i1' }, {}],
    content: 'cached',
  };
  const bound = String(sandbox._nodeOutputContent(node2, new Set(), 'out-2'));
  if (bound.includes('AAA') || !bound.includes('图片B')) throw new Error('按素材附加口应只送绑定素材：' + JSON.stringify(bound));
  const basket2 = String(sandbox._nodeOutputContent(node2, new Set(), 'out-3'));
  if (!basket2.includes('AAA') || !basket2.includes('图片B')) throw new Error('无绑定附加口应是整篮：' + JSON.stringify(basket2));
  if (sandbox._sourcePortLabel(node2, 'out-0') !== '文字A') throw new Error('条目口标签＝素材名');
  if (sandbox._sourcePortLabel(node2, 'out-2') !== '图片B') throw new Error('按素材附加口标签＝素材名');
  if (sandbox._sourcePortLabel(node2, 'out-3') !== '全部素材') throw new Error('整篮口标签应为「全部素材」');
  const boundImgs = sandbox._sourcePortImageItems(node2, 2);
  if (boundImgs.length !== 1 || boundImgs[0].id !== 'i1') throw new Error('绑定口图片只收该素材');
  const allImgs = sandbox._sourcePortImageItems(node2, 3);
  if (allImgs.length !== 2) throw new Error('整篮口图片应收全部条目');
  // 4. 渲染：按素材附加口显示素材名（非「待命名」）、行内有「加口」按钮
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    seedNode([{ id: 'ib', kind: 'image', name: '受力图', text: '' }], { addonPorts: [{ item: 'ib' }] });
    vm.runInContext('graphView.selectedNodeIds = new Set();', sandbox);
    const html2 = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: { "src-test": 2 } })', sandbox);
    if (!html2.includes('graphAddSourceItemPort')) throw new Error('行内「加口」按钮缺失');
    const at = html2.indexOf('data-port-id="out-1"');
    if (at < 0) throw new Error('按素材附加口应渲染 out-1');
    const seg = html2.slice(at, at + 400);
    if (!seg.includes('受力图') || seg.includes('待命名')) throw new Error('按素材附加口应显示素材名而非待命名');
  } finally {
    sandbox.escapeHtml = realEsc;
  }
  // 5. 静态契约：图片按绑定分流助手在位
  const promptSrc = readFileSync('src/static/js/graph-workflow-prompt.js', 'utf8');
  if (!promptSrc.includes('function _sourcePortImageItems')) throw new Error('图片按绑定分流助手缺失');
  return true;
});

check('素材篮按素材加口全链（2026-10-24 三）：绑定记账、条目增删平移、删绑定素材撤口、通用×删口同步', () => {
  seedNode([
    { id: 'it0', kind: 'text', name: 'A', text: '甲' },
    { id: 'it1', kind: 'text', name: 'B', text: '乙' },
  ]);
  let mem = null;
  const realUndo = sandbox._pushGraphUndo;
  const realRender = sandbox.renderGraphCanvas;
  const realSave = sandbox.saveGraphState;
  sandbox._pushGraphUndo = () => {};
  sandbox.renderGraphCanvas = () => {};
  sandbox.saveGraphState = () => {};
  try {
    sandbox.window.getGraphState = () => mem;
    sandbox.window.saveGraphState = (_sid, state) => { mem = state; };
    mem = {
      connections: [
        { from: 'src-test', fromPort: 'out-0', to: 'x1', toPort: 'in-0', custom: true },
        { from: 'src-test', fromPort: 'out-2', to: 'x2', toPort: 'in-0', custom: true },
        { from: 'src-test', fromPort: 'out-3', to: 'x3', toPort: 'in-0', custom: true },
      ],
      removedEdges: [], portCounts: { 'src-test': 4 }, inputPortCounts: {}, customNodes: [], positions: {},
    };
    const node = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
    node.addonPorts = [{ item: 'it1' }, {}];
    // 1. 给 it0 加口：绑定表追加、portCounts＝2 条目＋3 附加＝5
    sandbox.graphAddSourceItemPort('src-test', 'it0');
    if (!node.addonPorts[2] || node.addonPorts[2].item !== 'it0') throw new Error('新附加口应带 it0 绑定');
    if (mem.portCounts['src-test'] !== 5) throw new Error('portCounts 应 5，实际 ' + mem.portCounts['src-test']);
    // 2. 加条目：附加口边整体右移（out-2→out-3、out-3→out-4）、portCounts＝3＋3＝6、绑定不重排
    sandbox._sourcePushItem(node, { id: 'it2', kind: 'text', name: 'C', text: '丙' });
    if (mem.connections.find(c => c.to === 'x2').fromPort !== 'out-3') throw new Error('绑定口边应右移 out-3');
    if (mem.connections.find(c => c.to === 'x3').fromPort !== 'out-4') throw new Error('整篮口边应右移 out-4');
    if (mem.portCounts['src-test'] !== 6) throw new Error('portCounts 应 6，实际 ' + mem.portCounts['src-test']);
    // 3. 删被绑定的素材 it1：它的条目口与绑定附加口一起撤（x2 边删），其余左移补位
    sandbox.deleteSourceItem('src-test', 'it1');
    if (mem.connections.some(c => c.to === 'x2')) throw new Error('被绑素材的附加口边应随素材删除');
    const x3e = mem.connections.find(c => c.to === 'x3');
    if (!x3e || x3e.fromPort !== 'out-2') throw new Error('整篮口边应左移 out-2，实际 ' + (x3e && x3e.fromPort));
    if (mem.portCounts['src-test'] !== 4) throw new Error('portCounts 应 4，实际 ' + mem.portCounts['src-test']);
    if (!mem.connections.some(c => c.to === 'x1' && c.fromPort === 'out-0')) throw new Error('it0 条目口边不动');
    // 4. 通用×删掉附加口 out-2（此时的整篮口，x3 的线随口删除）：绑定表 splice、portCounts 同步
    sandbox.graphRemoveOutputPort('src-test', 2);
    if (mem.connections.some(c => c.to === 'x3')) throw new Error('删口应移除其连线');
    if (node.addonPorts.length !== 1 || node.addonPorts[0].item !== 'it0') throw new Error('绑定表应剩 it0 一项');
    if (mem.portCounts['src-test'] !== 3) throw new Error('portCounts 应 3，实际 ' + mem.portCounts['src-test']);
  } finally {
    sandbox._pushGraphUndo = realUndo;
    sandbox.renderGraphCanvas = realRender;
    sandbox.saveGraphState = realSave;
    delete sandbox.window.getGraphState;
    delete sandbox.window.saveGraphState;
  }
  return true;
});

check('素材篮附加口随条目增删平移：加条目右移＋1、删条目左移−1，portCounts 同步记账', () => {
  seedNode([
    { id: 'it0', kind: 'text', name: 'A', text: '甲' },
    { id: 'it1', kind: 'text', name: 'B', text: '乙' },
  ]);
  let mem = null;
  const realUndo = sandbox._pushGraphUndo;
  const realRender = sandbox.renderGraphCanvas;
  const realSave = sandbox.saveGraphState;
  sandbox._pushGraphUndo = () => {};
  sandbox.renderGraphCanvas = () => {};
  sandbox.saveGraphState = () => {};
  try {
    sandbox.window.getGraphState = () => mem;
    sandbox.window.saveGraphState = (_sid, state) => { mem = state; };
    mem = {
      connections: [
        { from: 'src-test', fromPort: 'out-0', to: 'x1', toPort: 'in-0', custom: true },
        { from: 'src-test', fromPort: 'out-2', to: 'x2', toPort: 'in-0', custom: true },
        { from: 'x9', fromPort: 'out-0', to: 'src-test', toPort: 'in-0', custom: true },
      ],
      removedEdges: [], portCounts: { 'src-test': 3 }, inputPortCounts: {}, customNodes: [], positions: {},
    };
    const node = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
    // 1. 加条目（附加口在场）：附加口边 out-2→out-3、portCounts 3→4，新条目落索引 2
    sandbox._sourcePushItem(node, { id: 'it2', kind: 'text', name: 'C', text: '丙' });
    const shifted = mem.connections.find(c => c.from === 'src-test' && c.to === 'x2');
    if (!shifted || shifted.fromPort !== 'out-3') throw new Error('附加口边应右移 out-3，实际 ' + (shifted && shifted.fromPort));
    if (mem.portCounts['src-test'] !== 4) throw new Error('portCounts 应 3→4，实际 ' + mem.portCounts['src-test']);
    if (node.items.length !== 3 || node.items[2].id !== 'it2') throw new Error('新条目应落原附加口索引 2');
    // 2. 删中间条目 it1：附加口边左移回 out-2、portCounts 回 3，无关边不动
    sandbox.deleteSourceItem('src-test', 'it1');
    const backEdge = mem.connections.find(c => c.from === 'src-test' && c.to === 'x2');
    if (!backEdge || backEdge.fromPort !== 'out-2') throw new Error('附加口边应左移回 out-2，实际 ' + (backEdge && backEdge.fromPort));
    if (mem.portCounts['src-test'] !== 3) throw new Error('portCounts 应 4→3，实际 ' + mem.portCounts['src-test']);
    if (!mem.connections.some(c => c.from === 'src-test' && c.fromPort === 'out-0' && c.to === 'x1')) throw new Error('条目口边不动');
    if (!mem.connections.some(c => c.from === 'x9')) throw new Error('入向边不动');
  } finally {
    sandbox._pushGraphUndo = realUndo;
    sandbox.renderGraphCanvas = realRender;
    sandbox.saveGraphState = realSave;
    delete sandbox.window.getGraphState;
    delete sandbox.window.saveGraphState;
  }
  return true;
});

check('素材篮按口取材：两口分别进上下文不混料、label=素材名、2000 字截断', () => {
  const longB = '乙素材长文。'.repeat(600); // 3000 字
  seedNode([
    { id: 'itA', kind: 'text', name: '甲素材', text: '甲的独有文字 AAAA' },
    { id: 'itB', kind: 'text', name: '乙素材', text: '乙的独有文字 BBBB ' + longB },
  ]);
  const downstream = { id: 'd1', kind: 'module', moduleKey: 'physics', messageIndex: -1, timestamp: 9, content: '' };
  vm.runInContext('graphView.nodes.push(' + JSON.stringify(downstream) + '); graphView.nodeById["d1"] = graphView.nodes[graphView.nodes.length - 1];', sandbox);
  vm.runInContext('graphView.edges = ['
    + '{ from: "src-test", fromPort: "out-0", to: "d1", toPort: "in-0", custom: true },'
    + '{ from: "src-test", fromPort: "out-1", to: "d1", toPort: "in-1", custom: true }'
    + '];', sandbox);
  const items = vm.runInContext('_collectUpstreamPath(graphView.nodeById["d1"])', sandbox);
  const sourceItems = items.filter(i => i.kind === 'source');
  if (sourceItems.length !== 2) throw new Error('同一输入节点的两口必须都留下（去重键 id@port），实际 ' + sourceItems.length);
  const labels = sourceItems.map(i => i.portLabel).sort();
  if (labels.join(',') !== '乙素材,甲素材') throw new Error('portLabel 应=素材名，实际 ' + labels);
  const entryA = sourceItems.find(i => i.portLabel === '甲素材');
  const entryB = sourceItems.find(i => i.portLabel === '乙素材');
  if (!String(entryA.content).includes('AAAA') || String(entryA.content).includes('BBBB')) {
    throw new Error('甲的口里出现了乙的内容（或丢了自己的）');
  }
  if (!String(entryB.content).includes('BBBB') || String(entryB.content).includes('AAAA')) {
    throw new Error('乙的口里出现了甲的内容（或丢了自己的）');
  }
  // entry 映射：source 条目 label 用端口名、2000 档截断且明示原文长度
  const ctx = vm.runInContext('_collectWorkflowContext(graphView.nodeById["d1"], null, {})', sandbox);
  const upstream = ctx.upstream.filter(e => e.kind === 'source');
  if (upstream.length !== 2) throw new Error('上下文里 source 条目应 2 条，实际 ' + upstream.length);
  const eB = upstream.find(e => String(e.content).includes('BBBB'));
  if (!eB) throw new Error('乙条目没进上下文');
  if (eB.label !== '乙素材') throw new Error('下游 label 应=素材名，实际 ' + eB.label);
  if (eB.content.length > 2200 || !eB.content.includes('已截断，原文 ')) {
    throw new Error('素材条目应按 2000 档截断并明示原文长度');
  }
  // 按口直读：只接 A 时整份取材里搜不到 B 的独有文字
  vm.runInContext('graphView.edges = graphView.edges.filter(e => e.fromPort !== "out-1");', sandbox);
  const only = vm.runInContext('_collectWorkflowContext(graphView.nodeById["d1"], null, {})', sandbox);
  const allText = JSON.stringify(only);
  if (allText.includes('BBBB')) throw new Error('只接甲口时，乙的文本不该出现在任何位置');
  return true;
});

check('素材篮旧节点取材与改前一致：items 知识点形状恒空内容', () => {
  seedNode([{ id: 'n1', title: '旧知识点', summary: '概要' }], { fileId: 'doc_x', fileName: 'a.pdf' });
  const downstream = { id: 'd2', kind: 'module', moduleKey: 'physics', messageIndex: -1, timestamp: 9 };
  vm.runInContext('graphView.nodes.push(' + JSON.stringify(downstream) + '); graphView.nodeById["d2"] = graphView.nodes[graphView.nodes.length - 1];', sandbox);
  vm.runInContext('graphView.edges = [{ from: "src-test", fromPort: "out-0", to: "d2", toPort: "in-0", custom: true }];', sandbox);
  const items = vm.runInContext('_collectUpstreamPath(graphView.nodeById["d2"])', sandbox);
  const src = items.find(i => i.kind === 'source');
  if (!src) throw new Error('旧 source 节点仍应进上游清单');
  if (String(src.content || '') !== '') throw new Error('旧 source 取材应恒为空（改前口径），实际：' + src.content.slice(0, 40));
  if (src.portLabel) throw new Error('旧条目不该有 portLabel（新字段不写旧节点）');
  return true;
});

check('素材篮命名与 OCR 状态文案：首行 20 字 / 文件名 24 字 / 转写态四档', () => {
  seedNode([]);
  const node = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
  const textName = sandbox._sourceItemName(node, 'text', '', '第一行标题很长很长很长很长很长很长很长\n正文');
  if (textName !== '第一行标题很长很长很长很长很长很长很长'.slice(0, 20)) {
    throw new Error('文本命名应取首行截 20 字，实际：' + textName);
  }
  if (sandbox._sourceItemName(node, 'text', '', '   \n  ') !== '文本 1') {
    throw new Error('空文本应回落「文本 N」');
  }
  const fileName = sandbox._sourceItemName(node, 'image', '一张特别特别特别特别特别特别特别长的受力分析图.png', '');
  if (fileName !== '一张特别特别特别特别特别特别特别长的受力分析图'.slice(0, 24)) {
    throw new Error('文件命名应去扩展名截 24 字，实际：' + fileName);
  }
  const st = sandbox._sourceOcrStatusText;
  if (st({ kind: 'image', ocr: { status: 'running' } }) !== '转写中…') throw new Error('running 态文案错');
  if (st({ kind: 'image', chars: 86, ocr: { status: 'done' } }) !== '已转写 86 字') throw new Error('done 态文案错');
  const failed = st({ kind: 'image', ocr: { status: 'failed', error: '未识别出文字' } });
  if (!failed.includes('识别失败') || !failed.includes('未识别出文字')) throw new Error('failed 态文案错：' + failed);
  if (st({ kind: 'image', ocr: { status: 'skipped' } }) !== '未转写') throw new Error('skipped 态文案错');
  if (st({ kind: 'text', ocr: { status: 'done' } }) !== '') throw new Error('非图片条目不该有 OCR 文案');
  return true;
});

// ===== 取材附图与 OCR 默认关（2026-10-23）=====
check('OCR 默认关：新节点开关不勾选，显式开启才勾选；toggle 写显式值', () => {
  const realEsc = sandbox.escapeHtml;
  const realSave = sandbox._saveCustomNodes;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  sandbox._saveCustomNodes = () => {};
  try {
    seedNode([]);
    const offHtml = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    const m = offHtml.match(/graph-source-ocr-toggle"><input type="checkbox"([^>]*)>/);
    if (!m) throw new Error('渲染缺 OCR 开关');
    if (m[1].includes(' checked')) throw new Error('ocrOn 未设应默认不勾选（默认关）');
    seedNode([], { ocrOn: true });
    const onHtml = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    if (!/graph-source-ocr-toggle"><input type="checkbox" checked/.test(onHtml)) {
      throw new Error('ocrOn=true 应勾选');
    }
    sandbox.toggleSourceOcr('src-test', false);
    const n = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
    if (n.ocrOn !== false) throw new Error('toggleSourceOcr(false) 应显式落 false（默认语义由读取方定）');
  } finally {
    sandbox.escapeHtml = realEsc;
    sandbox._saveCustomNodes = realSave;
  }
  return true;
});

check('OCR 默认关源码契约：addSourceFiles 严格判 ocrOn === true（加素材默认不发 OCR）', () => {
  const src = readFileSync(new URL('../../src/static/js/graph-custom.js', import.meta.url), 'utf8');
  if (!src.includes('const wantOcr = node.ocrOn === true;')) {
    throw new Error('addSourceFiles 必须严格判 ocrOn === true（默认关）');
  }
  return true;
});

check('取材附图收集：_collectUpstreamImages 按口挑图片条目，未接线口不收、旧节点不收', () => {
  seedNode([
    { id: 'itA', kind: 'text', name: '文字', text: '甲' },
    { id: 'itB', kind: 'image', name: '受力图', text: '', fileId: 'doc_img1' },
    { id: 'itC', kind: 'image', name: '没接线的图', text: '', fileId: 'doc_img2' },
  ]);
  const downstream = { id: 'd1', kind: 'module', moduleKey: 'physics', messageIndex: -1, timestamp: 9, content: '' };
  vm.runInContext('graphView.nodes.push(' + JSON.stringify(downstream) + '); graphView.nodeById["d1"] = graphView.nodes[graphView.nodes.length - 1];', sandbox);
  vm.runInContext('graphView.edges = [{ from: "src-test", fromPort: "out-1", to: "d1", toPort: "in-0", custom: true }];', sandbox);
  const got = vm.runInContext('_collectUpstreamImages(graphView.nodeById["d1"])', sandbox);
  if (got.length !== 1 || got[0].fileId !== 'doc_img1' || got[0].name !== '受力图') {
    throw new Error('只应收接线那口的图片条目，实际 ' + JSON.stringify(got));
  }
  seedNode([{ id: 'n1', title: '旧' }], { fileId: 'doc_old', fileName: 'a.pdf' });
  // seedNode 已整体重置 nodes，下游节点要重建
  vm.runInContext('graphView.nodes.push(' + JSON.stringify(downstream) + '); graphView.nodeById["d1"] = graphView.nodes[graphView.nodes.length - 1]; graphView.edges = [{ from: "src-test", fromPort: "out-0", to: "d1", toPort: "in-0", custom: true }];', sandbox);
  const none = vm.runInContext('_collectUpstreamImages(graphView.nodeById["d1"])', sandbox);
  if (none.length !== 0) throw new Error('旧知识点形状节点不该收图');
  return true;
});

// ===== T382（2026-10-23）：扫描版 PDF 页转图与 4 张配额 =====
check('扫描版 PDF 配额轮转：4 张按素材轮转分，页多不等于张数多（单文件 8 页上限）', () => {
  const alloc = (groups, max) => vm.runInContext(
    '_allocateSendImageRefs(' + JSON.stringify(groups) + ', ' + max + ')', sandbox);
  const pages = (n) => Array.from({ length: n }, (_, i) => i + 1);
  // ① 一张图 + 一份 8 页扫描件：图先、PDF 吃满余量 3 页（不会因为 PDF 在后面就整份缺席）
  let refs = alloc([{ fileId: 'doc_img', name: '受力图', pages: [0] },
                    { fileId: 'doc_pdf', name: '扫描讲义', pages: pages(8) }], 4);
  if (refs.length !== 4) throw new Error('应有 4 张，实际 ' + JSON.stringify(refs));
  if (refs[0].page !== 0 || refs[0].fileId !== 'doc_img') throw new Error('图片条目应排第一（page 0＝原图）');
  if (refs.slice(1).map(r => r.page).join(',') !== '1,2,3') {
    throw new Error('PDF 应补第 1/2/3 页，实际 ' + JSON.stringify(refs));
  }
  // ② 两份扫描件混篮：轮转＝各前 2 页（不一份吃满另一份饿死）
  refs = alloc([{ fileId: 'p1', name: 'A', pages: pages(8) },
                { fileId: 'p2', name: 'B', pages: pages(8) }], 4);
  if (refs.map(r => r.fileId + ':' + r.page).join('|') !== 'p1:1|p2:1|p1:2|p2:2') {
    throw new Error('两份扫描件应各前 2 页，实际 ' + JSON.stringify(refs));
  }
  // ③ 单份两页：只有两页可发，不编造
  refs = alloc([{ fileId: 'p3', name: 'C', pages: [1, 2] }], 4);
  if (refs.length !== 2) throw new Error('两页扫描件最多 2 张');
  // ④ 配额 0／空清单：不产生任何图（服务端不会收到空图数组）
  if (alloc([{ fileId: 'p3', pages: [1] }], 0).length !== 0) throw new Error('配额 0 应返回空');
  if (alloc([], 4).length !== 0) throw new Error('无素材应返回空');
});

check('扫描版 PDF 收集：ingest 打标与旧条目现场判定两条路都产出页图引用', () => {
  // 打标条目（T382 新数据）：kind=file + scanned + pages，text 恒空
  seedNode([
    { id: 'itP', kind: 'file', name: '扫描讲义', fileName: '扫描讲义.pdf', text: '', fileId: 'doc_pdf', scanned: true, pages: 12 },
  ]);
  const downstream = { id: 'd2', kind: 'module', moduleKey: 'physics', messageIndex: -1, timestamp: 9, content: '' };
  vm.runInContext('graphView.nodes.push(' + JSON.stringify(downstream) + '); graphView.nodeById["d2"] = graphView.nodes[graphView.nodes.length - 1]; graphView.edges = [{ from: "src-test", fromPort: "out-0", to: "d2", toPort: "in-0", custom: true }];', sandbox);
  let got = vm.runInContext('_collectUpstreamImages(graphView.nodeById["d2"])', sandbox);
  if (got.length !== 4 || got.some(r => r.fileId !== 'doc_pdf')) throw new Error('单份扫描件应吃满 4 张页图：' + JSON.stringify(got));
  if (got.map(r => r.page).join(',') !== '1,2,3,4') throw new Error('应取前 4 页，实际 ' + JSON.stringify(got));
  // 页上限：12 页的扫描件只参与前 8 页（配额给到 99 也只出 8 张页图）
  const capped = vm.runInContext('_allocateSendImageRefs([_sourceItemImageGroup('
    + JSON.stringify({ kind: 'file', fileId: 'doc_pdf', fileName: '扫描讲义.pdf', scanned: true, pages: 12 })
    + ')], 99)', sandbox);
  if (capped.length !== 8) throw new Error('单份 PDF 最多 8 页（与后端 PDF_PAGE_MAX 同口径），实际 ' + capped.length);
  // 存量条目（无 scanned 字段）：.pdf + 无文字＝现场按扫描版处理，不用重新入篮
  seedNode([{ id: 'itL', kind: 'file', name: '旧扫描件', fileName: '旧扫描件.PDF', text: '', fileId: 'doc_old' }]);
  vm.runInContext('graphView.nodes.push(' + JSON.stringify(downstream) + '); graphView.nodeById["d2"] = graphView.nodes[graphView.nodes.length - 1]; graphView.edges = [{ from: "src-test", fromPort: "out-0", to: "d2", toPort: "in-0", custom: true }];', sandbox);
  got = vm.runInContext('_collectUpstreamImages(graphView.nodeById["d2"])', sandbox);
  if (got.length !== 4 || got[0].fileId !== 'doc_old') throw new Error('存量扫描件应按 PDF 页收集：' + JSON.stringify(got));
  // 有文字层的 PDF（text 非空）：不产页图，照旧走文字
  seedNode([{ id: 'itT', kind: 'file', name: '文字版', fileName: '文字版.pdf', text: '牛顿第二定律 F=ma', fileId: 'doc_text' }]);
  vm.runInContext('graphView.nodes.push(' + JSON.stringify(downstream) + '); graphView.nodeById["d2"] = graphView.nodes[graphView.nodes.length - 1]; graphView.edges = [{ from: "src-test", fromPort: "out-0", to: "d2", toPort: "in-0", custom: true }];', sandbox);
  if (vm.runInContext('_collectUpstreamImages(graphView.nodeById["d2"])', sandbox).length !== 0) {
    throw new Error('有文字层的 PDF 不该触发页转图');
  }
});

check('扫描版 PDF 文案：占位说明「非空料」、条目行标扫描版与转图', () => {
  const item = { kind: 'file', name: '扫描讲义', fileName: '扫描讲义.pdf', text: '', fileId: 'doc_pdf', scanned: true, pages: 12 };
  const placeholder = vm.runInContext('_sourceItemPlaceholder(' + JSON.stringify(item) + ')', sandbox);
  for (const frag of ['扫描版 PDF', '共 12 页', '转图']) {
    if (!placeholder.includes(frag)) throw new Error('占位缺「' + frag + '」：' + placeholder);
  }
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    const row = vm.runInContext('_renderSourceItemRow(' + JSON.stringify({ id: 'src-x' })
      + ', { color: "#fff" }, ' + JSON.stringify(item) + ', 0)', sandbox);
    for (const frag of ['扫描版', '共 12 页', '发送时转图']) {
      if (!row.includes(frag)) throw new Error('条目行缺「' + frag + '」：' + row);
    }
  } finally {
    sandbox.escapeHtml = realEsc;
  }
});

// ===== T381（2026-10-23）：附图接其余发送链 =====
check('附图收集路线与上下文同源：普通节点收全祖先、配方 first_inbound 只收单父链', () => {
  // 图形：S2 → A(in-1)、S1 → A(in-0)、A → D。单父链＝取 A 的第一条入边（S2），
  // 全祖先＝两条都收。图必须跟 workflowContext 的取材路一致，否则「证据」与
  // 「随消息发的图」来自两套节点集合。
  seedNode([{ id: 'itS1', kind: 'image', name: 'S1 图', text: '', fileId: 'doc_s1' }]);
  const extra = {
    s2: { id: 's2', kind: 'source', x: 0, y: 0, messageIndex: -1, timestamp: 2, items: [{ id: 'itS2', kind: 'image', name: 'S2 图', text: '', fileId: 'doc_s2' }] },
    a: { id: 'a', kind: 'module', moduleKey: 'physics', x: 0, y: 0, messageIndex: -1, timestamp: 3, items: [], content: '' },
    d: { id: 'd', kind: 'module', moduleKey: 'math', x: 0, y: 0, messageIndex: -1, timestamp: 4, items: [], content: '' },
  };
  vm.runInContext([
    'graphView.nodes.push(' + JSON.stringify(extra.s2) + ');',
    'graphView.nodeById["s2"] = graphView.nodes[graphView.nodes.length - 1];',
    'graphView.nodes.push(' + JSON.stringify(extra.a) + ');',
    'graphView.nodeById["a"] = graphView.nodes[graphView.nodes.length - 1];',
    'graphView.nodes.push(' + JSON.stringify(extra.d) + ');',
    'graphView.nodeById["d"] = graphView.nodes[graphView.nodes.length - 1];',
    'graphView.edges = [',
    '  { from: "s2", fromPort: "out-0", to: "a", toPort: "in-1", custom: true },',
    '  { from: "src-test", fromPort: "out-0", to: "a", toPort: "in-0", custom: true },',
    '  { from: "a", fromPort: "out-0", to: "d", toPort: "in-0", custom: true }',
    '];',
  ].join(' '), sandbox);
  const pathIds = vm.runInContext('_collectUpstreamImages(graphView.nodeById["d"]).map(r => r.fileId)', sandbox);
  // 全祖先按后序（边表顺序递归）：A 的第一条入边 S2 先收、再 S1——配额也按这个顺序分
  if (pathIds.join(',') !== 'doc_s2,doc_s1') throw new Error('普通节点应收全祖先的图，实际 ' + pathIds.join(','));
  vm.runInContext('graphView.nodeById["d"].recipeId = "r1"; graphView.nodeById["d"].recipe = { aggregation: "first_inbound" };', sandbox);
  const inboundIds = vm.runInContext('_collectUpstreamImages(graphView.nodeById["d"]).map(r => r.fileId)', sandbox);
  if (inboundIds.join(',') !== 'doc_s2') throw new Error('first_inbound 只收单父链（A 的第一条入边），实际 ' + inboundIds.join(','));
  if (vm.runInContext('_workflowContextRoute(graphView.nodeById["d"])', sandbox) !== 'inbound') {
    throw new Error('_workflowContextRoute 应与 _collectWorkflowContext 的判定一致');
  }
});

check('附图取字节分流源码契约：页图走 pdf_pages 路由、原图走 files 路由（真机行为另验）', () => {
  // 取字节分流是异步 fetch，本域前面的异步发送用例已占用全局桩（AGENTS 硬规则 4：
  // 两条异步用例不可替换同一全局桩），这里按源码契约钉住分流形状
  const wfSrc = readFileSync(new URL('../../src/static/js/graph-workflow.js', import.meta.url), 'utf8');
  if (!wfSrc.includes('_sourcePdfPageDataUrl(ref.fileId, ref.page)')) {
    throw new Error('页图未走 pdf_pages 取图口');
  }
  if (!wfSrc.includes('_sourceImageDataUrl(ref.fileId)')) throw new Error('原图未走 files 取图口');
  if (!wfSrc.includes('return dataUrls.length ? dataUrls : null;')) {
    throw new Error('一张都取不到必须回落 null（纯文本发送）');
  }
  const customSrc = readFileSync(new URL('../../src/static/js/graph-custom.js', import.meta.url), 'utf8');
  if (!customSrc.includes('/api/input/pdf_pages?fileId=')) throw new Error('页转图端点未接');
  if (!customSrc.includes('item.scanned = data.pdf.scanned === true;')) throw new Error('ingest 的扫描版标记未落条目');
});

check('附图发送与回落：带图直发；4xx 去图重发一次并提示开 OCR；5xx 原样抛', async () => {
  // 本文件异步用例在 drain() 的 Promise.all 里并发收口（addSourceText 还挂着
  // 20ms 回填计时器）——本用例全程不碰共享 graphView：按口收集打桩（它有专门
  // 的同步用例盖着），只单测发送 helper 的附图与回落逻辑，零共享状态
  const prevCollect = sandbox._collectUpstreamImages;
  const prevBmp = sandbox._sourceImageDataUrl;
  const prevChat = sandbox.proxyChatWithModel;
  const realToast = sandbox.showToast;
  const toasts = [];
  sandbox.showToast = msg => toasts.push(msg);
  sandbox._collectUpstreamImages = () => [{ fileId: 'doc_img1', name: '受力图' }];
  sandbox._sourceImageDataUrl = async () => 'data:image/png;base64,AAA';
  const targetNode = { id: 'd9', kind: 'module' };
  const slotCall = { model: { provider: 'x', model: 'm', apiKey: 'k', baseUrl: 'https://u' }, role: 'agent' };
  try {
    let gotPayload = null;
    sandbox.proxyChatWithModel = async (model, body) => { gotPayload = body; return { ok: true, status: 200 }; };
    await sandbox._workflowSendWithImages(targetNode, slotCall, { prompt: 'p' }, undefined);
    if (!gotPayload || !Array.isArray(gotPayload.images) || gotPayload.images[0] !== 'data:image/png;base64,AAA') {
      throw new Error('发送 payload 应带压好的图');
    }
    const calls = [];
    sandbox.proxyChatWithModel = async (model, body) => {
      calls.push(body);
      if (body.images) throw new Error('API 400: bad image');
      return { ok: true, status: 200, retried: true };
    };
    const resp = await sandbox._workflowSendWithImages(targetNode, slotCall, { prompt: 'p' }, undefined);
    if (calls.length !== 2 || !calls[0].images || calls[1].images) throw new Error('4xx 应恰好去图重发一次（首发带图、重发无图）');
    if (!resp.retried) throw new Error('回落响应应原样返回调用方');
    if (!toasts.some(t => String(t).includes('图片自动转文字'))) throw new Error('回落必须提示开 OCR：' + toasts.join('|'));
    sandbox.proxyChatWithModel = async () => { throw new Error('API 500: boom'); };
    let threw = null;
    try { await sandbox._workflowSendWithImages(targetNode, slotCall, { prompt: 'p' }, undefined); } catch (e) { threw = e; }
    if (!threw || !String(threw.message).includes('500')) throw new Error('5xx 不该走去图回落');
  } finally {
    sandbox._collectUpstreamImages = prevCollect;
    sandbox._sourceImageDataUrl = prevBmp;
    sandbox.proxyChatWithModel = prevChat;
    sandbox.showToast = realToast;
  }
  return true;
});

// ===== addSourceText：本地建条目（≤8000 不走网络）与超长走 ingest（fetch 桩）=====
check('addSourceText：短文本本地入篮；超长文本走 ingest 落盘并回填截断', async () => {
  seedNode([]);
  const realUndo = sandbox._pushGraphUndo;
  const realRender = sandbox.renderGraphCanvas;
  const realSave = sandbox.saveGraphState;
  sandbox._pushGraphUndo = () => {};
  sandbox.renderGraphCanvas = () => {};
  sandbox.saveGraphState = () => {};
  sandbox.window.getGraphState = () => ({ connections: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, customNodes: [], positions: {} });
  sandbox.window.saveGraphState = () => {};
  const prevFetch = sandbox.fetch;
  let ingestCalls = 0;
  sandbox.fetch = async (url, init) => {
    if (String(url).includes('/api/input/ingest')) {
      ingestCalls++;
      const body = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, fileId: 'doc_stub', fileName: body.fileName, kind: 'text',
          text: '回'.repeat(8000), chars: 9000, truncated: true,
          mime: 'text/plain', size: 9000,
          ocr: { status: 'none', engine: '', ms: 0, error: '' },
        }),
      };
    }
    return prevFetch(url, init);
  };
  try {
    // 短文本：本地直接建条目，零网络
    sandbox.addSourceText('src-test', ' 一道简谐运动的题 ');
    const node1 = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
    if (node1.items.length !== 1 || node1.items[0].text !== '一道简谐运动的题') throw new Error('短文本应本地入篮');
    if (node1.items[0].kind !== 'text' || !node1.items[0].id) throw new Error('条目缺 kind/id');
    if (!String(node1.content).includes('一道简谐运动的题')) throw new Error('node.content 未同步拼接');
    // 超长：占位立即出现（chars 已知），ingest 回来后回填
    const longText = '长'.repeat(8100);
    sandbox.addSourceText('src-test', longText);
    const node2 = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
    if (node2.items.length !== 2) throw new Error('超长文本占位条目应立即出现');
    await new Promise(r => setTimeout(r, 20));
    const node3 = vm.runInContext('graphView.nodeById["src-test"]', sandbox);
    if (ingestCalls !== 1) throw new Error('超长文本应恰好调一次 ingest，实际 ' + ingestCalls);
    const filled = node3.items[1];
    if (filled.fileId !== 'doc_stub' || filled.text.length !== 8000 || !filled.truncated || filled.chars !== 9000) {
      throw new Error('ingest 回填失败：fileId=' + filled.fileId + ' len=' + filled.text.length + ' truncated=' + filled.truncated);
    }
  } finally {
    sandbox._pushGraphUndo = realUndo;
    sandbox.renderGraphCanvas = realRender;
    sandbox.saveGraphState = realSave;
    sandbox.fetch = prevFetch;
    delete sandbox.window.getGraphState;
    delete sandbox.window.saveGraphState;
    vm.runInContext('graphView.nodes = []; graphView.edges = []; graphView.nodeById = {};', sandbox);
  }
  return true;
});

await drain();
}
