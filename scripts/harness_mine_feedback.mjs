#!/usr/bin/env node
// Harness 数据挖掘：把用户差评（data/harness_feedback.json）与真实用量日志
// （logs/harness_usage.jsonl）变成可复核的坏例清单——数据闭环的「读」端。
// 跑法：node scripts/harness_mine_feedback.mjs [feedbackPath] [usagePath] [outJson]
// 输出：控制台人读报告；传 outJson 时另存结构化结果（供补 battery 场景参考）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FEEDBACK = process.argv[2] || path.join(ROOT, 'data/harness_feedback.json');
const USAGE = process.argv[3] || path.join(ROOT, 'logs/harness_usage.jsonl');
const OUT = process.argv[4] || '';

const SLOW_MS = 90000; // 单次请求 >90s 视为长延迟（线上痛点口径，见 iteration-log）
const HIGH_CALLS = 3;  // model_calls >= 3 视为多次重试（烧时延的主要形态）
const TOP_N = 10;

function loadFeedback() {
  if (!fs.existsSync(FEEDBACK)) return [];
  try {
    const items = JSON.parse(fs.readFileSync(FEEDBACK, 'utf-8'));
    return Array.isArray(items) ? items : [];
  } catch (e) {
    console.error('反馈文件解析失败：' + e.message);
    return [];
  }
}

