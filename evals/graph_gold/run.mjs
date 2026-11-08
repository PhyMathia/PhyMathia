#!/usr/bin/env node
// 改图金样集运行器（Φ 改图模式的质量尺子）。
//
// 三条命令：
//   node evals/graph_gold/run.mjs --selftest        纯本地验证评分器（秒级，零服务）
//   node evals/graph_gold/run.mjs --mock           自带 mock 上游＋隔离实例，验管道／建基线
//   node evals/graph_gold/run.mjs --server --model-file my.json   真模型，出质量读数
//
// 环境保护（AGENTS.md 硬规则 4 / T415）：默认自带「临时数据目录第二实例」，
// 绝不连 5050；--base-url 只用于用户自己起的隔离实例，:5050/:5051 直接拒跑。
// 真机模式不并进 npm run verify（每次都是 N 次模型往返，太贵）——改提示词／换模型
// 前后各手动跑一次，用 --label + --compare 对比。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { graphById } from '../../scripts/harness_graphs.mjs';
import { startIsolatedServer } from '../../scripts/lib/test_server.mjs';
import { gradeCase, diffBaseline, selftest, BUCKETS, BUCKET_LABELS } from './grader.mjs';
import { installHttpFetch } from './http_fetch.mjs';

// 本机设了 HTTP_PROXY 却没设 NO_PROXY；curlFetch 与隔离实例里的 httpx 都要
// 直连 127.0.0.1，显式放行，避免本机请求被代理吞掉（远端真机 URL 仍走代理）。
const NO_PROXY = [process.env.NO_PROXY || process.env.no_proxy, '127.0.0.1', 'localhost']
  .filter(Boolean).join(',');
process.env.NO_PROXY = NO_PROXY;
process.env.no_proxy = NO_PROXY;

// 必须在任何 fetch（含 startIsolatedServer 内部的 /health 探活）之前装好。
installHttpFetch();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REPORTS = join(ROOT, 'evals', 'reports');
const BASELINE = join(HERE, 'baseline.json');
const CASES_FILE = join(HERE, 'cases.jsonl');

const SERVER_PORT = 5090;   // 隔离实例（test_server.mjs 先探后占）
const MOCK_PORT = 5091;     // 金样专用 mock，避开通用 5065 与 5060/5061 坏端口
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

function help() {
  console.log(`改图金样集（Φ 改图模式质量尺子）

  --selftest                 纯本地验证评分器：断言两向／四桶归因／基线 diff／A/B 灵敏度
  --mock                     默认评测模式：自带 mock 上游＋隔离实例，零污染、零花费
  --server                   真机模式：需 --model-file，出真实质量读数
  --model-file <path>        真机模型配置 JSON：{provider, api_key, model, base_url}
  --base-url <url>           连用户自己起的隔离实例（默认脚本自带；拒绝 :5050/:5051）
  --degrade <N>              mock 模式专用：每第 N 条注入坏答案，验证尺子灵敏度
  --only <id1,id2>           只跑指定用例
  --label <name>             本次 run 另存为可对比标签（字母数字点下划线连字符）
  --save-baseline            把本次 pass_map 存为基线（确认改善后才覆盖）
  --compare <A> <B>          不跑评测，直接对比两个 --label 的报告
  --help                     本说明

常用流程：
  1) node evals/graph_gold/run.mjs --selftest
  2) node evals/graph_gold/run.mjs --mock                       （应满分）
  3) node evals/graph_gold/run.mjs --mock --degrade 2           （应明显变红，证明尺子有灵敏度）
  4) 改了 harness/prompts.py 或换了模型后，真机跑 --server 并 --label，再 --compare 基线`);
}

function loadCases() {
  const lines = readFileSync(CASES_FILE, 'utf8').split('\n').map((l) => l.trim());
  const cases = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const c = JSON.parse(line);
    if (c.graph) {
      const g = graphById(c.graph);
      if (!g) throw new Error(`用例 ${c.id} 引用了不存在的夹具 ${c.graph}`);
      c.snapshot = { version: 1, nodes: g.nodes, edges: g.edges };
    }
    if (!c.snapshot) throw new Error(`用例 ${c.id} 缺 graph / snapshot`);
    cases.push(c);
  }
  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`金样 id 重复：${c.id}`);
    ids.add(c.id);
  }
  return cases;
}

