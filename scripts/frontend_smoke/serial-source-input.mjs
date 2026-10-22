// 串行边界：输入节点（素材篮，2026-10-22 重做）
// 一条素材 = 一个条目 = 一个出口（out-i ↔ items[i]）。覆盖：三入口渲染、端口=条目、
// 折叠态出口改走输出列（2026-10-22 修复）、删中间条目边重排、两口按口取材不混料、
// 旧数据只读分支、命名/OCR 状态文案、addSourceText 本地建条目与超长走 ingest（fetch 桩）。
// 本文件有用例会 await 且替换全局 fetch 桩——串行域契约（见 AGENTS.md 硬规则 4），
// 执行顺序由 ../frontend_smoke.mjs 调用序列决定，收口线 drain() 之前注册完毕。
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
    if (html.includes('add-output-port') && html.includes('graph-add-port-btn')) {
      throw new Error('素材篮不该有加输出端口入口（端口=条目）');
    }
    // 旧数据（items 知识点形状）：只读分支——不渲染条目行/输入区，保留 AI 整理关系
    seedNode([{ id: 'n1', title: '牛顿定律', summary: 'F=ma' }], { fileName: '讲义.pdf', fileId: 'doc_x' });
    const legacyHtml = vm.runInContext('_renderSourceNodeHtml(graphView.nodeById["src-test"], { portCounts: {} })', sandbox);
    if (!legacyHtml.includes('graph-source-legacy') || !legacyHtml.includes('openHarnessOrganizeRelations')) {
      throw new Error('旧数据应走只读分支并保留 AI 整理关系');
    }
    if (legacyHtml.includes('addSourceTextFromCard')) throw new Error('旧数据不提供新输入入口');
    if (legacyHtml.includes('解析中')) throw new Error('旧数据只读分支不该有 busy 态');
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

check('素材篮端口＝条目：out-i ↔ items[i]，新条目 type 留空、旧条目 type=knowledge', () => {
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
  // 旧条目口保持 knowledge（拖空直建知识点，旧快捷方式不失效）
  seedNode([{ id: 'n1', title: '牛顿定律' }]);
  const legacyPorts = vm.runInContext('_nodeBaseOutputPorts(graphView.nodeById["src-test"], [])', sandbox);
  if (legacyPorts[0].type !== 'knowledge' || legacyPorts[0].label !== '牛顿定律') {
    throw new Error('旧条目口应保持 type=knowledge 与 title 名');
  }
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
