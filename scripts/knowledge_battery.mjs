// Knowledge extraction battery: tests /api/documents/parse and /api/extract_knowledge
// with real models. Run:
//   node scripts/knowledge_battery.mjs [baseUrl] [model] [outJson] [onlyIds]
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:5052';
const MODEL = process.argv[3] || 'deepseek-v4-flash-free';
const MODEL_CFG = { provider: 'opencode', api_key: '', model: MODEL, base_url: 'https://opencode.ai/zen/v1' };

const T_BASIC = '简谐运动是物体在回复力作用下，偏离平衡位置的位移随时间按余弦规律变化的运动。回复力 F 与位移 x 成正比且方向相反，即 F=-kx（胡克定律）。由牛顿第二定律可得运动微分方程 m(d²x/dt²)+kx=0，其解为 x=Acos(ωt+φ)，其中角频率 ω=√(k/m)，周期 T=2π√(m/k)。振幅 A 由初始条件决定。简谐运动的能量在动能与势能之间相互转化，总机械能 E=½kA² 守恒。';

const T_MIXED = T_BASIC + '\n\n导数是函数在某一点的瞬时变化率，定义为 f\'(x)=lim(Δx→0)(Δy/Δx)。导数表示曲线切线的斜率，在物理上对应瞬时速度 v=dx/dt。';

const T_LONG = [
  T_BASIC,
  '牛顿第二定律 F=ma 是经典力学的核心，适用于宏观低速运动。动量定理 Ft=Δp 与能量守恒定律共同构成力学分析的基本工具。',
  '静电场中，电场强度 E=F/q，电势 φ=W/q。高斯定理 ∮E·dS=Q/ε₀ 描述电通量与电荷的关系。',
  '欧姆定律 U=IR，电阻串联 R=R1+R2，并联 1/R=1/R1+1/R2。基尔霍夫定律用于复杂电路分析。',
  '波动方程 ∂²y/∂t²=v²∂²y/∂x² 描述机械波的传播，波长 λ、频率 f 与波速 v 满足 v=λf。',
  '麦克斯韦方程组统一了电磁现象，包括高斯定律、法拉第定律和安培定律，预言了电磁波的存在。',
].join('\n\n');

const T_FORMULA = '麦克斯韦方程组：∇·E=ρ/ε₀，∇·B=0，∇×E=-∂B/∂t，∇×B=μ₀J+μ₀ε₀∂E/∂t。电磁波速度 c=1/√(μ₀ε₀)。洛伦兹力 F=q(E+v×B)。';

const T_EMPTY = '';

const T_APPLES = '今天天气很好，我去市场买了三斤苹果，苹果富含维生素，早上吃一个苹果对身体好。';

const scenarios = [
  {
    id: 'doc-basic', label: '文件提取：简谐运动段落', endpoint: 'doc',
    text: T_BASIC, fileName: '简谐运动.txt', maxItems: 5, level: 'university',
    expect: { minNodes: 1, maxNodes: 5, keyConcepts: ['简谐运动', '回复力'], titleClean: true, categoryValid: true, formulaValid: true },
  },
  {
    id: 'doc-mixed', label: '文件提取：物理+数学混合', endpoint: 'doc',
    text: T_MIXED, fileName: '混合.txt', maxItems: 6, level: 'university',
    expect: { minNodes: 1, maxNodes: 6, keyConcepts: ['导数', '简谐运动'], titleClean: true, categoryValid: true },
  },
  {
    id: 'doc-long', label: '文件提取：长文本（6 段）', endpoint: 'doc',
    text: T_LONG, fileName: '长文.txt', maxItems: 8, level: 'university',
    expect: { minNodes: 1, maxNodes: 8, keyConcepts: ['麦克斯韦'], titleClean: true, categoryValid: true },
  },
  {
    id: 'doc-empty', label: '文件提取：空文本（不应崩溃）', endpoint: 'doc',
    text: T_EMPTY, fileName: '空.txt', maxItems: 5, level: 'university',
    expect: { noCrash: true },
  },
  {
    id: 'doc-formula', label: '文件提取：公式密集', endpoint: 'doc',
    text: T_FORMULA, fileName: '公式.txt', maxItems: 5, level: 'university',
    expect: { minNodes: 1, maxNodes: 5, keyConcepts: ['麦克斯韦'], formulaValid: true, titleClean: true },
  },
  {
    id: 'doc-level-middle', label: '文件提取：中学难度', endpoint: 'doc',
    text: T_BASIC, fileName: '简谐运动.txt', maxItems: 5, level: 'middle',
    expect: { minNodes: 1, maxNodes: 5, noCrash: true },
  },
  {
    id: 'doc-level-research', label: '文件提取：科研难度', endpoint: 'doc',
    text: T_BASIC, fileName: '简谐运动.txt', maxItems: 5, level: 'research',
    expect: { minNodes: 1, maxNodes: 5, noCrash: true },
  },
  {
    id: 'doc-no-fabricate', label: '文件提取：非物理数学内容（不编造）', endpoint: 'doc',
    text: T_APPLES, fileName: '苹果.txt', maxItems: 5, level: 'university',
    expect: { noCrash: true, notFabricate: true },
  },
  {
    id: 'chat-extract', label: '聊天提取：含公式回答', endpoint: 'chat',
    messages: [
      { role: 'user', content: '什么是简谐运动？' },
      { role: 'assistant', content: '简谐运动是回复力与位移成正比的振动，公式为 <formula>F=-kx</formula>，位移 <formula>x(t)=A\\cos(\\omega t+\\varphi)</formula>。' },
    ],
    expect: { minNodes: 1, maxNodes: 5, keyConcepts: ['简谐运动'], formulaValid: true },
  },
  {
    id: 'chat-socratic', label: '聊天提取：苏格拉底追问（不应提取）', endpoint: 'chat',
    messages: [
      { role: 'user', content: '为什么回复力与位移成正比？' },
      { role: 'assistant', content: '[苏格拉底回答] 如果回复力不与位移成正比，运动还会是简谐的吗？', branchType: 'socratic' },
    ],
    expect: { emptyItems: true, noCrash: true },
  },
  {
    id: 'chat-thanks', label: '聊天提取：寒暄（不应编造）', endpoint: 'chat',
    messages: [
      { role: 'user', content: '谢谢，明白了' },
      { role: 'assistant', content: '不客气，有问题随时问我。' },
    ],
    expect: { noCrash: true },
  },
];

