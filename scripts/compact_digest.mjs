#!/usr/bin/env node
// 日志摘要压缩器（2026-10-24 新增，配合 scripts/check_context_budget.mjs 的配额闸门）
// 用法：node scripts/compact_digest.mjs [--check] [--days N] [--root DIR]
//   --check   只打印计划，不写盘
//   --days N  主文件保留最近 N 天全量块（默认 1＝当天）
//   --root    仓库根（测试口，默认本脚本所在仓库）
//
// 做什么：主文件 docs/日志/日志摘要.md 只留「最近 N 天」的当天全量块；更早的当月各天
// 整块搬进 docs/日志/日志摘要-YYYY-MM.md（按月），主文件在该月分组下留一行索引
// 「- 日期 · N 条 · 主题头1 / 主题头2 / 主题头3」。
//
// 为什么：本文件是「不必读整份当日日志」的路由表（AGENTS.md 硬规则 8 的单点依赖），
// 2026-09-27 定契约时 5,922 字符，2026-10-24 实测 57,850 字符（22 天涨 ×9.8）——
// 靠人肉「只留当月」的纪律必然反弹，改成脚本压缩＋配额闸门才守得住。
//
// 两条硬约束（2026-10-24 实测出来的坑，别改回去）：
// 1. **按日期选保留日，不按文件位置**：并发会话可能把补记的旧日期插到月份分组顶部，
//    按位置选会把「今天」归档、把补记的旧日子当今天留着。
// 2. **同一天可以在主文件与归档里各有一份**（压缩后又被补记）：并入归档时按行去重，
//    不开第二个 `## ` 块；归档恒为超集，索引行的条数从归档算。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const dry = argv.includes('--check');
const keepDays = Math.max(1, Number(opt('days', '1')) || 1);
const root = path.resolve(opt('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const logDir = path.join(root, 'docs', '日志');
const mainFile = path.join(logDir, '日志摘要.md');

// ── 解析：按 `## ` 切块；`### ` 不是块边界（自检脚本也只看 `## `）──────────────
function splitBlocks(text) {
  const out = [];
  let cur = { head: null, lines: [] };
  for (const raw of text.split('\n')) {
    const m = /^## (\S.*?)\s*$/.exec(raw);
    if (m) { out.push(cur); cur = { head: m[1].trim(), lines: [] }; }
    else cur.lines.push(raw);
  }
  out.push(cur);
  return out;
}
const isMonth = h => /^\d{4}-\d{2}$/.test(h || '');
const isDay = h => /^\d{4}-\d{2}-\d{2}$/.test(h || '');
const trimBlanks = ls => {
  let a = 0; let b = ls.length;
  while (a < b && !ls[a].trim()) a++;
  while (b > a && !ls[b - 1].trim()) b--;
  return ls.slice(a, b);
};
const countBullets = ls => ls.filter(l => /^\s*- /.test(l)).length;

// 合并同一天的两份内容：按行去重，保持先出现的顺序
function mergeLines(a, b) {
  const seen = new Set(a.map(l => l.trim()));
  const out = [...a];
  for (const l of b) {
    const t = l.trim();
    if (t && !seen.has(t)) { out.push(l); seen.add(t); }
  }
  return out;
}

// 主题头：取每条 bullet 第一个分隔符之前的部分（≤12 字），最多 3 个
function heads(lines, max = 3) {
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('- ')) continue;
    let s = t.slice(2).replace(/^\[[^\]]*\]\s*/, '').trim();
    if (!s) continue;
    const cut = s.split(/[：:（(｜|]|——|—/)[0].trim();
    const h = (cut || s).replace(/\s+/g, ' ').slice(0, 12);
    if (!h) continue;
    if (!out.includes(h)) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

if (!fs.existsSync(mainFile)) {
  console.error(`❌ 找不到 ${mainFile}`);
  process.exit(1);
}
// 本脚本生成的索引段（`### 本月更早` … 下一条 `## `）每次重算，解析前先剥掉；
// 否则它们会被当成上面那天块的内容，重排时又渲染一遍（2026-10-24 实测：索引行翻倍）。
function stripGeneratedIndex(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (/^###\s+本月更早/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (!/^##\s/.test(line)) continue;
      skipping = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

const mainText = fs.readFileSync(mainFile, 'utf8');
const mainBlocks = splitBlocks(stripGeneratedIndex(mainText));

// ── 归位：preamble（首个月份分组之前的一切）／月份分组／游离块 ─────────────────
const preamble = [];
const months = [];
const strays = [];
let inMonths = false;
for (const b of mainBlocks) {
  if (!b.head) { preamble.push(b); continue; }
  if (isMonth(b.head)) { inMonths = true; months.push({ month: b.head, days: [] }); continue; }
  if (isDay(b.head)) {
    if (!inMonths) { preamble.push(b); continue; }
    months[months.length - 1].days.push(b);
    continue;
  }
  // `## 维护契约` / `## 历史月份` 这类：在首个月份分组之前就属于 preamble，必须原地不动。
  if (!inMonths) preamble.push(b); else strays.push(b);
}

// ── 按日期摊平（同一天多块先合并），保留日 = 日期最新的 N 天 ────────────────────
const dayMap = new Map(); // date -> { head, lines, month }
const dateOrder = [];     // 出现顺序（仅用于无日期冲突时的稳定渲染）
for (const m of months) {
  for (const d of m.days) {
    const prev = dayMap.get(d.head);
    if (!prev) {
      dayMap.set(d.head, { head: d.head, lines: [...d.lines], month: m.month });
      dateOrder.push(d.head);
    } else {
      prev.lines = mergeLines(prev.lines, d.lines); // 同一天两块：合并，别丢
    }
  }
}
const allDates = [...dayMap.keys()].sort().reverse(); // ISO 日期，字符串序＝时间序
const keptDates = new Set(allDates.slice(0, keepDays));
const toArchive = allDates.filter(d => !keptDates.has(d)); // 新→旧

// 主文件里出现重复块也算「需要整理」（即使没有要归档的日子）
const hasDup = months.some(m => new Set(m.days.map(d => d.head)).size !== m.days.length);

if (toArchive.length === 0 && !hasDup) {
  console.log(`✓ 无需压缩：主文件 ${mainText.length.toLocaleString()} 字符，${allDates.length} 个当天块，已只留最近 ${keepDays} 天`);
  process.exit(0);
}

// ── 归档：按月份各写一个文件，块序旧→新；已有同一天则并进去 ─────────────────────
const archivePlan = new Map(); // month -> { file, isNew, prefix, blocks: Map(date -> lines) }
const archPlanFor = month => {
  if (archivePlan.has(month)) return archivePlan.get(month);
  const file = path.join(logDir, `日志摘要-${month}.md`);
  const exists = fs.existsSync(file);
  const parsed = exists ? splitBlocks(fs.readFileSync(file, 'utf8')) : [];
  const prefix = [];
  const blocks = new Map();
  for (const b of parsed) {
    if (!b.head) { prefix.push(...b.lines); continue; }
    if (isDay(b.head)) blocks.set(b.head, trimBlanks(b.lines));
    else prefix.push(`## ${b.head}`, ...b.lines);
  }
  if (!prefix.some(l => l.startsWith('# '))) {
    prefix.unshift(`# PhyMathia 日志摘要 · ${month}（全量块）`, '',
      `\`日志摘要.md\` 留当天全量 + 本月的按天索引；这里是 ${month} 每一天的完整块（一天一块，每条改动一行）。`,
      '块序：旧 → 新（便于追加）。查某天：`grep -n \'^## 2026-10-01\' docs/日志/日志摘要-2026-10.md`。', '');
  }
  const plan = { file, isNew: !exists, prefix, blocks };
  archivePlan.set(month, plan);
  return plan;
};

// 归档里已经有这一天的（压缩后被补记），把主文件的新条目并进去；否则整块搬过去
for (const date of toArchive) {
  const d = dayMap.get(date);
  const plan = archPlanFor(d.month);
  const add = trimBlanks(d.lines);
  if (!add.length) continue;
  const old = plan.blocks.get(date);
  plan.blocks.set(date, old ? mergeLines(old, add) : add);
}
// 保留日若在归档里也有旧副本，同样并成超集（归档恒为全量）
for (const date of keptDates) {
  const d = dayMap.get(date);
  if (!d) continue;
  const f = path.join(logDir, `日志摘要-${d.month}.md`);
  if (!fs.existsSync(f)) continue;
  const plan = archPlanFor(d.month);
  const old = plan.blocks.get(date);
  if (old) plan.blocks.set(date, mergeLines(old, trimBlanks(d.lines)));
}

// ── 重排主文件 ────────────────────────────────────────────────────────────
const out = [];
const push = s => out.push(s);
const renderBlock = b => {
  const body = trimBlanks(b.lines);
  if (b.head) push(`## ${b.head}`);
  for (const l of body) push(l);
  push('');
};
for (const b of preamble) renderBlock(b);

for (const m of months) {
  push(`## ${m.month}`);
  const kept = [...new Set(m.days.map(d => d.head))]
    .map(h => dayMap.get(h))
    .filter(d => d && keptDates.has(d.head))
    .sort((a, b) => b.head.localeCompare(a.head)); // 块序新→旧，不依赖原文件顺序
  // 索引要覆盖「归档里已有的 + 主文件里的」本月的天：只按主文件算，早先压进归档的日子会从索引里消失
  const indexed = [...new Set([
    ...allDates.filter(d => dayMap.get(d).month === m.month),
    ...(archivePlan.get(m.month)?.blocks.keys() ?? []),
  ])].filter(d => !keptDates.has(d)).sort((a, b) => b.localeCompare(a));
  for (const d of kept) {
    push(`## ${d.head}`);
    for (const l of trimBlanks(d.lines)) push(l);
    push('');
  }
  if (indexed.length) {
    push(`### 本月更早（全量见 [日志摘要-${m.month}.md](日志摘要-${m.month}.md)）`);
    for (const date of indexed) {
      const body = archivePlan.get(m.month)?.blocks.get(date) ?? dayMap.get(date).lines;
      const hs = heads(body);
      push(`- ${date} · ${countBullets(body)} 条${hs.length ? ` · ${hs.join(' / ')}` : ''}`);
    }
    push('');
  }
}
for (const b of strays) renderBlock(b);

// 收口：不留连续空行、文件尾一个换行
const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
const before = mainText.length;
const after = text.length;

for (const [month, plan] of archivePlan) {
  const blocks = [...plan.blocks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const parts = [plan.prefix.join('\n').replace(/\s*$/, ''), ''];
  for (const [head, lines] of blocks) parts.push(`## ${head}`, '', ...lines, '');
  const body = parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  const touched = blocks.map(([k]) => k).filter(k => toArchive.includes(k));
  console.log(`${dry ? '（预演）' : '✓'} ${plan.isNew ? '新建' : '更新'} ${path.relative(root, plan.file)}：${blocks.length} 块，${body.length.toLocaleString()} 字符${touched.length ? `（本轮归入 ${touched.length} 天）` : '（仅同步超集）'}`);
  if (!dry) fs.writeFileSync(plan.file, body, 'utf8');
}

console.log(`${dry ? '（预演）' : '✓'} 日志摘要 ${before.toLocaleString()} → ${after.toLocaleString()} 字符（保留最近 ${keepDays} 天全量，${toArchive.length} 天压成索引）`);
if (!dry) {
  fs.writeFileSync(mainFile, text, 'utf8');
  console.log('下一步：node scripts/check_context_budget.mjs 复核；当日日志与摘要当天块仍在原位，不受影响');
}
