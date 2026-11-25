#!/usr/bin/env node
// 版本号唯一入口（2026-11-25，用户要求「能快速改版本号的入口」）。
//
// 版本号在四个源里各存一份，手工改容易漏：
//   src/static/js/config.js      APP_VERSION（前端真相源，About 页/导出元信息/构建产物）
//   package.json / package-lock  npm 版本
//   src/server/llm_common.py     PHYMATHIA_USER_AGENT（opencode.ai 出网 UA）
//
// 用法：
//   node scripts/bump_version.mjs 1.5.2      # 指定版本
//   node scripts/bump_version.mjs --patch    # 当前 +0.0.1（默认）
//   node scripts/bump_version.mjs --minor    # +0.1.0
//   node scripts/bump_version.mjs --major    # +1.0.0
//   node scripts/bump_version.mjs --check    # 只核对四处是否同号，不改
//   node scripts/bump_version.mjs --dry-run  # 只打印将要改什么，不写文件/不构建
//   node scripts/bump_version.mjs --no-build # 改源但不重建（调试用；正式发版别用）
//
// 改完自动跑 build:js + build:viewer（viewer 子集也含 config.js，只建 app.js 会漏），
// 并核对两个产物里确实是新号。npm 别名：npm run version:bump -- 1.5.2

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG = path.join(ROOT, 'src/static/js/config.js');
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');
const LLM = path.join(ROOT, 'src/server/llm_common.py');
const DIST = path.join(ROOT, 'src/static/dist');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const noBuild = flags.has('--no-build');
const checkOnly = flags.has('--check');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { fail('读不到 ' + path.relative(ROOT, file) + '：' + e.message); }
}

function currentVersion() {
  const m = readText(CONFIG).match(/const APP_VERSION = '([^']+)';/);
  if (!m) fail('config.js 里找不到 `const APP_VERSION = \'x.y.z\';`');
  return m[1];
}

function parseSemver(v, label) {
  const m = SEMVER.exec(v);
  if (!m) fail(label + ' 不是 x.y.z 形式：' + v);
  return m.slice(1).map(Number);
}

function nextVersion(cur, kind) {
  const [a, b, c] = parseSemver(cur, '当前版本');
  if (kind === 'major') return (a + 1) + '.0.0';
  if (kind === 'minor') return a + '.' + (b + 1) + '.0';
  return a + '.' + b + '.' + (c + 1);
}

function sources() {
  const pkg = JSON.parse(readText(PKG));
  const lock = JSON.parse(readText(LOCK));
  const ua = readText(LLM).match(/PHYMATHIA_USER_AGENT = "PhyMathia\/([^"]+)"/);
  return {
    config: currentVersion(),
    packageJson: String(pkg.version || ''),
    packageLock: String(lock.version || ''),
    packageLockRoot: String((lock.packages && lock.packages[''] && lock.packages[''].version) || ''),
    userAgent: ua ? ua[1] : '',
  };
}

function checkSync() {
  const s = sources();
  const rows = [
    ['config.js APP_VERSION', s.config],
    ['package.json version', s.packageJson],
    ['package-lock.json version', s.packageLock],
    ['package-lock packages[""].version', s.packageLockRoot],
    ['llm_common.py PHYMATHIA_USER_AGENT', s.userAgent],
  ];
  const bad = rows.filter(([, v]) => v !== s.config);
  for (const [name, v] of rows) console.log((v === s.config ? '✓ ' : '❌ ') + name + ' = ' + (v || '(缺失)'));
  if (bad.length) {
    console.error('❌ 版本号不同步：以 config.js 的 ' + s.config + ' 为准');
    process.exit(1);
  }
  console.log('✓ 四处版本号一致：' + s.config);
}

if (checkOnly) { checkSync(); process.exit(0); }

const KNOWN_FLAGS = new Set(['--major', '--minor', '--patch', '--dry-run', '--no-build', '--check']);
for (const f of flags) if (!KNOWN_FLAGS.has(f)) fail('未知参数：' + f);

const cur = currentVersion();
parseSemver(cur, '当前版本');
let target;
if (positional.length > 1) fail('只接受一个版本号参数');
const kind = ['major', 'minor', 'patch'].find(k => flags.has('--' + k));
if (positional.length === 1) {
  target = positional[0].replace(/^v/, '');
  parseSemver(target, '目标版本');
} else {
  target = nextVersion(cur, kind || 'patch');
}

if (target === cur) fail('目标版本与当前版本相同：' + cur);

const pkg = JSON.parse(readText(PKG));
const lock = JSON.parse(readText(LOCK));
if (!lock.packages || !lock.packages['']) fail('package-lock.json 缺 packages[""]，lockfile 结构异常');

const nextConfig = readText(CONFIG).replace(
  /const APP_VERSION = '[^']+';/,
  "const APP_VERSION = '" + target + "';"
);
if (nextConfig === readText(CONFIG)) fail('config.js 版本行未替换');
pkg.version = target;
lock.version = target;
lock.packages[''].version = target;
const nextLlm = readText(LLM).replace(
  /PHYMATHIA_USER_AGENT = "PhyMathia\/[^"]+"/,
  'PHYMATHIA_USER_AGENT = "PhyMathia/' + target + '"'
);
if (nextLlm === readText(LLM)) fail('llm_common.py UA 行未替换');

console.log('版本号：' + cur + ' → ' + target + (dryRun ? '（dry-run，不写文件）' : ''));

if (!dryRun) {
  fs.writeFileSync(CONFIG, nextConfig);
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  fs.writeFileSync(LLM, nextLlm);
  console.log('✓ 已写：config.js / package.json / package-lock.json / llm_common.py');
}

// 旧号残留扫描（只告警）：dist 由构建覆盖；docs/日志里的历史版本号属正常。
function scanLeftover() {
  const exts = new Set(['.js', '.mjs', '.cjs', '.py', '.json', '.html', '.css']);
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.venv', '.venv-linux', '__pycache__', 'data', 'logs']);
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!skipDirs.has(ent.name)) walk(p);
        continue;
      }
      if (!exts.has(path.extname(ent.name))) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!text.includes(cur)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(cur)) hits.push(path.relative(ROOT, p) + ':' + (i + 1));
      }
    }
  };
  for (const dir of ['src', 'scripts', 'tests', 'harness']) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) walk(p);
  }
  if (hits.length) {
    console.log('⚠ 以下位置仍写着旧版本 ' + cur + '（若是历史夹具可忽略；dist 构建后会覆盖）：');
    for (const h of hits.slice(0, 20)) console.log('  - ' + h);
    if (hits.length > 20) console.log('  … 共 ' + hits.length + ' 处');
  }
}

if (!dryRun) scanLeftover();

if (dryRun) {
  console.log('（dry-run 结束；去掉 --dry-run 才会写文件并重建）');
  process.exit(0);
}

if (!noBuild) {
  const run = (script) => {
    console.log('▸ npm run ' + script);
    const r = spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) fail('npm run ' + script + ' 失败（exit ' + (r.status == null ? r.error && r.error.message : r.status) + '）');
  };
  run('build:js');
  run('build:viewer');
  for (const [name, file] of [['app.js', 'app.js'], ['viewer.js', 'viewer.js']]) {
    const p = path.join(DIST, file);
    const text = readText(p);
    if (!text.includes('APP_VERSION="' + target + '"')) fail(name + ' 里没找到 APP_VERSION="' + target + '"');
    console.log('✓ ' + name + ' 已含新版本号');
  }
}

checkSync();
console.log('完成。下一步：git add -A && git commit -m "chore(release): v' + target + '"；发版再打 tag v' + target + '。');