function toBase64(text) {
  return Buffer.from(String(text || ''), 'utf8').toString('base64');
}

function cleanTitle(t) {
  return String(t || '').trim();
}

function looksLikeFormula(latex) {
  const s = String(latex || '').trim();
  if (!s) return false;
  const core = s.replace(/^\$+/, '').replace(/\$+$/, '');
  return core.length > 1 && (/[\\^_{}=∫∑∮√±∞∇]/.test(core) || /\$/.test(s));
}

function scoreScenario(sc, data) {
  const issues = [];
  const ex = sc.expect || {};
  if (!data) { issues.push('无响应'); return { passed: false, issues }; }
  if (data.error) {
    if (ex.noCrash) return { passed: true, issues: [], note: '优雅错误: ' + String(data.error) };
    issues.push('接口错误: ' + JSON.stringify(data.error || data.detail || data.errors));
    return { passed: false, issues };
  }
  const nodes = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data.items) ? data.items : []);
  if (ex.minNodes != null && nodes.length < ex.minNodes) issues.push('节点数不足: ' + nodes.length + '/' + ex.minNodes);
  if (ex.maxNodes != null && nodes.length > ex.maxNodes) issues.push('节点数超限: ' + nodes.length + '>' + ex.maxNodes);
  if (ex.emptyItems && nodes.length) issues.push('应返回空结果，实际 ' + nodes.length + ' 条');
  if (ex.notFabricate) {
    const text = nodes.map(n => (n.title || '') + ' ' + (n.summary || '')).join(' ');
    if (nodes.length && !text.includes('苹果') && !text.includes('水果') && !text.includes('市场')) {
      issues.push('疑似编造了原文没有的概念: ' + nodes.map(n => n.title).slice(0, 5).join(','));
    }
  }
  for (const n of nodes) {
    const title = cleanTitle(n.title);
    if (!title) { issues.push('存在空标题'); continue; }
    if (ex.titleClean && (/^\d+\s*[.、．]/.test(title) || /^知识点\s*\d+$/i.test(title) || /^[【\[]/.test(title))) {
      issues.push('标题不干净: ' + title);
    }
    if (ex.categoryValid && n.category && !['physics', 'math', 'other'].includes(n.category)) {
      issues.push('category 非法: ' + n.category + '（' + title + '）');
    }
    if (ex.formulaValid) {
      for (const f of (n.formulas || [])) {
        if (!looksLikeFormula(f)) issues.push('公式格式可疑: ' + String(f).slice(0, 60));
      }
    }
  }
  if (ex.keyConcepts) {
    const hay = nodes.map(n => (n.title || '') + ' ' + (n.summary || '')).join(' ');
    for (const k of ex.keyConcepts) {
      if (!hay.includes(k)) issues.push('缺少关键概念: ' + k);
    }
  }
  return { passed: issues.length === 0, issues, nodeCount: nodes.length, titles: nodes.map(n => n.title).slice(0, 8) };
}

async function callDoc(sc) {
  const r = await fetch(BASE + '/api/documents/parse', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: sc.fileName || 'text.txt',
      contentBase64: toBase64(sc.text || ''),
      maxItems: sc.maxItems || 5,
      level: sc.level || 'university',
      ...MODEL_CFG,
    }),
    signal: AbortSignal.timeout(180000),
  });
  return await r.json();
}

async function callChat(sc) {
  const r = await fetch(BASE + '/api/extract_knowledge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: sc.messages || [], sessionId: 'test', level: 'university', ...MODEL_CFG }),
    signal: AbortSignal.timeout(180000),
  });
  return await r.json();
}

const only = process.argv[5] ? process.argv[5].split(',') : [];
const filtered = scenarios.filter(s => !only.length || only.includes(s.id));
const results = [];
let ri = 0;
for (const sc of filtered) {
  const t0 = Date.now();
  let data = null;
  let err = null;
  try {
    data = sc.endpoint === 'chat' ? await callChat(sc) : await callDoc(sc);
  } catch (e) {
    err = e.message;
  }
  const score = err ? { passed: false, issues: ['请求失败: ' + err] } : scoreScenario(sc, data);
  const status = err ? 'network_error' : (data && data.error ? 'error' : (data && (data.nodes || data.items) ? 'ok' : 'ok'));
  console.log('[' + (ri + 1) + '/' + filtered.length + '] ' + sc.id + ' (' + (Date.now() - t0) + 'ms) ' + (score.passed ? 'PASS' : 'FAIL'));
  if (!score.passed) console.log('   ' + score.issues.join('\n   '));
  results.push({ id: sc.id, label: sc.label, status, score, data: data ? { nodes: (data.nodes || data.items || []).slice(0, 10) } : null });
  ri++;
}
const passedCount = results.filter(r => r.score.passed).length;
console.log('\n===== 汇总: ' + passedCount + '/' + results.length + ' 通过 =====');
for (const r of results) console.log('- ' + r.id + ': ' + (r.score.passed ? 'PASS' : 'FAIL'));
const outFile = process.argv[4];
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