function runSelftest() {
  const r = selftest();
  console.log(`\n评分器自检：${r.passed}/${r.total} 通过`);
  for (const f of r.failed) console.log('  ❌ ' + f);
  if (r.failed.length) process.exitCode = 1;
  else console.log('  ✓ 断言两向、四桶归因、基线 diff、A/B 灵敏度全绿（尺子可用）');
}

function labelPath(name) { return join(REPORTS, `graph-gold-${name}.json`); }

function compare(a, b) {
  const read = (n) => {
    const p = labelPath(n);
    if (!existsSync(p)) throw new Error(`找不到标签报告 ${p}`);
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const A = read(a), B = read(b);
  const d = diffBaseline(B.pass_map || {}, A.pass_map || {});
  const pct = (r) => r && r.total ? ((r.passed / r.total) * 100).toFixed(1) + '%' : '-';
  console.log(`\n对比 ${a} → ${b}`);
  console.log(`  总分：${pct(A.score)} (${A.score?.passed}/${A.score?.total}) → ${pct(B.score)} (${B.score?.passed}/${B.score?.total})`);
  console.log(`  退步 ${d.regressions.length} 条${d.regressions.length ? '：' + d.regressions.join(', ') : ''}`);
  console.log(`  进步 ${d.improvements.length} 条${d.improvements.length ? '：' + d.improvements.join(', ') : ''}`);
  if (d.added.length) console.log(`  新增 ${d.added.length} 条：${d.added.join(', ')}`);
  if (d.removed.length) console.log(`  删除 ${d.removed.length} 条：${d.removed.join(', ')}`);
  const byBucket = {};
  for (const [k, v] of Object.entries(B.by_bucket || {})) byBucket[k] = `${A.by_bucket?.[k]?.passed ?? '-'} → ${v.passed}/${v.total}`;
  if (Object.keys(byBucket).length) {
    console.log('  按题目类别：');
    for (const [k, v] of Object.entries(byBucket)) console.log(`    ${k}: ${v}`);
  }
}

function renderMd(rep) {
  const pct = rep.score.total ? ((rep.score.passed / rep.score.total) * 100).toFixed(1) : '0.0';
  const L = [];
  L.push(`# 改图金样集报告`);
  L.push('');
  L.push(`- 时间：${rep.generated_at}`);
  L.push(`- 模式：${rep.mode}${rep.degrade ? `（A/B 降级每 ${rep.degrade} 条）` : ''}`);
  L.push(`- 通过：**${rep.score.passed}/${rep.score.total}（${pct}%）**`);
  if (rep.baseline_diff) {
    const d = rep.baseline_diff;
    L.push(`- 与基线对比：退步 ${d.regressions.length} / 进步 ${d.improvements.length} / 新增 ${d.added.length} / 删除 ${d.removed.length}`);
    if (d.regressions.length) L.push(`  - 退步题：${d.regressions.join(', ')}`);
  }
  L.push('');
  L.push('## 失败归因（四桶）');
  L.push('');
  L.push('| 桶 | 失败用例数 | 占比 |');
  L.push('|---|---|---|');
  const failedCount = rep.results.filter((r) => !r.pass).length;
  for (const b of BUCKETS) {
    const n = rep.results.filter((r) => r.primary === b).length;
    L.push(`| ${b} ${BUCKET_LABELS[b]} | ${n} | ${failedCount ? ((n / failedCount) * 100).toFixed(0) + '%' : '0%'} |`);
  }
  L.push('');
  L.push('## 按题目类别');
  L.push('');
  L.push('| 类别 | 通过/总 | 通过率 |');
  L.push('|---|---|---|');
  for (const [k, v] of Object.entries(rep.by_bucket)) {
    L.push(`| ${k} | ${v.passed}/${v.total} | ${((v.passed / v.total) * 100).toFixed(0)}% |`);
  }
  L.push('');
  L.push('## 逐条明细');
  L.push('');
  L.push('| id | 类别 | 结果 | 主桶 | 原因 |');
  L.push('|---|---|---|---|---|');
  for (const r of rep.results) {
    const reason = r.failures.map((f) => `[${BUCKET_LABELS[f.bucket] || f.bucket}] ${f.msg}`).join('；').replace(/\|/g, '\\|') || '—';
    L.push(`| ${r.id} | ${r.bucket} | ${r.pass ? '✓' : '✗'} | ${r.primary ? BUCKET_LABELS[r.primary] : '—'} | ${reason} |`);
  }
  L.push('');
  return L.join('\n');
}

// 本机 python3 被 PATH 解析到托管 3.13（未装 uvicorn），共享的
// startIsolatedServer 内部 spawn('python3') 会起不来。探测到系统 Python 有依赖
// 就把 /usr/bin 提前，让共享收敛口照常复用（不复制一份隔离实例代码）。
function ensureServerPython() {
  const probe = spawnSync('/usr/bin/python3', ['-c', 'import uvicorn, fastapi'], { encoding: 'utf8' });
  if (probe.status === 0) {
    process.env.PATH = '/usr/bin:' + (process.env.PATH || '');
    return '/usr/bin/python3';
  }
  return 'python3';
}

async function waitHealth(base, ms = 15000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(900) })).ok) return true; } catch { /* 等启动 */ }
    await wait(300);
  }
  throw new Error('health 超时：' + base);
}

