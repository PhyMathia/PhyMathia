// Knowledge extraction battery: tests /api/extract_knowledge with real models. Run:
//   node scripts/knowledge_battery.mjs [baseUrl] [model] [outJson] [onlyIds]
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:5052';
const MODEL = process.argv[3] || 'deepseek-v4-flash-free';
const MODEL_CFG = { provider: 'opencode', api_key: '', model: MODEL, base_url: 'https://opencode.ai/zen/v1' };

const scenarios = [
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
    data = await callChat(sc);
  } catch (e) {
    err = e.message;
  }
  const score = err ? { passed: false, issues: ['请求失败: ' + err] } : scoreScenario(sc, data);
  const status = err ? 'network_error' : (data && data.error ? 'error' : 'ok');
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
