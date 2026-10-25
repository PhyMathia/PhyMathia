#!/usr/bin/env node
// 上下文预算闸门（2026-10-24 新增）
// 用法：node scripts/check_context_budget.mjs [--root DIR]
//
// 为什么：token 开销 ≈ 轮数 × 每轮上下文。AGENTS.md 随系统提示**每一轮都注入**，
// backlog/日志摘要是**每次开工都要读**的路由表——这三件涨一倍，所有会话的账单就涨一倍。
// 2026-09-27 定的「只留当月、每天一行」契约靠人肉执行，22 天后摘要从 5,922 涨到
// 57,850 字符（×9.8）。软纪律会反弹，所以这里把它变成会红的闸门。
//
// 口径：字符数（不是字节，中文 1 字 3 字节，用字节会吓自己 3 倍）。超限 exit 1。
// 已挂进 `npm run verify`（跑前先闸门，2ms，不拖慢验证）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const root = path.resolve(opt('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));

// 上限＝2026-10-24 实测值持平（棘轮：只许不涨，涨了就红，别默默放宽）
const BUDGETS = [
  { file: 'AGENTS.md', max: 11000, hint: '每一轮都随系统注入，最贵的一件；新规则优先并进已有条目，别加节' },
  { file: 'docs/backlog.md', max: 16000, hint: '条目做完就移进 docs/backlog-archive.md（正文不留完工过程）' },
  // 摘要留 1.4 万：常态 6–8k，余量给「当天块特别厚」的日子（当天块不能压，
  // 压了就等于丢了当天细节）；当天块本身超过 6k 时另有警示，见下面 todayBlockWarn。
  { file: 'docs/日志/日志摘要.md', max: 10000, hint: 'node scripts/compact_digest.mjs（留当天全量，更早的压成一行索引）' },
];

// 当天块厚度警示（不红，只提醒）：这块是给「接上下文」用的，不是第二份日志。
// 2026-10-24 实测 10-24 块 41 行 / 4,071 字符、10-01 块 80 行 / 10,050 字符——正是摘要涨 9.8 倍的主因。
const TODAY_BLOCK_WARN = 6000;

const tokenEst = s => {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk * 0.7 + (s.length - cjk) * 0.28);
};

let failed = false;
let total = 0;
let totalTok = 0;
console.log('上下文预算（字符 / 上限，超过即红）');
for (const { file, max, hint } of BUDGETS) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) {
    console.log(`  ⚠️  ${file} 不存在，跳过`);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  const chars = text.length;
  total += chars;
  totalTok += tokenEst(text);
  const ok = chars <= max;
  if (!ok) failed = true;
  const pct = Math.round((chars / max) * 100);
  console.log(`  ${ok ? '✓' : '❌'} ${file.padEnd(26)} ${String(chars).padStart(7)} / ${String(max).padStart(6)}  (${pct}%)  ≈${String(tokenEst(text)).padStart(6)} token${ok ? '' : `\n     → ${hint}`}`);
}
// 当天块厚度：摘要里 `## <今天>` 到下个 `## ` 之间的字符数
const summaryAbs = path.join(root, 'docs', '日志', '日志摘要.md');
if (fs.existsSync(summaryAbs)) {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const lines = fs.readFileSync(summaryAbs, 'utf8').split('\n');
  const start = lines.findIndex(l => l.trim() === `## ${today}`);
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { end = i; break; }
    const body = lines.slice(start + 1, end);
    const chars = body.join('\n').length;
    const bullets = body.filter(l => /^\s*- /.test(l)).length;
    if (chars > TODAY_BLOCK_WARN) {
      console.log(`  ⚠️  今日块（${today}）${bullets} 条 / ${chars} 字符，超过 ${TODAY_BLOCK_WARN} 的提醒线`);
      console.log('     → 摘要只写「做了什么 + 关键数字 + 当日日志小节锚」一行；过程、踩坑、回归清单留在当日日志');
    }
  }
}

console.log(`  合计（开工必读三件）：${total.toLocaleString()} 字符 ≈ ${totalTok.toLocaleString()} token`);
console.log(`  参考：40 轮会话仅重读这三件 ≈ ${(totalTok * 40).toLocaleString()} token`);

if (failed) {
  console.log('❌ 上下文预算超限——省 token 的结构又反弹了，按上面的提示收口');
  process.exit(1);
}
console.log('✓ 上下文预算在限内');