function loadUsage() {
  if (!fs.existsSync(USAGE)) return [];
  const rows = [];
  for (const line of fs.readFileSync(USAGE, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return rows;
}

function errorBucket(err) {
  const e = String(err || '');
  if (/MissingSessionID|can only be used in OpenCode/i.test(e)) return 'opencode 会话头缺失（已修复：x-opencode-session）';
  if (/FreeUsageLimit|Rate limit|429/i.test(e)) return '限流 429';
  if (/401|Invalid API key|Unauthorized|AuthError/i.test(e)) return '鉴权失败 401';
  if (/Model is unavailable|server_error|503|Upstream request failed/i.test(e)) return '上游模型不可用';
  if (/timeout|Timed out|timed out/i.test(e)) return '超时';
  if (/不是合法 JSON|parse|缺少有效内容|截断/i.test(e)) return '模型输出解析失败';
  if (/快照过大/i.test(e)) return '快照超限';
  return '其他';
}

function fmtTs(ts) {
  const n = Number(ts);
  if (!n || Number.isNaN(n)) return '?';
  // 用量日志是秒级浮点；容错兼容毫秒（13 位以上数值）
  const d = new Date(n > 1e12 ? n : n * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

const feedback = loadFeedback();
const usage = loadUsage();
const reviews = usage.filter(r => (r.endpoint || '') === 'review');
const fmt = (label, fn) => { console.log('\n===== ' + label + ' ====='); fn(); };

let report = { feedback_total: feedback.length, usage_total: usage.length };

if (usage.length) {
  const times = usage.map(r => r.ts || 0).filter(Boolean);
  report.time_range = times.length ? [fmtTs(Math.min(...times)), fmtTs(Math.max(...times))] : [];
  console.log('PhyMathia Φ 数据挖掘报告  （数据范围 ' + report.time_range.join(' ~ ') + '）');
  console.log('反馈 ' + feedback.length + ' 条 · 用量 ' + usage.length + ' 条（review ' + reviews.length + '）');
}

fmt('① 错误分桶（按可行动性归组）', () => {
  const errs = reviews.filter(r => r.status === 'error');
  const buckets = new Map();
  for (const r of errs) {
    const b = errorBucket(r.error);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [b, rows] of sorted) {
    const latest = Math.max(...rows.map(r => r.ts || 0));
    console.log('  ' + String(rows.length).padStart(4) + '  ' + b + '（最近 ' + fmtTs(latest) + '）');
  }
  report.error_buckets = Object.fromEntries(sorted.map(([b, rows]) => [b, rows.length]));
});

fmt('② 长延迟 TOP（>' + Math.round(SLOW_MS / 1000) + 's，model_calls 区分「次数多」vs「单次慢」）', () => {
  const slow = reviews
    .filter(r => (r.latency_ms || 0) > SLOW_MS)
    .sort((a, b) => (b.latency_ms || 0) - (a.latency_ms || 0))
    .slice(0, TOP_N);
  for (const r of slow) {
    const attr = (r.model_calls || 0) >= 2 ? '重试×' + r.model_calls : '单次慢';
    console.log('  ' + Math.round((r.latency_ms || 0) / 1000) + 's  ' + attr
      + '  [' + (r.status || '?') + '] ' + String(r.instruction || '').slice(0, 40));
  }
  report.slow_count = reviews.filter(r => (r.latency_ms || 0) > SLOW_MS).length;
});

fmt('③ 高重试且最终成功（model_calls ≥ ' + HIGH_CALLS + '，重试循环的真实成本）', () => {
  const heavy = reviews
    .filter(r => (r.model_calls || 0) >= HIGH_CALLS && r.status !== 'error')
    .sort((a, b) => (b.model_calls || 0) - (a.model_calls || 0))
    .slice(0, TOP_N);
  if (!heavy.length) console.log('  （无）');
  for (const r of heavy) {
    console.log('  ×' + r.model_calls + '  ' + Math.round((r.latency_ms || 0) / 1000) + 's  ops=' + (r.ops_count || 0)
      + '  ' + String(r.instruction || '').slice(0, 44));
  }
  report.heavy_retry_count = reviews.filter(r => (r.model_calls || 0) >= HIGH_CALLS && r.status !== 'error').length;
});

fmt('④ 烧多次调用却输出空操作（重试换不来 ops，重点排查）', () => {
  const wasted = reviews
    .filter(r => (r.model_calls || 0) >= 2 && r.status === 'no_ops' && (r.ops_count || 0) === 0)
    .sort((a, b) => (b.model_calls || 0) - (a.model_calls || 0))
    .slice(0, TOP_N);
  if (!wasted.length) console.log('  （无）');
  for (const r of wasted) {
    console.log('  ×' + r.model_calls + '  ' + Math.round((r.latency_ms || 0) / 1000) + 's  '
      + String(r.instruction || '').slice(0, 44));
  }
  report.wasted_noops_count = reviews.filter(r => (r.model_calls || 0) >= 2 && r.status === 'no_ops').length;
});

fmt('⑤ 用户差评（kind=bad，逐条列出——补 battery 场景的第一来源）', () => {
  const bad = feedback.filter(f => String(f.kind) === 'bad');
  if (!bad.length) console.log('  （无差评）');
  for (const f of bad) {
    console.log('  [' + fmtTs(f.ts) + '] ' + String(f.instruction || '').slice(0, 50));
    console.log('      摘要: ' + String(f.summary || '').slice(0, 70));
    if (f.note) console.log('      备注: ' + String(f.note).slice(0, 100));
  }
  report.bad_feedback = bad.map(f => ({ ts: f.ts, instruction: f.instruction, note: f.note || '' }));
});

fmt('⑥ 好评画像（kind=good，用户认可什么样的回答）', () => {
  const good = feedback.filter(f => String(f.kind) !== 'bad');
  for (const f of good.slice(-5)) {
    console.log('  [' + fmtTs(f.ts) + '] ' + String(f.instruction || '').slice(0, 40) + ' → ops=' + (f.ops_count || 0));
  }
});

console.log('\n提示：把 ⑤ 的差评与 ③④ 的高成本指令对参，可转化为 scripts/harness_battery.mjs 的'
  + ' feedbackScenarios 新场景（参照 fb-* 的 expect 写法）；修复后重跑电池闭环。');

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf-8');
  console.log('结构化结果已写入 ' + OUT);
}