async function runEval() {
  const PY = ensureServerPython();
  let cases = loadCases();
  const only = val('--only', '');
  if (only) {
    const set = new Set(only.split(',').map((s) => s.trim()));
    cases = cases.filter((c) => set.has(c.id));
    if (!cases.length) throw new Error('--only 没匹配到任何用例');
  }

  const serverMode = has('--server');
  const degrade = Number(val('--degrade', '0')) || 0;
  const baseOverride = val('--base-url', '');
  const modelFile = val('--model-file', '');
  if (degrade && serverMode) throw new Error('--degrade 只能用于 --mock（真机不能注入坏答案）');
  if (baseOverride && /:505[01](\D|$)/.test(baseOverride)) {
    throw new Error('拒绝连接 5050/5051（用户日常实例）。请让脚本自带隔离实例，或用自己起的隔离端口。');
  }
  if (serverMode && !modelFile) {
    throw new Error('--server 需要 --model-file <path>（模型配置 {provider, api_key, model, base_url}）；脚本不会默认读任何账号配置');
  }

  const MODEL = serverMode
    ? JSON.parse(readFileSync(modelFile, 'utf8'))
    : { provider: 'opencode-go', api_key: 'mock', model: 'gold-1', base_url: `http://127.0.0.1:${MOCK_PORT}/v1` };

  let mock = null, srv = null;
  const cleanup = () => {
    try { if (srv) srv.stop(); } catch { /* 已停 */ }
    try { if (mock) mock.kill(); } catch { /* 已停 */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  let base;
  try {
    if (!serverMode) {
      // 本机 Node 22 只要 http.createServer + listen 就会初始化 undici 的
      // lazyllhttp WASM 并 OOM（最简脚本即崩，覆盖 fetch / 换 Node 版本均无效），
      // 故 mock 上游用 Python stdlib 承载；与隔离实例共用同一解释器。
      mock = spawn(PY, [join(HERE, 'mock.py')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(MOCK_PORT), GOLD_DEGRADE_EVERY: String(degrade) },
      });
      let mockLog = '';
      mock.stdout.on('data', (d) => { mockLog += d; });
      mock.stderr.on('data', (d) => { mockLog += d; });
      await waitHealth(`http://127.0.0.1:${MOCK_PORT}`, 8000).catch((e) => { throw new Error(e.message + '\n' + mockLog.slice(-800)); });
      const reg = await fetch(`http://127.0.0.1:${MOCK_PORT}/__cases`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cases),
      });
      if (!reg.ok) throw new Error('注册金样到 mock 失败');
      console.log(`[graph-gold] mock 已注册 ${cases.length} 条金样${degrade ? `，降级每 ${degrade} 条` : ''}`);
    }

    if (baseOverride) {
      base = baseOverride.replace(/\/$/, '');
      await waitHealth(base);
      console.log(`[graph-gold] 连外部隔离实例 ${base}`);
    } else {
      console.log('[graph-gold] 服务 Python：' + PY);
      srv = await startIsolatedServer({ port: SERVER_PORT, label: 'phymathia-graph-gold' });
      base = srv.base;
      console.log(`[graph-gold] 隔离实例 ${base}（临时数据目录，真实 data/ 零写入）`);
    }

    const results = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const payload = {
        snapshot: c.snapshot,
        instruction: c.instruction,
        model: MODEL,
        max_tokens: 2000,
        phase: c.phase || 'normal',
        level: c.level || 'university',
        focus_node_ids: c.focus || [],
        harness_history: [],
        previous_ops: [],
        previous_snapshot: null,
        retries: 0,
        self_check: 'off',
        stream: false,
      };
      let data = null;
      let sendError = '';
      try {
        const r = await fetch(base + '/api/harness/graph/review', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(120000),
          timeoutSec: 90,   // curlFetch 专用：盖住后端 60s 客户端 / 90s 上游与重试退避
        });
        data = await r.json();
      } catch (e) {
        sendError = String(e && e.message || e);
        // 超时/连不上时把隔离实例日志尾带出来，省得再复跑一轮猜原因。
        if (srv && typeof srv.logTail === 'function') {
          const tail = srv.logTail(600).trim().replace(/\s+/g, ' ');
          if (tail) sendError += '\n[隔离实例日志尾] ' + tail;
        }
      }
      const g = gradeCase(c, data);
      if (sendError) g.failures.unshift({ bucket: 'protocol', msg: '发送失败：' + sendError });
      const pass = !sendError && g.pass;
      const primary = BUCKETS.find((b) => g.failures.some((f) => f.bucket === b)) || null;
      results.push({
        id: c.id, bucket: c.bucket || '-', pass, primary,
        failures: g.failures, buckets: g.buckets,
        status: data?.status ?? null, ops: Array.isArray(data?.operations) ? data.operations.length : null,
      });
      process.stdout.write(`${pass ? '✓' : '✗'} ${c.id} (${i + 1}/${cases.length})${pass ? '' : ' → ' + (g.failures[0]?.msg || '').slice(0, 90)}\n`);
    }

    const byBucket = {};
    for (const r of results) {
      if (!byBucket[r.bucket]) byBucket[r.bucket] = { passed: 0, total: 0 };
      byBucket[r.bucket].total += 1;
      if (r.pass) byBucket[r.bucket].passed += 1;
    }
    const passMap = Object.fromEntries(results.map((r) => [r.id, r.pass]));
    const score = { passed: results.filter((r) => r.pass).length, total: results.length };

    let baselineDiff = null;
    if (existsSync(BASELINE)) {
      const baseData = JSON.parse(readFileSync(BASELINE, 'utf8'));
      baselineDiff = diffBaseline(passMap, baseData.pass_map || {});
    }

    const rep = {
      generated_at: new Date().toISOString(),
      mode: serverMode ? 'server' : 'mock',
      degrade: degrade || null,
      score, by_bucket: byBucket, results, pass_map: passMap,
      baseline_diff: baselineDiff,
    };
    mkdirSync(REPORTS, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonPath = join(REPORTS, `graph-gold-${ts}.json`);
    const mdPath = join(REPORTS, `graph-gold-${ts}.md`);
    writeFileSync(jsonPath, JSON.stringify(rep, null, 2), 'utf8');
    writeFileSync(mdPath, renderMd(rep), 'utf8');

    const label = val('--label', '');
    if (label) {
      if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('--label 只许字母数字点下划线连字符');
      writeFileSync(labelPath(label), JSON.stringify({ score, by_bucket: byBucket, pass_map: passMap }, null, 2), 'utf8');
    }
    if (has('--save-baseline')) {
      writeFileSync(BASELINE, JSON.stringify({ generated_at: rep.generated_at, label: label || '', score, pass_map: passMap }, null, 2), 'utf8');
      console.log('[graph-gold] 已保存基线 ' + BASELINE);
    }

    const pct = score.total ? ((score.passed / score.total) * 100).toFixed(1) : '0.0';
    console.log(`\n改图金样集：${score.passed}/${score.total}（${pct}%）${degrade ? ' [A/B 降级轮]' : ''}`);
    if (baselineDiff) {
      console.log(`与基线对比：退步 ${baselineDiff.regressions.length} / 进步 ${baselineDiff.improvements.length}${baselineDiff.regressions.length ? '，退步题：' + baselineDiff.regressions.join(', ') : ''}`);
    } else {
      console.log('（无基线；确认这轮是「好状态」后加 --save-baseline，以后每次自动 diff）');
    }
    console.log(`报告：${mdPath}`);
    console.log(`      ${jsonPath}`);

    // 回归门：有基线且出现退步才 exit 1；降级自检轮不拦（红是预期）。
    if (!degrade && baselineDiff && baselineDiff.regressions.length) process.exitCode = 1;
  } finally {
    cleanup();
  }
}

async function main() {
  if (has('--help') || has('-h')) return help();
  if (has('--compare')) {
    const i = argv.indexOf('--compare');
    return compare(argv[i + 1], argv[i + 2]);
  }
  if (has('--selftest')) return runSelftest();
  return runEval();
}

main().catch((e) => { console.error('❌ ' + (e && e.stack || e)); process.exitCode = 1; });
