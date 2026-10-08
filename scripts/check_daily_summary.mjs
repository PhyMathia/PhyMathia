#!/usr/bin/env node
// T67 收尾自检：日志摘要缺当天块即红。
// 用法：node scripts/check_daily_summary.mjs [YYYY-MM-DD] [仓库根目录]
//   两个参数都是测试口：日期默认今天，根目录默认本脚本所在仓库根。
// 背景（backlog T67，2026-09-27 登记）：日志摘要是「不必读整份当日日志」的路由表
// （AGENTS.md 硬规则 8 的单点依赖），维护曾靠自觉欠账（09-22/23/25 后补）。
// 收尾四件做完后跑一次，红（exit 1）＝收尾还没做完。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , dateArg, rootArg] = process.argv;
const pad = n => String(n).padStart(2, '0');
const now = new Date();
const date = dateArg || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const root = path.resolve(rootArg || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const logDir = path.join(root, 'docs', '日志');
const summaryFile = path.join(logDir, '日志摘要.md');

let failed = false;
let entries = 0;
const fail = msg => { console.log(`❌ ${msg}`); failed = true; };

if (!fs.existsSync(summaryFile)) {
  fail(`日志摘要.md 不存在（${summaryFile}）`);
} else {
  const lines = fs.readFileSync(summaryFile, 'utf8').split('\n');
  const dayIdx = lines.map(l => l.trim()).lastIndexOf(`## ${date}`);
  if (dayIdx < 0) {
    fail(`日志摘要.md 缺「## ${date}」当天块——当日改动没进路由表，硬规则 8「只读摘要不读整份日志」会漏`);
  } else {
    if (lines.map(l => l.trim()).filter(l => l === `## ${date}`).length > 1) {
      fail(`日志摘要.md「## ${date}」出现多块（契约：一天一块，同一天只追加不新开块）`);
    }
    for (const l of lines.slice(dayIdx + 1)) {
      if (l.startsWith('## ')) break;
      if (l.trim()) entries++;
    }
    if (entries === 0) fail(`「## ${date}」块是空的——有块无条目，等于没写`);
    const monthIdx = lines.findIndex(l => l.trim() === `## ${date.slice(0, 7)}`);
    if (monthIdx < 0 || monthIdx > dayIdx) {
      fail(`「## ${date}」不在当月「## ${date.slice(0, 7)}」分组下（跨月第一天要新开月分组，见摘要文件头说明）`);
    }
  }
}

if (!fs.existsSync(path.join(logDir, `${date}.md`))) fail(`当日日志 ${logDir}/${date}.md 不存在——收尾四件之一没做`);

if (failed) process.exit(1);
console.log(`✓ 收尾自检通过（${date}）：摘要当天块在位（${entries} 条）、当日日志在位`);
